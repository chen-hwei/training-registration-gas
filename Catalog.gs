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

/** 新增研習課程 */
function addCatalog(userId, body) {
  if (!body.title)  return _err('MISSING_TITLE');
  if (!body.hours)  return _err('MISSING_HOURS');

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
      createdAt:      _now()
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

/** 編輯研習課程（不可修改 catalogId、createdBy、createdAt、status） */
function editCatalog(userId, body) {
  if (!body.catalogId) return _err('MISSING_CATALOG_ID');

  const sheet  = _getCatalogSheet();
  const schema = SHEET_SCHEMA.TRAINING_CATALOG;
  const lock   = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data  = sheet.getDataRange().getValues();
    const idIdx = schema.keys.indexOf('catalogId');
    let found   = false;

    const EDITABLE = ['title', 'hours', 'organizer', 'department', 'startDate',
                      'endDate', 'description', 'targetAudience', 'link', 'isRequired'];

    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] !== body.catalogId) continue;
      found = true;
      EDITABLE.forEach(key => {
        if (body[key] === undefined) return;
        const col = schema.keys.indexOf(key);
        if (col === -1) return;
        if (key === 'hours')      { data[i][col] = Number(body[key]) || 0; return; }
        if (key === 'isRequired') { data[i][col] = body[key] === true || body[key] === 'TRUE'; return; }
        data[i][col] = String(body[key]);
      });
      break;
    }

    if (!found) return _err('CATALOG_NOT_FOUND');
    sheet.clearContents();
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);

    SchoolPortalLib.logAction(userId, 'EDIT_CATALOG', body.catalogId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/** 封存研習課程（狀態設為 ARCHIVED，不實體刪除） */
function archiveCatalog(body) {
  if (!body.catalogId) return _err('MISSING_CATALOG_ID');

  const sheet  = _getCatalogSheet();
  const schema = SHEET_SCHEMA.TRAINING_CATALOG;
  const lock   = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data      = sheet.getDataRange().getValues();
    const idIdx     = schema.keys.indexOf('catalogId');
    const statusIdx = schema.keys.indexOf('status');
    let found = false;

    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] !== body.catalogId) continue;
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
