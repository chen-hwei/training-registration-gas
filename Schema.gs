// ==================== 系統常數（部署後填入實際 ID） ====================
// 優先讀取 Script Properties（GAS 編輯器 → 專案設定 → 指令碼屬性），讀不到時 fallback 回下方常數（P1-a 新增，2026-07-19）
const TRAINING_SS_ID_FALLBACK                = '1Wx9ccA2rfH5HB1kVB4QlUIvTS7zVmbcklHFOJI6Xj6Y';
const TRAINING_DRIVE_ROOT_FOLDER_ID_FALLBACK = '1YoGvcZqlHFZdqyZdNlIuoo3a0wQ_Z1um';
const HUB_SPREADSHEET_ID_FALLBACK            = '10CkSP4jGDh6Tfitljl69AJ256gV46TdGnaN170gE6BQ';

// ==================== Script Properties 共用讀取層（P1-a 新增，2026-07-19）====================
// 單次執行內最多 1 次 getProperties() 整包讀取＋memoize，供下方各 getter 共用
let _configPropsCache_ = null;
function _configProps_() {
  if (_configPropsCache_) return _configPropsCache_;
  _configPropsCache_ = PropertiesService.getScriptProperties().getProperties();
  return _configPropsCache_;
}

let _trainingSsIdCache_ = null;
function getTrainingSsId_() {
  if (_trainingSsIdCache_) return _trainingSsIdCache_;
  _trainingSsIdCache_ = _configProps_()['TRAINING_SS_ID'] || TRAINING_SS_ID_FALLBACK;
  return _trainingSsIdCache_;
}

let _trainingDriveRootFolderIdCache_ = null;
function getTrainingDriveRootFolderId_() {
  if (_trainingDriveRootFolderIdCache_) return _trainingDriveRootFolderIdCache_;
  _trainingDriveRootFolderIdCache_ = _configProps_()['TRAINING_DRIVE_ROOT_FOLDER_ID'] || TRAINING_DRIVE_ROOT_FOLDER_ID_FALLBACK;
  return _trainingDriveRootFolderIdCache_;
}

let _hubSpreadsheetIdCache_ = null;
function getHubSpreadsheetId_() {
  if (_hubSpreadsheetIdCache_) return _hubSpreadsheetIdCache_;
  _hubSpreadsheetIdCache_ = _configProps_()['HUB_SPREADSHEET_ID'] || HUB_SPREADSHEET_ID_FALLBACK;
  return _hubSpreadsheetIdCache_;
}

// ==================== Web App 絕對 URL（前端導覽用）====================
// 必須使用含 /a/macros/zlsh.tp.edu.tw/ 的 Workspace 域 URL
// 此值會透過 doGet() template.appBaseUrl 注入前端，供 _navigate() 使用
// 優先讀取 Script Properties（重新部署後到 GAS 編輯器「專案設定 → 指令碼屬性」改值即可，程式碼零異動）
// 讀不到 Script Properties 時 fallback 回下方常數
const WEB_APP_BASE_URL_FALLBACK = 'https://script.google.com/a/macros/zlsh.tp.edu.tw/s/AKfycbx9kbkwBcxy8XnoqIBuiUF36UGUKjaTWOA87BoKK72JO_hvE4kqxfotLmEHadWkOXAu6g/exec';

let _webAppBaseUrlCache = null;
function getWebAppBaseUrl_() {
  if (_webAppBaseUrlCache) return _webAppBaseUrlCache;
  _webAppBaseUrlCache = _configProps_()['WEB_APP_BASE_URL'] || WEB_APP_BASE_URL_FALLBACK;
  return _webAppBaseUrlCache;
}

// ==================== 通知信寄件識別（任務 13-A）====================
// 系統顯示名稱（MailApp sendEmail 的 name 欄）
const SYSTEM_MAIL_NAME = '研習登錄系統';

// 回信地址：優先讀 Script Properties「MAIL_REPLY_TO」（GAS 編輯器 → 專案設定 → 指令碼屬性）
// 讀不到時 fallback 回目前執行帳號的信箱，避免因忘記設定屬性而寄信失敗
let _mailReplyToCache = null;
function getMailReplyTo_() {
  if (_mailReplyToCache) return _mailReplyToCache;
  _mailReplyToCache = _configProps_()['MAIL_REPLY_TO'] || Session.getEffectiveUser().getEmail();
  return _mailReplyToCache;
}

