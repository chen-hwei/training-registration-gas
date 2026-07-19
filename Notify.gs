// ==================== 通知系統（Notify.gs） ====================
// 三種情境：
//   N1 — 必修課程距截止日 ≤ 7 天，分組 BCC 寄給教師（每週一 07:00）
//   N2 — 必修課程已逾期且無 APPROVED 紀錄，分組 BCC 寄給教師 + 管理者每日彙整（每日 07:00）
//   N3 — PENDING 紀錄超過 3 天未審核，管理者每日彙整（每日 07:00）
// 防重複：
//   教師信（N1/N2）— 同一 type + userId + courseId，24 小時內最多寄一封（逐人標記，維持原邏輯）
//   管理者彙整信（N2_DIGEST/N3_DIGEST）— 同一 type + adminEmail，24 小時內最多寄一封
// 個資紅線：分組信一律用 BCC，to 欄固定為系統回信地址，絕不可放教師信箱

// ── 防重複發送 ──

function _notifCacheKey(type, targetId, courseOrRecordId) {
  const d = new Date();
  return `notif_${type}_${targetId}_${courseOrRecordId}_${d.getFullYear()}${d.getMonth()}${d.getDate()}`;
}

function _hasNotifiedToday(type, targetId, courseOrRecordId) {
  return !!CacheService.getScriptCache().get(_notifCacheKey(type, targetId, courseOrRecordId));
}

function _markNotified(type, targetId, courseOrRecordId) {
  CacheService.getScriptCache().put(_notifCacheKey(type, targetId, courseOrRecordId), '1', 86400);
}

// ── 主入口：計算通知名單（供實際發送與預覽共用） ──

/**
 * 建立本次通知名單（不發送）
 * @returns {Object[]} 通知項目陣列，每項含 type, teacher, course/record, daysLeft, adminEmails
 */
function _buildNotificationList() {
  const today    = new Date();
  const catalog  = parseSheetData(_getCatalogSheet())
    .filter(c => c.status === 'ACTIVE' && (c.isRequired === true || String(c.isRequired).toUpperCase() === 'TRUE'));
  const records  = parseSheetData(_getRecordSheet());
  const teachers = _getActiveTeachers();

  // Hash Map：「userId_catalogId」→ 最高狀態（APPROVED > PENDING > REJECTED）
  const statusPriority = { 'APPROVED': 3, 'PENDING': 2, 'REJECTED': 1 };
  const statusMap = {};
  records.forEach(r => {
    const key = r.userId + '_' + r.catalogId;
    if (!statusMap[key] || (statusPriority[r.status] || 0) > (statusPriority[statusMap[key]] || 0)) {
      statusMap[key] = r.status;
    }
  });

  const list = [];

  catalog.forEach(course => {
    // 日期解析：禁用 new Date("YYYY/M/D")，改用數字拆分
    const [y, m, d]  = String(course.endDate).replace(/-/g, '/').split('/').map(Number);
    if (!y || !m || !d) return;
    const endDate  = new Date(y, m - 1, d);
    const daysLeft = Math.ceil((endDate - today) / 86400000);

    teachers.forEach(teacher => {
      const key       = teacher.userId + '_' + course.catalogId;
      const topStatus = statusMap[key];
      if (topStatus === 'APPROVED') return;

      if (daysLeft > 0 && daysLeft <= 7) {
        if (!_hasNotifiedToday('N1', teacher.userId, course.catalogId)) {
          list.push({ type: 'N1', teacher, course, daysLeft, adminEmails: [] });
        }
      } else if (daysLeft <= 0) {
        if (!_hasNotifiedToday('N2', teacher.userId, course.catalogId)) {
          const adminEmails = _getAdminEmailsByDept(teacher.department);
          list.push({ type: 'N2', teacher, course, daysLeft, adminEmails });
        }
      }
    });
  });

  // N3：PENDING 紀錄超過 3 天（改為管理者每日彙整，不再逐筆做記錄層級防重複，
  // dedupe 改在 _sendAdminDigest 呼叫端以 adminEmail + 當日 做一次性判斷）
  const threeDaysAgo = new Date(today.getTime() - 3 * 86400000);
  records
    .filter(r => {
      if (r.status !== 'PENDING' || !r.submittedAt) return false;
      const submitted = new Date(r.submittedAt);
      return submitted < threeDaysAgo;
    })
    .forEach(record => {
      const teacher = teachers.find(t => t.userId === record.userId);
      if (!teacher) return;
      const adminEmails = _getAdminEmailsByDept(teacher.department);
      if (!adminEmails.length) return;
      list.push({ type: 'N3', teacher, record, adminEmails });
    });

  return list;
}

