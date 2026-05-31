// ==================== Hub 統計同步（每晚 23:30 定時觸發） ====================

/**
 * 同步本系統 APPROVED 研習紀錄至 Hub.TrainingStats
 * 提供主門戶儀表板 KPI #7「年度研習人時彙整」
 * 一次 setValues 批次寫入，不做即時計算
 */
function syncTrainingStats() {
  const records = parseSheetData(_getRecordSheet()).filter(r => r.status === 'APPROVED');

  // 建立課程 Hash Map：catalogId → isRequired（O(1) 比對）
  const catalogMap = {};
  parseSheetData(_getCatalogSheet()).forEach(c => {
    catalogMap[c.catalogId] = c.isRequired === true || String(c.isRequired).toUpperCase() === 'TRUE';
  });

  // 彙整每位教師的核准時數與必修達成數
  const statsMap = {};
  records.forEach(r => {
    const uid = r.userId;
    if (!statsMap[uid]) statsMap[uid] = { approvedHours: 0, requiredCompleted: 0 };
    statsMap[uid].approvedHours += Number(r.hours) || 0;
    if (r.catalogId && catalogMap[r.catalogId] === true) {
      statsMap[uid].requiredCompleted += 1;
    }
  });

  // 從 Hub.UserStatusCache 取得教師處室資訊
  const hub        = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
  const cacheData  = hub.getSheetByName('UserStatusCache').getDataRange().getValues();
  const ch         = cacheData[0];
  const uidCol     = ch.indexOf('userId');
  const deptCol    = ch.indexOf('department');
  const deptMap    = {};
  cacheData.slice(1).forEach(row => { if (row[uidCol]) deptMap[row[uidCol]] = row[deptCol] || ''; });

  // 組裝並一次寫入 Hub.TrainingStats
  const now       = _now();
  const headers   = ['教師 ID', '所屬處室', '本學年核准時數', '必修達成數', '最後同步時間'];
  const dataRows  = Object.entries(statsMap).map(([uid, s]) => [
    uid,
    deptMap[uid] || '',
    s.approvedHours,
    s.requiredCompleted,
    now
  ]);

  const allData    = [headers, ...dataRows];
  // 若 Hub 試算表尚未建立 TrainingStats 工作表，自動建立
  let statsSheet = hub.getSheetByName('TrainingStats');
  if (!statsSheet) statsSheet = hub.insertSheet('TrainingStats');
  statsSheet.clearContents();
  statsSheet.getRange(1, 1, allData.length, allData[0].length).setValues(allData);

  console.log('syncTrainingStats 完成，共同步 ' + dataRows.length + ' 筆教師統計。');
}

/** 建立每晚 23:30 的定時觸發器（一次性執行，部署時呼叫） */
function setupSyncTrigger() {
  ScriptApp.newTrigger('syncTrainingStats')
    .timeBased()
    .atHour(23)
    .nearMinute(30)
    .everyDays(1)
    .create();
  console.log('syncTrainingStats 定時觸發器已建立（每晚 23:30）。');
}
