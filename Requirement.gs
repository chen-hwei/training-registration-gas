// ==================== 年度研習任務（Requirement） ====================

// ── Level 1：教師端 ──

/**
 * 取得當前學年度所有 ACTIVE 任務，並附帶登入教師的完成進度
 * 回傳格式：[{ ...requirement, requiredHours, approvedHours, pendingHours, isCompleted }, ...]
 */
function getRequirements(userId) {
  const academicYear = _currentAcademicYear();
  const requirements = parseSheetData(_getRequirementSheet())
    .filter(r => r.status === 'ACTIVE' && Number(r.academicYear) === academicYear);

  if (requirements.length === 0) return [];

  // 讀取此教師所有紀錄，建立任務進度 Map
  const records = parseSheetData(_getRecordSheet())
    .filter(r => r.userId === userId && r.requirementId);

  const approvedMap = {};
  const pendingMap  = {};
  records.forEach(r => {
    const rid = r.requirementId;
    const h   = Number(r.hours) || 0;
    if (r.status === 'APPROVED') approvedMap[rid] = (approvedMap[rid] || 0) + h;
    if (r.status === 'PENDING')  pendingMap[rid]  = (pendingMap[rid]  || 0) + h;
  });

  // 若有分眾任務（audienceRules），從 Hub.UserStatusCache 取得使用者身分
  let userIdentityGroup = null;
  const hasAudienceRules = requirements.some(r => r.audienceRules && String(r.audienceRules).trim() !== '');
  if (hasAudienceRules) {
    try {
      const hub      = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
      const uscSheet = hub.getSheetByName('UserStatusCache');
      if (uscSheet) {
        const uscData = uscSheet.getDataRange().getValues();
        const hdr     = uscData[0];
        const idCol   = hdr.indexOf('userId');
        const jpCol   = hdr.indexOf('jobPrimary');
        const ttCol   = hdr.indexOf('title');
        const jtCol   = hdr.indexOf('jobTask');
        const userRow = uscData.slice(1).find(r => String(r[idCol] || '').trim() === userId);
        if (userRow) {
          const identityRules = _loadIdentityRules_();
          userIdentityGroup   = _classifyIdentity_({
            jobPrimary: jpCol >= 0 ? String(userRow[jpCol] || '').trim() : '',
            title:      ttCol >= 0 ? String(userRow[ttCol] || '').trim() : '',
            jobTask:    jtCol >= 0 ? String(userRow[jtCol] || '').trim() : ''
          }, identityRules);
        }
      }
    } catch (e) {
      Logger.log('getRequirements: identity lookup failed: ' + e.message);
    }
  }

  return requirements.map(req => {
    let required = Number(req.requiredHours) || 0;

    // audienceRules 分眾：依使用者身分覆寫 requiredHours
    if (required === 0 && req.audienceRules && String(req.audienceRules).trim() !== '') {
      try {
        const rules = JSON.parse(req.audienceRules);
        if (userIdentityGroup) {
          const match = rules.find(ar => ar.group === userIdentityGroup);
          if (match) required = Number(match.hours) || 0;
        }
      } catch (e) {}
    }

    const approved = approvedMap[req.requirementId] || 0;
    return {
      ...req,
      requiredHours: required,
      approvedHours: approved,
      pendingHours:  pendingMap[req.requirementId] || 0,
      isCompleted:   required > 0 && approved >= required
    };
  });
}

// ── Level 2：管理者端 ──

/**
 * 取得所有任務（不限學年度，供管理者全覽）
 * 可傳入 body.academicYear 篩選特定學年度
 */
function getAllRequirements(body) {
  const all = parseSheetData(_getRequirementSheet()).map(r => ({
    ...r,
    requiredHours: Number(r.requiredHours) || 0
  }));
  if (body && body.academicYear) {
    return all.filter(r => Number(r.academicYear) === Number(body.academicYear));
  }
  return all;
}

/**
 * 新增年度研習任務
 * body 必填：name, endDate
 * body 選填：startDate, requiredHours, hoursNote, deliveryType, semesterSplit,
 *            notes, links, isRecurring, academicYear
 * owner 自動從管理者的 department 取得，不信任前端傳入
 */
