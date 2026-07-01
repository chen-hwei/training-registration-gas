// ==================== TRAIN-REPORT：研習統計分析模組 ====================
// 對應任務單：TRAIN-REPORT v1.2
// 資料來源：全國教師在職進修網（CSV）＋ 臺北市教師研習網（XLSX）

// ── 欄位別名對映表 ──
var FIELD_ALIASES_ = {
  teacherName: ['教師姓名', '姓名', '教師', '教職員姓名'],
  title:       ['研習課程名稱', '研習名稱', '課程名稱', '研習主題', '研習班名稱'],
  organizer:   ['主辦單位', '承辦單位', '辦理單位'],
  date:        ['課程日期', '研習日期', '課程結束時間', '辦理日期'],
  hours:       ['實核時數/學分數', '實核時數', '核給時數', '時數', '核予時數'],
  courseCode:  ['課程代碼', '課程代號', '研習代碼', '研習代號'],
  certNumber:  ['核准文號']
};

// ── 預設指標規則（移植自 TTVS TagService.DEFAULT_RULES，JS Regex 已校正）──
var DEFAULT_INDICATORS_ = [
  { id: 'A1',   label: 'A1',   patterns: ['A1', '數位學習工作坊[（(]一[）)]', '數位學習工作坊.*一'] },
  { id: 'A2',   label: 'A2',   patterns: ['A2', '數位學習工作坊[（(]二[）)]', '數位學習工作坊.*二'] },
  { id: 'A3',   label: 'A3',   patterns: ['A3', '數位素養進階'] },
  { id: 'B1',   label: 'B1',   patterns: ['B1', '智慧學習課堂', '課堂教學應用'] },
  { id: 'B5-1', label: 'B5-1', patterns: ['B5-1', '生成式AI.*教育應用', '生成式AI與教育應用'] },
  { id: 'B5-2', label: 'B5-2', patterns: ['B5-2', '生成式AI融入', 'AI融入學科'] },
  { id: 'C',    label: 'C',    patterns: ['C\\s', '(?<![a-zA-Z0-9])C$', '跨領域前瞻', '數位增能指標'] },
  { id: 'D',    label: 'D',    patterns: ['D\\s', '(?<![a-zA-Z0-9])D$'] },
  { id: 'E',    label: 'E',    patterns: ['E\\s', '(?<![a-zA-Z0-9])E$'] }
];

// ==================== F2：指標規則管理 ====================

function getIndicators() {
  try {
    const props = PropertiesService.getScriptProperties();
    const raw   = props.getProperty(INDICATOR_RULES_KEY);
    const rules = raw ? JSON.parse(raw) : DEFAULT_INDICATORS_;
    return _ok(rules);
  } catch (e) {
    return _err('getIndicators 失敗：' + e.message);
  }
}

function saveIndicator(body) {
  try {
    const { id, label, patterns } = body || {};
    if (!id || !label || !Array.isArray(patterns) || patterns.length === 0)
      return _err('id、label、patterns 為必填');

    const props = PropertiesService.getScriptProperties();
    const raw   = props.getProperty(INDICATOR_RULES_KEY);
    const rules = raw ? JSON.parse(raw) : DEFAULT_INDICATORS_.slice();

    const idx = rules.findIndex(r => r.id === id);
    const entry = { id: id.trim().toUpperCase(), label: label.trim(), patterns: patterns.map(p => p.trim()).filter(Boolean) };
    if (idx >= 0) rules[idx] = entry;
    else rules.push(entry);

    props.setProperty(INDICATOR_RULES_KEY, JSON.stringify(rules));
    return _ok({ saved: entry });
  } catch (e) {
    return _err('saveIndicator 失敗：' + e.message);
  }
}

function deleteIndicator(id) {
  try {
    if (!id) return _err('id 為必填');
    const props = PropertiesService.getScriptProperties();
    const raw   = props.getProperty(INDICATOR_RULES_KEY);
    const rules = raw ? JSON.parse(raw) : DEFAULT_INDICATORS_.slice();
    const next  = rules.filter(r => r.id !== id);
    props.setProperty(INDICATOR_RULES_KEY, JSON.stringify(next));
    return _ok({ deleted: id });
  } catch (e) {
    return _err('deleteIndicator 失敗：' + e.message);
  }
}

// ── 內部：Regex 比對，回傳符合的指標 ID 陣列 ──
// preloadedRules 選填：若已從 PropertiesService 讀取則傳入，避免在迴圈中重複讀取（效能關鍵）
function parseIndicators_(title, preloadedRules) {
  if (!title) return [];
  var rules;
  if (preloadedRules) {
    rules = preloadedRules;
  } else {
    var props = PropertiesService.getScriptProperties();
    var raw   = props.getProperty(INDICATOR_RULES_KEY);
    rules = raw ? JSON.parse(raw) : DEFAULT_INDICATORS_;
  }
  var matched = [];
  rules.forEach(function(rule) {
    for (var i = 0; i < rule.patterns.length; i++) {
      try {
        if (new RegExp(rule.patterns[i], 'i').test(title)) {
          matched.push(rule.id);
          break;
        }
      } catch (_) { /* 跳過無效 Regex */ }
    }
  });
  var order = rules.map(function(r) { return r.id; });
  matched.sort(function(a, b) { return order.indexOf(a) - order.indexOf(b); });
  return matched;
}

// ==================== F1：資料匯入與清洗 ====================

