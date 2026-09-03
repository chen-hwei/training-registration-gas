// ==================== 資料健檢模組（任務單任務 3）====================
// scope='yearSwitch'（學年切換檢查）／'preExport'（簽呈匯出前檢查）共用同一套引擎與回傳格式。
// 警示式：只列出問題清單供管理者判斷，不阻擋任何流程；全程純讀取，禁止任何寫入。
// 回傳格式：{ success, data: { groups: [{ id, title, count, samples[≤30], level }] } }

var HEALTHCHECK_SAMPLE_LIMIT = 30;

/**
 * 健檢入口
 * @param {string} userId - 執行的管理者 userId（供 AuditLog 留痕用）
 * @param {string} scope - 'yearSwitch' 或 'preExport'
 * @param {number} academicYear - 目標學年度
 */
function runDataHealthCheck(userId, scope, academicYear) {
  try {
    var year = Number(academicYear || _currentAcademicYear());
    var groups = (scope === 'preExport') ? _healthCheckPreExport_(year) : _healthCheckYearSwitch_(year);
    var problemCount = groups.reduce(function(sum, g) { return sum + (g.level === 'warning' ? g.count : 0); }, 0);
    _logOp_(userId, 'RUN_HEALTH_CHECK', 'scope=' + scope + ' academicYear=' + year + ' 問題數=' + problemCount);
    return _ok({ groups: groups });
  } catch (e) {
    return _err('runDataHealthCheck 失敗：' + e.message);
  }
}

// ── 共用：組裝單一檢查群組（count/samples/level 一致格式）──
function _hcGroup_(id, title, problemSamples) {
  var count = problemSamples.length;
  return {
    id: id,
    title: title,
    count: count,
    samples: problemSamples.slice(0, HEALTHCHECK_SAMPLE_LIMIT),
    level: count === 0 ? 'ok' : 'warning'
  };
}

// ── 共用：Hub 儲存格時間值轉 Date，一律用數字參數建構，禁止 new Date(字串) ──
// 實測發現 Hub.TrainingStats「最後同步時間」欄因 Sync.gs 寫入後強制 setNumberFormat('General')，
// 讀出來是試算表日期序號（Number），並非 Date 物件也不是 ISO 字串，須額外處理此情況。
function _hcParseTimestamp_(raw) {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'number' && !isNaN(raw)) {
    // 試算表日期序號 epoch 為 1899-12-30；Asia/Taipei 固定 UTC+8、無夏令時，直接反推絕對時間
    var utcMillis = Math.round((raw - 25569) * 86400000);
    return new Date(utcMillis - 8 * 3600 * 1000);
  }
  var m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

// ==================== scope = 'yearSwitch'：學年切換檢查 ====================

function _healthCheckYearSwitch_(year) {
  var groups = [];

  // ── 讀一次 TRAINING_REQUIREMENT，供①②共用 ──
  var reqRows = parseSheetData(_getRequirementSheet());

  // ① 目標學年是否已有 ACTIVE 任務資料
  var targetActive = reqRows.filter(function(r) {
    return Number(r.academicYear) === year && r.status === 'ACTIVE';
  });
  groups.push(_hcGroup_(
    'yearSwitch_targetRequirementExists',
    year + ' 學年度任務資料是否就緒',
    targetActive.length === 0 ? [year + ' 學年度尚無 ACTIVE 任務資料，請先執行「複製到下學年」'] : []
  ));

  // ② 全部任務列關鍵欄位完整性（不限學年）：所需時數 / 分學期計算 / 日期格式
  var hoursBad = [], semesterBad = [], dateBad = [];
  var dateFmtRe = /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/;
  reqRows.forEach(function(r) {
    var label = '[' + r.requirementId + '] ' + r.name;
    var hrs = Number(r.requiredHours);
    if (isNaN(hrs) || hrs < 0) hoursBad.push(label + '：所需時數為「' + r.requiredHours + '」（非法數值）');
    // 沿用 _normalizeSemesterSplit_ 當比對基準：正規化結果與原值不同即代表非合法值
    if (String(r.semesterSplit || '').trim() !== _normalizeSemesterSplit_(r.semesterSplit)) {
      semesterBad.push(label + '：分學期計算為「' + r.semesterSplit + '」（非合法值）');
    }
    if (r.startDate && !dateFmtRe.test(String(r.startDate).trim())) {
      dateBad.push(label + '：開始日期「' + r.startDate + '」格式異常');
    }
    if (r.endDate && !dateFmtRe.test(String(r.endDate).trim())) {
      dateBad.push(label + '：截止日期「' + r.endDate + '」格式異常');
    }
  });
  groups.push(_hcGroup_('yearSwitch_requiredHoursInvalid', '任務所需時數欄位異常', hoursBad));
  groups.push(_hcGroup_('yearSwitch_semesterSplitInvalid', '任務分學期計算欄位異常', semesterBad));
  groups.push(_hcGroup_('yearSwitch_dateFieldInvalid', '任務日期欄位格式異常', dateBad));

  // ③ Hub.TrainingStats 最後同步時間是否在 24 小時內
  groups.push(_hcCheckHubSyncFreshness_());

  // ④ 目標學年名冊快照（TeacherSnapshot）是否存在
  var snapSheet = SpreadsheetApp.openById(getTrainingSsId_()).getSheetByName(TEACHER_SNAPSHOT_SHEET);
  var hasSnapshot = false;
  if (snapSheet) {
    var snapData = snapSheet.getDataRange().getValues();
    var yearCol = snapData[0].indexOf('academicYear');
    hasSnapshot = snapData.slice(1).some(function(r) { return Number(r[yearCol]) === year; });
  }
  groups.push(_hcGroup_(
    'yearSwitch_snapshotExists',
    year + ' 學年度名冊快照是否存在',
    hasSnapshot ? [] : [year + ' 學年度尚無 TeacherSnapshot 名冊快照，請先執行名冊快照']
  ));

  return groups;
}

