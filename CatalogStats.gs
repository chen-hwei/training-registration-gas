// ==================== 研習目錄課程統計（task_c95dbe21 Stage 4） ====================

/**
 * 課程完成狀況：每門「掛有 ACTIVE 且學年相符任務」的課程，回傳已完成／審核中／退件人數
 * （全校／高中部／國中部／其他）與已登錄名單。課程視圖不算達成率、不做未完成名單（Q2 丙、Q2-1 乙）。
 *
 * - 範圍（Y-9）：課程所掛任務須 ACTIVE 且 academicYear 相符；未掛任務的課程不列；封存課程仍列入並標 archived
 * - 處室過濾：非全權只回任務 owner ∈ scope 的課程，空 owner 僅全權（沿用 _buildOwnerIndex_／_resolveRecordOwner_）
 * - 一人一狀態（R-2）：同一教師同一課程多筆紀錄取最高狀態（_statusRank_）
 * - 名冊查無：紀錄的教師在 Hub.UserStatusCache 查無帳號時照列，部別／email 留空並標 inRoster=false
 * - 部別歸桶與 calcRequirementStats 相同：高中部→hs、國中部→jh、其餘→other
 * - 紀錄以 catalogId 對課程，catalogId 為空的自訂課程紀錄不計入
 * @param {Object} body { academicYear }（缺省為當學年）
 * @param {string[]} scope 呼叫者處室範圍
 */
function getCatalogStats(body, scope) {
  try {
    const academicYear = Number((body || {}).academicYear || _currentAcademicYear());
    const isAll = _isAllScope_(scope);

    // ── 各表只讀一次 ──
    const reqRows     = parseSheetData(_getRequirementSheet());
    const catalogRows = parseSheetData(_getCatalogSheet());
    const recordRows  = parseSheetData(_getRecordSheet());
    const hubRows     = _readHubUserStatusRows_();

    // ── 任務：ACTIVE 且學年相符 ──
    const reqMap = {};
    reqRows.forEach(r => {
      if (r.status === 'ACTIVE' && Number(r.academicYear) === academicYear) reqMap[r.requirementId] = r;
    });

    // ── 課程：掛有上述任務，且（全權或任務 owner ∈ scope）──
    const ownerIndex = _buildOwnerIndex_(catalogRows, reqRows);
    const courses = catalogRows.filter(c => {
      const rid = String(c.requirementId || '').trim();
      if (!rid || !reqMap[rid]) return false;
      return isAll || _inScope_(_resolveRecordOwner_({ requirementId: rid }, ownerIndex), scope);
    });
    if (courses.length === 0) return _ok({ academicYear: academicYear, courses: [] });

    // ── 名冊：userId → { name, department, schoolEmail }（不篩在職，查無才標 inRoster=false）──
    const hdr = hubRows[0];
    const uIdCol = hdr.indexOf('userId'), uNmCol = hdr.indexOf('name');
    const uDpCol = hdr.indexOf('department'), uEmCol = hdr.indexOf('schoolEmail');
    const roster = {};
    hubRows.slice(1).forEach(r => {
      const uid = String(r[uIdCol] || '').trim();
      if (!uid) return;
      roster[uid] = {
        name:        uNmCol >= 0 ? String(r[uNmCol] || '').trim() : '',
        department:  uDpCol >= 0 ? String(r[uDpCol] || '').trim() : '',
        schoolEmail: uEmCol >= 0 ? String(r[uEmCol] || '').trim() : ''
      };
    });

    // ── 紀錄：「catalogId_userId」→ 最高狀態 ──
    const courseIds = {};
    courses.forEach(c => { courseIds[c.catalogId] = true; });
    const best = {};  // key → { catalogId, userId, status }
    recordRows.forEach(r => {
      const cid = String(r.catalogId || '').trim();
      const uid = String(r.userId || '').trim();
      if (!cid || !uid || !courseIds[cid] || !_statusRank_(r.status)) return;
      const key = cid + '_' + uid;
      if (!best[key] || _statusRank_(r.status) > _statusRank_(best[key].status)) {
        best[key] = { catalogId: cid, userId: uid, status: r.status };
      }
    });
    const byCourse = {};
    Object.keys(best).forEach(k => {
      const b = best[k];
      (byCourse[b.catalogId] = byCourse[b.catalogId] || []).push(b);
    });

    const bucket = () => ({ all: 0, hs: 0, jh: 0, other: 0 });
    const result = courses.map(c => {
      const counts = { approved: bucket(), pending: bucket(), rejected: bucket() };
      const registrants = (byCourse[c.catalogId] || []).map(b => {
        const u = roster[b.userId];
        const dept = u ? u.department : '';
        const dk = dept === '高中部' ? 'hs' : (dept === '國中部' ? 'jh' : 'other');
        const sk = b.status === 'APPROVED' ? 'approved' : (b.status === 'PENDING' ? 'pending' : 'rejected');
        counts[sk].all++;
        counts[sk][dk]++;
        return {
          userId:      b.userId,
          name:        u ? u.name : '',
          department:  dept,
          schoolEmail: u ? u.schoolEmail : '',
          status:      b.status,
          inRoster:    !!u
        };
      }).sort((a, b) => (_statusRank_(b.status) - _statusRank_(a.status)) || String(a.userId).localeCompare(String(b.userId)));
      const req = reqMap[String(c.requirementId).trim()];
      return {
        catalogId:       c.catalogId,
        title:           c.title,
        hours:           Number(c.hours) || 0,
        requirementId:   req.requirementId,
        requirementName: req.name,
        owner:           String(req.owner || '').trim(),
        archived:        c.status === 'ARCHIVED',
        counts:          counts,
        registrants:     registrants
      };
    });
    return _ok({ academicYear: academicYear, courses: result });
  } catch (e) {
    return _err('getCatalogStats 失敗：' + e.message);
  }
}