/**
 * 將名單依「課程 × 剩餘天數」（N1）／「課程」（N2 教師）／「管理者信箱」（N2/N3 彙整）分組
 * checkAndNotifyOverdue 與 previewNotification 共用，確保預覽與實發口徑一致
 */
function _groupNotificationList(list) {
  const n1Map = {}, n2Map = {}, n2AdminMap = {}, n3AdminMap = {};

  list.forEach(item => {
    if (item.type === 'N1') {
      const key = item.course.catalogId + '_' + item.daysLeft;
      if (!n1Map[key]) n1Map[key] = { course: item.course, daysLeft: item.daysLeft, teachers: [] };
      n1Map[key].teachers.push(item.teacher);
    } else if (item.type === 'N2') {
      const key = item.course.catalogId;
      if (!n2Map[key]) n2Map[key] = { course: item.course, teachers: [] };
      n2Map[key].teachers.push(item.teacher);
      item.adminEmails.forEach(email => {
        if (!n2AdminMap[email]) n2AdminMap[email] = [];
        n2AdminMap[email].push({ teacher: item.teacher, course: item.course });
      });
    } else if (item.type === 'N3') {
      item.adminEmails.forEach(email => {
        if (!n3AdminMap[email]) n3AdminMap[email] = [];
        n3AdminMap[email].push({ teacher: item.teacher, record: item.record });
      });
    }
  });

  return {
    n1Groups: Object.keys(n1Map).map(k => n1Map[k]),
    n2Groups: Object.keys(n2Map).map(k => n2Map[k]),
    n2AdminDigest: n2AdminMap,
    n3AdminDigest: n3AdminMap
  };
}

/** 預覽通知名單（不發送，供管理者確認後再手動觸發）*/
function previewNotification() {
  const list = _buildNotificationList();
  const { n1Groups, n2Groups, n2AdminDigest, n3AdminDigest } = _groupNotificationList(list);

  const toTeacherRow = t => ({ userId: t.userId, teacherName: t.name, department: t.department });

  const n1 = n1Groups.map(g => ({
    label: `${g.course.title}（還有 ${g.daysLeft} 天）`,
    count: g.teachers.length,
    teachers: g.teachers.map(toTeacherRow)
  }));

  const n2 = n2Groups.map(g => ({
    label: g.course.title,
    count: g.teachers.length,
    teachers: g.teachers.map(toTeacherRow)
  }));

  const n2Admin = Object.keys(n2AdminDigest).map(email => ({
    adminEmail: email,
    count: n2AdminDigest[email].length,
    items: n2AdminDigest[email].map(it => ({
      teacherName: it.teacher.name,
      department:  it.teacher.department,
      title:       it.course.title
    }))
  }));

  const n3Admin = Object.keys(n3AdminDigest).map(email => ({
    adminEmail: email,
    count: n3AdminDigest[email].length,
    items: n3AdminDigest[email].map(it => ({
      teacherName: it.teacher.name,
      department:  it.teacher.department,
      title:       it.record.title
    }))
  }));

  return { success: true, count: list.length, groups: { n1, n2, n2Admin, n3Admin } };
}