// ==================== SHEET_SCHEMA ====================
// headers：試算表第一列的中文標題（唯一來源）
// keys   ：前後端程式碼使用的英文 Key（與 headers 一一對應）
const SHEET_SCHEMA = {
  TRAINING_CATALOG: {
    name: 'TRAINING_CATALOG',
    headers: [
      '課程編號', '課程名稱', '研習時數', '主辦單位', '推薦處室', '建立者',
      '開始日期', '結束日期', '課程說明', '研習對象', '相關連結', '是否必修', '狀態', '建立時間',
      '關聯任務編號'
    ],
    keys: [
      'catalogId', 'title', 'hours', 'organizer', 'department', 'createdBy',
      'startDate', 'endDate', 'description', 'targetAudience', 'link', 'isRequired', 'status', 'createdAt',
      'requirementId'
    ]
  },
  TRAINING_RECORD: {
    name: 'TRAINING_RECORD',
    headers: [
      '紀錄編號', '教師 ID', '課程編號', '研習名稱', '研習時數', '是否自訂',
      '研習日期', '主辦單位', 'Drive 檔案 ID', '原始檔名', '審核狀態',
      '審核者', '退件原因', '審核時間', '送出時間', '補件自', '任務編號'
    ],
    keys: [
      'recordId', 'userId', 'catalogId', 'title', 'hours', 'isCustom',
      'trainingDate', 'organizer', 'fileId', 'fileName', 'status',
      'reviewedBy', 'reviewNote', 'reviewedAt', 'submittedAt', 'resubmitOf', 'requirementId'
    ]
  },
  TRAINING_REQUIREMENT: {
    name: 'TRAINING_REQUIREMENT',
    headers: [
      '任務編號', '任務名稱', '主責單位', '學年度',
      '開始日期', '截止日期', '所需時數', '時數說明',
      '研習形式', '分學期計算', '備註說明', '推薦連結',
      '是否循環', '狀態', '建立時間', '分眾時數規則', '比對關鍵字',
      '教師公告', '適用對象'
    ],
    keys: [
      'requirementId', 'name', 'owner', 'academicYear',
      'startDate', 'endDate', 'requiredHours', 'hoursNote',
      'deliveryType', 'semesterSplit', 'notes', 'links',
      'isRecurring', 'status', 'createdAt', 'audienceRules', 'matchKeywords',
      'teacherNote', 'targetAudience'
    ]
  }
};

// ==================== 工作表存取輔助 ====================

function _getTrainingSheet(sheetName) {
  const ss = SpreadsheetApp.openById(getTrainingSsId_());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('工作表不存在：' + sheetName);
  return sheet;
}

function _getCatalogSheet()      { return _getTrainingSheet(SHEET_SCHEMA.TRAINING_CATALOG.name);     }
function _getRecordSheet()       { return _getTrainingSheet(SHEET_SCHEMA.TRAINING_RECORD.name);      }
function _getRequirementSheet()  { return _getTrainingSheet(SHEET_SCHEMA.TRAINING_REQUIREMENT.name); }

// ==================== 資料讀寫工具 ====================

/**
 * 將工作表資料（不含標題列）依 SHEET_SCHEMA 解析為英文 Key 的物件陣列
 * 以工作表名稱自動比對 SHEET_SCHEMA
 */
function parseSheetData(sheet) {
  const schema = SHEET_SCHEMA[sheet.getName()];
  if (!schema) throw new Error('SHEET_SCHEMA 找不到：' + sheet.getName());
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null && cell !== undefined))
    .map(row => {
      const obj = {};
      schema.keys.forEach((key, i) => {
        let val = (row[i] !== undefined && row[i] !== null) ? row[i] : '';
        // ⚠️ GAS 地雷：日期格式儲存格 getValues() 回傳 JS Date 物件
        // google.script.run postMessage 無法序列化 Date → result 變 null → 靜默白屏
        // 必須在此強制轉為字串
        if (val instanceof Date) {
          // submittedAt / reviewedAt 含時間，必須保留 HH:mm:ss 才能做新舊比較
          const timeKeys = ['submittedAt', 'reviewedAt', 'createdAt', 'updatedAt', 'borrowTime', 'returnTime', 'lentAt'];
          const fmt = timeKeys.indexOf(key) !== -1
            ? 'yyyy-MM-dd HH:mm:ss'
            : 'yyyy-MM-dd';
          val = Utilities.formatDate(val, 'Asia/Taipei', fmt);
        }
        obj[key] = val;
      });
      return obj;
    });
}

