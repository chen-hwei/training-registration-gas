// ==================== 年度研習任務（Requirement） ====================

// ── Level 1：教師端 ──

/**
 * 取得指定學年度所有 ACTIVE 任務，並附帶登入教師的完成進度
 * body.academicYear 選填；未傳時預設當前學年度（Index.html 沿用此預設）
 * 有效時數 = 核准紀錄與匯入時數取較大值（口徑與 Records.html 一致，見 v3.6 修正）
 * 回傳格式：[{ ...requirement, requiredHours, approvedHours, pendingHours, importedHours, effectiveHours, hasSameName, isCompleted }, ...]
 */
function getRequirements_(userId, body) {
  const academicYear = (body && body.academicYear) ? Number(body.academicYear) : _currentAcademicYear_();
  const requirements = parseSheetData_(_getRequirementSheet_())
    .filter(r => r.status === 'ACTIVE' && Number(r.academicYear) === academicYear);

  if (requirements.length === 0) return [];

  // 讀取此教師所有紀錄，建立任務進度 Map
  const records = parseSheetData_(_getRecordSheet_())
    .filter(r => r.userId === userId && r.requirementId);

  const approvedMap = {};
  const pendingMap  = {};
  records.forEach(r => {
    const rid = r.requirementId;
    const h   = Number(r.hours) || 0;
    if (r.status === 'APPROVED') approvedMap[rid] = (approvedMap[rid] || 0) + h;
    if (r.status === 'PENDING')  pendingMap[rid]  = (pendingMap[rid]  || 0) + h;
  });

  // Hub.UserStatusCache 只開一次：供 audienceRules 分眾身分判斷 + 匯入時數姓名比對共用
  let userIdentityGroup = null;
  let importedByReq     = {};
  let hasSameName        = false;
  try {
    const userInfo = _getHubUserInfo_(userId);
    if (userInfo) {
      hasSameName = userInfo.hasSameName;

      const hasAudienceRules = requirements.some(r => r.audienceRules && String(r.audienceRules).trim() !== '');
      if (hasAudienceRules) {
        const identityRules = _loadIdentityRules_();
        userIdentityGroup   = _classifyIdentity_({
          jobPrimary: userInfo.jobPrimary,
          title:      userInfo.title,
          jobTask:    userInfo.jobTask
        }, identityRules);
      }

      importedByReq = _matchImportedToRequirements_(userInfo.myName, academicYear).importedByReq;
    }
  } catch (e) {
    Logger.log('getRequirements: identity/imported lookup failed: ' + e.message);
  }

  return requirements.map(req => {
    let required = Number(req.requiredHours) || 0;

    // audienceRules 分眾：依使用者身分覆寫 requiredHours
    if (required === 0 && req.audienceRules && String(req.audienceRules).trim() !== '') {
      try {
        const rules = JSON.parse(req.audienceRules);
        if (userIdentityGroup) {
          const match = rules.find(ar => ar.group === userIdentityGroup);
          if (match) required = Number(match.hours) || 0;
        }
      } catch (e) {}
    }

    const approved  = approvedMap[req.requirementId] || 0;
    const imported  = importedByReq[req.requirementId] || 0;
    const effective = Math.max(approved, imported);
    return {
      ...req,
      requiredHours:  required,
      approvedHours:  approved,
      pendingHours:   pendingMap[req.requirementId] || 0,
      importedHours:  imported,
      effectiveHours: effective,
      hasSameName:    hasSameName,
      isCompleted:    required > 0 && effective >= required
    };
  });
}

// ── Level 2：管理者端 ──

/**
 * 取得所有任務（不限學年度，供管理者全覽）
 * 可傳入 body.academicYear 篩選特定學年度
 * scope 限制下只回 owner ∈ scope 的任務；owner 空值僅全權可見（task_c95dbe21 Stage 2a，2e／Q-a）
 */
