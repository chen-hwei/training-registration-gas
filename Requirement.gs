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

  return requirements.map(req => {
    const required = Number(req.requiredHours) || 0;
    const approved = approvedMap[req.requirementId] || 0;
    return {
      ...req,
      requiredHours: required,
      approvedHours: approved,
      pendingHours:  pendingMap[req.requirementId] || 0,
      // requiredHours === 0 代表「請依公文確認時數」，不計算完成狀態
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
                      'deliveryType', 'semesterSplit', 'notes', 'links', 'isRecurring'];
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
