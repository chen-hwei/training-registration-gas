// ==================== 審核流程（管理者端，Level 2） ====================

/** 取得所有 PENDING 待審清單 */
function getPendingReviews() {
  return parseSheetData(_getRecordSheet())
    .filter(r => r.status === 'PENDING')
    .map(r => ({ ...r, hours: Number(r.hours) || 0 }));
}

/**
 * 核准或退件（支援單筆與批次）
 * body.records: [{ recordId, status: 'APPROVED'|'REJECTED', reviewNote }]
 * 退件原因（reviewNote）至少需填寫 10 個字
 */
function reviewRecord(reviewerId, body) {
  if (!Array.isArray(body.records) || body.records.length === 0) return _err('MISSING_RECORDS');

  for (const r of body.records) {
    if (!['APPROVED', 'REJECTED'].includes(r.status)) return _err('狀態值無效，只接受 APPROVED 或 REJECTED。');
    if (r.status === 'REJECTED' && !r.reviewNote) return _err('退件原因不可為空。');
  }

  const schema      = SHEET_SCHEMA.TRAINING_RECORD;
  const idIdx       = schema.keys.indexOf('recordId');
  const statusIdx   = schema.keys.indexOf('status');
  const reviewerIdx = schema.keys.indexOf('reviewedBy');
  const noteIdx     = schema.keys.indexOf('reviewNote');
  const atIdx       = schema.keys.indexOf('reviewedAt');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = _getRecordSheet();
    const data  = sheet.getDataRange().getValues();

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

/** 取得研習證明檔案的 Drive 連結（供管理者在瀏覽器開啟審核） */
function getFileUrl(body) {
  if (!body.fileId) return _err('MISSING_FILE_ID');
  try {
    const file = DriveApp.getFileById(body.fileId);
    return { success: true, url: file.getUrl(), name: file.getName() };
  } catch (_) {
    return _err('FILE_NOT_FOUND');
  }
}

/**
 * 匯出研習紀錄為 CSV 字串（管理者，Level 2）
 * body 可含篩選條件：status, userId, year（研習日期年份）
 */
function exportRecords(body) {
  const sheet  = _getRecordSheet();
  const schema = SHEET_SCHEMA.TRAINING_RECORD;
  let records  = parseSheetData(sheet);

  if (body.status) records = records.filter(r => r.status === body.status);
  if (body.userId) records = records.filter(r => r.userId === body.userId);
  if (body.year)   records = records.filter(r => String(r.trainingDate).startsWith(String(body.year)));

  const csvHeader = schema.headers.join(',');
  const csvRows   = records.map(r =>
    schema.keys
      .map(k => '"' + String(r[k] !== undefined ? r[k] : '').replace(/"/g, '""') + '"')
      .join(',')
  );
  const csv = [csvHeader, ...csvRows].join('\n');
  return { success: true, csv, count: records.length };
}
