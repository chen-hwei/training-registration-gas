// ==================== 通知系統（Notify.gs） ====================
// 三種情境：
//   N1 — 必修課程距截止日 ≤ 7 天，分組 BCC 寄給教師（每週一 07:00）
//   N2 — 必修課程已逾期且無 APPROVED 紀錄，分組 BCC 寄給教師 + 該課程所屬處室管理者
//        每日彙整（task_6e2d40af Stage D 起依 training_scope 路由，查無管理者退回全體）
//   N3 — PENDING 紀錄超過 3 天未審核，該紀錄所屬處室管理者每日彙整（同上，Stage D 起）
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
 * @returns {Object[]} 通知項目陣列，每項含 type, teacher, course/record, daysLeft,
 *   adminEmails, owner, replyTo（task_6e2d40af Stage D：owner／replyTo 依課程或
 *   紀錄解析出的處室動態決定，N1 的 adminEmails 維持 [] 不變，Y-D1）
 */
function _buildNotificationList() {
  const today = new Date();

  // D-5：Hub UserStatusCache／TRAINING_CATALOG 各只讀一次，分別餵給下游函式
  const hubRows     = _readHubUserStatusRows_();
  const teachers     = _getActiveTeachers(hubRows);
  const buckets      = _buildAdminBuckets_(hubRows);
  const fullCatalog  = parseSheetData(_getCatalogSheet());
  const catalog      = fullCatalog.filter(c => c.status === 'ACTIVE' &&
    (c.isRequired === true || String(c.isRequired).toUpperCase() === 'TRUE'));
  const ownerIndex   = _buildOwnerIndex_(fullCatalog);

  const records = parseSheetData(_getRecordSheet());

  // Hash Map：「userId_catalogId」→ 最高狀態（APPROVED > PENDING > REJECTED）
  const statusPriority = { 'APPROVED': 3, 'PENDING': 2, 'REJECTED': 1 };
  const statusMap = {};
  records.forEach(r => {
    const key = r.userId + '_' + r.catalogId;
    if (!statusMap[key] || (statusPriority[r.status] || 0) > (statusPriority[statusMap[key]] || 0)) {
      statusMap[key] = r.status;
    }
  });

  // S-D-2：fallback 留痕的 owner 去重集合，整個執行只留一次痕跡（不隨教師/紀錄
  // 筆數重複寫入 Hub AuditLog，避免退化狀態下的雙層迴圈拖死執行時間）
  const loggedFallbackOwners = new Set();

  const list = [];

  catalog.forEach(course => {
    // 日期解析：禁用 new Date("YYYY/M/D")，改用數字拆分
    const [y, m, d]  = String(course.endDate).replace(/-/g, '/').split('/').map(Number);
    if (!y || !m || !d) return;
    const endDate  = new Date(y, m - 1, d);
    const daysLeft = Math.ceil((endDate - today) / 86400000);
    const owner    = _resolveRecordOwner_(course, ownerIndex);
    const replyTo  = _replyToForOwner_(owner, buckets);
    // S-D-2：每門課程只算一次（原寫法在 teachers.forEach 內層，等同每位教師呼叫一次）
    const adminEmails = daysLeft <= 0 ? _adminEmailsForOwner_(owner, buckets, loggedFallbackOwners) : null;

    teachers.forEach(teacher => {
      const key       = teacher.userId + '_' + course.catalogId;
      const topStatus = statusMap[key];
      if (topStatus === 'APPROVED') return;

      if (daysLeft > 0 && daysLeft <= 7) {
        if (!_hasNotifiedToday('N1', teacher.userId, course.catalogId)) {
          list.push({ type: 'N1', teacher, course, daysLeft, adminEmails: [], owner, replyTo });
        }
      } else if (daysLeft <= 0) {
        if (!_hasNotifiedToday('N2', teacher.userId, course.catalogId)) {
          list.push({ type: 'N2', teacher, course, daysLeft, adminEmails, owner, replyTo });
        }
      }
    });
  });

  // N3：PENDING 紀錄超過 3 天（改為管理者每日彙整，不再逐筆做記錄層級防重複，
  // dedupe 改在 _sendAdminDigest 呼叫端以 adminEmail + 當日 做一次性判斷）
  const threeDaysAgo = new Date(today.getTime() - 3 * 86400000);
  const teacherById = {};
  teachers.forEach(t => { teacherById[t.userId] = t; }); // Y-F1：取代 O(n×m) 的 teachers.find()
  const ownerAdminCache = {}; // S-D-2：N3 依 owner memoize，同一 owner 在本次執行只算一次
  records
    .filter(r => {
      if (r.status !== 'PENDING' || !r.submittedAt) return false;
      const submitted = new Date(r.submittedAt);
      return submitted < threeDaysAgo;
    })
    .forEach(record => {
      const teacher = teacherById[record.userId];
      if (!teacher) return;
      const owner = _resolveRecordOwner_(record, ownerIndex);
      if (!(owner in ownerAdminCache)) {
        ownerAdminCache[owner] = _adminEmailsForOwner_(owner, buckets, loggedFallbackOwners);
      }
      const adminEmails = ownerAdminCache[owner];
      if (!adminEmails.length) return; // 理論上 _adminEmailsForOwner_ 已保底退回全體，此判斷僅作防禦
      const replyTo = _replyToForOwner_(owner, buckets);
      list.push({ type: 'N3', teacher, record, adminEmails, owner, replyTo });
    });

  return list;
}

