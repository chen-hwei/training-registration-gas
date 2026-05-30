// ==================== Web App 入口點 ====================

function doGet(e) {
  const page    = (e.parameter && e.parameter.page) || 'index';
  const pageMap = { 'index': 'Index', 'submit': 'Submit', 'records': 'Records', 'admin': 'Admin' };
  const tmplName = pageMap[page] || 'Index';
  const template = HtmlService.createTemplateFromFile(tmplName);

  // 將 URL 參數傳入模板（sanitized：僅允許英數字）
  template.initCatalogId  = (e.parameter && e.parameter.catalog  || '').replace(/[^A-Za-z0-9]/g, '');
  template.initResubmitId = (e.parameter && e.parameter.resubmit || '').replace(/[^A-Za-z0-9]/g, '');

  return template.evaluate()
    .setTitle('研習登錄系統 — 中崙高中')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** GAS 模板語法 <?!= include('style') ?> 所需的輔助函式 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    return ContentService
      .createTextOutput(JSON.stringify(handleRequest(payload)))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==================== 路由分流（handleRequest） ====================

function handleRequest(payload) {
  const { action, token, body } = payload || {};

  if (!action) return _err('MISSING_ACTION');

  // ── 公開路由（無需 Token）──
  if (action === 'login') {
    return SchoolPortalLib.login((body || {}).userId, (body || {}).pin);
  }
  if (action === 'getTeachers') {
    return { success: true, data: SchoolPortalLib.getTeachers() };
  }
  if (action === 'logout') {
    SchoolPortalLib.revokeToken(token);
    return { success: true };
  }

  // ── Level 1：驗證 Token ──
  const session = SchoolPortalLib.verifyToken(token);
  if (!session || !session.valid) return _err('TOKEN_EXPIRED');
  const userId = session.userId;

  switch (action) {
    case 'v1/getCatalog':   return { success: true, data: getCatalog() };
    case 'v1/getMyRecords': return { success: true, data: getMyRecords(userId) };
    case 'v1/submitRecord': return submitRecord(userId, body || {});
    case 'v1/deleteRecord': return deleteRecord(userId, body || {});
  }

  // ── Level 2：驗證管理者身分 ──
  const user = SchoolPortalLib.getUser(userId);
  let access = {};
  try { access = JSON.parse(user.systemAccess || '{}'); } catch (_) {}
  if (!access.training_admin) return _err('FORBIDDEN');

  switch (action) {
    case 'v1/admin/addCatalog':          return addCatalog(userId, body || {});
    case 'v1/admin/editCatalog':         return editCatalog(userId, body || {});
    case 'v1/admin/archiveCatalog':      return archiveCatalog(body || {});
    case 'v1/admin/getPendingReviews':   return { success: true, data: getPendingReviews() };
    case 'v1/admin/reviewRecord':        return reviewRecord(userId, body || {});
    case 'v1/admin/getFileUrl':          return getFileUrl(body || {});
    case 'v1/admin/exportRecords':       return exportRecords(body || {});
    case 'v1/admin/previewNotification': return previewNotification();
    case 'v1/admin/triggerNotification': return { success: true, sent: checkAndNotifyOverdue() };
    default: return _err('UNKNOWN_ACTION');
  }
}

// ==================== 回應輔助 ====================

function _ok(data)  { return { success: true,  data  }; }
function _err(msg)  { return { success: false, error: msg }; }
