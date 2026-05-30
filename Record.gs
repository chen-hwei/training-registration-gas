// ==================== 研習登錄紀錄（教師端，Level 1） ====================

/** 取得教師自己的所有登錄紀錄 */
function getMyRecords(userId) {
  return parseSheetData(_getRecordSheet())
    .filter(r => r.userId === userId)
    .map(r => ({
      ...r,
      hours:      Number(r.hours) || 0,
      isCustom:   r.isCustom === true || String(r.isCustom).toUpperCase() === 'TRUE'
    }));
}

/**
 * 送出研習登錄（含研習證明上傳）
 *
 * body 必填：title, hours, trainingDate, organizer, isCustom
 * 上傳模式（擇一）：
 *   A. 新上傳：{ base64, mimeType, fileName }
 *   B. 沿用舊檔案：{ reuseFileId, fileName }（退件後重送，不重複佔用 Drive 空間）
 * 選填：catalogId（自訂課程時省略）
 */
function submitRecord(userId, body) {
  if (!body.title)        return _err('MISSING_TITLE');
  if (!body.trainingDate) return _err('MISSING_TRAINING_DATE');
  if (!body.reuseFileId && (!body.base64 || !body.mimeType || !body.fileName)) {
    return _err('MISSING_FILE_DATA');
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (_) {
    return _err('系統正忙，請稍後再試（約 10 秒後重新送出）。');
  }

  try {
    const sheet   = _getRecordSheet();
    const allRows = sheet.getDataRange().getValues();
    const schema  = SHEET_SCHEMA.TRAINING_RECORD;

    let fileId, fileName;

    if (body.reuseFileId) {
      // 驗證舊 fileId 確實屬於此教師，防止偽造他人檔案 ID
      const prevRow = _findRecordByFileId(allRows, body.reuseFileId, userId);
      if (!prevRow) return _err('找不到原始檔案，請重新上傳。');
      fileId   = body.reuseFileId;
      fileName = body.fileName || prevRow[schema.keys.indexOf('fileName')];
    } else {
      fileId   = _saveFileToDrive(userId, body.base64, body.mimeType, body.fileName, body.trainingDate, body.title);
      fileName = body.fileName;
    }

    const recordId = _generateRecordId(allRows);
    const newRecord = {
      recordId,
      userId,
      catalogId:    String(body.catalogId    || ''),
      title:        String(body.title),
      hours:        Number(body.hours)        || 0,
      isCustom:     body.isCustom === true || body.isCustom === 'TRUE',
      trainingDate: String(body.trainingDate),
      organizer:    String(body.organizer     || ''),
      fileId,
      fileName,
      status:       'PENDING',
      reviewedBy:   '',
      reviewNote:   '',
      reviewedAt:   '',
      submittedAt:  _now(),
      resubmitOf:   String(body.resubmitOf || '')
    };

    const newRow = schema.keys.map(k => newRecord[k] !== undefined ? newRecord[k] : '');
    allRows.push(newRow);
    sheet.clearContents();
    sheet.getRange(1, 1, allRows.length, allRows[0].length).setValues(allRows);

    SchoolPortalLib.logAction(userId, 'SUBMIT_RECORD', recordId);
    return { success: true, recordId };
  } finally {
    lock.releaseLock();
  }
}

/** 刪除自己的 PENDING 紀錄（僅允許刪除尚未進入審核的紀錄） */
function deleteRecord(userId, body) {
  if (!body.recordId) return _err('MISSING_RECORD_ID');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet   = _getRecordSheet();
    const schema  = SHEET_SCHEMA.TRAINING_RECORD;
    const data    = sheet.getDataRange().getValues();
    const header  = data[0];
    const rows    = data.slice(1);
    const idIdx     = schema.keys.indexOf('recordId');
    const userIdx   = schema.keys.indexOf('userId');
    const statusIdx = schema.keys.indexOf('status');

    const target = rows.find(r => r[idIdx] === body.recordId && r[userIdx] === userId);
    if (!target)                       return _err('RECORD_NOT_FOUND');
    if (target[statusIdx] !== 'PENDING') return _err('只能刪除「待審核」狀態的紀錄。');

    const newData = [header, ...rows.filter(r => !(r[idIdx] === body.recordId && r[userIdx] === userId))];
    sheet.clearContents();
    sheet.getRange(1, 1, newData.length, newData[0].length).setValues(newData);

    SchoolPortalLib.logAction(userId, 'DELETE_RECORD', body.recordId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}
