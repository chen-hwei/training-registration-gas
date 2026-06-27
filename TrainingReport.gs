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

// ==================== F3-cache：伺服器端統計快取 ====================

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