// ── 內部：從 headers 陣列中找到目標欄位的索引 ──
function findColIdx_(headers, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    var idx = headers.indexOf(aliases[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}

// ── 內部：將一列原始資料依欄位別名對映為標準物件 ──
function normalizeRow_(row, headers) {
  var obj = {};
  Object.keys(FIELD_ALIASES_).forEach(function(key) {
    var idx = findColIdx_(headers, FIELD_ALIASES_[key]);
    var val = idx >= 0 ? String(row[idx] || '').trim() : '';
    obj[key] = val;
  });
  return obj;
}

// ── 內部：學年度計算（月份 >= 8 為新學年）──
function toAcademicYear_(dateStr) {
  if (!dateStr) return _currentAcademicYear();
  var d = new Date(dateStr.replace(/\//g, '-'));
  if (isNaN(d)) return _currentAcademicYear();
  var y = d.getFullYear() - 1911;
  return (d.getMonth() + 1) >= 8 ? y : y - 1;
}

// ── 內部：判斷來源（有 courseCode → national；有核准文號格式 → taipei）──
function detectSource_(rec) {
  if (rec.courseCode) return 'national';
  if (rec.certNumber && rec.certNumber.indexOf('字第') >= 0) return 'taipei';
  return 'national';
}

/**
 * 名冊快照：建立、追加或覆蓋指定學年度的 TeacherSnapshot
 * body.academicYear  - 目標學年度（數字）
 * body.rosterRows    - 人事室名冊 [{ teacherName, department, jobPrimary }]，空陣列則從 Hub
 * body.overwrite     - true：完全取代該年度快照；false（預設）：若已存在回傳 conflict
 * body.appendMode    - true：追加合併（不刪現有資料，以 teacherName 去重更新）
 * body.fileName      - 來源 CSV 檔名（供 rosterSources 記錄）
 */
function snapshotTeacherRoster(body) {
  try {
    var academicYear = Number(body.academicYear || _currentAcademicYear());
    var rosterRows   = body.rosterRows || [];
    var overwrite    = body.overwrite  || false;
    var appendMode   = body.appendMode || false;
    var fileName     = body.fileName   || '';

    var ss    = SpreadsheetApp.openById(TRAINING_SS_ID);
    var sheet = ss.getSheetByName(TEACHER_SNAPSHOT_SHEET);

    // 初始化工作表
    if (!sheet) {
      sheet = ss.insertSheet(TEACHER_SNAPSHOT_SHEET);
      sheet.getRange(1, 1, 1, 4).setValues([['academicYear', 'teacherName', 'department', 'jobPrimary']]);
    }

    var existing = sheet.getDataRange().getValues();
    var headers  = existing[0];
    var hasYear  = existing.slice(1).some(function(r) { return Number(r[0]) === academicYear; });

    // 若已存在且非強制覆蓋且非追加 → 回傳衝突
    if (hasYear && !overwrite && !appendMode) {
      return { success: false, conflict: true, message: academicYear + ' 學年度快照已存在，請確認是否覆蓋。' };
    }

    var sourceTag = '';  // 'hub' 或 'csv'

    if (appendMode && hasYear) {
      // ── 追加模式：以 teacherName 為 key 建立現有資料 Map，再合併新資料 ──
      var existMap = {};
      existing.slice(1).forEach(function(r) {
        if (Number(r[0]) !== academicYear) return;
        existMap[String(r[1]).trim()] = [r[0], String(r[1]).trim(), String(r[2]).trim(), String(r[3]).trim()];
      });

      if (rosterRows.length > 0) {
        sourceTag = 'csv';
        rosterRows.forEach(function(row) {
          var name = String(row.teacherName || '').trim();
          if (!name) return;
          existMap[name] = [academicYear, name, String(row.department || '').trim(), String(row.jobPrimary || '').trim()];
        });
      } else {
        sourceTag = 'hub';
        var hub2  = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
        var cs2   = hub2.getSheetByName('UserStatusCache');
        if (!cs2) return _err('Hub UserStatusCache 工作表不存在');
        var cd2   = cs2.getDataRange().getValues();
        var ch2   = cd2[0];
        var nC2   = ch2.indexOf('name'), dC2 = ch2.indexOf('department');
        var jC2   = ch2.indexOf('jobPrimary'), stC2 = ch2.indexOf('status');
        var ACTIVE2 = ['在職', '轉調'];
        cd2.slice(1).forEach(function(row) {
          if (!ACTIVE2.includes(String(row[stC2] || ''))) return;
          var dept = String(row[dC2] || '').trim();
          if (dept !== '高中部' && dept !== '國中部') return;
          var name = String(row[nC2] || '').trim();
          existMap[name] = [academicYear, name, dept, jC2 >= 0 ? String(row[jC2] || '').trim() : ''];
        });
      }

      var mergedRows = Object.values(existMap);
      var keptOther  = existing.slice(1).filter(function(r) { return Number(r[0]) !== academicYear; });
      var allData    = [headers].concat(keptOther).concat(mergedRows);
      sheet.clearContents();
      sheet.getRange(1, 1, allData.length, 4).setValues(allData);
      _saveRosterSource_(academicYear, sourceTag, fileName, mergedRows.length);
      return _ok({ academicYear: academicYear, snapshotCount: mergedRows.length, appended: true });
    }

    // ── 取代模式（overwrite 或 新建）──
    var kept    = existing.slice(1).filter(function(r) { return Number(r[0]) !== academicYear; });
    var newRows = [];

    if (rosterRows.length > 0) {
      sourceTag = 'csv';
      rosterRows.forEach(function(row) {
        if (!row.teacherName) return;
        newRows.push([
          academicYear,
          String(row.teacherName || '').trim(),
          String(row.department  || '').trim(),
          String(row.jobPrimary  || '').trim()
        ]);
      });
    } else {
      sourceTag = 'hub';
      var hub       = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
      var cacheSheet = hub.getSheetByName('UserStatusCache');
      if (!cacheSheet) return _err('Hub UserStatusCache 工作表不存在');
      var cacheData = cacheSheet.getDataRange().getValues();
      var ch        = cacheData[0];
      var nameCol   = ch.indexOf('name');
      var deptCol   = ch.indexOf('department');
      var jobCol    = ch.indexOf('jobPrimary');
      var statusCol = ch.indexOf('status');
      var ACTIVE    = ['在職', '轉調'];
      cacheData.slice(1).forEach(function(row) {
        if (!ACTIVE.includes(String(row[statusCol] || ''))) return;
        var dept = String(row[deptCol] || '').trim();
        if (dept !== '高中部' && dept !== '國中部') return;
        newRows.push([
          academicYear,
          String(row[nameCol]  || '').trim(),
          dept,
          jobCol >= 0 ? String(row[jobCol] || '').trim() : ''
        ]);
      });
    }

    var allData = [headers].concat(kept).concat(newRows);
    sheet.clearContents();
    sheet.getRange(1, 1, allData.length, 4).setValues(allData);
    _saveRosterSource_(academicYear, sourceTag, fileName, newRows.length);
    return _ok({ academicYear: academicYear, snapshotCount: newRows.length });
  } catch (e) {
    return _err('snapshotTeacherRoster 失敗：' + e.message);
  }
}

/** 記錄各學年度名冊來源至 PropertiesService */
function _saveRosterSource_(academicYear, source, fileName, count) {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw   = props.getProperty(ROSTER_SOURCES_KEY);
    var map   = raw ? JSON.parse(raw) : {};
    var ts    = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm');
    map[String(academicYear)] = { source: source, fileName: fileName || '', count: count, at: ts };
    props.setProperty(ROSTER_SOURCES_KEY, JSON.stringify(map));
  } catch (e) { /* 記錄失敗不影響主流程 */ }
}

/**
 * 取得各學年度名冊來源記錄（供前端摘要顯示）
 */
function getRosterSources() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw   = props.getProperty(ROSTER_SOURCES_KEY);
    return _ok(raw ? JSON.parse(raw) : {});
  } catch (e) {
    return _err('getRosterSources 失敗：' + e.message);
  }
}

/**
 * 批次人事名冊快照（多年度 CSV 一次送入）
 * body.yearGroups  - { "110": [{ teacherName, department, jobPrimary }], "111": [...] }
 * body.appendMode  - 是否追加（預設 true，避免蓋掉已有的 Hub 資料）
 * body.fileName    - 來源 CSV 檔名
 * body.years       - 要處理的年度陣列（管理者勾選的）
 */
function snapshotRosterBatch(body) {
  try {
    var yearGroups = body.yearGroups || {};
    var years      = body.years || Object.keys(yearGroups).map(Number).sort();
    var appendMode = body.appendMode !== false;  // 預設 true
    var fileName   = body.fileName   || '';
    var results    = [];

    years.forEach(function(yr) {
      yr = Number(yr);
      var rows = yearGroups[String(yr)] || [];
      var res  = snapshotTeacherRoster({
        academicYear: yr,
        rosterRows:   rows,
        overwrite:    !appendMode,
        appendMode:   appendMode,
        fileName:     fileName
      });
      results.push({ academicYear: yr, success: res.success, count: res.data ? res.data.snapshotCount : 0, error: res.error });
    });

    var failed = results.filter(function(r) { return !r.success; });
    return _ok({ results: results, failedCount: failed.length });
  } catch (e) {
    return _err('snapshotRosterBatch 失敗：' + e.message);
  }
}

/**
 * 判斷 jobPrimary 是否屬於應計入統計的教師職務
 * 採關鍵字包含比對，相容「正式」「正式教師」等各種格式
 * 排除：兼課、校長、主任、組長、教官等純行政或兼課身分
 */
function _isTeacherJob_(job) {
  if (!job) return true;  // 空白＝尚未同步，不排除
  var INCLUDE_KW = ['正式', '代理', '代課'];
  for (var i = 0; i < INCLUDE_KW.length; i++) {
    if (job.indexOf(INCLUDE_KW[i]) >= 0) return true;
  }
  return false;
}

/**
 * 從日期字串推算台灣學年度（民國年）
 * 支援 YYYY/MM/DD、YYYY-MM-DD 格式
 */
function _detectAcademicYearFromDate_(dateStr) {
  var m = String(dateStr || '').match(/(\d{4})[\/\-](\d{1,2})/);
  if (!m) return null;
  var yr = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  if (yr < 1990) return null;
  return mo >= 8 ? yr - 1911 : yr - 1912;
}

/**
 * 研習資料匯入
 * body.academicYear - 學年度
 * body.rows         - [{ rawRow, headers }] 前端解析後的原始列資料
 * body.appendMode   - true：追加合併（保留現有同年度紀錄）；false（預設）：取代
 */
function importTrainingData(body) {
  try {
    var academicYear = Number(body.academicYear || _currentAcademicYear());
    var rows         = body.rows || [];
    var appendMode   = body.appendMode || false;
    if (rows.length === 0) return _err('無匯入資料');

    // 讀取 TeacherSnapshot 建立姓名集合（用於 unmatchedNames 偵測）
    var ss            = SpreadsheetApp.openById(TRAINING_SS_ID);
    var snapSheet     = ss.getSheetByName(TEACHER_SNAPSHOT_SHEET);
    var knownNames    = {};
    if (snapSheet) {
      var snapData = snapSheet.getDataRange().getValues();
      var sHdr     = snapData[0];
      var sYearCol = sHdr.indexOf('academicYear');
      var sNameCol = sHdr.indexOf('teacherName');
      snapData.slice(1).forEach(function(r) {
        if (Number(r[sYearCol]) === academicYear) knownNames[String(r[sNameCol]).trim()] = true;
      });
    }

    // 正規化所有列
    var normalized = rows.map(function(item) {
      return normalizeRow_(item.row, item.headers);
    }).filter(function(r) { return r.teacherName; });

    // appendMode：預先載入現有同年度資料至 dedupeMap（合併而非取代）
    var dedupeMap    = {};
    var dedupeCount  = 0;
    var skipped      = 0;

    if (appendMode) {
      var importSheet0 = ss.getSheetByName(IMPORTED_DATA_SHEET);
      if (importSheet0) {
        var existData = importSheet0.getDataRange().getValues();
        var eHdr      = existData[0];
        var eYrCol    = eHdr.indexOf('academicYear');
        var eNmCol    = eHdr.indexOf('teacherName');
        var eTlCol    = eHdr.indexOf('title');
        var eDtCol    = eHdr.indexOf('date');
        var eHrCol    = eHdr.indexOf('hours');
        var eSrCol    = eHdr.indexOf('source');
        var eCcCol    = eHdr.indexOf('courseCode');
        var eCnCol    = eHdr.indexOf('certNumber');
        var eOgCol    = eHdr.indexOf('organizer');
        existData.slice(1).forEach(function(r) {
          if (Number(r[eYrCol]) !== academicYear) return;
          var rec = {
            academicYear: academicYear,
            teacherName:  String(r[eNmCol] || '').trim(),
            title:        String(r[eTlCol] || '').trim(),
            date:         String(r[eDtCol] || '').trim(),
            hours:        String(r[eHrCol] || '').trim(),
            source:       String(r[eSrCol] || '').trim(),
            courseCode:   String(r[eCcCol] || '').trim(),
            certNumber:   String(r[eCnCol] || '').trim(),
            organizer:    String(r[eOgCol] || '').trim()
          };
          var key = rec.teacherName + '||' + rec.title.slice(0, 20) + '||' + rec.date;
          dedupeMap[key] = rec;
        });
      }
    }

    normalized.forEach(function(rec) {
      // 安全驗證：若日期能辨識且與宣告學年度不符則略過
      var detectedYr = _detectAcademicYearFromDate_(rec.date);
      if (detectedYr !== null && detectedYr !== academicYear) {
        skipped++;
        return;
      }
      var key = rec.teacherName + '||' + rec.title.slice(0, 20) + '||' + rec.date;
      if (!dedupeMap[key]) {
        rec.source       = detectSource_(rec);
        rec.academicYear = academicYear;
        dedupeMap[key]   = rec;
      } else {
        // 重複：保留時數較大者，合併來源與 ID
        dedupeCount++;
        var prev = dedupeMap[key];
        if (parseFloat(rec.hours) > parseFloat(prev.hours)) prev.hours = rec.hours;
        if (prev.source !== rec.source) prev.source = 'both';
        if (!prev.courseCode && rec.courseCode) prev.courseCode = rec.courseCode;
        if (!prev.certNumber && rec.certNumber) prev.certNumber = rec.certNumber;
      }
    });

    var toWrite      = Object.values(dedupeMap);
    var unmatchedNames = [];
    var seenUnmatched  = {};
    toWrite.forEach(function(rec) {
      if (!knownNames[rec.teacherName] && !seenUnmatched[rec.teacherName]) {
        unmatchedNames.push(rec.teacherName);
        seenUnmatched[rec.teacherName] = true;
      }
    });

    // 讀取既有 ImportedData，移除同學年度舊資料後合併寫入
    var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
    if (!importSheet) {
      importSheet = ss.insertSheet(IMPORTED_DATA_SHEET);
      var importHdrs = ['academicYear','teacherName','title','organizer','date','hours','courseCode','certNumber','source'];
      importSheet.getRange(1, 1, 1, importHdrs.length).setValues([importHdrs]);
    }

    var importData = importSheet.getDataRange().getValues();
    var iHdr       = importData[0];
    var iYearCol   = iHdr.indexOf('academicYear');
    var prevRows   = importData.slice(1).filter(function(r) { return Number(r[iYearCol]) !== academicYear; });

    var keys = ['academicYear','teacherName','title','organizer','date','hours','courseCode','certNumber','source'];
    var newData = toWrite.map(function(rec) {
      return keys.map(function(k) { return rec[k] || ''; });
    });

    var allData = [iHdr].concat(prevRows).concat(newData);
    importSheet.clearContents();
    importSheet.getRange(1, 1, allData.length, keys.length).setValues(allData);

    clearStatsCache_(academicYear);  // 資料已更新，清除伺服器端統計快取
    return _ok({
      imported:           toWrite.length,
      duplicatesResolved: dedupeCount,
      skipped:            skipped,
      unmatchedNames:     unmatchedNames
    });
  } catch (e) {
    return _err('importTrainingData 失敗：' + e.message);
  }
}

// ==================== 手動執行工具（Debug / 補救） ====================

/**
 * 診斷：在 ImportedData 中搜尋 CRPD / 身心障礙相關紀錄
 * 在 GAS 編輯器執行此函式（TrainingReport.gs），結果顯示於執行記錄
 */
function debugFindCRPDRecord() {
  var TEACHER_NAME = '陳宏煒';  // ← 若要查別人，改這裡
  var KEYWORDS     = ['CRPD', '身心障礙者權利公約', '兒童權利公約', 'CRC'];

  var ss    = SpreadsheetApp.openById(TRAINING_SS_ID);
  var sheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
  if (!sheet) { Logger.log('❌ ImportedData 工作表不存在'); return; }

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0];
  var nmCol  = hdr.indexOf('teacherName');
  var tlCol  = hdr.indexOf('title');
  var yrCol  = hdr.indexOf('academicYear');
  var hrCol  = hdr.indexOf('hours');
  var dtCol  = hdr.indexOf('date');
  var cnCol  = hdr.indexOf('certNumber');

  // 1. 搜尋關鍵字匹配紀錄（不限姓名）
  Logger.log('=== 關鍵字搜尋結果（全表）===');
  var kwFound = 0;
  data.slice(1).forEach(function(r, i) {
    var ttl = String(r[tlCol] || '');
    var hit = KEYWORDS.some(function(kw) { return ttl.indexOf(kw) >= 0; });
    if (hit) {
      kwFound++;
      Logger.log('列' + (i+2) + ' | 姓名:' + r[nmCol] + ' | 學年:' + r[yrCol] +
                 ' | 時數:' + r[hrCol] + ' | 日期:' + r[dtCol] + ' | 課名:' + ttl.slice(0, 40));
    }
  });
  if (kwFound === 0) Logger.log('⚠️ 全表無任何關鍵字匹配紀錄 → 此資料確實未被匯入');

  // 2. 搜尋該教師所有 114 年紀錄
  Logger.log('\n=== ' + TEACHER_NAME + ' 的 114 學年度所有匯入紀錄 ===');
  var myFound = 0;
  data.slice(1).forEach(function(r) {
    if (String(r[nmCol]).trim() === TEACHER_NAME && Number(r[yrCol]) === 114) {
      myFound++;
      Logger.log('時數:' + r[hrCol] + ' | 日期:' + r[dtCol] + ' | ' + String(r[tlCol]).slice(0, 50));
    }
  });
  Logger.log('→ 共 ' + myFound + ' 筆');

  // 3. 模擬日期解析
  Logger.log('\n=== 日期解析測試（_detectAcademicYearFromDate_）===');
  var testDates = ['2025/8/15', '2025/08/15', '2025-08-15', '114/8/15', '114/08/15', ''];
  testDates.forEach(function(d) {
    Logger.log('"' + d + '" → 學年度:' + _detectAcademicYearFromDate_(d));
  });
}

