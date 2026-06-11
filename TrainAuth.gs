// ================================================================
// TrainAuth.gs — TRAIN 系統原生 Token 驗證 + 身分證後六碼登入
// ================================================================
// Token 架構：
//   前置詞   : 'train_' + UUID（無連字符）
//   儲存位置 : TRAIN 自身 CacheService.getScriptCache()
//   Cache key: 'ttok_' + token
//   Cache 值 : JSON { userId, expireAt(ms) }
//   TTL      : 6 小時（21600 秒）
// 欄位查找策略：
//   _getHubUser_ 依試算表「標題列」動態建立 colMap，
//   不依賴固定欄位索引，不受欄位新增/搬移影響。
// ================================================================

const TRAIN_TOKEN_PREFIX  = 'train_';
const TRAIN_TOKEN_TTL     = 21600;   // 6 小時
const TRAIN_ACTIVE_STATUSES = ['在職', '轉調'];

// Hub UserStatusCache 標題 → 英文 key 對照（動態查找用）
// 同時支援中文標題（規範）與英文標題（Hub 現行實際欄名）
const HUB_USC_HEADER_MAP = {
  // 中文標題（未來標準化後的規範格式）
  '教師ID':       'userId',
  '姓名':         'name',
  '所屬處室':     'department',
  'Email':        'email',
  '在職狀態':     'status',
  '狀態異動時間': 'statusChangedAt',
  '系統存取權':   'systemAccess',
  '身分驗證雜湊': 'idHash',
  // 英文標題（Hub 現行實際欄名）
  'userId':          'userId',
  'name':            'name',
  'department':      'department',
  'schoolEmail':     'email',     // G欄 schoolEmail 視為主要 email
  'status':          'status',
  'statusChangedAt': 'statusChangedAt',
  'systemAccess':    'systemAccess',
};

// ── Token 發行 ────────────────────────────────────────────────
function _issueTrainToken_(userId) {
  const token    = TRAIN_TOKEN_PREFIX + Utilities.getUuid().replace(/-/g, '');
  const expireAt = Date.now() + TRAIN_TOKEN_TTL * 1000;
  CacheService.getScriptCache().put(
    'ttok_' + token,
    JSON.stringify({ userId, expireAt }),
    TRAIN_TOKEN_TTL
  );
  return { token, expireAt };
}

// ── Token 驗證（回傳 userId 或 null）──────────────────────────
function _verifyTrainToken_(token) {
  if (!token || !token.startsWith(TRAIN_TOKEN_PREFIX)) return null;
  const raw = CacheService.getScriptCache().get('ttok_' + token);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data.expireAt >= Date.now() ? data.userId : null;
  } catch (_) { return null; }
}

// ── SHA-256 雜湊（身分證後六碼用）────────────────────────────
function _hashIdSuffixTrain_(suffix) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    suffix,
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// ── 讀取 Hub UserStatusCache（依標題列動態查找，回傳英文 key 物件）
// 不依賴固定欄序，欄位新增或搬移不影響程式邏輯。
function _getHubUser_(userId) {
  try {
    const hub   = SpreadsheetApp.openById(HUB_SPREADSHEET_ID);
    const sheet = hub.getSheetByName('UserStatusCache');
    if (!sheet) { Logger.log('[_getHubUser_] 找不到 UserStatusCache 工作表'); return null; }

    const rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return null;

    // 依標題列建立 colMap：{ userId: 0, name: 1, ... }
    const colMap = {};
    rows[0].forEach((h, i) => {
      const key = HUB_USC_HEADER_MAP[String(h).trim()];
      if (key) colMap[key] = i;
    });

    if (colMap.userId === undefined) {
      Logger.log('[_getHubUser_] 找不到「教師ID」欄');
      return null;
    }

    // 找到對應列
    const found = rows.slice(1).find(
      r => String(r[colMap.userId] || '').trim() === userId
    );
    if (!found) return null;

    // 將列轉為英文 key 物件
    const obj = {};
    Object.keys(colMap).forEach(key => {
      obj[key] = found[colMap[key]];
    });
    return obj;
  } catch (e) {
    Logger.log('[_getHubUser_] err=' + e.message);
    return null;
  }
}

// ── 公開 API：查詢帳號對應姓名（登入步驟 1）─────────────────
/**
 * action: 'train/getUserName'
 * body: { userId }
 */
function trainGetUserName_(params) {
  const userId = String((params && params.userId) || '').trim();
  if (!userId)                 return { success: false, message: '請輸入帳號' };
  if (!/^t\d+$/i.test(userId)) return { success: false, message: '帳號格式錯誤（應為 txxxx）' };

  const user = _getHubUser_(userId);
  if (!user) return { success: false, message: '查無此帳號，請確認後再試' };

  if (!TRAIN_ACTIVE_STATUSES.includes(String(user.status || '').trim())) {
    return { success: false, message: '此帳號已停用，請聯繫資訊組' };
  }

  return { success: true, name: String(user.name || ''), userId };
}

