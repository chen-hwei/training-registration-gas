// ==================== 審核流程（管理者端，Level 2） ====================

/**
 * 取得所有 PENDING 待審清單
 * scope 未設定或含 "ALL" 回全部；否則只回三段瀑布解析落在自己 scope 內、
 * 的紀錄（task_6e2d40af Stage B）；查不到處室者（自由研習等）僅全權可見（task_c95dbe21 Stage 2a）
 */
function getPendingReviews(scope) {
  const list = parseSheetData(_getRecordSheet())
    .filter(r => r.status === 'PENDING')
    .map(r => ({ ...r, hours: Number(r.hours) || 0 }));
  if (_isAllScope_(scope)) return _attachReqSuggestions_(list);
  const index = _buildOwnerIndex_();
  return list.filter(r => _inScopeRecord_(r, index, scope));  // task_40e96378 Stage 1b：含 TASK: 授權
}

/**
 * 2c 關鍵字建議（task_c95dbe21 Stage 2b）：僅全權路徑呼叫（空值紀錄只有全權看得到）。
 * 任務表、課程表各讀一次（Y-6，禁止逐筆重讀）：建處室索引＋「學年 → ACTIVE 任務關鍵字」索引；
 * 對三段瀑布解析為空的紀錄，以研習名稱子字串比對（indexOf，同 _importedHoursFor_），
 * 命中者附 suggestedReqs: [{ requirementId, name, owner }]。研習日期解析失敗不給建議（N-2）。
 * 只建議，不改資料。
 */
function _attachReqSuggestions_(list) {
  const reqRows = parseSheetData(_getRequirementSheet());
  const index   = _buildOwnerIndex_(parseSheetData(_getCatalogSheet()), reqRows);

  const byYear = {};  // 學年 → [{ requirementId, name, owner, keywords }]
  reqRows.forEach(r => {
    if (r.status !== 'ACTIVE') return;
    let kws = [];
    try { kws = r.matchKeywords ? JSON.parse(r.matchKeywords) : []; } catch (_) { kws = []; }
    if (!Array.isArray(kws)) return;
    kws = kws.map(k => String(k || '').trim()).filter(Boolean);
    if (!kws.length) return;
    const y = Number(r.academicYear);
    (byYear[y] = byYear[y] || []).push({
      requirementId: r.requirementId, name: r.name, owner: String(r.owner || '').trim(), keywords: kws
    });
  });

  return list.map(r => {
    if (_resolveRecordOwner_(r, index)) return r;
    const p = _parseTrainingDateStrict_(r.trainingDate);
    if (!p) return r;
    const title = String(r.title || '');
    const suggestedReqs = (byYear[_academicYearOfDate_(p)] || [])
      .filter(q => q.keywords.some(k => title.indexOf(k) >= 0))
      .map(q => ({ requirementId: q.requirementId, name: q.name, owner: q.owner }));
    return suggestedReqs.length ? { ...r, suggestedReqs } : r;
  });
}

/**
 * 核准或退件（支援單筆與批次）
 * body.records: [{ recordId, status: 'APPROVED'|'REJECTED', reviewNote }]
 * 退件原因（reviewNote）至少需填寫 10 個字
 * scope 限制下，批次中任一筆解析出的處室超出呼叫者 scope 即整批拒絕，不寫入任何一筆
 * （B-3：避免「過濾掉違規筆、其餘照做」造成 { reviewed: n } 的靜默部分失敗）
 */
