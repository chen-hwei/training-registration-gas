# 研習登錄系統 — 專案記憶庫 (CLAUDE.md)

> 本檔案為此專案的 Claude 工作記憶，每次開新對話前必須讀取。
> 已列入 `.claspignore`，不會被 `clasp push` 推送至 GAS。

---

## 🔗 系統網址（極重要，勿用錯）

| 用途 | URL |
|---|---|
| **正確入口（必用）** | `https://script.google.com/a/macros/zlsh.tp.edu.tw/s/AKfycbx9kbkwBcxy8XnoqIBuiUF36UGUKjaTWOA87BoKK72JO_hvE4kqxfotLmEHadWkOXAu6g/exec` |
| GAS 編輯器 | `https://script.google.com/d/1adeMuteQ3rkICnHD7W1bZpRhAdc_WaeN27zBpAmCqOVoEhL6hOCi43lB/edit` |
| Hub 試算表 | `https://docs.google.com/spreadsheets/d/10CkSP4jGDh6Tfitljl69AJ256gV46TdGnaN170gE6BQ` |
| 研習紀錄試算表 | `https://docs.google.com/spreadsheets/d/1Wx9ccA2rfH5HB1kVB4QlUIvTS7zVmbcklHFOJI6Xj6Y` |

### ⚠️ 白屏問題的根本原因（已驗證）

Google Workspace 學校帳號的 GAS Web App 有兩種 URL，**只有第一種是正確的**：

```
✅ https://script.google.com/a/macros/zlsh.tp.edu.tw/s/[DEPLOYMENT_ID]/exec
❌ https://script.google.com/macros/s/[DEPLOYMENT_ID]/exec   ← 消費者 URL，禁止使用
```

**為什麼消費者 URL 導致白屏：**
1. 使用消費者 URL → Google 將用戶轉址到 `[hash]-script.googleusercontent.com/userCodeAppPanel`
2. 代碼裡的頁面導覽 `window.top.location.href = '?page=admin'` 是相對路徑，從 `googleusercontent.com` 出發，停在 `googleusercontent.com`
3. 每次更新 GAS 部署版本，`googleusercontent.com` 的 **hash 子網域可能改變**
4. Hash 改變 → localStorage 的 `spl_token` 消失 → `getToken()` 回傳 null → 白屏

**正確 URL 的行為：**
- 頁面導覽結果：`script.google.com/a/macros/zlsh.tp.edu.tw/s/.../exec?page=admin`（穩定不變）
- localStorage 存在 `script.google.com` 域下，部署更新不影響

---

## 🔑 系統 ID 清單

| 常數 | 值 |
|---|---|
| `scriptId` (.clasp.json) | `1adeMuteQ3rkICnHD7W1bZpRhAdc_WaeN27zBpAmCqOVoEhL6hOCi43lB` |
| `TRAINING_SS_ID` | `1Wx9ccA2rfH5HB1kVB4QlUIvTS7zVmbcklHFOJI6Xj6Y` |
| `TRAINING_DRIVE_ROOT_FOLDER_ID` | `1YoGvcZqlHFZdqyZdNlIuoo3a0wQ_Z1um` |
| `HUB_SPREADSHEET_ID` | `10CkSP4jGDh6Tfitljl69AJ256gV46TdGnaN170gE6BQ` |
| `LOG_SPREADSHEET_ID` | `1dSOsV-y_9O0Hj1pKkOFf_NKBlGSbTzClC_OcTBcSFuM` |
| `SchoolPortalLib` Library ID | `1nAG4tkI8tlHbmrMpdvmIHdA47SFkPwO8zMujGH11rOhjteYieMxzpVFS` |
| Deployment ID | `AKfycbx9kbkwBcxy8XnoqIBuiUF36UGUKjaTWOA87BoKK72JO_hvE4kqxfotLmEHadWkOXAu6g` |

---

## 🔄 每次部署的標準流程（必須兩步都做）

```bash
# 步驟 1：推送程式碼
cd "C:\Users\User\Documents\Claude Desktop\研習登錄系統"
clasp push
# 出現 "Manifest file has been updated. Do you want to push and overwrite?" 要回答 y
```

```
步驟 2：更新 GAS 部署版本（每次 clasp push 後必做，否則線上跑舊版）
GAS 編輯器 → 右上「部署」→「管理部署」→ ✎ 編輯 → 版本選「新增版本」→ 儲存
```

> **過去曾因漏掉步驟 2 導致白屏**，clasp push 只更新 HEAD，不會自動更新已部署的 Web App 版本。

---

## 👤 管理者權限設定

`isAdmin()` 讀取 `localStorage.spl_access`，此值來自 `SchoolPortalLib.login()` 回傳的 `systemAccess`，最終來源是 **Hub 試算表的 `UserStatusCache` 工作表**。

若管理者帳號看不到管理後台（跳回首頁）：
1. 開啟 Hub 試算表 → `UserStatusCache` 工作表
2. 找到該教師帳號（txxxx）的列
3. `systemAccess` 欄位填入：`{"training_admin":true}`
4. 登出後重新登入（重新取得 Token 讓新的 `systemAccess` 生效）

---

## 📚 SchoolPortalLib 使用說明

- Library ID：`1nAG4tkI8tlHbmrMpdvmIHdA47SFkPwO8zMujGH11rOhjteYieMxzpVFS`
- **已嵌入 `appsscript.json`**，`clasp push` 後不需要在 GAS 編輯器手動重新加入
- 使用 `developmentMode: true`（HEAD 版本），修改 Library 後立即生效
- 主要呼叫方式：`SchoolPortalLib.login()`, `SchoolPortalLib.verifyToken()`, `SchoolPortalLib.getUser()`, `SchoolPortalLib.getTeachers()`

