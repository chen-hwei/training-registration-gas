// ==================== Google Drive 檔案管理 ====================

/**
 * 儲存研習證明至 Drive，回傳檔案 ID
 * @param {string} userId        - txxxx
 * @param {string} base64        - 不含 data:xxx 前綴的純 base64 字串
 * @param {string} mimeType      - 如 'image/jpeg'、'application/pdf'
 * @param {string} originalName  - 原始檔名（含副檔名，僅取副檔名用）
 * @param {string} trainingDate  - 格式 'YYYY/M/D'
 * @param {string} courseTitle   - 課程名稱（用於建構標準化檔名）
 */
function _saveFileToDrive(userId, base64, mimeType, originalName, trainingDate, courseTitle) {
  const folder   = _getOrCreateUserFolder(userId, trainingDate);
  const fileName = _buildFileName(userId, trainingDate, courseTitle, originalName);
  const blob     = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, fileName);
  const file     = folder.createFile(blob);

  // 授予本人唯讀（失敗不中斷，僅記錄）
  try {
    const email = SchoolPortalLib.getUser(userId).email;
    if (email) file.addViewer(email);
  } catch (e) {
    console.warn('授予教師唯讀失敗，userId=' + userId + '，原因：' + e.message);
  }

  return file.getId();
}

/**
 * 取得或建立教師個人資料夾
 * 結構：研習證明根目錄 / {年份} / {txxxx}
 */
function _getOrCreateUserFolder(userId, trainingDate) {
  const year       = String(trainingDate).split('/')[0] || String(new Date().getFullYear());
  const root       = DriveApp.getFolderById(TRAINING_DRIVE_ROOT_FOLDER_ID);
  const yearFolder = _getOrCreateSubFolder(root, year);
  return _getOrCreateSubFolder(yearFolder, userId);
}

function _getOrCreateSubFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

/**
 * 建立標準化檔名：{年份}_{txxxx}_{課程名稱前20字}_{YYYYMMDD}.{副檔名}
 * 特殊字元統一替換為底線
 */
function _buildFileName(userId, trainingDate, courseTitle, originalName) {
  const parts   = String(trainingDate).split('/');
  const year    = parts[0] || String(new Date().getFullYear());
  const dateStr = year + String(parts[1] || '01').padStart(2, '0') + String(parts[2] || '01').padStart(2, '0');
  const ext     = originalName.includes('.') ? originalName.split('.').pop() : 'jpg';
  const safeTitle = String(courseTitle || '')
    .replace(/[\\/\?%\*:\|"<>]/g, '_')
    .trim()
    .slice(0, 20);
  return `${year}_${userId}_${safeTitle}_${dateStr}.${ext}`;
}

/**
 * 在 allRows（含標題列的 2D 陣列）中尋找屬於 userId 的 fileId 所對應的資料列
 * 用於 reuseFileId 驗證，防止偽造他人檔案 ID
 * @returns {any[]|null} 找到的資料列，否則 null
 */
function _findRecordByFileId(allRows, fileId, userId) {
  const schema    = SHEET_SCHEMA.TRAINING_RECORD;
  const fileIdIdx = schema.keys.indexOf('fileId');
  const userIdIdx = schema.keys.indexOf('userId');
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (row[fileIdIdx] === fileId && row[userIdIdx] === userId) return row;
  }
  return null;
}