/** 實際發送通知（分組 BCC + 管理者每日彙整），回傳 { mails, recipients } */
function checkAndNotifyOverdue() {
  const list = _buildNotificationList();
  const { n1Groups, n2Groups, n2AdminDigest, n3AdminDigest } = _groupNotificationList(list);
  let mails = 0, recipients = 0;

  // N1：教師分組 BCC（依課程 × 剩餘天數）
  n1Groups.forEach(g => {
    _chunkArray(g.teachers, 50).forEach(chunk => {
      try {
        _sendGroupedReminder('N1', g.course, g.daysLeft, chunk);
        chunk.forEach(t => _markNotified('N1', t.userId, g.course.catalogId));
        _logOp_('', 'NOTIFY_N1', 'catalogId=' + g.course.catalogId + '，daysLeft=' + g.daysLeft +
          '，' + chunk.length + ' 人：' + chunk.map(t => t.userId).join(','));
        mails++;
        recipients += chunk.length;
      } catch (e) {
        _logOp_('', 'ERROR_NOTIFY_N1', 'catalogId=' + g.course.catalogId + '，daysLeft=' + g.daysLeft +
          '，' + chunk.length + ' 人：' + e.message);
      }
    });
  });

  // N2：教師分組 BCC（依課程）
  n2Groups.forEach(g => {
    _chunkArray(g.teachers, 50).forEach(chunk => {
      try {
        _sendGroupedReminder('N2', g.course, null, chunk);
        chunk.forEach(t => _markNotified('N2', t.userId, g.course.catalogId));
        _logOp_('', 'NOTIFY_N2', 'catalogId=' + g.course.catalogId +
          '，' + chunk.length + ' 人：' + chunk.map(t => t.userId).join(','));
        mails++;
        recipients += chunk.length;
      } catch (e) {
        _logOp_('', 'ERROR_NOTIFY_N2', 'catalogId=' + g.course.catalogId +
          '，' + chunk.length + ' 人：' + e.message);
      }
    });
  });

  // N2 管理者每日彙整
  Object.keys(n2AdminDigest).forEach(email => {
    if (_hasNotifiedToday('N2_DIGEST', email, 'ALL')) return;
    try {
      _sendAdminDigest('N2', email, n2AdminDigest[email]);
      _markNotified('N2_DIGEST', email, 'ALL');
      _logOp_('', 'NOTIFY_N2_DIGEST', email + '，' + n2AdminDigest[email].length + ' 筆');
      mails++;
      recipients++;
    } catch (e) {
      _logOp_('', 'ERROR_NOTIFY_N2_DIGEST', email + '：' + e.message);
    }
  });

  // N3 管理者每日彙整
  Object.keys(n3AdminDigest).forEach(email => {
    if (_hasNotifiedToday('N3_DIGEST', email, 'ALL')) return;
    try {
      _sendAdminDigest('N3', email, n3AdminDigest[email]);
      _markNotified('N3_DIGEST', email, 'ALL');
      _logOp_('', 'NOTIFY_N3_DIGEST', email + '，' + n3AdminDigest[email].length + ' 筆');
      mails++;
      recipients++;
    } catch (e) {
      _logOp_('', 'ERROR_NOTIFY_N3_DIGEST', email + '：' + e.message);
    }
  });

  console.log('checkAndNotifyOverdue 完成，共發送 ' + mails + ' 封（' + recipients + ' 人次）。');
  return { mails, recipients };
}

// ── 信件發送函式 ──

/** 分組陣列，size 內為一組（BCC 單封上限抓 50，超過分批） */
function _chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * 教師分組提醒信：to 固定為系統回信地址，教師名單一律走 bcc
 * ⚠️ 個資紅線：嚴禁把任一教師信箱放進 to，否則會被同組其他 bcc 收件者看到
 */