/**
 * 補救：手動將 CRPD 紀錄補寫入 ImportedData（執行前先跑 debugFindCRPDRecord 確認確實遺失）
 * 在 GAS 編輯器執行此函式（TrainingReport.gs）
 */
function manualAddImportedRecord() {
  // ── 在此填入要補加的紀錄資訊 ──
  var RECORD = {
    academicYear: 114,
    teacherName:  '陳宏煒',
    title:        '臺北市114學年度國民中學身心障礙者權利公約(CRPD)(直接至酷課雲單一身分簽入上課，勿在此報名!!!)',
    organizer:    '臺北市政府教育局',
    date:         '2025/08/15',   // ← 若確定日期請填，不確定填 ''
    hours:        '3',
    courseCode:   '',
    certNumber:   '北市研習字第1140815001號',  // ← 若知道請填
    source:       'taipei'
  };
  // ────────────────────────────────

  var ss    = SpreadsheetApp.openById(TRAINING_SS_ID);
  var sheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
  if (!sheet) { Logger.log('❌ ImportedData 工作表不存在'); return; }

  // 去重確認：同 key 不重複寫入
  var data  = sheet.getDataRange().getValues();
  var hdr   = data[0];
  var nmCol = hdr.indexOf('teacherName');
  var tlCol = hdr.indexOf('title');
  var dtCol = hdr.indexOf('date');
  var dupKey = RECORD.teacherName + '||' + RECORD.title.slice(0, 20) + '||' + RECORD.date;
  var exists = data.slice(1).some(function(r) {
    return (String(r[nmCol]).trim() + '||' + String(r[tlCol]).slice(0, 20) + '||' + String(r[dtCol]).trim()) === dupKey;
  });
  if (exists) { Logger.log('⚠️ 此紀錄已存在，不重複寫入'); return; }

  var keys = ['academicYear','teacherName','title','organizer','date','hours','courseCode','certNumber','source'];
  sheet.appendRow(keys.map(function(k) { return RECORD[k] || ''; }));
  clearStatsCache_(RECORD.academicYear);
  Logger.log('✅ 已補寫入 1 筆：' + RECORD.title.slice(0, 40));
}

// ==================== F3-cache：伺服器端統計快取 ====================

/**
 * 診斷：確認 getRequirements 的分眾身分查詢與日期過濾是否正常
 * 在 GAS 編輯器執行此函式（TrainingReport.gs），結果顯示於執行記錄
 */