/**
 * 將名單依「課程 × 剩餘天數」（N1）／「課程」（N2 教師）／「管理者信箱」（N2/N3 彙整）分組
 * checkAndNotifyOverdue 與 previewNotification 共用，確保預覽與實發口徑一致
 * （Y-F4：Stage D 起兩邊共用同一份 _buildNotificationList() 算出的 owner／
 * adminEmails，Y-B4 登記的「Stage B～D 之間暫時性偏離」至此結案）
 */
function _groupNotificationList(list) {
  const n1Map = {}, n2Map = {}, n2AdminMap = {}, n3AdminMap = {};

  list.forEach(item => {
    if (item.type === 'N1') {
      const key = item.course.catalogId + '_' + item.daysLeft;
      if (!n1Map[key]) n1Map[key] = { course: item.course, daysLeft: item.daysLeft, teachers: [], owner: item.owner, replyTo: item.replyTo };
      n1Map[key].teachers.push(item.teacher);
    } else if (item.type === 'N2') {
      const key = item.course.catalogId;
      if (!n2Map[key]) n2Map[key] = { course: item.course, teachers: [], owner: item.owner, replyTo: item.replyTo };
      n2Map[key].teachers.push(item.teacher);
      item.adminEmails.forEach(email => {
        if (!n2AdminMap[email]) n2AdminMap[email] = [];
        n2AdminMap[email].push({ teacher: item.teacher, course: item.course, owner: item.owner, replyTo: item.replyTo });
      });
    } else if (item.type === 'N3') {
      item.adminEmails.forEach(email => {
        if (!n3AdminMap[email]) n3AdminMap[email] = [];
        n3AdminMap[email].push({ teacher: item.teacher, record: item.record, owner: item.owner, replyTo: item.replyTo });
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

/**
 * 預覽通知名單（不發送，供管理者確認後再手動觸發）
 * scope 限制下（Y-4）：n1／n2 教師名單只含解析到自己 scope（或無法歸屬）的課程；
 * n2Admin／n3Admin 只含呼叫者自己的 email，且該 email 底下的 items 本身也只含解析到
 * 自己 scope（或無法歸屬）的課程／紀錄——見「Y-4 揭露面收斂的實際邊界」節。
 * Y-E3：items 已在 _buildNotificationList() 階段掛好 owner，這裡直接讀用，
 * 不重建 _buildOwnerIndex_()，省一次 TRAINING_CATALOG／TRAINING_REQUIREMENT 重讀。
 */
function previewNotification(callerUserId, scope) {
  const list = _buildNotificationList();
  let { n1Groups, n2Groups, n2AdminDigest, n3AdminDigest } = _groupNotificationList(list);

  if (!_isAllScope_(scope)) {
    const inScope = owner => _inScope_(owner, scope);
    n1Groups = n1Groups.filter(g => inScope(g.owner));
    n2Groups = n2Groups.filter(g => inScope(g.owner));

    const callerUser  = _getHubUser_(callerUserId);
    const callerEmail = callerUser ? String(callerUser.email || '') : '';

    const myN2Items = (callerEmail && n2AdminDigest[callerEmail])
      ? n2AdminDigest[callerEmail].filter(it => inScope(it.owner))
      : [];
    const myN3Items = (callerEmail && n3AdminDigest[callerEmail])
      ? n3AdminDigest[callerEmail].filter(it => inScope(it.owner))
      : [];
    n2AdminDigest = myN2Items.length ? { [callerEmail]: myN2Items } : {};
    n3AdminDigest = myN3Items.length ? { [callerEmail]: myN3Items } : {};
  }

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

  // scope 限制下，count 須反映過濾後的實際項目數，否則會出現「有數字、卻看不到內容」的誤導
  const count = _isAllScope_(scope)
    ? list.length
    : n1Groups.reduce((s, g) => s + g.teachers.length, 0) +
      n2Groups.reduce((s, g) => s + g.teachers.length, 0) +
      Object.keys(n2AdminDigest).reduce((s, e) => s + n2AdminDigest[e].length, 0) +
      Object.keys(n3AdminDigest).reduce((s, e) => s + n3AdminDigest[e].length, 0);

  return { success: true, count, groups: { n1, n2, n2Admin, n3Admin } };
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
        _sendGroupedReminder('N1', g.course, g.daysLeft, chunk, g.replyTo);
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
        _sendGroupedReminder('N2', g.course, null, chunk, g.replyTo);
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
      const items = n2AdminDigest[email];
      _sendAdminDigest('N2', email, items, _digestReplyTo_(items));
      _markNotified('N2_DIGEST', email, 'ALL');
      _logOp_('', 'NOTIFY_N2_DIGEST', email + '，' + items.length + ' 筆');
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
      const items = n3AdminDigest[email];
      _sendAdminDigest('N3', email, items, _digestReplyTo_(items));
      _markNotified('N3_DIGEST', email, 'ALL');
      _logOp_('', 'NOTIFY_N3_DIGEST', email + '，' + items.length + ' 筆');
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
 * replyTo：課程解析出的處室承辦人信箱（task_6e2d40af Stage D）；查不到處室承辦人
 * （null）則沿用系統信箱。Q-C 裁示：to 永遠是系統信箱，不隨處室動態化。
 */
function _sendGroupedReminder(type, course, daysLeft, teachers, replyTo) {
  const bcc = teachers.map(t => t.email).filter(Boolean).join(',');
  if (!bcc) return;
  const to = getMailReplyTo_();
  const finalReplyTo = replyTo || to;
  const mailOptions = { to, bcc, name: SYSTEM_MAIL_NAME, replyTo: finalReplyTo };

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

/**
 * 管理者每日彙整信（N2 逾期未完成 / N3 待審逾時），一位管理者一天最多一封
 * replyTo：由呼叫端 _digestReplyTo_() 依信內 items 是否橫跨多處室算好傳入
 * （task_6e2d40af Stage D，Q-H 裁示）。to 維持該管理者本人信箱，不受影響。
 */
function _sendAdminDigest(type, email, items, replyTo) {
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

/** 讀一次 Hub.UserStatusCache 原始列（含標題列），供本檔多支函式共用（D-5 單次讀表） */
function _readHubUserStatusRows_() {
  const hub = SpreadsheetApp.openById(getHubSpreadsheetId_());
  return hub.getSheetByName('UserStatusCache').getDataRange().getValues();
}

/**
 * 取得應收催辦通知的人員清單（從 Hub.UserStatusCache）
 * task_c5f2e08d Q-6：套用 _isTrainingTracked_()，兼課教師與實習老師不再收催辦信，
 * 行政人員維持照收（與 Sync.gs／calcRequirementStats 口徑一致）
 * @param {Array[]} [preReadRows] 已讀入的 Hub 原始列（D-5，帶了就不重讀；
 *   不帶時行為與改動前完全相同，供 debugNotify() 等既有無參數呼叫零影響）
 */
function _getActiveTeachers(preReadRows) {
  const data  = preReadRows || _readHubUserStatusRows_();
  const hdr   = data[0];
  const uidCol    = hdr.indexOf('userId');
  const nameCol   = hdr.indexOf('name');
  const emailCol  = hdr.indexOf('schoolEmail');
  const statusCol = hdr.indexOf('status');
  const deptCol   = hdr.indexOf('department');
  const jobCol    = hdr.indexOf('jobPrimary');
  const ACTIVE    = ['在職', '轉調'];
  const includePartTime = _loadStatsIncludePartTime_();
  return data.slice(1)
    .filter(row => {
      if (!row[uidCol] || !ACTIVE.includes(row[statusCol])) return false;
      const job = jobCol >= 0 ? String(row[jobCol] || '').trim() : '';
      return _isTrainingTracked_(job, includePartTime);
    })
    .map(row => ({
      userId:     row[uidCol],
      name:       row[nameCol]   || '',
      email:      row[emailCol]  || '',
      department: row[deptCol]   || ''
    }));
}

/**
 * 建立「處室 → 管理者 email」對照表（task_6e2d40af Stage D，取代 _getTrainingAdminEmails_()）
 * scoped[dept]：training_scope 明列該處室者；all[]：ALL-scope（含未設定 training_scope）者。
 * 判定一律走 _normalizeScope_() ＋ _isAllScope_()，不得另寫第二套 scope 判準（S-B-2 教訓）。
 * @param {Array[]} [preReadRows] 已讀入的 Hub 原始列（D-5，帶了就不重讀）
 */
function _buildAdminBuckets_(preReadRows) {
  const data  = preReadRows || _readHubUserStatusRows_();
  const hdr   = data[0];
  const accessCol = hdr.indexOf('systemAccess');
  const emailCol  = hdr.indexOf('schoolEmail');
  const statusCol = hdr.indexOf('status');
  const ACTIVE    = ['在職', '轉調'];

  const scoped = {};
  OWNER_DEPTS.forEach(dept => { scoped[dept] = []; });
  const all = [];

  data.slice(1).forEach(row => {
    if (!ACTIVE.includes(row[statusCol])) return;
    let access = {};
    try { access = JSON.parse(row[accessCol] || '{}'); } catch (_) {}
    if (access.training_admin !== true) return;
    const email = row[emailCol];
    if (!email) return;

    const scopeVal = _normalizeScope_(access.training_scope);
    if (_isAllScope_(scopeVal)) {
      all.push(email);
    } else {
      // Y-F6：scopeVal 含受控清單外的值（如舊「研習組」）時 scoped[dept] 不存在，
      // 該筆靜默跳過，此人不進 all[] 也不進任何 scoped[]——這是刻意結果，與
      // Stage B _inScope_() 的語意一致（後台同樣看不到清單外處室的資料），非缺陷
      scopeVal.forEach(dept => { if (scoped[dept]) scoped[dept].push(email); });
    }
  });

  return { scoped, all };
}

/**
 * 查表取得某處室的收件人（D-1／D-4）：scoped[owner] ∪ all[]。
 * owner 為空字串（查不到處室）一律視為全體管理者可見。
 * 退路觸發條件是 union 本身為空（S-D-1 訂正，不是 scoped[owner] 為空）——
 * owner 為受控清單外的舊值時，因 scoped[owner] 不存在，直接落到 union 判斷，
 * 邏輯與「該處室無 scoped 管理者」共用同一條退路，唯有 union 真的為空
 * （全校無任何 ALL-scope 管理者、該處室也無 scoped 管理者）才退回全體 ＋ 留痕（Q-I）。
 * @param {Set} [loggedFallbackOwners] 呼叫端傳入、跨迴圈共用的 owner 去重集合
 *   （S-D-2）：同一 owner 在本次執行只寫一筆 _logOp_ 留痕，避免雙層迴圈（N2 每位
 *   教師、N3 每筆紀錄）在退化狀態下對 Hub AuditLog 造成數百次寫入而拖死執行時間。
 */
function _adminEmailsForOwner_(owner, buckets, loggedFallbackOwners) {
  if (!owner) return _allAdminEmails_(buckets);
  const scoped = (OWNER_DEPTS.includes(owner) && buckets.scoped[owner]) || [];
  const union = Array.from(new Set(scoped.concat(buckets.all)));
  if (union.length) return union;
  if (!loggedFallbackOwners || !loggedFallbackOwners.has(owner)) {
    if (loggedFallbackOwners) loggedFallbackOwners.add(owner);
    _logOp_('', 'NOTIFY_FALLBACK_ALL_ADMINS', 'owner=' + owner + ' 查無對應管理者，改發全體管理者');
  }
  return _allAdminEmails_(buckets);
}

/** 全體 training_admin email（四處室 scoped 併 all，去重）——Q-I 的最終退路 */
function _allAdminEmails_(buckets) {
  let emails = buckets.all.slice();
  OWNER_DEPTS.forEach(dept => { emails = emails.concat(buckets.scoped[dept] || []); });
  return Array.from(new Set(emails));
}

/**
 * 某處室的 Reply-To 承辦人（D-2）：只從 scoped[owner] 取第一位（依 Hub 表列順序），
 * 絕不可用 scoped ∪ all 的收件人清單——否則排在前面的全權管理者會讓每個處室的
 * Reply-To 全部指向同一人。查無 scoped 管理者（含 owner='' 或清單外值）回 null，
 * 由呼叫端統一決定是否退回 getMailReplyTo_()（Y-E1）。
 */
function _replyToForOwner_(owner, buckets) {
  const scoped = (owner && OWNER_DEPTS.includes(owner) && buckets.scoped[owner]) || [];
  return scoped.length ? scoped[0] : null;
}

/**
 * 管理者彙整信的 Reply-To（D-3／Q-H：維持一人一封，單處室才動態化）：
 * 判定基準是信內所有 items 各自帶的 **owner**（不是 replyTo，S-D-3 訂正）——
 * 非空 owner 的相異值恰好 1 個時，才用該筆的 replyTo（若為 null 則退回系統信箱）；
 * 0 個（全部無法歸屬處室）或 2 個以上（橫跨多個處室）一律退回系統信箱。
 * 用 replyTo 直接去重會誤判：A 處室有承辦人、B 處室無承辦人混在同一封信時，
 * 非 null 的 replyTo 只剩 A 一個，會誤指向 A（讓 A 收到含 B 處室內容的回信），
 * 但 owner 相異值其實是 2 個，裁示要求此情況退回系統信箱。
 */
function _digestReplyTo_(items) {
  const distinctOwners = Array.from(new Set(items.map(it => it.owner).filter(Boolean)));
  if (distinctOwners.length !== 1) return getMailReplyTo_();
  const matched = items.find(it => it.owner === distinctOwners[0]);
  return (matched && matched.replyTo) || getMailReplyTo_();
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

  // 3. 每位教師的 statusMap（Y-D6：迴圈外讀一次，取代原本 catalog.forEach 內每輪重讀）
  const records = parseSheetData(_getRecordSheet());
  const statusPriority = { 'APPROVED': 3, 'PENDING': 2, 'REJECTED': 1 };
  const statusMap = {};
  records.forEach(r => {
    const key = r.userId + '_' + r.catalogId;
    if (!statusMap[key] || (statusPriority[r.status] || 0) > (statusPriority[statusMap[key]] || 0)) {
      statusMap[key] = r.status;
    }
  });

  // 4. 各課程日期解析與 daysLeft
  catalog.forEach(course => {
    const [y, m, d] = String(course.endDate).replace(/-/g, '/').split('/').map(Number);
    if (!y || !m || !d) { console.log('  ⚠️ 日期解析失敗: ' + course.endDate); return; }
    const endDate  = new Date(y, m - 1, d);
    const daysLeft = Math.ceil((endDate - today) / 86400000);
    console.log('  ' + course.title + ' → daysLeft=' + daysLeft + '（endDate=' + endDate.toDateString() + '）');

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

/**
 * 除錯用：印出每位管理者 N2 彙整信的 _digestReplyTo_() 實際計算結果，不發送任何信件。
 * task_6e2d40af Stage D UAT：驗證橫跨多處室的彙整信是否正確退回系統信箱（Q-H 裁示）。
 * 不寫死查特定帳號，逐一印出所有管理者，橫跨處室的自然會在輸出裡現形。
 */
function debugDigestReplyTo() {
  console.log('=== debugDigestReplyTo 開始 ===');
  const list = _buildNotificationList();
  const { n2AdminDigest } = _groupNotificationList(list);
  const systemReplyTo = getMailReplyTo_();
  console.log('系統預設 Reply-To（getMailReplyTo_）：' + systemReplyTo);

  Object.keys(n2AdminDigest).forEach(email => {
    const items = n2AdminDigest[email];
    const owners = Array.from(new Set(items.map(it => it.owner).filter(Boolean)));
    const replyTo = _digestReplyTo_(items);
    console.log('管理者 ' + email + '：' + items.length + ' 筆，涉及處室 owner=' +
      JSON.stringify(owners) + '，_digestReplyTo_ 結果=' + replyTo +
      (owners.length > 1 ? '　← 橫跨多處室，應等於系統預設信箱' : ''));
  });

  console.log('=== debugDigestReplyTo 結束 ===');
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