function _sendGroupedReminder(type, course, daysLeft, teachers) {
  const bcc = teachers.map(t => t.email).filter(Boolean).join(',');
  if (!bcc) return;
  const replyTo = getMailReplyTo_();
  const mailOptions = { to: replyTo, bcc, name: SYSTEM_MAIL_NAME, replyTo };

  if (type === 'N1') {
    mailOptions.subject  = `【研習提醒】${course.title} 距截止日僅剩 ${daysLeft} 天`;
    mailOptions.htmlBody = `
      <p>老師您好，</p>
      <p>您尚未完成必修研習 <strong>「${course.title}」</strong>（${course.hours} 小時）。</p>
      <p>截止日期：<strong>${course.endDate}</strong>（還有 ${daysLeft} 天）</p>
      <p>請盡快登錄研習紀錄並上傳研習證明。</p>
      <p style="color:#888;font-size:12px;">此信由研習登錄系統自動寄送，如有疑問請回覆此信聯繫承辦人。</p>
    `;
  } else if (type === 'N2') {
    mailOptions.subject  = `【研習逾期】${course.title} 尚未完成，請盡快處理`;
    mailOptions.htmlBody = `
      <p>老師您好，</p>
      <p>必修研習 <strong>「${course.title}」</strong> 已於 ${course.endDate} 截止，
         但您尚無通過審核的登錄紀錄。</p>
      <p>請盡快聯繫所屬處室管理者說明情況，或補登研習紀錄。</p>
      <p style="color:#888;font-size:12px;">此信由研習登錄系統自動寄送，如有疑問請回覆此信聯繫承辦人。</p>
    `;
  } else {
    return;
  }

  MailApp.sendEmail(mailOptions);
}

/** 管理者每日彙整信（N2 逾期未完成 / N3 待審逾時），一位管理者一天最多一封 */
function _sendAdminDigest(type, email, items) {
  const replyTo = getMailReplyTo_();
  let subject, rows;

  if (type === 'N2') {
    subject = `【研習管理】今日逾期未完成清單（共 ${items.length} 筆）`;
    rows = items.map(it =>
      `<li>${_escapeHtml_(it.teacher.department)} ${_escapeHtml_(it.teacher.name)}（${_escapeHtml_(it.teacher.userId)}）— ` +
      `「${_escapeHtml_(it.course.title)}」（截止 ${_escapeHtml_(it.course.endDate)}）</li>`
    ).join('');
  } else {
    subject = `【研習管理】今日待審逾時清單（共 ${items.length} 筆）`;
    rows = items.map(it =>
      `<li>${_escapeHtml_(it.teacher.department)} ${_escapeHtml_(it.teacher.name)}（${_escapeHtml_(it.teacher.userId)}）— ` +
      `「${_escapeHtml_(it.record.title)}」（送出 ${_escapeHtml_(it.record.submittedAt)}）</li>`
    ).join('');
  }

  MailApp.sendEmail({
    to: email,
    name: SYSTEM_MAIL_NAME,
    replyTo,
    subject,
    htmlBody: `
      <p>管理者您好，</p>
      <p>以下為今日彙整清單：</p>
      <ul>${rows}</ul>
      <p>請登入研習登錄系統後台進行追蹤或審核。</p>
      <p style="color:#888;font-size:12px;">此信由研習登錄系統自動寄送，如有疑問請回覆此信聯繫承辦人。</p>
    `
  });
}

function _escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 輔助函式 ──

/** 取得所有在職教師清單（從 Hub.UserStatusCache） */
function _getActiveTeachers() {
  const hub   = SpreadsheetApp.openById(getHubSpreadsheetId_());
  const data  = hub.getSheetByName('UserStatusCache').getDataRange().getValues();
  const hdr   = data[0];
  const uidCol    = hdr.indexOf('userId');
  const nameCol   = hdr.indexOf('name');
  const emailCol  = hdr.indexOf('schoolEmail');
  const statusCol = hdr.indexOf('status');
  const deptCol   = hdr.indexOf('department');
  const ACTIVE    = ['在職', '轉調'];
  return data.slice(1)
    .filter(row => ACTIVE.includes(row[statusCol]) && row[uidCol])
    .map(row => ({
      userId:     row[uidCol],
      name:       row[nameCol]   || '',
      email:      row[emailCol]  || '',
      department: row[deptCol]   || ''
    }));
}