function debugRequirementsAndDateFilter() {
  var TEST_USER_ID = 't1180';   // ← 改成您的工號

  Logger.log('=== Step 1：確認 audienceRules 是否有寫入 ===');
  var reqSheet = _getRequirementSheet();
  var reqs = parseSheetData(reqSheet).filter(function(r) { return r.status === 'ACTIVE' && Number(r.academicYear) === 114; });
  reqs.forEach(function(r) {
    Logger.log('requirementId:' + r.requirementId + ' | name:' + r.name
      + ' | requiredHours:' + r.requiredHours
      + ' | audienceRules:' + (r.audienceRules || '(空)').slice(0, 60)
      + ' | startDate:' + r.startDate + ' | endDate:' + r.endDate);
  });

  Logger.log('\n=== Step 2：確認身分分類 ===');
  try {
    var hub      = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
    var uscSheet = hub.getSheetByName('UserStatusCache');
    if (!uscSheet) { Logger.log('❌ UserStatusCache 不存在'); return; }
    var uscData = uscSheet.getDataRange().getValues();
    var hdr     = uscData[0];
    Logger.log('UserStatusCache headers: ' + hdr.join(', '));
    var idCol = hdr.indexOf('userId'), jpCol = hdr.indexOf('jobPrimary');
    var ttCol = hdr.indexOf('title'), jtCol = hdr.indexOf('jobTask');
    var userRow = uscData.slice(1).find(function(r) { return String(r[idCol] || '').trim() === TEST_USER_ID; });
    if (!userRow) {
      Logger.log('❌ UserStatusCache 找不到 userId=' + TEST_USER_ID);
      Logger.log('前5筆 userId: ' + uscData.slice(1, 6).map(function(r) { return r[idCol]; }).join(', '));
    } else {
      var jp = jpCol >= 0 ? String(userRow[jpCol] || '') : '(無欄)';
      var tt = ttCol >= 0 ? String(userRow[ttCol] || '') : '(無欄)';
      var jt = jtCol >= 0 ? String(userRow[jtCol] || '') : '(無欄)';
      Logger.log('✅ 找到使用者 | jobPrimary:' + jp + ' | title:' + tt + ' | jobTask:' + jt);
      var identityGroup = _classifyIdentity_({ jobPrimary: jp, title: tt, jobTask: jt }, _loadIdentityRules_());
      Logger.log('身分分類結果：' + identityGroup);
    }
  } catch (e) {
    Logger.log('❌ Step 2 失敗：' + e.message);
  }

  Logger.log('\n=== Step 3：確認交通安全記錄的日期過濾 ===');
  try {
    var ss          = SpreadsheetApp.openById(TRAINING_SS_ID);
    var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
    var iData       = importSheet.getDataRange().getValues();
    var iHdr        = iData[0];
    Logger.log('ImportedData headers: ' + iHdr.join(', '));
    var iNmCol = iHdr.indexOf('teacherName'), iTtCol = iHdr.indexOf('title');
    var iDtCol = iHdr.indexOf('date'), iHrCol = iHdr.indexOf('hours');

    // 找測試使用者的交通安全紀錄
    var testName = null;
    var hub2 = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
    var usc2 = hub2.getSheetByName('UserStatusCache');
    if (usc2) {
      var ud = usc2.getDataRange().getValues();
      var uh = ud[0];
      var uIdC = uh.indexOf('userId'), uNmC = uh.indexOf('name');
      var ur = ud.slice(1).find(function(r) { return String(r[uIdC] || '').trim() === TEST_USER_ID; });
      if (ur) testName = String(ur[uNmC] || '').trim();
    }
    Logger.log('測試姓名：' + (testName || '(查無)'));

    // 找交通安全相關任務的所有關鍵字
    var trafficReqs = reqs.filter(function(r) { return r.requirementId === 'RQ114006' || r.requirementId === 'RQ114013'; });
    var allTrafficKws = [];
    trafficReqs.forEach(function(r) {
      var kws = [];
      try { kws = r.matchKeywords ? JSON.parse(r.matchKeywords) : []; } catch(e) {}
      Logger.log(r.requirementId + '(' + r.name + ') matchKeywords: ' + JSON.stringify(kws));
      kws.forEach(function(kw) { if (allTrafficKws.indexOf(kw) < 0) allTrafficKws.push(kw); });
    });
    Logger.log('所有交通安全關鍵字: ' + JSON.stringify(allTrafficKws));

    // 用完整關鍵字清單搜尋
    var matched = iData.slice(1).filter(function(r) {
      if (String(r[iNmCol] || '').trim() !== testName) return false;
      var title = String(r[iTtCol] || '');
      return allTrafficKws.some(function(kw) { return title.indexOf(kw) >= 0; });
    });
    Logger.log('所有交通安全關鍵字命中筆數：' + matched.length + '（含跨年度）');
    matched.forEach(function(r) {
      var rawDate = r[iDtCol];
      var recTs   = rawDate instanceof Date ? rawDate.getTime() : (isNaN(new Date(String(rawDate)).getTime()) ? null : new Date(String(rawDate)).getTime());
      Logger.log('  recYear:' + r[iHdr.indexOf('academicYear')] + ' | 日期:' + rawDate + ' | recTs:' + recTs + ' | 時數:' + r[iHrCol] + ' | 課名:' + String(r[iTtCol]).slice(0,30));
    });

    // 確認 endTs for RQ114006 並模擬過濾
    var rq6 = reqs.find(function(r) { return r.requirementId === 'RQ114006'; });
    if (rq6) {
      var ep = String(rq6.endDate || '').replace(/-/g, '/').split('/').map(Number);
      var endTs = ep.length >= 3 ? new Date(ep[0], ep[1]-1, ep[2], 23, 59, 59).getTime() : null;
      var sp6 = String(rq6.startDate || '').replace(/-/g, '/').split('/').map(Number);
      var startTs = sp6.length >= 3 ? new Date(sp6[0], sp6[1]-1, sp6[2]).getTime() : null;
      Logger.log('RQ114006 endDate:' + rq6.endDate + ' → endTs:' + endTs + ' (' + (endTs ? new Date(endTs) : 'null') + ')');
      var totalFiltered = 0;
      matched.forEach(function(r) {
        if (Number(r[iHdr.indexOf('academicYear')]) !== 114) return;
        var rawDate = r[iDtCol];
        var recTs = rawDate instanceof Date ? rawDate.getTime() : null;
        var passStart = startTs === null || recTs === null || recTs >= startTs;
        var passEnd   = endTs   === null || recTs === null || recTs <= endTs;
        Logger.log('  過濾模擬：課名:' + String(r[iTtCol]).slice(0,20) + ' | passStart:' + passStart + ' | passEnd:' + passEnd + ' | 計入:' + (passStart && passEnd));
        if (passStart && passEnd) totalFiltered += parseFloat(r[iHrCol]) || 0;
      });
      Logger.log('模擬正確結果：RQ114006（上學期）應計入時數 = ' + totalFiltered);
    }
  } catch (e) {
    Logger.log('❌ Step 3 失敗：' + e.message);
  }
}

/**
 * 取得指定年度+模式的伺服器快取
 * 回傳 { success: true, data: { statsData, cachedAt } } 或 { success: true, data: null }
 */
function getStatsCache(academicYear, mode) {
  try {
    var key   = _statsCacheKey_(academicYear, mode);
    var ss    = SpreadsheetApp.openById(TRAINING_SS_ID);
    var sheet = ss.getSheetByName(STATS_CACHE_SHEET);
    if (!sheet) return _ok(null);
    var rows = sheet.getDataRange().getValues();
    // 標題列：cacheKey | cachedAt | data
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === key) {
        var parsed = JSON.parse(String(rows[i][2] || 'null'));
        return _ok({ statsData: parsed, cachedAt: String(rows[i][1]) });
      }
    }
    return _ok(null);
  } catch (e) {
    return _ok(null);  // 快取讀取失敗不影響主流程
  }
}

/** 寫入或更新一筆伺服器快取（內部呼叫） */
function saveStatsCache_(academicYear, mode, statsData) {
  try {
    var key  = _statsCacheKey_(academicYear, mode);
    var ts   = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm');
    var json = JSON.stringify(statsData);
    var ss   = SpreadsheetApp.openById(TRAINING_SS_ID);
    var sheet = ss.getSheetByName(STATS_CACHE_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(STATS_CACHE_SHEET);
      sheet.getRange(1, 1, 1, 3).setValues([['cacheKey', 'cachedAt', 'data']]);
    }
    var rows = sheet.getDataRange().getValues();
    var found = -1;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === key) { found = i; break; }
    }
    if (found >= 0) {
      rows[found] = [key, ts, json];
    } else {
      rows.push([key, ts, json]);
    }
    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  } catch (e) { /* 快取寫入失敗不中斷主流程 */ }
}

/** 清除指定學年度所有模式的伺服器快取（匯入新資料後呼叫） */
function clearStatsCache_(academicYear) {
  try {
    var prefix = String(academicYear) + '_';
    var ss     = SpreadsheetApp.openById(TRAINING_SS_ID);
    var sheet  = ss.getSheetByName(STATS_CACHE_SHEET);
    if (!sheet) return;
    var rows = sheet.getDataRange().getValues();
    var kept = [rows[0]].concat(rows.slice(1).filter(function(r) {
      return String(r[0]).indexOf(prefix) !== 0;
    }));
    sheet.clearContents();
    if (kept.length > 0) sheet.getRange(1, 1, kept.length, 3).setValues(kept);
  } catch (e) { /* 失敗不中斷 */ }
}

function _statsCacheKey_(academicYear, mode) {
  return String(academicYear) + '_' + (mode === 'year' ? 'year' : 'cumulative');
}

/**
 * 批次預計算：依序執行多個年度+模式組合，結果自動寫入 StatsCache
 * body.combinations = [{ academicYear: 114, mode: 'cumulative' }, ...]
 * 在同一次 GAS 執行中完成（修掉 Bug 後每組合約 5–10 秒，10 組合 < 2 分鐘，安全）
 */
function batchCalcStats(body) {
  try {
    var combinations = body.combinations || [];
    if (combinations.length === 0) return _err('combinations 為必填');
    var results = [];
    combinations.forEach(function(c) {
      var res = calcStats(Number(c.academicYear), c.mode);  // 內含 saveStatsCache_()
      results.push({
        academicYear: c.academicYear,
        mode:         c.mode,
        success:      res.success,
        error:        res.error || null
      });
    });
    var failed = results.filter(function(r) { return !r.success; });
    return _ok({ results: results, failedCount: failed.length });
  } catch (e) {
    return _err('batchCalcStats 失敗：' + e.message);
  }
}