/**
 * 確保工作表存在且第一列為標準中文標題列
 * - 工作表不存在時自動建立（Phase 0 初始化情境）
 * - 已存在時直接覆寫第一列標題（修復/更新情境）
 * - 絕不使用 insertRow，以免產生雙標題行
 */
function ensureSheetHeaders(sheetName) {
  const schema = SHEET_SCHEMA[sheetName];
  if (!schema) throw new Error('SHEET_SCHEMA 找不到：' + sheetName);

  const ss = SpreadsheetApp.openById(getTrainingSsId_());
  let sheet = ss.getSheetByName(sheetName);

  // 工作表不存在時自動建立
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    Logger.log('已建立工作表：' + sheetName);
  }

  // 覆寫第一列為中文標題（不插列）
  sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
  Logger.log('已設定標題列：' + sheetName + '（' + schema.headers.length + ' 欄）');
}

/** 建立三張工作表並寫入標題列（可重複執行，執行後既有資料不受影響） */
function initSheetHeaders() {
  ensureSheetHeaders('TRAINING_CATALOG');
  ensureSheetHeaders('TRAINING_RECORD');
  ensureSheetHeaders('TRAINING_REQUIREMENT');
  Logger.log('initSheetHeaders 完成，三張工作表已就緒。');
}

// ==================== 研習統計分析模組常數 ====================

const IMPORTED_DATA_SHEET    = 'ImportedData';
const TEACHER_SNAPSHOT_SHEET = 'TeacherSnapshot';
const INDICATOR_RULES_KEY    = 'indicatorRules';
const ROSTER_SOURCES_KEY     = 'rosterSources';   // 各學年度名冊來源記錄（PropertiesService）
const VALID_DEPT             = ['高中部', '國中部'];  // 納入統計範圍的部別（HealthCheck.gs / TrainingReport.gs / Sync.gs 共用）
const STATS_CACHE_SHEET      = 'StatsCache';       // 伺服器端統計快取工作表
const REPORT_DOC_TEMPLATE_ID = '';        // fallback；正式值優先讀 PropertiesService（REPORT_TEMPLATE_ID_KEY）
const SCHOOL_NAME            = '臺北市立中崙高級中學';
const PRINCIPAL_NAME         = '';        // fallback；正式值優先讀 PropertiesService（PRINCIPAL_NAME_KEY）
const REPORT_TEMPLATE_ID_KEY = 'reportDocTemplateId';  // 簽呈範本文件 ID（createReportDocTemplate_ 自動寫入）
const PRINCIPAL_NAME_KEY     = 'principalName';        // 校長姓名（管理後台「報告設定」可修改）
const STATS_PARTTIME_KEY     = 'statsIncludePartTime'; // 兼課教師是否計入統計母數（管理後台可切換）

// ==================== 統計母數共用判定（task_c5f2e08d） ====================
// 兩支判定函式語意不同、不可合併：
// - _isCountedInStats_：教師「達成率統計母數」，讀 TeacherSnapshot 的路徑用
// - _isTrainingTracked_：Hub.UserStatusCache 的「應受訓人員名單」，含行政人員
//   （audienceRules 分眾任務本就為行政人員設時數，不可用 VALID_DEPT 篩掉他們）

/**
 * 判斷 jobPrimary 是否屬於應計入統計的教師職務
 * 採關鍵字包含比對，相容「正式」「正式教師」等各種格式
 * 排除：兼課、校長、主任、組長、教官等純行政或兼課身分
 * @param {string} job - jobPrimary 欄位值
 * @param {boolean} [includePartTime] - 是否連兼課教師也算入（呼叫端在迴圈外讀一次
 *   _loadStatsIncludePartTime_() 傳入，禁止在此函式內每次呼叫 PropertiesService）
 */
function _isTeacherJob_(job, includePartTime) {
  if (!job) return true;  // 空白＝尚未同步，不排除
  const INCLUDE_KW = includePartTime ? ['正式', '代理', '代課', '兼課教師'] : ['正式', '代理', '代課'];
  for (let i = 0; i < INCLUDE_KW.length; i++) {
    if (job.indexOf(INCLUDE_KW[i]) >= 0) return true;
  }
  return false;
}

