// ==================== 系統常數（部署後填入實際 ID） ====================
const TRAINING_SS_ID                = 'TODO_填入_研習登錄試算表_ID';
const TRAINING_DRIVE_ROOT_FOLDER_ID = 'TODO_填入_研習證明根目錄_Drive_ID';
const HUB_SPREADSHEET_ID            = 'TODO_填入_Portal_Hub_試算表_ID';
const LOG_SPREADSHEET_ID            = 'TODO_填入_AuditLog_獨立日誌試算表_ID';

// ==================== SHEET_SCHEMA ====================
// headers：試算表第一列的中文標題（唯一來源）
// keys   ：前後端程式碼使用的英文 Key（與 headers 一一對應）
const SHEET_SCHEMA = {
  TRAINING_CATALOG: {
    name: 'TRAINING_CATALOG',
    headers: [
      '課程編號', '課程名稱', '研習時數', '主辦單位', '推薦處室', '建立者',
      '開始日期', '結束日期', '課程說明', '研習對象', '相關連結', '是否必修', '狀態', '建立時間'
    ],
    keys: [
      'catalogId', 'title', 'hours', 'organizer', 'department', 'createdBy',
      'startDate', 'endDate', 'description', 'targetAudience', 'link', 'isRequired', 'status', 'createdAt'
    ]
  },
  TRAINING_RECORD: {
    name: 'TRAINING_RECORD',
    headers: [
      '紀錄編號', '教師 ID', '課程編號', '研習名稱', '研習時數', '是否自訂',
      '研習日期', '主辦單位', 'Drive 檔案 ID', '原始檔名', '審核狀態',
      '審核者', '退件原因', '審核時間', '送出時間'
    ],
    keys: [
      'recordId', 'userId', 'catalogId', 'title', 'hours', 'isCustom',
      'trainingDate', 'organizer', 'fileId', 'fileName', 'status',
      'reviewedBy', 'reviewNote', 'reviewedAt', 'submittedAt'
    ]
  }
};

// ==================== 工作表存取輔助 ====================

function _getTrainingSheet(sheetName) {
  const ss = SpreadsheetApp.openById(TRAINING_SS_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('工作表不存在：' + sheetName);
  return sheet;
}

function _getCatalogSheet() { return _getTrainingSheet(SHEET_SCHEMA.TRAINING_CATALOG.name); }
function _getRecordSheet()  { return _getTrainingSheet(SHEET_SCHEMA.TRAINING_RECORD.name);  }

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
        obj[key] = (row[i] !== undefined && row[i] !== null) ? row[i] : '';
      });
      return obj;
    });
}

/**
 * 確保工作表第一列為標準中文標題列（直接覆寫，不插列）
 * 部署 Phase 0 時手動執行一次即可
 */
function ensureSheetHeaders(sheetName) {
  const schema = SHEET_SCHEMA[sheetName];
  if (!schema) throw new Error('SHEET_SCHEMA 找不到：' + sheetName);
  const sheet = _getTrainingSheet(sheetName);
  sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
}

/** 一次建立兩張工作表的標題列（Phase 0 初始化用） */
function initSheetHeaders() {
  ensureSheetHeaders('TRAINING_CATALOG');
  ensureSheetHeaders('TRAINING_RECORD');
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

/** 回傳台北時間的 ISO 格式 Timestamp */
function _now() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ss");
}