// ==================== F3：達成率計算 ====================

/**
 * mode = 'year'        → 只計算該學年度的研習紀錄（每年重算型指標）
 * mode = 'cumulative'  → 累積至該學年度的所有紀錄（終身有效型指標，預設）
 */
function calcStats(academicYear, mode) {
  try {
    academicYear = Number(academicYear || _currentAcademicYear());
    mode = (mode === 'year') ? 'year' : 'cumulative';  // 預設 cumulative
    var ss = SpreadsheetApp.openById(TRAINING_SS_ID);

    // Step 1：讀取 TeacherSnapshot，建立教師 Map
    var snapSheet = ss.getSheetByName(TEACHER_SNAPSHOT_SHEET);
    if (!snapSheet) return _err('TeacherSnapshot 工作表不存在，請先執行名冊快照');
    var snapData  = snapSheet.getDataRange().getValues();
    var sHdr      = snapData[0];
    var sYearCol  = sHdr.indexOf('academicYear');
    var sNameCol  = sHdr.indexOf('teacherName');
    var sDeptCol  = sHdr.indexOf('department');
    var sJobCol   = sHdr.indexOf('jobPrimary');

    var teacherMap = {};   // { name → { department, jobPrimary } }
    var VALID_DEPT = ['高中部', '國中部'];
    // jobPrimary 過濾：使用 _isTeacherJob_() 關鍵字比對，相容完整職稱格式

    snapData.slice(1).forEach(function(r) {
      if (Number(r[sYearCol]) !== academicYear) return;
      var dept = String(r[sDeptCol] || '').trim();
      var job  = String(r[sJobCol]  || '').trim();
      if (!VALID_DEPT.includes(dept)) return;
      if (!_isTeacherJob_(job)) return;  // 兼課、行政等排除
      teacherMap[String(r[sNameCol]).trim()] = { department: dept, jobPrimary: job };
    });

    var allNames = Object.keys(teacherMap);
    var totalHS  = allNames.filter(function(n) { return teacherMap[n].department === '高中部'; }).length;
    var totalJH  = allNames.filter(function(n) { return teacherMap[n].department === '國中部'; }).length;
    var total    = allNames.length;

    // Step 2：讀取 ImportedData，建立研習 Map
    var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
    var trainingMap = {};  // { teacherName → [title] }（只取 hours > 0 的列）
    if (importSheet) {
      var iData    = importSheet.getDataRange().getValues();
      var iHdr     = iData[0];
      var iYearCol = iHdr.indexOf('academicYear');
      var iNameCol = iHdr.indexOf('teacherName');
      var iTitleCol= iHdr.indexOf('title');
      var iHrsCol  = iHdr.indexOf('hours');
      iData.slice(1).forEach(function(r) {
        var recYear = Number(r[iYearCol]);
        // year：只取當學年度；cumulative：取截至該學年度的所有紀錄
        if (mode === 'year' ? recYear !== academicYear : recYear > academicYear) return;
        if (parseFloat(r[iHrsCol]) <= 0) return;
        var name  = String(r[iNameCol] || '').trim();
        var title = String(r[iTitleCol] || '').trim();
        if (!trainingMap[name]) trainingMap[name] = [];
        trainingMap[name].push(title);
      });
    }

    // Step 3：取得指標規則
    var props    = PropertiesService.getScriptProperties();
    var raw      = props.getProperty(INDICATOR_RULES_KEY);
    var rules    = raw ? JSON.parse(raw) : DEFAULT_INDICATORS_;

    // Step 4：逐指標計算
    var result = rules.map(function(rule) {
      var passedSchool = 0, passedHS = 0, passedJH = 0;
      var pendingList  = [];

      allNames.forEach(function(name) {
        var dept    = teacherMap[name].department;
        var titles  = trainingMap[name] || [];
        // 同指標多場研習只計一次（Set 去重）
        var matched = false;
        for (var i = 0; i < titles.length; i++) {
          var tags = parseIndicators_(titles[i], rules);  // 傳入已載入的 rules，避免重複讀 PropertiesService
          if (tags.indexOf(rule.id) >= 0) { matched = true; break; }
        }
        if (matched) {
          passedSchool++;
          if (dept === '高中部') passedHS++;
          else                   passedJH++;
        } else {
          pendingList.push({ name: name, department: dept });
        }
      });

      return {
        id:    rule.id,
        label: rule.label,
        school: { passed: passedSchool, total: total,   rate: total   ? Math.round(passedSchool / total   * 100) : 0 },
        hs:     { passed: passedHS,     total: totalHS, rate: totalHS ? Math.round(passedHS     / totalHS * 100) : 0 },
        jh:     { passed: passedJH,     total: totalJH, rate: totalJH ? Math.round(passedJH     / totalJH * 100) : 0 },
        pendingList: pendingList
      };
    });

    var resultData = { academicYear: academicYear, mode: mode, stats: result, totals: { school: total, hs: totalHS, jh: totalJH } };
    saveStatsCache_(academicYear, mode, resultData);  // 同步寫入伺服器快取
    return _ok(resultData);
  } catch (e) {
    return _err('calcStats 失敗：' + e.message);
  }
}

// ==================== F4-a：雙欄審查 CSV ====================

function exportDoubleColumnCSV(academicYear) {
  try {
    academicYear = Number(academicYear || _currentAcademicYear());
    var statsRes = calcStats(academicYear);
    if (!statsRes.success) return statsRes;

    var ss        = SpreadsheetApp.openById(TRAINING_SS_ID);
    var snapSheet = ss.getSheetByName(TEACHER_SNAPSHOT_SHEET);
    if (!snapSheet) return _err('TeacherSnapshot 不存在');

    // 讀取該學年度教師清單（保持原始順序）
    var snapData  = snapSheet.getDataRange().getValues();
    var sHdr      = snapData[0];
    var sYearCol  = sHdr.indexOf('academicYear');
    var sNameCol  = sHdr.indexOf('teacherName');
    var sDeptCol  = sHdr.indexOf('department');
    var sJobCol   = sHdr.indexOf('jobPrimary');

    var VALID_DEPT = ['高中部', '國中部'];
    // jobPrimary 過濾：使用 _isTeacherJob_() 關鍵字比對
    var teachers   = [];
    snapData.slice(1).forEach(function(r) {
      if (Number(r[sYearCol]) !== academicYear) return;
      var dept = String(r[sDeptCol] || '').trim();
      var job  = String(r[sJobCol]  || '').trim();
      if (!VALID_DEPT.includes(dept)) return;
      if (!_isTeacherJob_(job)) return;  // 兼課、行政等排除
      teachers.push({ name: String(r[sNameCol]).trim(), department: dept, jobPrimary: job || dept });
    });

    // 建立教師 → 通過指標字串 Map
    var statsMap = {};
    statsRes.data.stats.forEach(function(s) {
      s.pendingList.forEach(function(p) { /* 反推通過者 */ });
    });

    // 直接從 calcStats 的 stats 重組每位教師通過的指標列表
    var passMap = {};
    teachers.forEach(function(t) { passMap[t.name] = []; });

    var props  = PropertiesService.getScriptProperties();
    var raw    = props.getProperty(INDICATOR_RULES_KEY);
    var rules  = raw ? JSON.parse(raw) : DEFAULT_INDICATORS_;

    // 讀 ImportedData 重算（避免反推邏輯複雜）
    var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
    if (importSheet) {
      var iData     = importSheet.getDataRange().getValues();
      var iHdr      = iData[0];
      var iYearCol  = iHdr.indexOf('academicYear');
      var iNameCol  = iHdr.indexOf('teacherName');
      var iTitleCol = iHdr.indexOf('title');
      var iHrsCol   = iHdr.indexOf('hours');
      iData.slice(1).forEach(function(r) {
        if (Number(r[iYearCol]) !== academicYear) return;
        if (parseFloat(r[iHrsCol]) <= 0) return;
        var name = String(r[iNameCol] || '').trim();
        if (!passMap.hasOwnProperty(name)) return;
        var tags = parseIndicators_(String(r[iTitleCol] || ''), rules);
        tags.forEach(function(tag) {
          if (passMap[name].indexOf(tag) < 0) passMap[name].push(tag);
        });
      });
    }

    // 依預設順序排序每位教師的指標
    var order = rules.map(function(r) { return r.id; });
    Object.keys(passMap).forEach(function(name) {
      passMap[name].sort(function(a, b) { return order.indexOf(a) - order.indexOf(b); });
    });

    // 平分左右兩欄
    var mid   = Math.ceil(teachers.length / 2);
    var left  = teachers.slice(0, mid);
    var right = teachers.slice(mid);

    var lines = ['﻿職稱,姓名,通過研習,職稱,姓名,通過研習'];
    for (var i = 0; i < mid; i++) {
      var l = left[i]  || {};
      var r = right[i] || {};
      var lTags = l.name ? passMap[l.name].join('.') : '';
      var rTags = r.name ? passMap[r.name].join('.') : '';
      var lJob  = l.jobPrimary || '';
      var rJob  = r.jobPrimary || '';
      lines.push([
        '"' + lJob       + '","' + (l.name || '') + '","' + lTags + '"',
        '"' + rJob       + '","' + (r.name || '') + '","' + rTags + '"'
      ].join(','));
    }

    var csvContent = lines.join('\n');
    var fileName   = academicYear + '學年度_全校研習達成率審查.csv';

    // 儲存至 Drive 並回傳下載連結
    var folder = DriveApp.getFolderById(TRAINING_DRIVE_ROOT_FOLDER_ID);
    var file   = folder.createFile(fileName, csvContent, MimeType.PLAIN_TEXT);
    file.setName(fileName);

    return _ok({ downloadUrl: file.getDownloadUrl(), fileName: fileName });
  } catch (e) {
    return _err('exportDoubleColumnCSV 失敗：' + e.message);
  }
}