/** 教師達成率統計母數：VALID_DEPT ＋ _isTeacherJob_()。用於讀 TeacherSnapshot 的三條路徑。 */
function _isCountedInStats_(dept, job, includePartTime) {
  return VALID_DEPT.includes(String(dept || '').trim()) && _isTeacherJob_(job, includePartTime);
}

/**
 * 應受訓人員名單：_isTeacherJob_() 或行政人員。用於讀 Hub.UserStatusCache 的路徑
 * （Sync.gs、calcRequirementStats、Notify.gs）。不套 VALID_DEPT——行政人員部別本就
 * 空白，套了等於把他們全刪，而 audienceRules 分眾任務本就為行政人員設有應達時數。
 * ⚠️ 行政人員判定用「嚴格相等」，與 _classifyIdentity_() 對同一欄位採「包含」比對
 * （如 jobPrimary_equals／compound 的 indexOf）不一致——目前 Hub 資料值恰好都是
 * 「行政人員」四字，兩邊結果相同；若日後出現「行政人員（約僱）」之類的變體值，
 * 此處會排除、但 _classifyIdentity_ 仍會分類為相關行政人員，兩邊將出現分岔。
 */
function _isTrainingTracked_(job, includePartTime) {
  const j = String(job || '').trim();
  return _isTeacherJob_(j, includePartTime) || j === '行政人員';
}

/**
 * 讀取「兼課教師是否計入統計」設定；讀不到用常數預設 false，不回寫
 * （維持 HealthCheck.gs 的零寫入契約）。呼叫端須在迴圈外呼叫一次，不可逐筆呼叫。
 */
function _loadStatsIncludePartTime_() {
  return PropertiesService.getScriptProperties().getProperty(STATS_PARTTIME_KEY) === 'true';
}

// ==================== ID 產生器（需在 LockService 內呼叫） ====================

/**
 * 掃描現有 allRows 中最大序號後 +1，避免因刪列導致重複 ID
 * @param {string[][]} allRows - getDataRange().getValues() 的原始 2D 陣列（含標題列）
 * @param {string} prefix - 如 'C2026'
 * @param {number} padLen  - 序號補零至幾位
 * @param {number} idColIdx - ID 欄在 schema.keys 中的 index（即欄的 0-based 位置）
 */
function _generateSequentialId(allRows, prefix, padLen, idColIdx) {
  let maxSeq = 0;
  for (let i = 1; i < allRows.length; i++) {
    const id = String(allRows[i][idColIdx] || '');
    if (id.startsWith(prefix)) {
      const seq = parseInt(id.slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  return prefix + String(maxSeq + 1).padStart(padLen, '0');
}

function _generateCatalogId(allRows) {
  const year = String(new Date().getFullYear());
  const idColIdx = SHEET_SCHEMA.TRAINING_CATALOG.keys.indexOf('catalogId');
  return _generateSequentialId(allRows, 'C' + year, 4, idColIdx);
}

function _generateRecordId(allRows) {
  const year = String(new Date().getFullYear());
  const idColIdx = SHEET_SCHEMA.TRAINING_RECORD.keys.indexOf('recordId');
  return _generateSequentialId(allRows, 'R' + year, 6, idColIdx);
}

/**
 * 產生任務編號，格式 RQ{學年度}{3位序號}，如 RQ1140001
 * @param {string[][]} allRows - getDataRange().getValues()
 * @param {number} academicYear - 台灣學年度（如 114）
 */
function _generateRequirementId(allRows, academicYear) {
  const prefix  = 'RQ' + String(academicYear);
  const idColIdx = SHEET_SCHEMA.TRAINING_REQUIREMENT.keys.indexOf('requirementId');
  return _generateSequentialId(allRows, prefix, 3, idColIdx);
}

/**
 * 回傳目前台灣學年度（民國年）
 * 8月以後為新學年（例：2025/9 → 114學年度，2026/5 → 114學年度）
 */
function _currentAcademicYear() {
  const d = new Date();
  const rocYear = d.getFullYear() - 1911;
  return (d.getMonth() + 1) >= 8 ? rocYear : rocYear - 1;
}

/** 回傳台北時間的 ISO 格式 Timestamp */
function _now() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ss");
}
