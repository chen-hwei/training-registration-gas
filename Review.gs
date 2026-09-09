// ==================== 審核流程（管理者端，Level 2） ====================

/**
 * 取得所有 PENDING 待審清單
 * scope 未設定或含 "ALL" 回全部；否則只回三段瀑布解析落在自己 scope 內、
 * 或落在「查不到處室」退路（自訂研習全體可見）的紀錄（task_6e2d40af Stage B）
 */
function getPendingReviews(scope) {
  const list = parseSheetData(_getRecordSheet())
    .filter(r => r.status === 'PENDING')
    .map(r => ({ ...r, hours: Number(r.hours) || 0 }));
  if (_isAllScope_(scope)) return list;
  const index = _buildOwnerIndex_();
  return list.filter(r => _inScope_(_resolveRecordOwner_(r, index), scope));
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

    // Hash Map O(1) 查詢：recordId → 原始列（供 scope 檢查與後續更新共用）
    const idToRow = {};
    for (let i = 1; i < data.length; i++) {
      idToRow[String(data[i][idIdx]).trim()] = data[i];
    }

    if (!_isAllScope_(scope)) {
      const index = _buildOwnerIndex_();
      for (const r of body.records) {
        const row = idToRow[r.recordId];
        if (!row) continue; // 查無此筆，交由既有 RECORD_NOT_FOUND 流程處理
        const owner = _resolveRecordOwner_({
          requirementId: row[requirementIdIdx],
          catalogId: row[catalogIdIdx]
        }, index);
        if (!_inScope_(owner, scope)) {
          return _err('FORBIDDEN：紀錄 ' + r.recordId + ' 不屬於您的處室');
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
    if (!_inScope_(_resolveRecordOwner_(record, index), scope)) return _err('FORBIDDEN');
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
    records = records.filter(r => _inScope_(_resolveRecordOwner_(r, index), scope));
  }

  const csvHeader = schema.headers.join(',');
  const csvRows   = records.map(r =>
    schema.keys
      .map(k => '"' + String(r[k] !== undefined ? r[k] : '').replace(/"/g, '""') + '"')
      .join(',')
  );
  const csv = [csvHeader, ...csvRows].join('\n');
  return { success: true, csv, count: records.length };
}
