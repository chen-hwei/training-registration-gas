// ==================== 研習目錄管理 ====================

// ── Level 1（教師端） ──

/** 取得所有 ACTIVE 狀態的研習課程清單 */
function getCatalog() {
  return parseSheetData(_getCatalogSheet())
    .filter(c => c.status === 'ACTIVE')
    .map(c => ({
      ...c,
      hours:      Number(c.hours) || 0,
      isRequired: c.isRequired === true || String(c.isRequired).toUpperCase() === 'TRUE'
    }));
}

// ── Level 2（管理者端） ──

/**
 * 新增研習課程
 * scope 限制下，若掛了任務（requirementId），該任務的 owner 須 ∈ scope（或留空不限制）
 * （B-4：課程若掛任務，視同該任務的處室資產）
 */
function addCatalog(userId, body, scope) {
  if (!body.title)  return _err('MISSING_TITLE');
  if (!body.hours)  return _err('MISSING_HOURS');

  const requirementId = String(body.requirementId || '').trim();
  if (!_isAllScope_(scope) && requirementId) {
    const owner = _buildOwnerIndex_().reqOwner[requirementId] || '';
    if (!_inScope_(owner, scope)) return _err('FORBIDDEN');
  }

  const sheet = _getCatalogSheet();
  const lock  = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const allRows   = sheet.getDataRange().getValues();
    const catalogId = _generateCatalogId(allRows);
    const schema    = SHEET_SCHEMA.TRAINING_CATALOG;

    const newCatalog = {
      catalogId,
      title:          String(body.title),
      hours:          Number(body.hours) || 0,
      organizer:      String(body.organizer      || ''),
      department:     String(body.department     || ''),
      createdBy:      userId,
      startDate:      String(body.startDate      || ''),
      endDate:        String(body.endDate        || ''),
      description:    String(body.description    || ''),
      targetAudience: String(body.targetAudience || ''),
      link:           String(body.link           || ''),
      isRequired:     body.isRequired === true || body.isRequired === 'TRUE',
      status:         'ACTIVE',
      createdAt:      _now(),
      requirementId:  String(body.requirementId   || '')
    };

    const newRow = schema.keys.map(k => newCatalog[k] !== undefined ? newCatalog[k] : '');
    allRows.push(newRow);
    sheet.clearContents();
    sheet.getRange(1, 1, allRows.length, allRows[0].length).setValues(allRows);

    SchoolPortalLib.logAction(userId, 'ADD_CATALOG', catalogId);
    return { success: true, catalogId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 編輯研習課程（不可修改 catalogId、createdBy、createdAt、status）
 * scope 限制下，改前 requirementId 與改後 requirementId 對應的 owner 皆須 ∈ scope（或空）
 * （B-4：requirementId 改綁與 editRequirement 的 owner 改前／改後同型，防止把課程從
 * A 處室任務改掛到 B 處室繞過權限）
 */
function editCatalog(userId, body, scope) {
  if (!body.catalogId) return _err('MISSING_CATALOG_ID');

  const sheet  = _getCatalogSheet();
  const schema = SHEET_SCHEMA.TRAINING_CATALOG;
  const lock   = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data     = sheet.getDataRange().getValues();
    const idIdx    = schema.keys.indexOf('catalogId');
    const reqIdIdx = schema.keys.indexOf('requirementId');
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] === body.catalogId) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return _err('CATALOG_NOT_FOUND');

    if (!_isAllScope_(scope)) {
      const index = _buildOwnerIndex_();
      const currentReqId = String(data[rowIdx][reqIdIdx] || '').trim();
      const currentOwner = currentReqId ? (index.reqOwner[currentReqId] || '') : '';
      if (!_inScope_(currentOwner, scope)) return _err('FORBIDDEN');

      if (body.requirementId !== undefined) {
        const newReqId = String(body.requirementId || '').trim();
        const newOwner = newReqId ? (index.reqOwner[newReqId] || '') : '';
        if (!_inScope_(newOwner, scope)) return _err('FORBIDDEN');
      }
    }

    const EDITABLE = ['title', 'hours', 'organizer', 'department', 'startDate',
                      'endDate', 'description', 'targetAudience', 'link', 'isRequired',
                      'requirementId'];

    EDITABLE.forEach(key => {
      if (body[key] === undefined) return;
      const col = schema.keys.indexOf(key);
      if (col === -1) return;
      if (key === 'hours')      { data[rowIdx][col] = Number(body[key]) || 0; return; }
      if (key === 'isRequired') { data[rowIdx][col] = body[key] === true || body[key] === 'TRUE'; return; }
      data[rowIdx][col] = String(body[key]);
    });

    sheet.clearContents();
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);

    SchoolPortalLib.logAction(userId, 'EDIT_CATALOG', body.catalogId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 封存研習課程（狀態設為 ARCHIVED，不實體刪除）
 * scope 限制下，課程現有 requirementId 對應的 owner 須 ∈ scope（或空）（B-4 同型）
 */
function archiveCatalog(body, scope) {
  if (!body.catalogId) return _err('MISSING_CATALOG_ID');

  const sheet  = _getCatalogSheet();
  const schema = SHEET_SCHEMA.TRAINING_CATALOG;
  const lock   = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data      = sheet.getDataRange().getValues();
    const idIdx     = schema.keys.indexOf('catalogId');
    const statusIdx = schema.keys.indexOf('status');
    const reqIdIdx  = schema.keys.indexOf('requirementId');
    let found = false;

    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] !== body.catalogId) continue;

      if (!_isAllScope_(scope)) {
        const currentReqId = String(data[i][reqIdIdx] || '').trim();
        const owner = currentReqId ? (_buildOwnerIndex_().reqOwner[currentReqId] || '') : '';
        if (!_inScope_(owner, scope)) return _err('FORBIDDEN');
      }

      data[i][statusIdx] = 'ARCHIVED';
      found = true;
      break;
    }

    if (!found) return _err('CATALOG_NOT_FOUND');
    sheet.clearContents();
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}
