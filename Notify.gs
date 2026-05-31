// ==================== 通知系統（Notify.gs） ====================
// 三種情境：
//   N1 — 必修課程距截止日 ≤ 7 天，寄給教師本人（每週一 07:00）
//   N2 — 必修課程已逾期且無 APPROVED 紀錄，寄給教師 + 處室管理者（每日 07:00）
//   N3 — PENDING 紀錄超過 3 天未審核，寄給處室管理者（每日 07:00）
// 防重複：同一 type + userId/adminEmail + courseId，24 小時內最多寄一封

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

  // N3：PENDING 紀錄超過 3 天
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
      if (!_hasNotifiedToday('N3', adminEmails.join(','), record.recordId)) {
        list.push({ type: 'N3', teacher, record, adminEmails });
      }
    });

  return list;
}

/** 預覽通知名單（不發送，供管理者確認後再手動觸發）*/
function previewNotification() {
  const list = _buildNotificationList();
  const grouped = { n1: [], n2: [], n3: [] };
  list.forEach(item => {
    const key = item.type.toLowerCase(); // 'N1' → 'n1'
    grouped[key].push({
      userId:      item.teacher ? item.teacher.userId     : '',
      teacherName: item.teacher ? item.teacher.name       : '',
      department:  item.teacher ? item.teacher.department : '',
      title:       item.course  ? item.course.title       : (item.record ? item.record.title : ''),
      daysLeft:    item.daysLeft || null,
      adminEmails: item.adminEmails || []
    });
  });
  return { success: true, data: grouped, count: list.length };
}

/** 實際發送通知並回傳發送封數（供定時觸發器與手動 API 共用） */
function checkAndNotifyOverdue() {
  const list = _buildNotificationList();
  let sent = 0;

  list.forEach(item => {
    try {
      if (item.type === 'N1') {
        _sendN1Reminder(item.teacher, item.course, item.daysLeft);
        _markNotified('N1', item.teacher.userId, item.course.catalogId);
        sent++;
      } else if (item.type === 'N2') {
        _sendN2Overdue(item.teacher, item.course, item.adminEmails);
        _markNotified('N2', item.teacher.userId, item.course.catalogId);
        sent++;
      } else if (item.type === 'N3') {
        _sendN3PendingOverdue(item.teacher, item.record, item.adminEmails);
        _markNotified('N3', item.adminEmails.join(','), item.record.recordId);
        sent++;
      }
    } catch (e) {
      console.error('通知發送失敗 type=' + item.type + ' userId=' + item.teacher.userId + ' 原因：' + e.message);
    }
  });

  console.log('checkAndNotifyOverdue 完成，共發送 ' + sent + ' 封。');
  return sent;
}

// ── 信件發送函式 ──

function _sendN1Reminder(teacher, course, daysLeft) {
  MailApp.sendEmail({
    to: teacher.email,
    subject: `【研習提醒】${course.title} 距截止日僅剩 ${daysLeft} 天`,
    htmlBody: `
      <p>${teacher.name} 老師您好，</p>
      <p>您尚未完成必修研習 <strong>「${course.title}」</strong>（${course.hours} 小時）。</p>
      <p>截止日期：<strong>${course.endDate}</strong>（還有 ${daysLeft} 天）</p>
      <p>請盡快登錄研習紀錄並上傳研習證明。</p>
      <p style="color:#888;font-size:12px;">此信由研習登錄系統自動寄送，請勿直接回覆。</p>
    `
  });
  SchoolPortalLib.logAction(teacher.userId, 'NOTIFY_N1', course.catalogId);
}

function _sendN2Overdue(teacher, course, adminEmails) {
  MailApp.sendEmail({
    to: teacher.email,
    subject: `【研習逾期】${course.title} 尚未完成，請盡快處理`,
    htmlBody: `
      <p>${teacher.name} 老師您好，</p>
      <p>必修研習 <strong>「${course.title}」</strong> 已於 ${course.endDate} 截止，
         但您尚無通過審核的登錄紀錄。</p>
      <p>請盡快聯繫所屬處室管理者說明情況，或補登研習紀錄。</p>
      <p style="color:#888;font-size:12px;">此信由研習登錄系統自動寄送，請勿直接回覆。</p>
    `
  });

  if (adminEmails.length) {
    MailApp.sendEmail({
      to: adminEmails.join(','),
      subject: `【研習管理】${teacher.department} ${teacher.name} 必修研習逾期未完成`,
      htmlBody: `
        <p>管理者您好，</p>
        <p>以下教師的必修研習 <strong>「${course.title}」</strong>（截止 ${course.endDate}）
           尚無通過審核的紀錄，請追蹤確認：</p>
        <ul><li>${teacher.name}（${teacher.userId}）</li></ul>
        <p style="color:#888;font-size:12px;">此信由研習登錄系統自動寄送，請勿直接回覆。</p>
      `
    });
  }

  SchoolPortalLib.logAction(teacher.userId, 'NOTIFY_N2', course.catalogId);
}

function _sendN3PendingOverdue(teacher, record, adminEmails) {
  if (!adminEmails.length) return;
  MailApp.sendEmail({
    to: adminEmails.join(','),
    subject: `【待審提醒】${teacher.department} ${teacher.name} 有研習紀錄待審超過 3 天`,
    htmlBody: `
      <p>管理者您好，</p>
      <p>${teacher.name}（${teacher.userId}）的研習紀錄
         <strong>「${record.title}」</strong>（送出時間：${record.submittedAt}）
         已超過 3 天尚未審核。</p>
      <p>請登入研習登錄系統後台進行審核。</p>
      <p style="color:#888;font-size:12px;">此信由研習登錄系統自動寄送，請勿直接回覆。</p>
    `
  });
}

// ── 輔助函式 ──

/** 取得所有在職教師清單（從 Hub.UserStatusCache） */
function _getActiveTeachers() {
  const hub   = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
  const data  = hub.getSheetByName('UserStatusCache').getDataRange().getValues();
  const hdr   = data[0];
  const uidCol    = hdr.indexOf('userId');
  const nameCol   = hdr.indexOf('name');
  const emailCol  = hdr.indexOf('email');
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
  const hub   = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
  const data  = hub.getSheetByName('UserStatusCache').getDataRange().getValues();
  const hdr   = data[0];
  const deptCol   = hdr.indexOf('department');
  const accessCol = hdr.indexOf('systemAccess');
  const emailCol  = hdr.indexOf('email');
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

/** 建立定時觸發器（一次性執行，部署時呼叫） */
function setupNotifyTriggers() {
  // N2 + N3：每日 07:00
  ScriptApp.newTrigger('checkAndNotifyOverdue')
    .timeBased().atHour(7).everyDays(1).create();
  console.log('通知觸發器已建立（checkAndNotifyOverdue，每日 07:00）。');
}