/** 取得指定處室的 training_admin 管理者 email 清單 */
function _getAdminEmailsByDept(department) {
  const hub   = SpreadsheetApp.openById(getHubSpreadsheetId_());
  const data  = hub.getSheetByName('UserStatusCache').getDataRange().getValues();
  const hdr   = data[0];
  const deptCol   = hdr.indexOf('department');
  const accessCol = hdr.indexOf('systemAccess');
  const emailCol  = hdr.indexOf('schoolEmail');
  const statusCol = hdr.indexOf('status');
  const ACTIVE    = ['在職', '轉調'];
  return data.slice(1)
    .filter(row => {
      if (!ACTIVE.includes(row[statusCol])) return false;
      if (row[deptCol] !== department)       return false;
      try { return JSON.parse(row[accessCol] || '{}').training_admin === true; }
      catch { return false; }
    })
    .map(row => row[emailCol])
    .filter(Boolean);
}

/** 除錯用：逐步印出通知邏輯各關卡的狀態，不發送任何信件 */
function debugNotify() {
  const today   = new Date();
  console.log('=== debugNotify 開始，today=' + today.toISOString() + ' ===');

  // 1. 必修 ACTIVE 課程
  const catalog = parseSheetData(_getCatalogSheet())
    .filter(c => c.status === 'ACTIVE' && (c.isRequired === true || String(c.isRequired).toUpperCase() === 'TRUE'));
  console.log('必修 ACTIVE 課程數：' + catalog.length);
  catalog.forEach(c => console.log('  課程: ' + c.catalogId + ' / ' + c.title + ' / endDate=' + c.endDate + ' / isRequired=' + c.isRequired));

  // 2. 在職教師
  const teachers = _getActiveTeachers();
  console.log('在職教師數：' + teachers.length);
  teachers.slice(0, 5).forEach(t => console.log('  教師: ' + t.userId + ' / ' + t.name + ' / email=' + t.email + ' / dept=' + t.department));

  // 3. 各課程日期解析與 daysLeft
  catalog.forEach(course => {
    const [y, m, d] = String(course.endDate).replace(/-/g, '/').split('/').map(Number);
    if (!y || !m || !d) { console.log('  ⚠️ 日期解析失敗: ' + course.endDate); return; }
    const endDate  = new Date(y, m - 1, d);
    const daysLeft = Math.ceil((endDate - today) / 86400000);
    console.log('  ' + course.title + ' → daysLeft=' + daysLeft + '（endDate=' + endDate.toDateString() + '）');

    // 4. 每位教師的 statusMap
    const records = parseSheetData(_getRecordSheet());
    const statusPriority = { 'APPROVED': 3, 'PENDING': 2, 'REJECTED': 1 };
    const statusMap = {};
    records.forEach(r => {
      const key = r.userId + '_' + r.catalogId;
      if (!statusMap[key] || (statusPriority[r.status] || 0) > (statusPriority[statusMap[key]] || 0)) {
        statusMap[key] = r.status;
      }
    });

    teachers.forEach(teacher => {
      const key       = teacher.userId + '_' + course.catalogId;
      const topStatus = statusMap[key] || '(無紀錄)';
      const cached    = _hasNotifiedToday('N2', teacher.userId, course.catalogId);
      if (daysLeft <= 0) {
        console.log('    N2候選: ' + teacher.userId + ' status=' + topStatus + ' cached=' + cached);
      }
    });
  });

  console.log('=== debugNotify 結束 ===');
}

/** 建立定時觸發器（可重複執行：會先刪除同名舊觸發器再重建，不疊加） */
function setupNotifyTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkAndNotifyOverdue') ScriptApp.deleteTrigger(t);
  });
  // N2 + N3：每日 07:00
  ScriptApp.newTrigger('checkAndNotifyOverdue')
    .timeBased().atHour(7).everyDays(1).create();
  console.log('通知觸發器已建立（checkAndNotifyOverdue，每日 07:00）。');
}