// ── 公開 API：身分證後六碼登入（登入步驟 2）─────────────────
/**
 * action: 'train/loginWithIdSuffix'
 * body: { userId, idSuffix }
 */
function trainLoginWithIdSuffix_(params) {
  const userId = String((params && params.userId) || '').trim();
  const suffix = String((params && params.idSuffix) || '').trim();

  if (!userId || !suffix) return { success: false, message: '資料不完整' };
  if (!/^[A-Za-z0-9]{6}$/.test(suffix)) {
    return { success: false, message: '請輸入身分證後六碼（共 6 碼英數字）' };
  }

  // ── 暴力破解保護 ──────────────────────────────────────────
  const props   = PropertiesService.getScriptProperties();
  const lockKey = 'train_fail_' + userId;
  const lockVal = parseInt(props.getProperty(lockKey) || '0', 10);
  if (lockVal >= 5) {
    return { success: false, message: '錯誤次數過多，帳號暫時鎖定，請聯繫資訊組解鎖' };
  }

  const user = _getHubUser_(userId);
  if (!user) return { success: false, message: '查無此帳號' };

  if (!TRAIN_ACTIVE_STATUSES.includes(String(user.status || '').trim())) {
    return { success: false, message: '此帳號已停用，請聯繫資訊組' };
  }

  const storedHash = String(user.idHash || '').trim();
  if (!storedHash) {
    return { success: false, message: '尚未設定個人驗證碼，請聯繫資訊組' };
  }

  // ── 比對雜湊 ──────────────────────────────────────────────
  const inputHash = _hashIdSuffixTrain_(suffix);
  if (inputHash !== storedHash) {
    props.setProperty(lockKey, String(lockVal + 1));
    const remain = 4 - lockVal;
    return { success: false, message: '驗證碼錯誤（還有 ' + remain + ' 次機會）' };
  }

  // ── 驗證成功 ──────────────────────────────────────────────
  props.deleteProperty(lockKey);
  const { token, expireAt } = _issueTrainToken_(userId);

  const name      = String(user.name || '');
  let systemAccess = {};
  try { systemAccess = JSON.parse(String(user.systemAccess || '{}')); } catch (_) {}

  return { success: true, token, expireAt, name, userId, systemAccess };
}

// ── 管理工具：解鎖被鎖定帳號 ─────────────────────────────────
function trainUnlockUser_(params) {
  const target = params && params.targetUserId;
  if (!target) return { success: false, message: '請傳入 targetUserId' };
  PropertiesService.getScriptProperties().deleteProperty('train_fail_' + target);
  return { success: true, message: target + ' 解鎖成功' };
}

// ── Token 驗證（train_ 優先，降級 SchoolPortalLib）───────────
/**
 * 回傳 { valid, userId, name, systemAccess } 或 { valid: false, reason }
 */
function verifyTrainSession_(token) {
  // 1. TRAIN 原生 Token
  if (token && token.startsWith(TRAIN_TOKEN_PREFIX)) {
    const userId = _verifyTrainToken_(token);
    if (!userId) return { valid: false, reason: 'TOKEN_EXPIRED' };

    const user = _getHubUser_(userId);
    if (!user)   return { valid: false, reason: 'USER_NOT_FOUND' };

    if (!TRAIN_ACTIVE_STATUSES.includes(String(user.status || '').trim())) {
      return { valid: false, reason: 'INACTIVE_USER' };
    }

    let systemAccess = {};
    try { systemAccess = JSON.parse(String(user.systemAccess || '{}')); } catch (_) {}

    return {
      valid: true,
      userId,
      name: String(user.name || ''),
      systemAccess,
    };
  }

  // 2. SchoolPortalLib Token（向後相容）
  try {
    const session = SchoolPortalLib.verifyToken(token);
    if (!session || !session.valid) return { valid: false, reason: 'TOKEN_EXPIRED' };
    const libUser = SchoolPortalLib.getUser(session.userId);
    if (!libUser) return { valid: false, reason: 'USER_NOT_FOUND' };
    const sa = libUser.systemAccess;
    let systemAccess = {};
    try {
      systemAccess = (typeof sa === 'object' && sa !== null)
        ? sa : JSON.parse(String(sa || '{}'));
    } catch (_) {}
    return {
      valid: true,
      userId: libUser.userId,
      name:   libUser.name,
      systemAccess,
    };
  } catch (e) {
    return { valid: false, reason: 'TOKEN_ERROR' };
  }
}
