// ==================== Hub 統計同步（每晚 23:30 定時觸發） ====================

/**
 * 同步本系統當學年研習達成狀況至 Hub.TrainingStats
 * 提供主門戶儀表板 KPI #7「年度研習人時彙整」與個人頁「我的研習進度」
 * 口徑比照任務 7（Index.html/getRequirements）：逐任務 effectiveHours = max(核准時數, 匹配匯入時數)
 * 一次 setValues 批次寫入，不做即時計算
 *
 * 效能注意（gas-limitations 鐵律）：ImportedData 與任務關鍵字／區間只在迴圈外各算一次，
 * 逐教師迭代時只做記憶體比對，禁止對每位教師重新讀表或重算區間。
 */
function syncTrainingStats() {
  const academicYear = _currentAcademicYear();

  // ── Step 1：當學年 ACTIVE 任務，預先算好關鍵字與硬性區間（迴圈外算一次）──
  const reqDefs = parseSheetData(_getRequirementSheet())
    .filter(r => r.status === 'ACTIVE' && Number(r.academicYear) === academicYear)
    .map(r => {
      let keywords = [];
      try { keywords = r.matchKeywords ? JSON.parse(r.matchKeywords) : []; } catch (e) {}
      return {
        requirementId: r.requirementId,
        requiredHours: Number(r.requiredHours) || 0,
        keywords,
        win: _requirementWindow_(r.academicYear, r.semesterSplit)
      };
    });

  // ── Step 2：課程 Hash Map：catalogId → isRequired（原「必修達成數」欄位語意，維持不變）──
  const catalogMap = {};
  parseSheetData(_getCatalogSheet()).forEach(c => {
    catalogMap[c.catalogId] = c.isRequired === true || String(c.isRequired).toUpperCase() === 'TRUE';
  });

  // ── Step 3：APPROVED 紀錄，一次迴圈同時建立
  //   (a) { userId_requirementId → hours }（供任務 effectiveHours 比對）
  //   (b) { userId → 必修課程達成數 }（原邏輯：課程 isRequired 計數，全期間不分學年）──
  const approvedMap    = {};
  const requiredDoneMap = {};
  parseSheetData(_getRecordSheet())
    .filter(r => r.status === 'APPROVED')
    .forEach(r => {
      if (r.requirementId) {
        const key = r.userId + '_' + r.requirementId;
        approvedMap[key] = (approvedMap[key] || 0) + (Number(r.hours) || 0);
      }
      if (r.catalogId && catalogMap[r.catalogId] === true) {
        requiredDoneMap[r.userId] = (requiredDoneMap[r.userId] || 0) + 1;
      }
    });

  // ── Step 4：ImportedData 只讀一次，建立 { 教師姓名 → 紀錄陣列 }（當學年篩選）──
  const importSheet = SpreadsheetApp.openById(TRAINING_SS_ID).getSheetByName(IMPORTED_DATA_SHEET);
  const importedByName = {};
  if (importSheet) {
    const iData  = importSheet.getDataRange().getValues();
    const iHdr   = iData[0];
    const iNmCol = iHdr.indexOf('teacherName');
    const iTtCol = iHdr.indexOf('title');
    const iHrCol = iHdr.indexOf('hours');
    const iYrCol = iHdr.indexOf('academicYear');
    const iDtCol = iHdr.indexOf('date');
    iData.slice(1).forEach(row => {
      if (Number(row[iYrCol]) !== academicYear) return;
      const nm  = String(row[iNmCol] || '').trim();
      const hrs = parseFloat(row[iHrCol]) || 0;
      if (!nm || hrs <= 0) return;
      if (!importedByName[nm]) importedByName[nm] = [];
      importedByName[nm].push({
        title: String(row[iTtCol] || '').trim(),
        hours: hrs,
        ts:    iDtCol >= 0 ? _importDateTs_(row[iDtCol]) : null
      });
    });
  }

  // 純記憶體比對：某教師的匯入紀錄中，符合關鍵字＋落在硬性區間內者加總時數
  function importedHoursFor_(records, keywords, win) {
    if (!records || keywords.length === 0) return 0;
    let total = 0;
    records.forEach(rec => {
      if (rec.ts !== null && win && (rec.ts < win.startTs || rec.ts > win.endTs)) return;
      if (keywords.some(kw => rec.title.indexOf(kw) >= 0)) total += rec.hours;
    });
    return total;
  }

  // ── Step 5：在職教師名單（userId／姓名／處室），迴圈只做記憶體運算 ──
  const hub       = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
  const cacheData = hub.getSheetByName('UserStatusCache').getDataRange().getValues();
  const ch        = cacheData[0];
  const uidCol    = ch.indexOf('userId');
  const nameCol   = ch.indexOf('name');
  const deptCol   = ch.indexOf('department');

  const now      = _now();
  const dataRows = [];
  cacheData.slice(1).forEach(row => {
    const uid = row[uidCol];
    if (!uid) return;
    const name = String(row[nameCol] || '').trim();

    let approvedTotal   = 0;   // 本學年核准時數（限當學年任務）
    let effectiveTotal   = 0;  // Σ 各任務 effectiveHours
    let requirementsDone = 0;  // 依 effectiveHours >= required 判定的任務達成數

    reqDefs.forEach(rd => {
      const approved  = approvedMap[uid + '_' + rd.requirementId] || 0;
      const imported   = importedHoursFor_(importedByName[name], rd.keywords, rd.win);
      const effective  = Math.max(approved, imported);
      approvedTotal   += approved;
      effectiveTotal  += effective;
      if (rd.requiredHours > 0 && effective >= rd.requiredHours) requirementsDone++;
    });

    dataRows.push([
      uid,
      row[deptCol] || '',
      approvedTotal,
      requiredDoneMap[uid] || 0,   // 必修達成數：原邏輯，課程 isRequired 計數，維持不變
      effectiveTotal,
      requirementsDone,            // 年度任務達成數：新欄，依 effectiveHours >= required 判定
      now
    ]);
  });

  // 組裝並一次寫入 Hub.TrainingStats（向下相容加欄，順序需與門戶 Schema.gs 的
  // TRAINING_STATS_HEADERS/TRAINING_STATS_KEYS 一致）
  const headers = ['教師ID', '所屬處室', '本學年核准時數', '必修達成數', '本學年有效時數', '年度任務達成數', '最後同步時間'];
  const allData = [headers, ...dataRows];

  // 若 Hub 試算表尚未建立 TrainingStats 工作表，自動建立
  let statsSheet = hub.getSheetByName('TrainingStats');
  if (!statsSheet) statsSheet = hub.insertSheet('TrainingStats');
  statsSheet.clearContents();
  statsSheet.getRange(1, 1, allData.length, allData[0].length).setValues(allData);

  console.log('syncTrainingStats 完成，共同步 ' + dataRows.length + ' 筆教師統計（' + academicYear + ' 學年度）。');
}

/** 建立每晚 23:30 的定時觸發器（可重複執行：會先刪除同名舊觸發器再重建，不疊加） */
function setupSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncTrainingStats') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncTrainingStats')
    .timeBased()
    .atHour(23)
    .nearMinute(30)
    .everyDays(1)
    .create();
  console.log('syncTrainingStats 定時觸發器已建立（每晚 23:30）。');
}