// ── ③ Hub.TrainingStats 同步時效檢查（獨立函式：內含多層讀取防呆，避免拖累主流程可讀性）──
function _hcCheckHubSyncFreshness_() {
  var id = 'yearSwitch_hubSyncFreshness';
  var title = 'Hub.TrainingStats 同步時效';
  try {
    var hub = SpreadsheetApp.openById(getHubSpreadsheetId_());
    var sheet = hub.getSheetByName('TrainingStats');
    if (!sheet) return _hcGroup_(id, title, ['Hub.TrainingStats 工作表不存在，尚未執行過同步']);

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return _hcGroup_(id, title, ['Hub.TrainingStats 尚無資料列']);

    var syncCol = data[0].indexOf('最後同步時間');
    if (syncCol < 0) return _hcGroup_(id, title, ['找不到「最後同步時間」欄位']);

    var syncDate = _hcParseTimestamp_(data[1][syncCol]);
    if (!syncDate) return _hcGroup_(id, title, ['「最後同步時間」值無法解析：' + data[1][syncCol]]);

    var hoursSince = (Date.now() - syncDate.getTime()) / 3600000;
    var problems = hoursSince > 24
      ? ['最後同步時間為 ' + Utilities.formatDate(syncDate, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') + '，距今已超過 24 小時，同步觸發器可能失效']
      : [];
    return _hcGroup_(id, title, problems);
  } catch (e) {
    return _hcGroup_(id, title, ['檢查失敗：' + e.message]);
  }
}

// ==================== scope = 'preExport'：簽呈匯出前檢查 ====================

function _healthCheckPreExport_(year) {
  var groups = [];
  var ss = SpreadsheetApp.openById(getTrainingSsId_());

  // ⑤ 教師名單一致性：TeacherSnapshot 該學年度全部姓名 vs calcStats 實際納入統計的篩選條件
  // （不呼叫 calcStats() 本體，因其內含 saveStatsCache_ 寫入快取，健檢須維持零寫入）
  var snapSheet = ss.getSheetByName(TEACHER_SNAPSHOT_SHEET);
  var excluded = [];
  if (snapSheet) {
    var snapData = snapSheet.getDataRange().getValues();
    var sHdr = snapData[0];
    var yearCol = sHdr.indexOf('academicYear');
    var nameCol = sHdr.indexOf('teacherName');
    var deptCol = sHdr.indexOf('department');
    var jobCol  = sHdr.indexOf('jobPrimary');
    snapData.slice(1).forEach(function(r) {
      if (Number(r[yearCol]) !== year) return;
      var name = String(r[nameCol] || '').trim();
      if (!name) return;
      var dept = String(r[deptCol] || '').trim();
      var job  = String(r[jobCol]  || '').trim();
      if (!(VALID_DEPT.indexOf(dept) >= 0 && _isTeacherJob_(job))) {
        excluded.push(name + '：部別「' + (dept || '空白') + '」／職務「' + (job || '空白') + '」未列入統計範圍');
      }
    });
  }
  groups.push(_hcGroup_('preExport_teacherRosterConsistency', '教師名單一致性（快照未列入統計）', excluded));

  // ⑥ ImportedData 品質：必要欄位缺漏 / 日期無法解析 / 時數非合法數值
  var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
  var missingField = [], dateBad = [], hoursBad = [];
  if (importSheet) {
    var iData = importSheet.getDataRange().getValues();
    var iHdr  = iData[0];
    var yCol = iHdr.indexOf('academicYear');
    var nCol = iHdr.indexOf('teacherName');
    var tCol = iHdr.indexOf('title');
    var hCol = iHdr.indexOf('hours');
    var dCol = iHdr.indexOf('date');
    iData.slice(1).forEach(function(r, idx) {
      if (Number(r[yCol]) > year) return;  // 累積口徑：只看截至目標學年（比照 calcStats cumulative 模式）
      var rowLabel = '第 ' + (idx + 2) + ' 列';
      var name = String(r[nCol] || '').trim();
      var title = String(r[tCol] || '').trim();
      if (!name || !title) missingField.push(rowLabel + '：教師姓名或研習名稱缺漏');

      // 日期欄可能因 Sheets 自動判讀而讀出 Date 物件，須先轉字串再驗證（比照 parseSheetData 的處理方式）
      var dateRaw = r[dCol];
      var dateStr = dateRaw instanceof Date
        ? Utilities.formatDate(dateRaw, 'Asia/Taipei', 'yyyy/M/d')
        : String(dateRaw || '').trim();
      // 空白日期是系統既有容許的正常狀態（calcStats／syncTrainingStats 皆不因此出錯），只標記「有值但解析失敗」
      // 沿用既有 _detectAcademicYearFromDate_（會回傳 null），不重寫日期解析邏輯
      if (dateStr && _detectAcademicYearFromDate_(dateStr) === null) {
        dateBad.push(rowLabel + '（' + name + '）：日期「' + dateStr + '」無法解析');
      }

      // 時數同理：空白/0 是既有業務規則容許的「未計入時數」，只標記「有值但非數字」的真正壞資料
      var hoursStr = String(r[hCol] || '').trim();
      if (hoursStr && isNaN(parseFloat(hoursStr))) {
        hoursBad.push(rowLabel + '（' + name + '）：時數「' + hoursStr + '」非合法數值');
      }
    });
  }
  groups.push(_hcGroup_('preExport_importedMissingField', 'ImportedData 必要欄位缺漏', missingField));
  groups.push(_hcGroup_('preExport_importedDateInvalid', 'ImportedData 日期無法解析', dateBad));
  groups.push(_hcGroup_('preExport_importedHoursInvalid', 'ImportedData 時數非合法數值', hoursBad));

  // ⑦ TRAINING_RECORD 審核狀態列舉值不合法
  var VALID_STATUS = ['PENDING', 'APPROVED', 'REJECTED'];
  var recordRows = parseSheetData(_getRecordSheet());
  var statusBad = recordRows
    .filter(function(r) { return VALID_STATUS.indexOf(r.status) < 0; })
    .map(function(r) { return '[' + r.recordId + '] ' + r.userId + '：審核狀態「' + r.status + '」非合法值'; });
  groups.push(_hcGroup_('preExport_recordStatusInvalid', '登錄紀錄審核狀態不合法', statusBad));

  // ⑧ TRAINING_RECORD 研習日期年份異常（不限狀態：PENDING 尚未審核也可能已寫入髒值，
  //   APPROVED／REJECTED 若曾中招會讓 Review.gs 依年度匯出時漏收或誤收，故全掃）
  //   只驗年份是否落在合理範圍，不驗「年/月/日」格式本身——trainingDate 若能被 Sheets
  //   判讀為合法日期會存成 Date 型別，parseSheetData 讀回時一律轉成「破折號」字串
  //   （見 Schema.gs parseSheetData，trainingDate 不在 timeKeys 清單內）；只有 Sheets 無法辨識
  //   的離譜值（如 6 位數年份）才會維持寫入時的原始「斜線」字串。兩種寫法都合法，不可用格式判斷。
  //   年份下限採 2000（系統有 seedHistoricalRequirements() 灌入的歷史學年度資料），
  //   不綁 _currentAcademicYear()——那是學年度邏輯，與「日期合理性」是兩回事。
  var TRAINING_DATE_MIN_YEAR = 2000, TRAINING_DATE_MAX_YEAR = 2100;
  var trainingDateBad = recordRows
    .map(function(r) {
      var m = String(r.trainingDate || '').match(/^(\d+)[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      var year = m ? Number(m[1]) : NaN;
      var bad = !m || isNaN(year) || year < TRAINING_DATE_MIN_YEAR || year > TRAINING_DATE_MAX_YEAR;
      return bad ? '[' + r.recordId + '] ' + r.userId + '（' + r.status + '）：研習日期「' + r.trainingDate + '」年份異常' : null;
    })
    .filter(function(msg) { return msg !== null; });
  groups.push(_hcGroup_('preExport_recordTrainingDateInvalid', '登錄紀錄研習日期年份異常', trainingDateBad));

  return groups;
}