function getAllRequirements_(body, scope) {
  let all = parseSheetData_(_getRequirementSheet_()).map(r => ({
    ...r,
    requiredHours: Number(r.requiredHours) || 0
  }));
  if (!_isAllScope_(scope)) {
    // task_40e96378 Stage 1b：處室 ∪ TASK:（任務管理者看得到自己系列各學年的任務）
    all = all.filter(r => _inScopeItem_(String(r.owner || '').trim(), String(r.seriesId || '').trim(), scope));
  }
  if (body && body.academicYear) {
    return all.filter(r => Number(r.academicYear) === Number(body.academicYear));
  }
  return all;
}

/**
 * semesterSplit（計算區間）正規化：僅允許 '上學期' / '下學期' / ''（空字串＝整學年）
 * 達成率的硬性計算區間由此欄推算（見 TrainingReport.gs _requirementWindow_）；
 * endDate 僅作催辦提醒與畫面顯示，不影響達成率計算。
 * 舊資料曾被誤存為布林 TRUE/FALSE，一律視為未標記（既有資料已於早期依名稱回填完畢，回填函式於 task_6d2f8a14 下架）。
 */
function _normalizeSemesterSplit_(v) {
  const s = String(v || '').trim();
  return (s === '上學期' || s === '下學期') ? s : '';
}

/**
 * 新增年度研習任務
 * body 必填：name, endDate, owner（task_c95dbe21 Stage 2a 起必填）
 * body 選填：startDate, requiredHours, hoursNote, deliveryType, semesterSplit,
 *            notes, links, isRecurring, academicYear, targetAudience,
 *            matchKeywords, audienceRules, teacherNote,
 *            seriesId（task_40e96378 D3：歸入既有系列，僅全權；須為表內已存在代號，否則 INVALID_SERIES）
 * owner：純由前端傳入。Hub 的 department 欄位語意是「部別（高中部／國中部）」，
 * 不是「行政處室」，兩者不可互相 fallback，故不自動帶入。
 * 檢查順序（R-5）：MISSING_OWNER → INVALID_OWNER → scope。MISSING_OWNER 必須排在 scope 之前，
 * 否則處室管理者送空 owner 會先撞 _inScope_('') 回 FORBIDDEN。
 * scope 限制下，寫入的 owner 須 ∈ scope（B-4／C-3：寫入 owner 的入口驗改後 owner）
 */