// ==================== F4-b：Google 文件公文 ====================

function generateGoogleDoc(academicYear) {
  try {
    academicYear = Number(academicYear || _currentAcademicYear());
    if (!REPORT_DOC_TEMPLATE_ID) return _err('REPORT_DOC_TEMPLATE_ID 尚未設定，請先建立 Google 文件範本並填入 Schema.gs');

    var statsRes = calcStats(academicYear);
    if (!statsRes.success) return statsRes;
    var stats    = statsRes.data.stats;
    var totals   = statsRes.data.totals;

    // 複製範本
    var templateFile = DriveApp.getFileById(REPORT_DOC_TEMPLATE_ID);
    var today        = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd');
    var docName      = academicYear + '學年度_研習達成率審查簽呈_' + today;
    var newFile      = templateFile.makeCopy(docName, DriveApp.getFolderById(TRAINING_DRIVE_ROOT_FOLDER_ID));
    var doc          = DocumentApp.openById(newFile.getId());
    var body         = doc.getBody();

    // 學年度顯示（民國年）
    var rocYear = academicYear;

    // 替換簡單文字佔位符
    var replacements = {
      '{{學校全名}}': SCHOOL_NAME,
      '{{發文日期}}': '中華民國' + (new Date().getFullYear() - 1911) + '年' +
                      (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日',
      '{{學年度}}':   rocYear + '學年度',
      '{{總人數}}':   String(totals.school),
      '{{校長姓名}}': PRINCIPAL_NAME || '○○○',
      '{{字號}}':     ''
    };
    Object.keys(replacements).forEach(function(key) {
      body.replaceText(key, replacements[key]);
    });

    // 替換 {{統計表格}}：找到段落後刪除，插入表格
    var paragraphs = body.getParagraphs();
    var insertIdx  = -1;
    for (var i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i].getText().indexOf('{{統計表格}}') >= 0) {
        insertIdx = i;
        break;
      }
    }

    if (insertIdx >= 0) {
      // 取前 10 筆教師達成資料（從 ImportedData 重建）
      var ss          = SpreadsheetApp.openById(TRAINING_SS_ID);
      var snapSheet   = ss.getSheetByName(TEACHER_SNAPSHOT_SHEET);
      var snapData    = snapSheet ? snapSheet.getDataRange().getValues() : [[]];
      var sHdr        = snapData[0] || [];
      var sYearCol    = sHdr.indexOf('academicYear');
      var sNameCol    = sHdr.indexOf('teacherName');
      var sJobCol     = sHdr.indexOf('jobPrimary');

      var teachers10  = [];
      (snapData.slice(1) || []).forEach(function(r) {
        if (Number(r[sYearCol]) === academicYear && teachers10.length < 10) {
          teachers10.push({ name: String(r[sNameCol] || ''), job: String(r[sJobCol] || '') });
        }
      });

      // 建立教師通過指標 Map（重用 passMap 邏輯）
      var passMap10 = {};
      teachers10.forEach(function(t) { passMap10[t.name] = []; });
      var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
      if (importSheet) {
        var iData2    = importSheet.getDataRange().getValues();
        var iHdr2     = iData2[0];
        var iYC2      = iHdr2.indexOf('academicYear');
        var iNC2      = iHdr2.indexOf('teacherName');
        var iTC2      = iHdr2.indexOf('title');
        var iHC2      = iHdr2.indexOf('hours');
        iData2.slice(1).forEach(function(r) {
          if (Number(r[iYC2]) !== academicYear) return;
          if (parseFloat(r[iHC2]) <= 0) return;
          var name = String(r[iNC2] || '').trim();
          if (!passMap10.hasOwnProperty(name)) return;
          parseIndicators_(String(r[iTC2] || ''), rules).forEach(function(tag) {
            if (passMap10[name].indexOf(tag) < 0) passMap10[name].push(tag);
          });
        });
      }

      // 插入表格
      var tableData = [['序號', '行政職位', '教師姓名', '已通過政策標籤']];
      teachers10.forEach(function(t, idx) {
        tableData.push([
          String(idx + 1),
          t.job || '教師',
          t.name,
          passMap10[t.name].join('.')
        ]);
      });

      var tableEl = body.insertTable(insertIdx, tableData);
      // 刪除佔位符段落
      body.removeChild(paragraphs[insertIdx]);
    }

    doc.saveAndClose();
    return _ok({ docUrl: newFile.getUrl(), docName: docName });
  } catch (e) {
    return _err('generateGoogleDoc 失敗：' + e.message);
  }
}

// ==================== 身分分類規則管理 ====================

var IDENTITY_RULES_KEY_ = 'identityClassificationRules';

/**
 * 預設身分分類規則（依優先順序排列，先符合先套用）
 * type:   'jobTask_contains' | 'compound' | 'jobPrimary_equals' | 'jobPrimary_contains'
 * jobPrimary_contains：jobPrimary 欄位「包含」指定字串即命中（例：'正式教師'、'代理教師' 都包含 '教師'）
 * 若 type = 'compound'：jobPrimary 比對同樣採 contains 邏輯
 */
var DEFAULT_IDENTITY_RULES_ = [
  {
    priority: 1,
    group: '特教教師',
    type: 'jobTask_contains',
    value: ['特教教師']
  },
  {
    priority: 2,
    group: '相關專業人員',
    type: 'compound',
    jobPrimary: '行政人員',
    secondary: { type: 'jobTask_contains', value: ['職能治療', '物理治療', '語言治療'] }
  },
  {
    priority: 3,
    group: '教保員及助理員',
    type: 'compound',
    jobPrimary: '行政人員',
    secondary: { type: 'title_contains', value: ['輔導室教保員', '輔導室助理員'] }
  },
  {
    priority: 4,
    group: '相關行政人員',
    type: 'jobPrimary_equals',
    value: '行政人員'
  },
  {
    // jobPrimary 包含「教師」（正式教師/代理教師/代課教師等）但職稱不是一般教師 → 行政類研習時數
    priority: 5,
    group: '相關行政人員',
    type: 'compound',
    jobPrimary: '教師',
    secondary: {
      type: 'title_not_in',
      value: ['', '教師']
    }
  },
  {
    // jobPrimary 包含「教師」且職稱為一般教師 → 普通班教師
    priority: 6,
    group: '普通班教師',
    type: 'jobPrimary_contains',
    value: '教師'
  }
  // 兜底：以上皆不符合的在職帳號 → '全體教職員工'（在程式碼中處理）
];

/**
 * 從 PropertiesService 讀取身分分類規則；若尚未設定，寫入預設規則後回傳
 */
function _loadIdentityRules_() {
  var props = PropertiesService.getScriptProperties();
  var raw   = props.getProperty(IDENTITY_RULES_KEY_);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* 損毀則回傳預設 */ }
  }
  props.setProperty(IDENTITY_RULES_KEY_, JSON.stringify(DEFAULT_IDENTITY_RULES_));
  return DEFAULT_IDENTITY_RULES_.slice();
}

/**
 * 依規則判斷單一使用者的身分類別
 * user: { jobPrimary, title, jobTask }（均為字串）
 * 回傳身分類別字串，無法歸類者回傳 '全體教職員工'
 */
function _classifyIdentity_(user, rules) {
  var jp  = String(user.jobPrimary || '').trim();
  var ttl = String(user.title      || '').trim();
  var jt  = String(user.jobTask    || '').trim();

  var sorted = rules.slice().sort(function(a, b) { return a.priority - b.priority; });

  for (var i = 0; i < sorted.length; i++) {
    var rule = sorted[i];

    if (rule.type === 'jobTask_contains') {
      for (var v = 0; v < rule.value.length; v++) {
        if (jt.indexOf(rule.value[v]) >= 0) return rule.group;
      }
    } else if (rule.type === 'jobPrimary_equals') {
      if (jp === rule.value) return rule.group;
    } else if (rule.type === 'jobPrimary_contains') {
      // 例：'正式教師'、'代理教師' 都包含 '教師'
      if (jp.indexOf(rule.value) >= 0) return rule.group;
    } else if (rule.type === 'compound') {
      // compound 的 jobPrimary 比對採 contains，以相容「正式教師」等完整職稱
      if (jp.indexOf(rule.jobPrimary) < 0) continue;
      var sec = rule.secondary;
      if (sec.type === 'jobTask_contains') {
        for (var v2 = 0; v2 < sec.value.length; v2++) {
          if (jt.indexOf(sec.value[v2]) >= 0) return rule.group;
        }
      } else if (sec.type === 'title_contains') {
        for (var v3 = 0; v3 < sec.value.length; v3++) {
          if (ttl.indexOf(sec.value[v3]) >= 0) return rule.group;
        }
      } else if (sec.type === 'title_not_in') {
        // 職稱不在白名單內 → 命中此規則
        var inList = false;
        for (var v4 = 0; v4 < sec.value.length; v4++) {
          if (ttl === sec.value[v4]) { inList = true; break; }
        }
        if (!inList) return rule.group;
      }
    }
  }
  return '全體教職員工'; // 兜底
}