function addRequirement(adminId, body) {
  if (!body.name)    return _err('MISSING_NAME');
  if (!body.endDate) return _err('MISSING_END_DATE');

  // 主責單位自動帶入管理者所屬處室
  const adminUser = SchoolPortalLib.getUser(adminId);
  const owner = (adminUser && adminUser.department) ? adminUser.department : String(body.owner || '');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err('系統正忙，請稍後再試。'); }

  try {
    const sheet       = _getRequirementSheet();
    const allRows     = sheet.getDataRange().getValues();
    const schema      = SHEET_SCHEMA.TRAINING_REQUIREMENT;
    const academicYear = body.academicYear ? Number(body.academicYear) : _currentAcademicYear();
    const requirementId = _generateRequirementId(allRows, academicYear);

    const newReq = {
      requirementId,
      name:          String(body.name),
      owner,
      academicYear,
      startDate:     String(body.startDate    || ''),
      endDate:       String(body.endDate),
      requiredHours: Number(body.requiredHours) || 0,
      hoursNote:     String(body.hoursNote    || ''),
      deliveryType:  String(body.deliveryType || 'ONLINE'),
      semesterSplit: body.semesterSplit === true || body.semesterSplit === 'TRUE',
      notes:         String(body.notes        || ''),
      links:         String(body.links        || ''),
      isRecurring:   body.isRecurring !== false,  // 預設 true
      status:        'ACTIVE',
      createdAt:     _now()
    };

    allRows.push(schema.keys.map(k => newReq[k] !== undefined ? newReq[k] : ''));
    sheet.clearContents();
    sheet.getRange(1, 1, allRows.length, allRows[0].length).setValues(allRows);

    SchoolPortalLib.logAction(adminId, 'ADD_REQUIREMENT', requirementId);
    return { success: true, requirementId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 編輯年度研習任務（owner 不可透過前端修改）
 * body 必填：requirementId
 * body 選填：name, startDate, endDate, requiredHours, hoursNote, deliveryType,
 *            semesterSplit, notes, links, isRecurring
 */
function editRequirement(adminId, body) {
  if (!body.requirementId) return _err('MISSING_REQUIREMENT_ID');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err('系統正忙，請稍後再試。'); }

  try {
    const sheet   = _getRequirementSheet();
    const data    = sheet.getDataRange().getValues();
    const schema  = SHEET_SCHEMA.TRAINING_REQUIREMENT;
    const idIdx   = schema.keys.indexOf('requirementId');

    const rowIdx = data.findIndex((row, i) => i > 0 && row[idIdx] === body.requirementId);
    if (rowIdx === -1) return _err('REQUIREMENT_NOT_FOUND');

    const EDITABLE = ['name', 'startDate', 'endDate', 'requiredHours', 'hoursNote',
                      'deliveryType', 'semesterSplit', 'notes', 'links', 'isRecurring',
                      'audienceRules', 'matchKeywords'];
    EDITABLE.forEach(key => {
      if (body[key] === undefined) return;
      const colIdx = schema.keys.indexOf(key);
      if (colIdx === -1) return;
      if (key === 'requiredHours') {
        data[rowIdx][colIdx] = Number(body[key]) || 0;
      } else if (key === 'semesterSplit' || key === 'isRecurring') {
        data[rowIdx][colIdx] = body[key] === true || body[key] === 'TRUE';
      } else {
        data[rowIdx][colIdx] = String(body[key]);
      }
    });

    sheet.clearContents();
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    SpreadsheetApp.flush();

    SchoolPortalLib.logAction(adminId, 'EDIT_REQUIREMENT', body.requirementId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 封存年度研習任務（status → ARCHIVED）
 * body 必填：requirementId
 */
function archiveRequirement(adminId, body) {
  if (!body.requirementId) return _err('MISSING_REQUIREMENT_ID');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err('系統正忙，請稍後再試。'); }

  try {
    const sheet   = _getRequirementSheet();
    const data    = sheet.getDataRange().getValues();
    const schema  = SHEET_SCHEMA.TRAINING_REQUIREMENT;
    const idIdx    = schema.keys.indexOf('requirementId');
    const statusIdx = schema.keys.indexOf('status');

    const rowIdx = data.findIndex((row, i) => i > 0 && row[idIdx] === body.requirementId);
    if (rowIdx === -1) return _err('REQUIREMENT_NOT_FOUND');

    data[rowIdx][statusIdx] = 'ARCHIVED';
    sheet.clearContents();
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    SpreadsheetApp.flush();

    SchoolPortalLib.logAction(adminId, 'ARCHIVE_REQUIREMENT', body.requirementId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 一鍵複製下一學年任務（從 isRecurring=TRUE 的任務複製，日期順延一年）
 * body 必填：sourceYear（來源學年度，如 114）
 * body 選填：targetYear（目標學年度，預設 sourceYear + 1）
 */
function renewRequirements(adminId, body) {
  const sourceYear = Number(body.sourceYear);
  if (!sourceYear) return _err('MISSING_SOURCE_YEAR');
  const targetYear = body.targetYear ? Number(body.targetYear) : sourceYear + 1;
  if (targetYear <= sourceYear) return _err('TARGET_YEAR_MUST_BE_GREATER');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err('系統正忙，請稍後再試。'); }

  try {
    const sheet   = _getRequirementSheet();
    const allRows = sheet.getDataRange().getValues();
    const schema  = SHEET_SCHEMA.TRAINING_REQUIREMENT;

    // 確認目標學年度是否已有任務，避免重複建立
    const existTarget = allRows.slice(1).some(
      row => Number(row[schema.keys.indexOf('academicYear')]) === targetYear
    );
    if (existTarget) return _err(`${targetYear} 學年度已有任務紀錄，請先封存再重新建立。`);

    const sourceBoolTrue = v => v === true || String(v).toUpperCase() === 'TRUE';
    const sourceReqs = parseSheetData(sheet).filter(
      r => Number(r.academicYear) === sourceYear &&
           sourceBoolTrue(r.isRecurring) &&
           r.status === 'ACTIVE'
    );
    if (sourceReqs.length === 0) return _err('沒有找到可複製的循環任務（isRecurring=TRUE）。');

    // 找出目標學年度現有最大序號，確保 ID 不重複
    const idColIdx = schema.keys.indexOf('requirementId');
    const prefix   = 'RQ' + String(targetYear);
    let maxSeq = 0;
    allRows.slice(1).forEach(row => {
      const id = String(row[idColIdx] || '');
      if (id.startsWith(prefix)) {
        const seq = parseInt(id.slice(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    });

    const yearDiff = targetYear - sourceYear;
    const newIds   = [];

    sourceReqs.forEach(req => {
      maxSeq++;
      const requirementId = prefix + String(maxSeq).padStart(3, '0');

      // 日期格式統一後順延 yearDiff 年
      const shiftDate = (dateStr) => {
        if (!dateStr) return '';
        const parts = String(dateStr).replace(/-/g, '/').split('/').map(Number);
        if (parts.length < 3 || isNaN(parts[0])) return dateStr;
        return `${parts[0] + yearDiff}/${parts[1]}/${parts[2]}`;
      };

      const newReq = {
        requirementId,
        name:          req.name,
        owner:         req.owner,
        academicYear:  targetYear,
        startDate:     shiftDate(req.startDate),
        endDate:       shiftDate(req.endDate),
        requiredHours: Number(req.requiredHours) || 0,
        hoursNote:     req.hoursNote || '',
        deliveryType:  req.deliveryType || 'ONLINE',
        semesterSplit: sourceBoolTrue(req.semesterSplit),
        notes:         req.notes  || '',
        links:         req.links  || '',
        isRecurring:   true,
        status:        'ACTIVE',
        createdAt:     _now()
      };

      allRows.push(schema.keys.map(k => newReq[k] !== undefined ? newReq[k] : ''));
      newIds.push(requirementId);
    });

    sheet.clearContents();
    sheet.getRange(1, 1, allRows.length, allRows[0].length).setValues(allRows);

    SchoolPortalLib.logAction(adminId, 'RENEW_REQUIREMENTS', 'to_year_' + targetYear);
    return { success: true, created: newIds.length, targetYear, ids: newIds };
  } finally {
    lock.releaseLock();
  }
}

// ==================== 114 學年度任務初始資料（一次性 Seed，執行後可刪除） ====================

/**
 * 一次性寫入 114 學年度全部 13 筆年度研習任務
 * 在 GAS 編輯器直接執行此函式即可；執行前請確認 TRAINING_REQUIREMENT 工作表已建立。
 * 執行後請確認試算表資料正確，確認無誤後可將此函式刪除。
 */
function seed114Requirements() {
  const sheet   = _getRequirementSheet();
  const schema  = SHEET_SCHEMA.TRAINING_REQUIREMENT;

  // 確認工作表是否已有資料（防止重複執行）
  const existing = parseSheetData(sheet).filter(r => Number(r.academicYear) === 114);
  if (existing.length > 0) {
    Logger.log('⚠️ 114 學年度任務已存在（' + existing.length + ' 筆），跳過 seed。如需重新匯入請先清空工作表。');
    return;
  }

  // 日期格式：西元年/月/日（民國114 = 2025, 民國115 = 2026）
  const data = [
    {
      requirementId: 'RQ114001',
      name: '資通安全教育訓練',
      owner: '圖書館',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/12/31',
      requiredHours: 3,
      hoursNote: '',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '技服組推薦 e 等公務園學習平臺、教育部磨課師線上課程。完成後上傳研習證明截圖或 PDF，時間需在 2025/8/1 之後。',
      links: 'https://elearn.hrd.gov.tw/',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114002',
      name: '特教研習',
      owner: '輔導室',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '',
      requiredHours: 0,
      hoursNote: '相關行政人員3h｜教保員及助理員3h｜普通班教師6h｜特教教師18h｜相關專業人員6h',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '請依特教組 10/1 電子信件說明確認個人應完成時數。研習平台：臺北市酷課雲-酷課OnO線上教室。',
      links: 'https://ono.tp.edu.tw/course/join/C4Y0FIZAA8W9',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114003',
      name: '家庭教育研習',
      owner: '輔導室',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/11/30',
      requiredHours: 4,
      hoursNote: '',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '依據家庭教育法，每年全校教職員工應有 4 小時家庭教育研習時數。完成後請填寫回覆表單。',
      links: 'https://moocs.moe.edu.tw/moocs/#/course/detail/10002417',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114004',
      name: '性別平等研習（性別主流化）',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/12/31',
      requiredHours: 3,
      hoursNote: '可含性騷擾防治 1 小時',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '每年至少須完成性別平等教育研習 4 小時（性別主流化 3h + 多元性別 1h）。完成後請填寫回覆表單。',
      links: 'https://ap2.elearning.taipei/elearn/courseinfo/index.php?courseid=4961',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114005',
      name: '性別平等研習（多元性別）',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/12/31',
      requiredHours: 1,
      hoursNote: '',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '與「性別主流化」合計 4 小時，共同完成性別平等研習義務。',
      links: 'https://ap2.elearning.taipei/elearn/courseinfo/index.php?courseid=3373',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114006',
      name: '交通安全研習（上學期）',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/12/31',
      requiredHours: 2,
      hoursNote: '',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '114/12/17 有交通評鑑，需本校教職員工 80% 完成率。完成後請填寫回覆表單。',
      links: 'https://ap1.elearning.taipei/elearn/courseinfo/index.php?courseid=2280',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114007',
      name: '急救教育研習',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/11/30',
      requiredHours: 4,
      hoursNote: '',
      deliveryType: 'INPERSON',
      semesterSplit: false,
      notes: '每學年至少辦理一次 4 小時實體課程，於新學年教師共備日執行。',
      links: '',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114008',
      name: '愛滋病防治教育研習（上學期）',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/11/30',
      requiredHours: 2,
      hoursNote: '上學期 8–11 月完成',
      deliveryType: 'ONLINE',
      semesterSplit: true,
      notes: '每學期需上 2 小時愛滋相關研習，全年合計 4 小時。臺北e大搜尋「愛滋」。',
      links: 'https://elearning.taipei/mpage/',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114009',
      name: '愛滋病防治教育研習（下學期）',
      owner: '學務處',
      academicYear: 114,
      startDate: '2026/2/1',
      endDate: '2026/5/31',
      requiredHours: 2,
      hoursNote: '下學期 2–5 月完成',
      deliveryType: 'ONLINE',
      semesterSplit: true,
      notes: '每學期需上 2 小時愛滋相關研習，全年合計 4 小時。臺北e大搜尋「愛滋」。',
      links: 'https://elearning.taipei/mpage/',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114010',
      name: '失智相關教育研習',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/11/30',
      requiredHours: 1,
      hoursNote: '',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '每年度至少 1 小時失智相關議題研習。臺北e大搜尋「失智」。',
      links: 'https://elearning.taipei/mpage/',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114011',
      name: '環境教育研習',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/12/20',
      requiredHours: 4,
      hoursNote: '4 小時中必須包含 2 小時「氣候變遷調適及溫室氣體減量」課程',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '完成 2 小時後請填報表單。推薦課程：臺北市淨零課程_淨零綠生活。',
      links: 'https://ap1.elearning.taipei/elearn/course/view.php?id=5038',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114012',
      name: '兒童權利公約 CRC 研習',
      owner: '學務處',
      academicYear: 114,
      startDate: '2025/8/1',
      endDate: '2025/12/31',
      requiredHours: 1,
      hoursNote: '',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '依據「臺北市推動兒童權利公約認知提升與教育訓練實施計畫」。臺北e大搜尋「兒童權利公約」。',
      links: 'https://ap2.elearning.taipei/elearn/courseinfo/index.php?courseid=2795',
      isRecurring: true,
      status: 'ACTIVE'
    },
    {
      requirementId: 'RQ114013',
      name: '交通安全研習（下學期）',
      owner: '學務處',
      academicYear: 114,
      startDate: '2026/2/1',
      endDate: '2026/4/17',
      requiredHours: 2,
      hoursNote: '',
      deliveryType: 'ONLINE',
      semesterSplit: false,
      notes: '115/5/21 有交通評鑑，需本校教職員工 80% 完成率。完成後請填寫回覆表單。',
      links: 'https://moocs.moe.edu.tw/moocs/#/course/detail/10002662',
      isRecurring: true,
      status: 'ACTIVE'
    }
  ];

  // 取得現有標題列（第一列），其餘資料列不存在故 allRows 僅有標題
  const allRows = sheet.getDataRange().getValues();

  data.forEach(req => {
    req.createdAt = _now();
    allRows.push(schema.keys.map(k => req[k] !== undefined ? req[k] : ''));
  });

  sheet.clearContents();
  sheet.getRange(1, 1, allRows.length, allRows[0].length).setValues(allRows);

  Logger.log('✅ seed114Requirements 完成，已寫入 ' + data.length + ' 筆 114 學年度研習任務。');
}

/**
 * 一次性更新 RQ114001（資通安全）與 RQ114002（特教研習）的分眾時數規則
 * 在 GAS 編輯器直接執行此函式即可；執行後可刪除或保留備查。
 *
 * audienceRules 格式（JSON 字串）：
 *   空字串  = 全員套用 requiredHours，不分眾
 *   JSON 陣列 = [{ "group": "身分類別", "hours": 數字 }, ...]
 *   若某人的身分不在清單內，該任務不計入其達標檢查。
 */
function updateAudienceRules114() {
  const sheet  = _getRequirementSheet();
  const schema = SHEET_SCHEMA.TRAINING_REQUIREMENT;
  const data   = sheet.getDataRange().getValues();
  const headers = data[0];

  // 標題列為中文，用 Schema keys 陣列的位置索引定位欄號（0-based）
  const keys   = SHEET_SCHEMA.TRAINING_REQUIREMENT.keys;
  const idCol  = keys.indexOf('requirementId');
  const audCol = keys.indexOf('audienceRules');

  if (audCol === -1) {
    throw new Error('Schema.gs 的 TRAINING_REQUIREMENT.keys 中找不到 audienceRules，請確認 Schema.gs 已更新。');
  }

  // 特教研習分眾規則
  const specialEdRules = JSON.stringify([
    { group: '特教教師',      hours: 18 },
    { group: '普通班教師',    hours: 6  },
    { group: '相關行政人員',  hours: 3  },
    { group: '教保員及助理員',hours: 3  },
    { group: '相關專業人員',  hours: 6  }
  ]);

  let updated = 0;
  for (let i = 1; i < data.length; i++) {
    const rid = String(data[i][idCol] || '');
    if (rid === 'RQ114001') {
      // 資通安全：全員 3h，audienceRules 留空（沿用 requiredHours），但確認 targetAudience
      data[i][audCol] = '';
      updated++;
    } else if (rid === 'RQ114002') {
      data[i][audCol] = specialEdRules;
      updated++;
    }
  }

  // 只寫入 audienceRules 欄，不用 clearContents（避免寫回失敗時資料遺失）
  for (let i = 1; i < data.length; i++) {
    const rid = String(data[i][idCol] || '');
    if (rid === 'RQ114001' || rid === 'RQ114002') {
      sheet.getRange(i + 1, audCol + 1).setValue(data[i][audCol]);
    }
  }
  Logger.log('✅ updateAudienceRules114 完成，已更新 ' + updated + ' 筆任務。');
}

/**
 * 一次性修正 114 學年度分學期任務的 endDate，改為標準學期結束日
 * 上學期 endDate → 2026/1/31；下學期 endDate → 2026/7/31
 * 執行後可刪除此函式。
 */
function fixSemesterEndDates114() {
  const sheet  = _getRequirementSheet();
  const keys   = SHEET_SCHEMA.TRAINING_REQUIREMENT.keys;
  const idCol  = keys.indexOf('requirementId');
  const edCol  = keys.indexOf('endDate');

  if (edCol === -1) throw new Error('找不到 endDate 欄，請確認 Schema.gs 已定義。');

  // { requirementId: newEndDate }
  const FIX_MAP = {
    'RQ114006': '2026/1/31',   // 交通安全（上學期）
    'RQ114008': '2026/1/31',   // 愛滋（上學期）
    'RQ114013': '2026/7/31',   // 交通安全（下學期）
    'RQ114009': '2026/7/31'    // 愛滋（下學期）
  };

  const data = sheet.getDataRange().getValues();
  let updated = 0;
  for (let i = 1; i < data.length; i++) {
    const rid = String(data[i][idCol] || '');
    if (FIX_MAP[rid]) {
      sheet.getRange(i + 1, edCol + 1).setValue(FIX_MAP[rid]);
      updated++;
      Logger.log('✅ 已更新 ' + rid + ' → endDate: ' + FIX_MAP[rid]);
    }
  }
  Logger.log('fixSemesterEndDates114 完成，共更新 ' + updated + ' 筆。');
}

/**
 * 一次性寫入 114 學年度所有任務的比對關鍵字（matchKeywords）
 * 執行前請確認已執行 initSheetHeaders()（使試算表有「比對關鍵字」欄）
 */
function seedMatchKeywords114() {
  const sheet  = _getRequirementSheet();
  const keys   = SHEET_SCHEMA.TRAINING_REQUIREMENT.keys;
  const idCol  = keys.indexOf('requirementId');
  const kwCol  = keys.indexOf('matchKeywords');

  if (kwCol === -1) throw new Error('找不到 matchKeywords 欄，請先執行 initSheetHeaders()。');

  const KEYWORD_MAP = {
    'RQ114001': ['資通安全', '資訊安全', '網路安全', '個資保護', '資安'],
    'RQ114002': ['特殊教育', '特教', '融合教育', '身心障礙', '資源班', '巡迴輔導'],
    'RQ114003': ['家庭教育', '親職教育', '家庭暴力'],
    'RQ114004': ['性別平等', '性別主流', '性騷擾防治', '性別意識'],
    'RQ114005': ['多元性別', '性別認同', 'LGBTQ', '同志'],
    'RQ114006': ['交通安全', '道路安全', '行車安全'],
    'RQ114007': ['急救', 'CPR', '心肺復甦', 'AED', '緊急救護'],
    'RQ114008': ['愛滋', 'HIV', '愛滋病防治', '性病防治'],
    'RQ114009': ['愛滋', 'HIV', '愛滋病防治', '性病防治'],
    'RQ114010': ['失智', '阿茲海默', '認知障礙', '失智症'],
    'RQ114011': ['環境教育', '氣候變遷', '溫室氣體', '淨零', '永續', '環境素養'],
    'RQ114012': ['兒童權利', 'CRC', '兒童人權', '兒童權利公約'],
    'RQ114013': ['交通安全', '道路安全', '行車安全']
  };

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) throw new Error('TRAINING_REQUIREMENT 工作表無資料列，請先確認年度任務已建立。');

  let updated = 0;
  // 只寫入 matchKeywords 那一欄，不碰整張表（避免 clearContents 後 setValues 失敗導致資料遺失）
  for (let i = 1; i < data.length; i++) {
    const rid = String(data[i][idCol] || '');
    if (KEYWORD_MAP[rid]) {
      // 直接寫入單一儲存格，安全且不影響其他欄位
      sheet.getRange(i + 1, kwCol + 1).setValue(JSON.stringify(KEYWORD_MAP[rid]));
      updated++;
    }
  }
  Logger.log('✅ seedMatchKeywords114 完成，已更新 ' + updated + ' 筆任務關鍵字。');
}