function addRequirement_(adminId, body, scope) {
  if (!body.name)    return _err_('MISSING_NAME');
  if (!body.endDate) return _err_('MISSING_END_DATE');

  const owner = String(body.owner || '').trim();
  if (!owner) return _err_('MISSING_OWNER');
  if (!OWNER_DEPTS.includes(owner)) return _err_('INVALID_OWNER');
  if (!_inScope_(owner, scope)) return _err_('FORBIDDEN');  // 處室層級：任務管理者（TASK:）不可新增任務（task_40e96378 Q2②）

  // task_40e96378 D3：歸入既有系列（選填），僅全權管理者可指定——系列是任務管理者授權的綁定鍵，
  // 處室管理者若能把任務掛進別處室的系列，等於替該系列的任務管理者擴權
  const joinSeries = String(body.seriesId || '').trim();
  if (joinSeries && !_isAllScope_(scope)) return _err_('FORBIDDEN');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err_('系統正忙，請稍後再試。'); }

  try {
    const sheet       = _getRequirementSheet_();
    const allRows     = sheet.getDataRange().getValues();
    const schema      = SHEET_SCHEMA.TRAINING_REQUIREMENT;
    const academicYear = body.academicYear ? Number(body.academicYear) : _currentAcademicYear_();
    const requirementId = _generateRequirementId_(allRows, academicYear);
    let seriesId;
    if (joinSeries) {
      // 只能歸入表內已存在的代號；不推進已發最高號（沒有發新號）
      const col = schema.keys.indexOf('seriesId');
      const exists = allRows.some((row, i) => i > 0 && String(row[col] || '').trim() === joinSeries);
      if (!exists) return _err_('INVALID_SERIES');
      seriesId = joinSeries;
    } else {
      seriesId = _formatSeriesId_(_maxSeriesSeq_(allRows) + 1);  // 新任務＝新系列（task_40e96378）
    }

    const newReq = {
      requirementId,
      name:          String(body.name),
      owner,
      academicYear,
      startDate:     String(body.startDate    || ''),
      endDate:       String(body.endDate),
      requiredHours: Number(body.requiredHours) || 0,
      hoursNote:     String(body.hoursNote    || ''),
      deliveryType:  String(body.deliveryType || 'ONLINE'),
      semesterSplit: _normalizeSemesterSplit_(body.semesterSplit),
      notes:         String(body.notes        || ''),
      links:         String(body.links        || ''),
      isRecurring:   body.isRecurring !== false,  // 預設 true
      status:        'ACTIVE',
      createdAt:     _now_(),
      audienceRules: String(body.audienceRules || ''),
      matchKeywords: String(body.matchKeywords || ''),
      teacherNote:   String(body.teacherNote   || ''),
      targetAudience: String(body.targetAudience || ''),
      seriesId
    };

    allRows.push(schema.keys.map(k => newReq[k] !== undefined ? newReq[k] : ''));
    // 補齊寬度：schema 若已加欄但試算表尚未跑過 initSheetHeaders()，避免 ragged array 導致
    // setValues 拋錯（此時 clearContents 已執行，拋錯會清空整張工作表）
    const W = Math.max(schema.keys.length, allRows[0].length);
    const rows = allRows.map(r => { const a = r.slice(); while (a.length < W) a.push(''); return a; });
    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, W).setValues(rows);

    if (!joinSeries) _saveSeriesSeqHwm_(parseInt(seriesId.slice(2), 10));  // Y-3：推進已發最高號，刪列後不重發
    SchoolPortalLib.logAction(adminId, 'ADD_REQUIREMENT', requirementId);
    return { success: true, requirementId, seriesId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 編輯年度研習任務
 * body 必填：requirementId
 * body 選填：name, startDate, endDate, requiredHours, hoursNote, deliveryType,
 *            semesterSplit, notes, links, isRecurring, owner, targetAudience,
 *            teacherNote, audienceRules, matchKeywords
 * 主責單位必填（task_c95dbe21 R-5）：以「合併後 owner」判空——body.owner 有傳用之，未傳用試算表現值；
 * 合併後為空 → MISSING_OWNER（既有空值任務只改其他欄位也會被要求補 owner，刻意設計），排在 scope 檢查之前。
 * task_40e96378 Stage 1b：編輯權＝處室 ∪ TASK:<seriesId>；owner 值有變更時，改前與改後 owner 皆須 ∈ 處室 scope（B-4）：
 * 防止管理者把任務單方面轉出自己 scope 後無法復原（空值僅全權，故處室管理者無法認領空值任務）
 */
function editRequirement_(adminId, body, scope) {
  if (!body.requirementId) return _err_('MISSING_REQUIREMENT_ID');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err_('系統正忙，請稍後再試。'); }

  try {
    const sheet    = _getRequirementSheet_();
    const data     = sheet.getDataRange().getValues();
    const schema   = SHEET_SCHEMA.TRAINING_REQUIREMENT;
    const idIdx     = schema.keys.indexOf('requirementId');
    const ownerIdx  = schema.keys.indexOf('owner');
    const seriesIdx = schema.keys.indexOf('seriesId');

    const rowIdx = data.findIndex((row, i) => i > 0 && row[idIdx] === body.requirementId);
    if (rowIdx === -1) return _err_('REQUIREMENT_NOT_FOUND');

    const currentOwner  = String(data[rowIdx][ownerIdx] || '').trim();
    const currentSeries = String(data[rowIdx][seriesIdx] || '').trim();
    const mergedOwner   = body.owner !== undefined ? String(body.owner || '').trim() : currentOwner;
    if (!mergedOwner) return _err_('MISSING_OWNER');
    if (body.owner !== undefined && !OWNER_DEPTS.includes(mergedOwner)) return _err_('INVALID_OWNER');

    // task_40e96378 Stage 1b：編輯權＝處室 ∪ TASK:；改主責處室（值有變）維持處室層級，
    // 改前、改後皆須 ∈ 處室 scope——只管任務者改不了 owner（Q2② 主責處室鎖定），處室管理者行為不變
    if (!_inScopeItem_(currentOwner, currentSeries, scope)) return _err_('FORBIDDEN');
    if (mergedOwner !== currentOwner &&
        !(_inScope_(currentOwner, scope) && _inScope_(mergedOwner, scope))) return _err_('FORBIDDEN');

    // seriesId 刻意不列入：系列代號是任務管理者授權的綁定鍵，改動會讓授權靜默失效（task_40e96378）
    const EDITABLE = ['name', 'startDate', 'endDate', 'requiredHours', 'hoursNote',
                      'deliveryType', 'semesterSplit', 'notes', 'links', 'isRecurring',
                      'audienceRules', 'matchKeywords', 'owner', 'teacherNote', 'targetAudience'];
    EDITABLE.forEach(key => {
      if (body[key] === undefined) return;
      const colIdx = schema.keys.indexOf(key);
      if (colIdx === -1) return;
      if (key === 'requiredHours') {
        data[rowIdx][colIdx] = Number(body[key]) || 0;
      } else if (key === 'isRecurring') {
        data[rowIdx][colIdx] = body[key] === true || body[key] === 'TRUE';
      } else if (key === 'semesterSplit') {
        data[rowIdx][colIdx] = _normalizeSemesterSplit_(body[key]);
      } else if (key === 'owner') {
        data[rowIdx][colIdx] = String(body[key] || '').trim();
      } else {
        data[rowIdx][colIdx] = String(body[key]);
      }
    });

    // 補齊寬度：理由同 addRequirement_()（R-2）
    const W = Math.max(schema.keys.length, data[0].length);
    const rows = data.map(r => { const a = r.slice(); while (a.length < W) a.push(''); return a; });
    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, W).setValues(rows);
    SpreadsheetApp.flush();

    SchoolPortalLib.logAction(adminId, 'EDIT_REQUIREMENT', body.requirementId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 封存年度研習任務（status → ARCHIVED）
 * body 必填：requirementId
 * scope 限制下，改前 owner 須 ∈ scope（B-4／C-3：改動既有任務的入口驗改前 owner；空值僅全權，task_c95dbe21 Stage 2a）
 */
function archiveRequirement_(adminId, body, scope) {
  if (!body.requirementId) return _err_('MISSING_REQUIREMENT_ID');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err_('系統正忙，請稍後再試。'); }

  try {
    const sheet    = _getRequirementSheet_();
    const data     = sheet.getDataRange().getValues();
    const schema   = SHEET_SCHEMA.TRAINING_REQUIREMENT;
    const idIdx     = schema.keys.indexOf('requirementId');
    const statusIdx = schema.keys.indexOf('status');
    const ownerIdx  = schema.keys.indexOf('owner');

    const rowIdx = data.findIndex((row, i) => i > 0 && row[idIdx] === body.requirementId);
    if (rowIdx === -1) return _err_('REQUIREMENT_NOT_FOUND');

    const currentOwner = String(data[rowIdx][ownerIdx] || '').trim();
    if (!_inScope_(currentOwner, scope)) return _err_('FORBIDDEN');  // 處室層級：任務管理者不可封存（task_40e96378 Q2②）

    data[rowIdx][statusIdx] = 'ARCHIVED';
    sheet.clearContents();
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    SpreadsheetApp.flush();

    SchoolPortalLib.logAction(adminId, 'ARCHIVE_REQUIREMENT', body.requirementId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 一鍵複製下一學年任務（從 isRecurring=TRUE 的任務複製，日期順延一年）
 * body 必填：sourceYear（來源學年度，如 114）
 * body 選填：targetYear（目標學年度，預設 sourceYear + 1）
 */
function renewRequirements_(adminId, body) {
  const sourceYear = Number(body.sourceYear);
  if (!sourceYear) return _err_('MISSING_SOURCE_YEAR');
  const targetYear = body.targetYear ? Number(body.targetYear) : sourceYear + 1;
  if (targetYear <= sourceYear) return _err_('TARGET_YEAR_MUST_BE_GREATER');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) { return _err_('系統正忙，請稍後再試。'); }

  try {
    const sheet   = _getRequirementSheet_();
    const allRows = sheet.getDataRange().getValues();
    const schema  = SHEET_SCHEMA.TRAINING_REQUIREMENT;

    // 確認目標學年度是否已有任務，避免重複建立
    const existTarget = allRows.slice(1).some(
      row => Number(row[schema.keys.indexOf('academicYear')]) === targetYear
    );
    if (existTarget) return _err_(`${targetYear} 學年度已有任務紀錄，請先封存再重新建立。`);

    const sourceBoolTrue = v => v === true || String(v).toUpperCase() === 'TRUE';
    const sourceReqs = parseSheetData_(sheet).filter(
      r => Number(r.academicYear) === sourceYear &&
           sourceBoolTrue(r.isRecurring) &&
           r.status === 'ACTIVE'
    );
    if (sourceReqs.length === 0) return _err_('沒有找到可複製的循環任務（isRecurring=TRUE）。');

    // 找出目標學年度現有最大序號，確保 ID 不重複
    const idColIdx = schema.keys.indexOf('requirementId');
    const prefix   = 'RQ' + String(targetYear);
    let maxSeq = 0;
    allRows.slice(1).forEach(row => {
      const id = String(row[idColIdx] || '');
      if (id.startsWith(prefix)) {
        const seq = parseInt(id.slice(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    });

    const yearDiff = targetYear - sourceYear;
    const newIds   = [];
    // task_40e96378：沿用來源任務的 seriesId；來源尚未回填者（未跑 backfillSeriesIds）發新代號並記錄
    // 已知限制（審查 Y-1）：同一批若有兩筆「同名」來源都缺代號，會各拿不同代號（不符 D1 同名同系列）；
    // 僅在試算表手動加列或執行 seed 函式後才可能發生，事後以 backfillSeriesIds 預覽檢查、手改併號
    let seriesSeq = _maxSeriesSeq_(allRows);
    const newSeries = [];

    sourceReqs.forEach(req => {
      maxSeq++;
      const requirementId = prefix + String(maxSeq).padStart(3, '0');

      // 日期格式統一後順延 yearDiff 年
      const shiftDate = (dateStr) => {
        if (!dateStr) return '';
        const parts = String(dateStr).replace(/-/g, '/').split('/').map(Number);
        if (parts.length < 3 || isNaN(parts[0])) return dateStr;
        return `${parts[0] + yearDiff}/${parts[1]}/${parts[2]}`;
      };

      const newReq = {
        requirementId,
        name:          req.name,
        owner:         req.owner,
        academicYear:  targetYear,
        startDate:     shiftDate(req.startDate),
        endDate:       shiftDate(req.endDate),
        requiredHours: Number(req.requiredHours) || 0,
        hoursNote:     req.hoursNote || '',
        deliveryType:  req.deliveryType || 'ONLINE',
        semesterSplit: _normalizeSemesterSplit_(req.semesterSplit),
        notes:         req.notes  || '',
        links:         req.links  || '',
        isRecurring:   true,
        status:        'ACTIVE',
        createdAt:     _now_(),
        // 統計模組欄位必須一併複製，否則新學年匯入紀錄比對不到任務（靜默失效）
        audienceRules: req.audienceRules || '',
        matchKeywords: req.matchKeywords || '',
        teacherNote:   req.teacherNote || '',
        targetAudience: req.targetAudience || '',
        seriesId:      String(req.seriesId || '').trim()
      };
      if (!newReq.seriesId) {
        newReq.seriesId = _formatSeriesId_(++seriesSeq);
        newSeries.push(requirementId + '←' + req.requirementId);
      }

      allRows.push(schema.keys.map(k => newReq[k] !== undefined ? newReq[k] : ''));
      newIds.push(requirementId);
    });

    // 補齊寬度：理由同 addRequirement_()（R-2），新列已用新版 schema 長度寫入，
    // 若舊列仍是舊欄寬會造成 ragged array
    const W = Math.max(schema.keys.length, allRows[0].length);
    const rows = allRows.map(r => { const a = r.slice(); while (a.length < W) a.push(''); return a; });
    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, W).setValues(rows);

    _saveSeriesSeqHwm_(seriesSeq);  // Y-3：來源缺號而發新號時推進已發最高號
    SchoolPortalLib.logAction(adminId, 'RENEW_REQUIREMENTS', 'to_year_' + targetYear);
    if (newSeries.length) {
      // 來源任務缺系列代號：新任務與舊學年斷鏈，任務管理者授權不會延續，需人工補正。
      // 回傳 newSeries 供前端提醒（Stage 1c），並寫 AuditLog；網頁觸發時 Logger 只在 GAS 執行作業頁看得到（Y-1）
      Logger.log('renewRequirements：以下新任務的來源缺 seriesId，已發新系列代號：' + newSeries.join(', '));
      _logOp_(adminId, 'RENEW_NEW_SERIES', 'to_year_' + targetYear + '：' + newSeries.join(', '));
    }
    return { success: true, created: newIds.length, targetYear, ids: newIds, newSeries };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 一次性維運函式：預覽既有年度任務的 seriesId 回填結果（task_40e96378 Stage 1a，GAS 編輯器手動執行）
 * 固定只預覽（只寫 Log，不動資料），不收參數；確認分組無誤後改執行 backfillSeriesIdsApply()。
 * R-1：公開函式可被前端 google.script.run 直呼，故開頭加部署者守衛，且不再接受 apply 參數。
 */
function backfillSeriesIds() {
  _assertManualRunByDeployer_('backfillSeriesIds');
  return _backfillSeriesIds_(false);
}

/**
 * seriesId 回填核心（私有，僅由 backfillSeriesIds／backfillSeriesIdsApply 呼叫）
 * 分組規則（D1 裁示）：不同學年但任務名稱完全相同（trim 後）者歸同一系列，名稱不同各自獨立。
 * - 同名群組已有 1 個既有代號 → 空白者沿用；已有 2 個以上相異代號 → 衝突，整組跳過不寫
 * - 同名群組全無代號 → 依（最早學年, 任務編號）順序發新代號
 * - 警示：同一系列在同一學年出現 2 筆以上、同一系列主責單位不一致（僅提示，照常分組）
 * 只寫 seriesId 一欄（含標題格），不碰其他資料
 * @param {boolean} [apply=false] true 才實際寫入
 */
function _backfillSeriesIds_(apply) {
  const sheet  = _getRequirementSheet_();
  const data   = sheet.getDataRange().getValues();
  const schema = SHEET_SCHEMA.TRAINING_REQUIREMENT;
  const k      = key => schema.keys.indexOf(key);
  const col    = k('seriesId');
  if (data.length <= 1) throw new Error('TRAINING_REQUIREMENT 工作表無資料列。');
  if (sheet.getMaxColumns() < col + 1) {
    throw new Error('工作表欄數不足（需 ' + (col + 1) + ' 欄），請先在試算表最右側手動新增欄位再執行。');
  }

  // 依名稱分組（單次掃描，O(n)）
  const groups = {};
  for (let i = 1; i < data.length; i++) {
    const row  = data[i];
    const name = String(row[k('name')] || '').trim();
    if (!name) continue;
    (groups[name] = groups[name] || []).push({
      i,
      rid:   String(row[k('requirementId')] || ''),
      year:  Number(row[k('academicYear')]) || 0,
      owner: String(row[k('owner')] || '').trim(),
      sid:   String(row[col] || '').trim()
    });
  }

  // 無代號群組依最早（學年, 任務編號）排序後發號，讓代號大致依時間先後
  const firstKey = g => g.reduce((m, r) => Math.min(m, r.year * 10000 + (parseInt(r.rid.slice(-3), 10) || 0)), Infinity);
  const names = Object.keys(groups).sort((a, b) => firstKey(groups[a]) - firstKey(groups[b]));

  let seq = _maxSeriesSeq_(data);
  const assign = {};   // rowIndex → seriesId
  const preview = [], warns = [], conflicts = [];
  let changed = 0;

  names.forEach(name => {
    const g = groups[name];
    const existing = Array.from(new Set(g.map(r => r.sid).filter(Boolean)));
    if (existing.length > 1) {
      conflicts.push('「' + name + '」已有多個代號 ' + existing.join('/') + '，整組跳過');
      return;
    }
    const sid = existing[0] || _formatSeriesId_(++seq);
    g.forEach(r => { if (!r.sid) { assign[r.i] = sid; changed++; } });

    const years = g.map(r => r.year);
    if (new Set(years).size !== years.length) warns.push(sid + '「' + name + '」同一學年有多筆');
    const owners = Array.from(new Set(g.map(r => r.owner)));
    if (owners.length > 1) warns.push(sid + '「' + name + '」主責單位不一致：' + owners.join('/'));

    preview.push(sid + '「' + name + '」← ' +
      g.slice().sort((a, b) => a.year - b.year)
       .map(r => r.year + ':' + r.rid + (r.sid ? '' : '*')).join(', '));
  });

  Logger.log('backfillSeriesIds ' + (apply ? '【寫入模式】' : '【預覽模式，未寫入】') +
    '：' + names.length + ' 個系列，待回填 ' + changed + ' 筆（* 為本次新填）\n' + preview.join('\n') +
    (warns.length ? '\n\n⚠️ 警示：\n' + warns.join('\n') : '') +
    (conflicts.length ? '\n\n❌ 衝突（未處理）：\n' + conflicts.join('\n') : ''));

  if (!apply || changed === 0) return { changed, series: names.length, warns, conflicts };

  // 整欄批次寫入：保留既有值，只填空白者（寫入模式由 backfillSeriesIdsApply 持鎖，讀寫之間不會有新增任務插入）
  const colValues = [];
  for (let i = 1; i < data.length; i++) {
    colValues.push([assign[i] || String(data[i][col] || '').trim()]);
  }
  sheet.getRange(1, col + 1).setValue(schema.headers[col]);
  sheet.getRange(2, col + 1, colValues.length, 1).setValues(colValues);
  SpreadsheetApp.flush();
  _saveSeriesSeqHwm_(seq);  // Y-3：推進已發最高號
  Logger.log('✅ backfillSeriesIds 寫入完成：' + changed + ' 筆。');
  return { changed, series: names.length, warns, conflicts };
}

/** 預覽確認後執行：實際寫入 seriesId（task_40e96378；R-1 守衛，寫入唯一入口） */
function backfillSeriesIdsApply() {
  _assertManualRunByDeployer_('backfillSeriesIdsApply');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);  // 讀取到寫入整段持鎖，與 add/edit/renewRequirements 互斥
  try {
    return _backfillSeriesIds_(true);
  } finally {
    lock.releaseLock();
  }
}
