// ==================== Web App 入口點 ====================

function doGet(e) {
  const page    = (e.parameter && e.parameter.page) || 'index';
  const pageMap = { 'index': 'Index', 'submit': 'Submit', 'records': 'Records', 'admin': 'Admin' };
  const tmplName = pageMap[page] || 'Index';
  const template = HtmlService.createTemplateFromFile(tmplName);

  // 將 URL 參數傳入模板（sanitized：僅允許英數字）
  template.initCatalogId     = (e.parameter && e.parameter.catalog  || '').replace(/[^A-Za-z0-9]/g, '');
  template.initResubmitId   = (e.parameter && e.parameter.resubmit || '').replace(/[^A-Za-z0-9]/g, '');
  template.initRequirementId = (e.parameter && e.parameter.req      || '').replace(/[^A-Za-z0-9]/g, '');
  // 注入絕對 URL 至前端，供 _navigate() 使用（防止 googleusercontent.com 相對路徑導覽問題）
  template.appBaseUrl     = getWebAppBaseUrl_();
  // SSO 方案 B 交換碼（task_5e719428 Stage 2）：門戶帶來的 ?hx=<code>，白名單比照既有參數處理
  // 無條件注入所有頁面模板（比照 appBaseUrl），避免其餘頁面 evaluate() 因未定義變數噴錯
  template.handoffCode    = (e.parameter && e.parameter.hx || '').replace(/[^A-Za-z0-9_]/g, '');

  return template.evaluate()
    .setTitle('研習登錄系統 — 中崙高中')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** GAS 模板語法 <?!= include('style') ?> 所需的輔助函式 */
function include(filename) {
  return HtmlService.createTemplateFromFile(filename).evaluate().getContent();
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

/** 中央 AuditLog 寫入 wrapper：logAction 失敗不可阻斷主流程（比照圖書館 _logOp_） */
function _logOp_(actorId, action, detail) {
  try {
    SchoolPortalLib.logAction(actorId || '', action, detail || '');
  } catch (e) {
    Logger.log('[_logOp_] logAction 失敗（不阻斷）：' + e.message);
  }
}

function handleRequest(payload) {
  let action = '', userId = '';
  try {
    const { token, body } = payload || {};
    action = (payload || {}).action;

    if (!action) return _err('MISSING_ACTION');

    // ── 公開路由（無需 Token）──
    if (action === 'train/getUserName') {
      // 新版登入步驟 1：查工號對應姓名
      return trainGetUserName_(body || {});
    }
    if (action === 'train/loginWithIdSuffix') {
      // 新版登入步驟 2：身分證後六碼驗證
      return trainLoginWithIdSuffix_(body || {});
    }
    if (action === 'train/redeemHandoff') {
      // SSO 方案 B（task_5e719428 Stage 2）：兌換門戶核發的一次性交換碼，換發原生 train_ token
      // PUBLIC：兌換發生在使用者尚未認證之前
      return trainRedeemHandoff_(body || {});
    }
    if (action === 'logout') {
      // train_ token 靠 CacheService TTL 自然過期，SPL token 呼叫 revokeToken
      if (!token || !token.startsWith(TRAIN_TOKEN_PREFIX)) {
        try { SchoolPortalLib.revokeToken(token); } catch (_) {}
      }
      return { success: true };
    }

    // ── Level 1：驗證 Token（train_ 原生優先，降級 SchoolPortalLib）──
    const session = verifyTrainSession_(token);
    if (!session || !session.valid) return _err('TOKEN_EXPIRED');
    userId = session.userId;

    switch (action) {
      case 'v1/getCatalog':                    return { success: true, data: getCatalog() };
      case 'v1/getMyRecords':                  return { success: true, data: getMyRecords(userId) };
      case 'v1/submitRecord':                  return submitRecord(userId, body || {});
      case 'v1/deleteRecord':                  return deleteRecord(userId, body || {});
      case 'v1/getRequirements':               return { success: true, data: getRequirements(userId, body || {}) };
      case 'v1/getMyImportedRecords':          return getMyImportedRecords(userId, body || {});
      case 'v1/checkImportedBeforeSubmit':     return checkImportedBeforeSubmit(userId, body || {});
    }

    // ── Level 2：驗證管理者身分 ──
    let access = {};
    try {
      const sa = session.systemAccess;
      access = (typeof sa === 'object' && sa !== null)
        ? sa
        : JSON.parse(String(sa || '{}'));
    } catch (_) {}
    if (!access.training_admin) return _err('FORBIDDEN');

    switch (action) {
      case 'v1/admin/addCatalog':           return addCatalog(userId, body || {});
      case 'v1/admin/editCatalog':          return editCatalog(userId, body || {});
      case 'v1/admin/archiveCatalog':       return archiveCatalog(body || {});
      case 'v1/admin/getPendingReviews':    return { success: true, data: getPendingReviews() };
      case 'v1/admin/reviewRecord':         return reviewRecord(userId, body || {});
      case 'v1/admin/getFileUrl':           return getFileUrl(body || {});
      case 'v1/admin/exportRecords':        return exportRecords(body || {});
      case 'v1/admin/previewNotification':  return previewNotification();
      case 'v1/admin/triggerNotification':  return Object.assign({ success: true }, checkAndNotifyOverdue());
      case 'v1/admin/getAllRequirements':   return { success: true, data: getAllRequirements(body || {}) };
      case 'v1/admin/addRequirement':       return addRequirement(userId, body || {});
      case 'v1/admin/editRequirement':      return editRequirement(userId, body || {});
      case 'v1/admin/archiveRequirement':   return archiveRequirement(userId, body || {});
      case 'v1/admin/renewRequirements':    return renewRequirements(userId, body || {});
      case 'v1/admin/runHealthCheck':       return runDataHealthCheck(userId, (body || {}).scope, (body || {}).academicYear);

      // ── 研習統計分析模組（TRAIN-REPORT）──
      case 'report_import':              return importTrainingData(body || {});
      case 'report_snapshot':            return snapshotTeacherRoster(body || {});
      case 'report_snapshot_batch':      return snapshotRosterBatch(body || {});
      case 'report_get_roster_sources':  return getRosterSources();
      case 'report_get_stats_cache':     return getStatsCache((body||{}).academicYear, (body||{}).mode);
      case 'report_batch_calc':          return batchCalcStats(body || {});
      case 'report_calc':                return calcStats((body || {}).academicYear, (body || {}).mode);
      case 'report_export_csv':          return exportDoubleColumnCSV((body || {}).academicYear);
      case 'report_export_doc':          return generateGoogleDoc((body || {}).academicYear);
      case 'report_get_settings':        return getReportSettings();
      case 'report_save_settings':       return saveReportSettings(body || {});
      case 'get_indicators':             return getIndicators();
      case 'save_indicator':             return saveIndicator(body || {});
      case 'delete_indicator':           return deleteIndicator((body || {}).id);
      case 'get_identity_rules':              return getIdentityRules();
      case 'save_identity_rules':             return saveIdentityRules(body || {});
      case 'report_req_stats':                return calcRequirementStats(body || {});
      case 'get_stats_settings':              return getStatsSettings();
      case 'save_stats_settings':             return saveStatsSettings(body || {});

      default: return _err('UNKNOWN_ACTION');
    }
  } catch (err) {
    _logOp_(userId, 'ERROR_' + (action || 'UNKNOWN'), err.message);
    return { success: false, error: err.message };
  }
}

// ==================== 回應輔助 ====================

function _ok(data)  { return { success: true,  data  }; }
function _err(msg)  { return { success: false, error: msg }; }