function reviewRecord(reviewerId, body, scope) {
  if (!Array.isArray(body.records) || body.records.length === 0) return _err('MISSING_RECORDS');

  for (const r of body.records) {
    if (!['APPROVED', 'REJECTED'].includes(r.status)) return _err('狀態值無效，只接受 APPROVED 或 REJECTED。');
    if (r.status === 'REJECTED' && !r.reviewNote) return _err('退件原因不可為空。');
  }

  const schema           = SHEET_SCHEMA.TRAINING_RECORD;
  const idIdx            = schema.keys.indexOf('recordId');
  const statusIdx        = schema.keys.indexOf('status');
  const reviewerIdx      = schema.keys.indexOf('reviewedBy');
  const noteIdx          = schema.keys.indexOf('reviewNote');
  const atIdx            = schema.keys.indexOf('reviewedAt');
  const catalogIdIdx     = schema.keys.indexOf('catalogId');
  const requirementIdIdx = schema.keys.indexOf('requirementId');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = _getRecordSheet();
    const data  = sheet.getDataRange().getValues();

    if (!_isAllScope_(scope)) {
      // Hash Map O(1) 查詢：recordId → 原始列（Y-C5：僅 scope 受限時才需要，
      // 全權管理者不做逐筆處室檢查，不必多花一輪整表掃描與物件配置）
      const idToRow = {};
      for (let i = 1; i < data.length; i++) {
        idToRow[String(data[i][idIdx]).trim()] = data[i];
      }
      const index = _buildOwnerIndex_();
      for (const r of body.records) {
        const row = idToRow[r.recordId];
        if (!row) continue; // 查無此筆，交由既有 RECORD_NOT_FOUND 流程處理
        const item = { requirementId: row[requirementIdIdx], catalogId: row[catalogIdIdx] };
        if (!_inScopeRecord_(item, index, scope)) {  // task_40e96378 Stage 1b：處室 ∪ TASK:
          return _err('FORBIDDEN：紀錄 ' + r.recordId + ' 不屬於您的管理範圍');
        }
      }
    }

    // Hash Map O(1) 查詢：recordId → 更新指令
    const updateMap = {};
    body.records.forEach(r => { updateMap[r.recordId] = r; });

    const now = _now();
    let updatedCount = 0;
    // 直接更新命中列的 4 個欄位（status/reviewedBy/reviewNote/reviewedAt 為連續欄）
    // 避免 clearContents + 全表 setValues 因混有 Date 物件導致隱性失敗
    for (let i = 1; i < data.length; i++) {
      const update = updateMap[String(data[i][idIdx]).trim()];
      if (!update) continue;
      sheet.getRange(i + 1, statusIdx + 1, 1, 4).setValues([[
        update.status,
        reviewerId,
        update.reviewNote || '',
        now
      ]]);
      updatedCount++;
    }

    if (updatedCount === 0) return _err('RECORD_NOT_FOUND');
    SpreadsheetApp.flush();

    body.records.forEach(r => {
      SchoolPortalLib.logAction(reviewerId, 'REVIEW_' + r.status, r.recordId);
    });
    return { success: true, reviewed: updatedCount };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 改歸屬任務（task_c95dbe21 Stage 2b，2d；路由列 ALL-only）
 * body: { recordId, requirementId }
 * - 任何 PENDING 紀錄皆可改（Q-b），目標任務須存在、ACTIVE，且學年與研習日期相符
 * - 研習日期以 _parseTrainingDateStrict_() 判定，無法解析即拒絕（R-3，禁用 toAcademicYear_）
 * - 取 ScriptLock（與 reviewRecord 同一把）後於鎖內重讀該列再驗，鎖外狀態不作判斷依據（R-3）
 * - 只寫 requirementId 單一儲存格（Y-7）；catalogId 不動，處室改依新任務（三段瀑布第 1 段優先）
 * - ⚠️ 核准後時數計入新任務達成率；calcRequirementStats 的 approvedMap 不套計算區間，
 *   本函式的學年檢查是防止跨學年誤計的唯一防線，不可移除
 */
function reassignRecordRequirement(adminId, body) {
  const recordId = String((body || {}).recordId || '').trim();
  const newReqId = String((body || {}).requirementId || '').trim();
  if (!recordId) return _err('MISSING_RECORD_ID');
  if (!newReqId) return _err('MISSING_REQUIREMENT_ID');

  const schema    = SHEET_SCHEMA.TRAINING_RECORD;
  const idIdx     = schema.keys.indexOf('recordId');
  const statusIdx = schema.keys.indexOf('status');
  const dateIdx   = schema.keys.indexOf('trainingDate');
  const reqIdx    = schema.keys.indexOf('requirementId');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err('系統正忙，請稍後再試。'); }
  try {
    const sheet = _getRecordSheet();
    const data  = sheet.getDataRange().getValues();
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idIdx]).trim() === recordId) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return _err('RECORD_NOT_FOUND');
    if (data[rowIdx][statusIdx] !== 'PENDING') return _err('NOT_PENDING');

    const oldReqId = String(data[rowIdx][reqIdx] || '').trim();
    if (oldReqId === newReqId) return _err('SAME_REQUIREMENT');

    const p = _parseTrainingDateStrict_(data[rowIdx][dateIdx]);
    if (!p) return _err('INVALID_TRAINING_DATE');

    const target = parseSheetData(_getRequirementSheet()).find(r => r.requirementId === newReqId);
    if (!target) return _err('REQUIREMENT_NOT_FOUND');
    if (target.status !== 'ACTIVE') return _err('REQUIREMENT_NOT_ACTIVE');
    if (Number(target.academicYear) !== _academicYearOfDate_(p)) return _err('ACADEMIC_YEAR_MISMATCH');

    sheet.getRange(rowIdx + 1, reqIdx + 1).setValue(newReqId);
    SpreadsheetApp.flush();

    _logOp_(adminId, 'REASSIGN_RECORD', recordId + ' ' + (oldReqId || '自由研習') + '→' + newReqId);
    return { success: true, recordId, requirementId: newReqId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 取得研習證明檔案的 Drive 連結（供管理者在瀏覽器開啟審核）
 * body.recordId：以紀錄反查處室後套用 scope（B-2，取代原本只收 fileId 與紀錄表零關聯的設計）
 * body.fileId（僅此無 recordId）：舊版前端格式，回 STALE_CLIENT 促使重新整理（C-5）
 */
function getFileUrl(body, scope) {
  if (!body.recordId) {
    return body.fileId ? _err('STALE_CLIENT') : _err('MISSING_RECORD_ID');
  }

  const record = parseSheetData(_getRecordSheet()).find(r => r.recordId === body.recordId);
  if (!record) return _err('RECORD_NOT_FOUND');

  if (!_isAllScope_(scope)) {
    const index = _buildOwnerIndex_();
    if (!_inScopeRecord_(record, index, scope)) return _err('FORBIDDEN');
  }

  if (!record.fileId) return _err('FILE_NOT_FOUND');
  try {
    const file = DriveApp.getFileById(record.fileId);
    return { success: true, url: file.getUrl(), name: file.getName() };
  } catch (_) {
    return _err('FILE_NOT_FOUND');
  }
}

/**
 * 匯出研習紀錄為 CSV 字串（管理者，Level 2）
 * body 可含篩選條件：status, userId, year（研習日期年份）
 * scope 限制下，只匯出解析落在自己 scope 內（含無法歸屬）的紀錄（Y-4）
 */
function exportRecords(body, scope) {
  const sheet  = _getRecordSheet();
  const schema = SHEET_SCHEMA.TRAINING_RECORD;
  let records  = parseSheetData(sheet);

  if (body.status) records = records.filter(r => r.status === body.status);
  if (body.userId) records = records.filter(r => r.userId === body.userId);
  if (body.year)   records = records.filter(r => String(r.trainingDate).startsWith(String(body.year)));

  if (!_isAllScope_(scope)) {
    const index = _buildOwnerIndex_();
    records = records.filter(r => _inScopeRecord_(r, index, scope));
  }

  const csvHeader = schema.headers.join(',');
  const csvRows   = records.map(r =>
    schema.keys
      .map(k => '"' + String(r[k] !== undefined ? r[k] : '').replace(/"/g, '""') + '"')
      .join(',')
  );
  const csv = [csvHeader, ...csvRows].join('\n');
  return { csv, count: records.length };
}