/**
 * Level 2 API：管理者儲存自訂身分分類規則
 * body.rules: 規則陣列（格式同 DEFAULT_IDENTITY_RULES_）
 */
function saveIdentityRules(body) {
  try {
    var rules = (body || {}).rules;
    if (!Array.isArray(rules) || rules.length === 0)
      return _err('rules 陣列為必填且不可為空');
    PropertiesService.getScriptProperties()
      .setProperty(IDENTITY_RULES_KEY_, JSON.stringify(rules));
    return _ok({ saved: rules.length });
  } catch (e) {
    return _err('saveIdentityRules 失敗：' + e.message);
  }
}

/**
 * 手動執行用：強制將 PropertiesService 的身分分類規則重設為程式碼中的預設值
 * 在 GAS 編輯器中直接執行此函式即可，無需傳入參數
 */
function resetIdentityRulesToDefault() {
  PropertiesService.getScriptProperties()
    .setProperty(IDENTITY_RULES_KEY_, JSON.stringify(DEFAULT_IDENTITY_RULES_));
  Logger.log('✅ 身分分類規則已重設為預設值，共 ' + DEFAULT_IDENTITY_RULES_.length + ' 條規則。');
  Logger.log(JSON.stringify(DEFAULT_IDENTITY_RULES_, null, 2));
}

/**
 * Level 2 API：取得目前的身分分類規則（含預設值）
 */
function getIdentityRules() {
  try {
    return _ok(_loadIdentityRules_());
  } catch (e) {
    return _err('getIdentityRules 失敗：' + e.message);
  }
}

// ==================== 年度任務達成率統計 ====================

/**
 * 計算指定學年度的年度任務達成率
 * 資料來源：Hub.UserStatusCache（人員） + TRAINING_REQUIREMENT（任務） + TRAINING_RECORD（已核准紀錄）
 *
 * 回傳格式：
 * {
 *   academicYear,
 *   requirements: [{
 *     requirementId, name, requiredHours, hoursNote, audienceRules,
 *     groups: [{
 *       group,          // 身分類別，'全體教職員工' 表示全員
 *       requiredHours,
 *       total,          // 分母（此類別在職人數）
 *       passed,         // 已達標人數
 *       rate,           // 達成率（0–100）
 *       pendingList: [{ userId, name, department, approvedHours }]
 *     }]
 *   }]
 * }
 */
function calcRequirementStats(body) {
  try {
    var academicYear = Number((body || {}).academicYear || _currentAcademicYear());

    // ── Step 1：從 Hub.UserStatusCache 讀取在職人員 ──
    var hub      = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
    var uscSheet = hub.getSheetByName('UserStatusCache');
    if (!uscSheet) return _err('Hub.UserStatusCache 工作表不存在');

    var uscData = uscSheet.getDataRange().getValues();
    var uHdr    = uscData[0];
    var uIdCol  = uHdr.indexOf('userId');
    var uNmCol  = uHdr.indexOf('name');
    var uDpCol  = uHdr.indexOf('department');
    var uStCol  = uHdr.indexOf('status');
    var uJpCol  = uHdr.indexOf('jobPrimary');
    var uTtCol  = uHdr.indexOf('title');
    var uJtCol  = uHdr.indexOf('jobTask');

    var ACTIVE_STATUS = ['在職', '轉調'];
    var identityRules = _loadIdentityRules_();

    var userMap  = {};  // { userId → user }
    var nameMap  = {};  // { name → [userId, ...] }（用於同名偵測）
    uscData.slice(1).forEach(function(r) {
      var uid    = String(r[uIdCol] || '').trim();
      var status = String(r[uStCol] || '').trim();
      if (!uid || !ACTIVE_STATUS.includes(status)) return;
      var user = {
        userId:      uid,
        name:        String(r[uNmCol] || '').trim(),
        department:  String(r[uDpCol] || '').trim(),
        jobPrimary:  uJpCol >= 0 ? String(r[uJpCol] || '').trim() : '',
        title:       uTtCol >= 0 ? String(r[uTtCol] || '').trim() : '',
        jobTask:     uJtCol >= 0 ? String(r[uJtCol] || '').trim() : ''
      };
      user.identityGroup = _classifyIdentity_(user, identityRules);
      userMap[uid] = user;
      if (user.name) {
        if (!nameMap[user.name]) nameMap[user.name] = [];
        nameMap[user.name].push(uid);
      }
    });

    var allUsers = Object.keys(userMap).map(function(k) { return userMap[k]; });

    // ── Step 2：讀取 TRAINING_REQUIREMENT ──
    var reqSheet     = _getRequirementSheet();
    var requirements = parseSheetData(reqSheet)
      .filter(function(r) { return r.status === 'ACTIVE' && Number(r.academicYear) === academicYear; });

    if (requirements.length === 0) return _ok({ academicYear: academicYear, requirements: [] });

    // ── Step 3：讀取 TRAINING_RECORD（APPROVED），建立 { userId_reqId → hours } ──
    var approvedMap = {};
    parseSheetData(_getRecordSheet())
      .filter(function(r) { return r.status === 'APPROVED' && r.requirementId; })
      .forEach(function(r) {
        var key = r.userId + '_' + r.requirementId;
        approvedMap[key] = (approvedMap[key] || 0) + (Number(r.hours) || 0);
      });

    // ── Step 4：讀取 ImportedData，建立 { name → [{ title, hours, date, source }] } ──
    var ss          = SpreadsheetApp.openById(TRAINING_SS_ID);
    var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
    var importedByName = {};  // { teacherName → [{ title, hours, academicYear }] }
    if (importSheet) {
      var iData    = importSheet.getDataRange().getValues();
      var iHdr     = iData[0];
      var iNmCol   = iHdr.indexOf('teacherName');
      var iTtCol   = iHdr.indexOf('title');
      var iHrCol   = iHdr.indexOf('hours');
      var iYrCol   = iHdr.indexOf('academicYear');
      iData.slice(1).forEach(function(r) {
        if (Number(r[iYrCol]) !== academicYear) return;
        var nm  = String(r[iNmCol] || '').trim();
        var hrs = parseFloat(r[iHrCol]) || 0;
        if (!nm || hrs <= 0) return;
        if (!importedByName[nm]) importedByName[nm] = [];
        importedByName[nm].push({ title: String(r[iTtCol] || '').trim(), hours: hrs });
      });
    }

    // ── 內部：關鍵字比對，回傳 ImportedData 中符合任務的累積時數 ──
    function _importedHoursFor_(userName, keywords) {
      var rows = importedByName[userName] || [];
      var total = 0;
      rows.forEach(function(rec) {
        var t = rec.title;
        for (var k = 0; k < keywords.length; k++) {
          if (t.indexOf(keywords[k]) >= 0) { total += rec.hours; break; }
        }
      });
      return total;
    }

    // ── Step 5：逐任務計算達成率（TRAINING_RECORD 與 ImportedData 取最大值，不重複計算）──
    var result = requirements.map(function(req) {
      var audienceRules = [];
      try { audienceRules = req.audienceRules ? JSON.parse(req.audienceRules) : []; } catch (e) {}

      var keywords = [];
      try { keywords = req.matchKeywords ? JSON.parse(req.matchKeywords) : []; } catch (e) {}

      var groups;
      if (audienceRules.length > 0) {
        groups = audienceRules.map(function(ar) { return { group: ar.group, requiredHours: Number(ar.hours) || 0 }; });
      } else {
        groups = [{ group: '全體教職員工', requiredHours: Number(req.requiredHours) || 0 }];
      }

      var groupResults = groups.map(function(g) {
        var isAllStaff = (g.group === '全體教職員工');
        var members = isAllStaff
          ? allUsers
          : allUsers.filter(function(u) { return u.identityGroup === g.group; });

        var passed  = 0;
        var pending = [];
        members.forEach(function(u) {
          var recordHours   = approvedMap[u.userId + '_' + req.requirementId] || 0;
          var importedHours = keywords.length > 0 ? _importedHoursFor_(u.name, keywords) : 0;
          // 同名衝突：若該姓名有多個 userId，匯入時數不確定歸屬，標記但仍計入（保守計算）
          var hasSameName   = (nameMap[u.name] || []).length > 1;
          var effectiveHours = Math.max(recordHours, importedHours);

          if (effectiveHours >= g.requiredHours) {
            passed++;
          } else {
            pending.push({
              userId:        u.userId,
              name:          u.name,
              department:    u.department,
              approvedHours: recordHours,
              importedHours: importedHours,
              hasSameName:   hasSameName
            });
          }
        });

        return {
          group:         g.group,
          requiredHours: g.requiredHours,
          total:         members.length,
          passed:        passed,
          rate:          members.length ? Math.round(passed / members.length * 100) : 0,
          pendingList:   pending
        };
      });

      return {
        requirementId: req.requirementId,
        name:          req.name,
        endDate:       req.endDate,
        hoursNote:     req.hoursNote,
        audienceRules: audienceRules,
        keywords:      keywords,
        groups:        groupResults
      };
    });

    return _ok({ academicYear: academicYear, requirements: result });
  } catch (e) {
    return _err('calcRequirementStats 失敗：' + e.message);
  }
}