---

## 🏗️ 架構重點

### 前端共用元件（config.html）
- `api(action, body)` → 所有後端呼叫唯一入口（透過 `google.script.run`，**禁止 fetch**）
- `initPage({ adminOnly: true })` → 頁面初始化 + Token 檢查 + 管理者檢查
- `saveSession(res)` → 登入後儲存 Token 到 localStorage
- `isAdmin()` → 讀取 `localStorage.spl_access.training_admin`

### GAS Warden 作用域隔離（每個 HTML 頁面都要做）
```javascript
// 每個頁面 <script> 末尾必須將所有 onclick 用到的函式掛到 window
window.onLoginSuccess = onLoginSuccess;
window.functionName   = functionName;
```

### 頁面 DOMContentLoaded 初始化模式
```javascript
document.addEventListener('DOMContentLoaded', function() {
  var ok = initPage({ adminOnly: true }); // 一般頁面不傳 adminOnly
  if (ok) _loadData();
});
```

### 頁面導覽（GAS iframe 環境必用 window.top）
```javascript
window.top.location.href = '?page=admin';  // ✅
window.location.href = '?page=admin';       // ❌ 在 iframe 內失效
```

---

## 🐛 已知問題與解法

| 問題 | 原因 | 解法 |
|---|---|---|
| 白屏（連藍色頁首都沒有） | 使用消費者 URL，每次部署 `googleusercontent.com` hash 改變，localStorage Token 失效 | 改用 `/a/macros/zlsh.tp.edu.tw/` 域 URL |
| 白屏（頁首可見，內容空白） | `showSpinner()` 的 `z-index:900` 蓋住 `z-index:100` 的頁首 | `style.html` spinner `z-index` 已改為 `90` |
| 點導覽連結又被帶到 `googleusercontent.com` | `window.top.location.href = '?page=...'` 是相對路徑；若 `window.top` 停在 `googleusercontent.com`，相對路徑就停留在 `googleusercontent.com` | `config.html` 新增 `_navigate()` helper，後端注入絕對 URL `APP_BASE_URL`（`WEB_APP_BASE_URL` 常數定義於 `Schema.gs`，`doGet()` 以 `template.appBaseUrl` 注入） |
| 資料載入後內容靜默空白（Date 序列化地雷） | 日期欄位 `getValues()` 回傳 JS `Date` 物件，`google.script.run` postMessage 無法序列化 → `result = null` → `withSuccessHandler(null)` → 靜默白屏，不進 `.catch()` | `Schema.gs parseSheetData` 補 `instanceof Date` 判斷，強制 `Utilities.formatDate()` 轉字串（同教職員名冊管理系統） |
| 管理後台跳回首頁 | Hub `UserStatusCache` 的 `systemAccess` 欄未設 `training_admin:true` | 見上方「管理者權限設定」 |
| clasp push 後改了沒生效 | 部署版本未更新 | 每次 push 後到 GAS 編輯器「新增版本」 |
| SchoolPortalLib 設定消失 | 以前 `appsscript.json` 沒有 Library 設定，clasp push 時覆寫 | Library 已嵌入 `appsscript.json`，此問題已修復 |
| `initSheetHeaders()` 拋出「工作表不存在」 | 舊版 `ensureSheetHeaders` 用 `_getTrainingSheet` 會 throw | `ensureSheetHeaders` 已改為自動建立工作表 |

### ⚠️ WEB_APP_BASE_URL 更新時機
若日後**重新部署**（產生新 Deployment ID），必須同步更新 `Schema.gs` 中的 `WEB_APP_BASE_URL` 常數，否則 `_navigate()` 會導向舊部署。

---

## 📋 UAT 狀態

目前正在進行端對端驗收測試（T1–T9）。執行前確保：
1. Hub `UserStatusCache` 有測試教師帳號與管理者帳號（含 `training_admin:true`）
2. 使用 `/a/macros/zlsh.tp.edu.tw/` 正確 URL 存取
3. 有執行 `setupSyncTrigger()` 和 `setupNotifyTriggers()` 設定定時觸發器

---

## 📁 專案結構

```
研習登錄系統/
├── 程式碼.gs      # doGet / doPost / handleRequest 路由
├── Schema.gs      # SHEET_SCHEMA + 系統常數 + ID 產生器
├── Catalog.gs     # 研習目錄 CRUD
├── Record.gs      # 登錄紀錄與 Base64 檔案上傳
├── Review.gs      # 審核流程（核准 / 退件 / 匯出）
├── Drive.gs       # Google Drive 資料夾與授權管理
├── Sync.gs        # 每晚同步 TrainingStats → Portal Hub
├── Notify.gs      # 通知系統（N1/N2/N3）
├── Index.html     # 教師端首頁（研習公告列表）
├── Submit.html    # 選課與上傳頁面
├── Records.html   # 教師端個人研習紀錄查詢
├── Admin.html     # 管理者審核後台
├── style.html     # 共用 CSS
├── config.html    # 共用 JS（api() / Token / 登入 Modal）
├── appsscript.json # GAS 設定（含 SchoolPortalLib Library）
├── .clasp.json    # scriptId + rootDir
├── .claspignore   # 排除 .git/ .claude/ *.md CLAUDE.md
├── README.md      # 專案說明文件
├── CLAUDE.md      # ← 本檔案，Claude 工作記憶
└── 開發進度說明.md # 開發知識庫
```