// ==================== 教師端：查看已匯入紀錄 ====================

/**
 * 取得登入教師的已匯入研習紀錄（從 ImportedData，依姓名比對）
 * 同時標示每筆是否符合任一年度任務關鍵字
 * 回傳 { records: [...], hasSameName: bool, academicYear }
 */
function getMyImportedRecords(userId, body) {
  try {
    // academicYear 空字串或 0 → 全部年度（不篩選）
    var rawYear      = (body || {}).academicYear;
    var academicYear = (rawYear === '' || rawYear === 0 || rawYear === '0') ? null : Number(rawYear || _currentAcademicYear());

    // 取得教師姓名
    var hub      = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
    var uscSheet = hub.getSheetByName('UserStatusCache');
    if (!uscSheet) return _err('Hub.UserStatusCache 不存在');
    var uscData  = uscSheet.getDataRange().getValues();
    var uHdr     = uscData[0];
    var uIdCol   = uHdr.indexOf('userId');
    var uNmCol   = uHdr.indexOf('name');

    var myName = '';
    for (var i = 1; i < uscData.length; i++) {
      if (String(uscData[i][uIdCol] || '') === userId) {
        myName = String(uscData[i][uNmCol] || '').trim();
        break;
      }
    }
    if (!myName) return _err('找不到此帳號對應的姓名');

    // 偵測同名：計算相同姓名的 userId 數量
    var sameNameCount = uscData.slice(1).filter(function(r) {
      return String(r[uNmCol] || '').trim() === myName;
    }).length;
    var hasSameName = sameNameCount > 1;

    // 讀取 ImportedData
    var ss          = SpreadsheetApp.openById(TRAINING_SS_ID);
    var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
    if (!importSheet) return _ok({ records: [], hasSameName: hasSameName, academicYear: academicYear });

    var iData   = importSheet.getDataRange().getValues();
    var iHdr    = iData[0];
    var iNmCol  = iHdr.indexOf('teacherName');
    var iTtCol  = iHdr.indexOf('title');
    var iHrCol  = iHdr.indexOf('hours');
    var iYrCol  = iHdr.indexOf('academicYear');
    var iOgCol  = iHdr.indexOf('organizer');
    var iDtCol  = iHdr.indexOf('date');
    var iSrCol  = iHdr.indexOf('source');    // 來源（全國/臺北市）

    // 讀取年度任務關鍵字（全部年度模式下不篩年度，讓跨年資料也能對應任務）
    var requirements = parseSheetData(_getRequirementSheet())
      .filter(function(r) {
        if (r.status !== 'ACTIVE') return false;
        return academicYear === null || Number(r.academicYear) === academicYear;
      });
    var reqKeywords = requirements.map(function(r) {
      var kws = [];
      try { kws = r.matchKeywords ? JSON.parse(r.matchKeywords) : []; } catch (e) {}
      // 解析日期範圍，供分學期任務過濾（避免同關鍵字的上下學期重複計入）
      var startTs = null, endTs = null;
      if (r.startDate) {
        var sp = String(r.startDate).replace(/-/g, '/').split('/').map(Number);
        if (sp.length >= 3 && !isNaN(sp[0])) startTs = new Date(sp[0], sp[1]-1, sp[2]).getTime();
      }
      if (r.endDate) {
        var ep = String(r.endDate).replace(/-/g, '/').split('/').map(Number);
        if (ep.length >= 3 && !isNaN(ep[0])) endTs = new Date(ep[0], ep[1]-1, ep[2], 23, 59, 59).getTime();
      }
      return { requirementId: r.requirementId, name: r.name, keywords: kws, startTs: startTs, endTs: endTs };
    });

    var myRecords = [];
    iData.slice(1).forEach(function(r) {
      if (String(r[iNmCol] || '').trim() !== myName) return;
      var recYear = Number(r[iYrCol]);
      if (academicYear !== null && recYear !== academicYear) return;

      var title = String(r[iTtCol] || '').trim();
      var hours = parseFloat(r[iHrCol]) || 0;

      // 取得記錄日期的 timestamp（ImportedData 的 date 欄讀回可能是 Date 物件）
      var rawDate = iDtCol >= 0 ? r[iDtCol] : null;
      var recTs   = null;
      if (rawDate) {
        recTs = rawDate instanceof Date ? rawDate.getTime() : new Date(String(rawDate)).getTime();
        if (isNaN(recTs)) recTs = null;
      }

      // 比對符合哪些任務（關鍵字 + 若有日期範圍則同時驗證）
      var matchedReqs = reqKeywords
        .filter(function(rk) {
          if (!rk.keywords.some(function(kw) { return title.indexOf(kw) >= 0; })) return false;
          // 若任務有設定 startDate/endDate，則記錄日期必須在區間內
          if (recTs !== null) {
            if (rk.startTs !== null && recTs < rk.startTs) return false;
            if (rk.endTs   !== null && recTs > rk.endTs)   return false;
          }
          return true;
        })
        .map(function(rk) { return { requirementId: rk.requirementId, name: rk.name }; });

      myRecords.push({
        title:       title,
        hours:       hours,
        date:        iDtCol >= 0 ? String(r[iDtCol] || '') : '',
        organizer:   iOgCol >= 0 ? String(r[iOgCol] || '') : '',
        source:      iSrCol >= 0 ? String(r[iSrCol] || '') : '',
        matchedReqs: matchedReqs
      });
    });

    // 依日期降冪排序
    myRecords.sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });

    return _ok({ records: myRecords, hasSameName: hasSameName, myName: myName, academicYear: academicYear });
  } catch (e) {
    return _err('getMyImportedRecords 失敗：' + e.message);
  }
}

// ==================== 送出前重複提醒 ====================

/**
 * 教師選定任務後，查詢 ImportedData 是否已有符合的紀錄
 * 回傳 { matched: bool, records: [...], totalHours, requiredHours }
 */
function checkImportedBeforeSubmit(userId, body) {
  try {
    var requirementId = (body || {}).requirementId;
    if (!requirementId) return _err('requirementId 為必填');

    var academicYear = Number((body || {}).academicYear || _currentAcademicYear());

    // 取得教師姓名
    var hub      = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
    var uscSheet = hub.getSheetByName('UserStatusCache');
    var uscData  = uscSheet.getDataRange().getValues();
    var uHdr     = uscData[0];
    var uIdCol   = uHdr.indexOf('userId');
    var uNmCol   = uHdr.indexOf('name');
    var myName   = '';
    for (var i = 1; i < uscData.length; i++) {
      if (String(uscData[i][uIdCol] || '') === userId) {
        myName = String(uscData[i][uNmCol] || '').trim();
        break;
      }
    }
    if (!myName) return _ok({ matched: false, records: [], totalHours: 0 });

    // 取得此任務的關鍵字與應達時數
    var reqData = parseSheetData(_getRequirementSheet())
      .find(function(r) { return r.requirementId === requirementId; });
    if (!reqData) return _ok({ matched: false, records: [], totalHours: 0 });

    var keywords = [];
    try { keywords = reqData.matchKeywords ? JSON.parse(reqData.matchKeywords) : []; } catch (e) {}
    if (keywords.length === 0) return _ok({ matched: false, records: [], totalHours: 0 });

    // 查 ImportedData
    var ss          = SpreadsheetApp.openById(TRAINING_SS_ID);
    var importSheet = ss.getSheetByName(IMPORTED_DATA_SHEET);
    if (!importSheet) return _ok({ matched: false, records: [], totalHours: 0 });

    var iData  = importSheet.getDataRange().getValues();
    var iHdr   = iData[0];
    var iNmCol = iHdr.indexOf('teacherName');
    var iTtCol = iHdr.indexOf('title');
    var iHrCol = iHdr.indexOf('hours');
    var iYrCol = iHdr.indexOf('academicYear');
    var iDtCol = iHdr.indexOf('date');
    var iOgCol = iHdr.indexOf('organizer');

    var matched = [];
    iData.slice(1).forEach(function(r) {
      if (String(r[iNmCol] || '').trim() !== myName) return;
      if (Number(r[iYrCol]) !== academicYear) return;
      var title = String(r[iTtCol] || '').trim();
      var hrs   = parseFloat(r[iHrCol]) || 0;
      if (hrs <= 0) return;
      for (var k = 0; k < keywords.length; k++) {
        if (title.indexOf(keywords[k]) >= 0) {
          matched.push({
            title:     title,
            hours:     hrs,
            date:      iDtCol >= 0 ? String(r[iDtCol] || '') : '',
            organizer: iOgCol >= 0 ? String(r[iOgCol] || '') : ''
          });
          break;
        }
      }
    });

    var totalHours    = matched.reduce(function(s, r) { return s + r.hours; }, 0);
    var requiredHours = Number(reqData.requiredHours) || 0;

    return _ok({
      matched:       matched.length > 0,
      records:       matched,
      totalHours:    totalHours,
      requiredHours: requiredHours,
      requirementName: reqData.name
    });
  } catch (e) {
    return _err('checkImportedBeforeSubmit 失敗：' + e.message);
  }
}
