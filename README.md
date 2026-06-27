# 研習登錄與審核系統

> 臺北市立中崙高中（`@zlsh.tp.edu.tw`）· 學校資訊系統整合平台 · 第五個子系統

以 Google Apps Script 建構的研習登錄與審核系統。提供「年度研習任務進度追蹤」功能，讓教師清楚掌握學年度各項應修研習的完成狀態；支援線上登錄研習紀錄、上傳研習證明，並由各處室管理者進行審核與退件。審核通過的紀錄定時彙整至整合平台 Hub，提供全校年度研習時數儀表板。

---

## 功能概覽

### 教師端
- **年度任務進度儀表板**：首頁依緊急程度顯示所有應修研習任務（過期 / 緊急 / 一般 / 已完成），每項任務顯示進度條與已核准時數
- 瀏覽各處室推薦的研習課程（含必修標記）
- 選擇推薦課程或自訂課程進行登錄；可在登錄時標記「完成哪項年度任務」
- 上傳研習證明（PDF / JPG / PNG，上限 8MB）
- 即時查詢審核狀態（待審核 / 已通過 / 已退件）
- 退件時顯示原因，可一鍵重新送出；若證明檔案無誤可選擇「沿用上次上傳的證明」，避免重複上傳

### 管理者端（需 `training_admin` 權限）
- **年度任務管理**：新增、編輯、封存各學年度的研習任務；一鍵複製到下學年（自動順延截止日）
- 新增、編輯、封存所屬處室的推薦研習課程
- 批次審核教師上傳的研習證明（核准 / 退件並附理由）
- 匯出研習紀錄報表（CSV）
- 預覽並手動觸發通知（即時掌握待通知教師名單）
- **研習統計分析**：多來源研習資料匯入（全國進修網 + 臺北市研習網）、人事名冊多學年管理、政策指標達成率儀表板（累積/當年度，跨裝置快取）、未達成教師矩陣總覽（指標 checkbox 篩選 + CSV 匯出）、批次預計算

### 自動通知（學校 Gmail）
系統透過 GAS `MailApp` 使用管理者的學校 Gmail 自動寄送三種通知信：

| 情境 | 觸發條件 | 收件者 |
|---|---|---|
| **到期前提醒**（N1） | 必修課程距截止日 ≤ 7 天，教師無登錄紀錄 | 教師本人 |
| **逾期未完成**（N2） | 必修課程已過截止日，無通過審核的紀錄 | 教師本人 ＋ 所屬處室管理者 |
| **待審逾時**（N3） | PENDING 紀錄超過 3 天未被審核 | 所屬處室管理者 |

---

## 技術架構

| 項目 | 技術 |
|---|---|
| 後端 | Google Apps Script（clasp 管理） |
| 資料庫 | Google Sheets（2 個工作表） |
| 檔案儲存 | Google Drive（依年份 / 教師 ID 分層管理） |
| 身分驗證 | TRAIN 原生 Token（`txxxx` + 身分證後六碼，SHA-256 雜湊，CacheService `train_` Token）；向後相容 SchoolPortalLib |
| 前端 | HTML / CSS / Vanilla JS（GAS HtmlService） |
| 檔案上傳 | FileReader → Base64 → `google.script.run`（單次上傳，上限 8MB） |
| 圖片壓縮 | Canvas API 前端壓縮（JPG/PNG 自動壓縮至 2MB 以下再上傳，防手機大圖逾時） |
| 併發保護 | `LockService.getScriptLock()` 保護所有試算表寫入（submitRecord / reviewRecord） |
| 通知寄送 | GAS `MailApp`，使用腳本擁有者的學校 Gmail，1,500 封/日配額 |
| Email 來源 | `SchoolPortalLib.getUser(txxxx).email`，不重複儲存（教職員名冊為唯一來源） |

---

## 資料庫 Schema

### TRAINING_REQUIREMENT（年度研習任務）

| 欄位 | 說明 |
|---|---|
| `requirementId` | 任務編號，格式 `RQ{學年度}{3位序號}`，如 `RQ114001` |
| `academicYear` | 民國學年度（如 `114`） |
| `name` | 任務名稱 |
| `endDate` · `requiredHours` | 截止日期（YYYY/M/D）、規定時數（0 = 依公文確認） |
| `hoursNote` | 分層時數說明，如「特教師18h｜普通班6h」 |
| `deliveryType` · `semesterSplit` | 研習方式、分學期（上/下） |
| `targetAudience` · `owner` | 適用對象、負責處室 |
| `isRecurring` | 每學年延續（`TRUE` = 複製到下學年時包含） |
| `status` | `ACTIVE` / `ARCHIVED` |

### TRAINING_CATALOG（研習目錄）

| 欄位 | 說明 |
|---|---|
| `catalogId` | 課程編號，格式 `C{年份}{4位序號}` |
| `title` · `hours` · `organizer` | 課程名稱、時數、主辦單位 |
| `department` · `createdBy` | 推薦處室、建立者（txxxx） |
| `startDate` · `endDate` | 研習日期區間（格式 `YYYY/M/D`） |
| `targetAudience` | 研習對象（如「全體教師」、「導師」）；留空表示不限 |
| `link` | 研習公文 URL 或報名頁面；前端顯示為可點擊超連結 |
| `isRequired` | 是否必修（TRUE / FALSE） |
| `status` | `ACTIVE`（可選）/ `ARCHIVED`（封存） |

### TRAINING_RECORD（登錄紀錄）

| 欄位 | 說明 |
|---|---|
| `recordId` | 紀錄編號，格式 `R{年份}{6位序號}` |
| `userId` | 教師 ID（txxxx） |
| `catalogId` · `isCustom` | 關聯課程（自訂課程時 catalogId 為空） |
| `title` · `hours` · `trainingDate` | 研習名稱、時數、日期 |
| `fileId` · `fileName` | Google Drive 檔案 ID 與原始檔名 |
| `status` | `PENDING` / `APPROVED` / `REJECTED` |
| `reviewedBy` · `reviewNote` · `reviewedAt` | 審核者、退件原因、審核時間 |
| `submittedAt` | 送出時間 |
| `resubmitOf` | 若為退件後重送，記錄原始退件紀錄的 `recordId`；初次送出為空字串 |

---

## API 路由

### 教師端（Level 1：Token 驗證）

| action | 說明 |
|---|---|
| `v1/getRequirements` | 取得當前學年所有 ACTIVE 任務 + 個人完成進度 |
| `v1/getCatalog` | 取得 ACTIVE 研習目錄 |
| `v1/getMyRecords` | 取得自己的登錄紀錄與審核狀態 |
| `v1/submitRecord` | 送出研習登錄（含 Base64 檔案，可附 requirementId） |
| `v1/deleteRecord` | 刪除自己的 PENDING 紀錄 |

### 管理者端（Level 2：Token + `training_admin` 角色）

| action | 說明 |
|---|---|
| `v1/admin/getAllRequirements` | 取得所有任務（含封存，可篩選學年度） |
| `v1/admin/addRequirement` · `editRequirement` · `archiveRequirement` | 年度任務 CRUD |
| `v1/admin/renewRequirements` | 複製 isRecurring=TRUE 任務到下學年（自動順延截止日） |
| `v1/admin/addCatalog` · `editCatalog` · `archiveCatalog` | 課程目錄管理 |
| `v1/admin/getPendingReviews` | 取得待審清單 |
| `v1/admin/reviewRecord` | 核准或退件（退件原因必填） |
| `v1/admin/getFileUrl` | 取得研習證明暫時存取 URL |
| `v1/admin/exportRecords` | 匯出研習紀錄 CSV |

---

## Google Drive 資料夾結構

```
研習證明根目錄/（限制存取，僅管理者）
├── 2025/
│   ├── t0001/    ← 個人資料夾：管理者讀寫，本人唯讀
│   └── t0023/
└── 2026/
    └── …
```

**檔案命名規則**：`{年份}_{txxxx}_{課程名稱}_{研習日期YYYYMMDD}.{副檔名}`
> 例：`2026_t0023_Google試算表進階應用_20260515.pdf`

---

## 與整合平台的關係

本系統是[學校資訊系統整合平台](https://github.com/chen-hwei/school-portal-gas)的第五個子系統。

```
研習登錄系統
  │
  ├─ 身分驗證 ──────→ SchoolPortalLib.verifyToken()
  │                    （共用 CacheService Token，txxxx + PIN）
  │
  ├─ 使用者資訊 ────→ Hub.UserStatusCache（唯讀，取得部門資料）
  │
  └─ 統計回寫 ──────→ Hub.TrainingStats（每晚定時同步）
                       └─ 提供主門戶儀表板「年度研習人時彙整」KPI
```

| 依賴方向 | 對象 | 說明 |
|---|---|---|
| 唯讀依賴 | `Hub.UserStatusCache` | 取得教師所屬處室，供統計分組使用 |
| 單向寫入 | `Hub.TrainingStats` | 彙整本學年 APPROVED 時數與必修達成數 |
| 無關聯 | `Hub.EquipmentRegistry` | 研習不涉及設備資產，不接入設備鎖定機制 |

---

## 專案結構

```
研習登錄系統/
├── 程式碼.gs        # doGet / doPost / handleRequest 路由
├── Schema.gs        # SHEET_SCHEMA 定義與系統常數（含 TRAINING_REQUIREMENT）
├── Requirement.gs   # 年度研習任務 CRUD（getRequirements / renewRequirements / seed114Requirements）
├── Catalog.gs       # 研習目錄 CRUD
├── Record.gs        # 登錄紀錄與 Base64 檔案上傳
├── Review.gs        # 審核流程（核准 / 退件 / 匯出）
├── Drive.gs         # Google Drive 資料夾與授權管理
├── Sync.gs          # 每晚同步 TrainingStats → Portal Hub
├── Notify.gs        # 通知系統（N1/N2/N3）+ 防重複寄送 + 處室管理者查詢
├── TrainingReport.gs # 研習統計分析模組（匯入/名冊快照/指標計算/StatsCache/匯出）
├── Index.html       # 教師端首頁（年度任務進度儀表板 + 公告課程列表）
├── Submit.html      # 選課與上傳頁面（Step ① 任務選擇 → Step ② 研習資訊）
├── Records.html     # 教師端個人研習紀錄查詢（PENDING / APPROVED / REJECTED 分頁）
├── Admin.html       # 管理者後台（待審核 + 研習目錄 + 通知預覽 + 年度任務管理）
├── style.html       # 系統識別色 3 個變數 + SchoolPortalLib.getSharedCSS() 注入共用 CSS + 系統專屬 CSS
└── config.html      # 共用 JS（api() bridge / Token / Base64 工具）
```

---

## 開發狀態

| 階段 | 說明 | 狀態 |
|---|---|---|
| 架構設計 | Schema / API / Drive 結構確認 | ✅ 完成（2026-05-29） |
| Phase 0 | 基礎建設（試算表 + Drive 資料夾 + clasp + SchoolPortalLib） | ✅ 完成（2026-05-30） |
| Phase 1 | 後端骨架（Schema / 路由 / 上傳）— **MVP 核心** | ✅ 完成（2026-05-30） |
| Phase 2 | 審核流程（Review.gs + 管理者 Catalog API）— **MVP 完成** | ✅ 完成（2026-05-30） |
| Phase 3 | 前端介面（Index / Submit / Records / Admin）— 擴展 | ✅ 完成（2026-05-30） |
| Phase 4 | 整合收尾（Hub 同步 / 觸發器 / 通知系統）— 維運就緒 | ✅ 完成（2026-05-30） |
| **UAT** | 端對端驗收測試（T1–T9）— 全部通過 ✅ | ✅ 完成（2026-05-31） |
| **Phase 5A** | 年度任務後端（Requirement.gs + Schema 擴充 + 8 支 API） | ✅ 完成（2026-05-31） |
| **Phase 5B** | 年度任務前端（Index 改版 + Submit 任務選擇 + Admin 第四分頁） | ✅ 完成（2026-05-31） |
| **共用 CSS 抽離** | SchoolPortalLib.getSharedCSS() + style.html 精簡（458 → 86 行） | ✅ 完成（2026-05-31） |
| **Phase 6** | 個人身分證後六碼登入（TRAIN 原生 Token，SHA-256，防暴力破解） | ✅ 完成（2026-06-11） |
| **Phase 7** | 研習統計分析模組（多來源匯入 / 人事名冊快照 / 儀表板 / 未達成矩陣） | ✅ 完成（2026-06-27） |

### 已部署系統常數
| 常數 | 說明 |
|---|---|
| `TRAINING_SS_ID` | `1Wx9ccA2rfH5HB1kVB4QlUIvTS7zVmbcklHFOJI6Xj6Y` |
| `HUB_SPREADSHEET_ID` | `10CkSP4jGDh6Tfitljl69AJ256gV46TdGnaN170gE6BQ` |
| `LOG_SPREADSHEET_ID` | `1dSOsV-y_9O0Hj1pKkOFf_NKBlGSbTzClC_OcTBcSFuM` |
| `SchoolPortalLib ID` | `1nAG4tkI8tlHbmrMpdvmIHdA47SFkPwO8zMujGH11rOhjteYieMxzpVFS` |
| `WEB_APP_BASE_URL` | `https://script.google.com/a/macros/zlsh.tp.edu.tw/s/AKfycbx9kbkwBcxy8XnoqIBuiUF36UGUKjaTWOA87BoKK72JO_hvE4kqxfotLmEHadWkOXAu6g/exec` |

### ⚠️ 正確的系統網址（Google Workspace 域專用）

```
https://script.google.com/a/macros/zlsh.tp.edu.tw/s/AKfycbx9kbkwBcxy8XnoqIBuiUF36UGUKjaTWOA87BoKK72JO_hvE4kqxfotLmEHadWkOXAu6g/exec
```

> **必須使用含 `/a/macros/zlsh.tp.edu.tw/` 的 Workspace 域 URL**，才能讓頁面導覽（`?page=admin` 等相對路徑）停在 `script.google.com` 域下，避免被轉址至 `googleusercontent.com` 造成 localStorage Token 失效（白屏問題）。

### 🐛 UAT 修復紀錄（2026-05-30 ~ 2026-05-31）

UAT 期間發現並修復下列問題：

| 症狀 | 根本原因 | 修復位置 |
|---|---|---|
| 點選導覽連結後白屏，URL 變 `googleusercontent.com` | `window.top.location.href = '?page=X'` 使用相對路徑，當 `window.top` 在 `googleusercontent.com` 時仍留在錯誤域 | `config.html` 新增 `_navigate()`，從 `doGet()` 注入絕對 `APP_BASE_URL` |
| 資料載入後內容空白，API 靜默失敗 | `getValues()` 對日期格式儲存格回傳 JS `Date`，`google.script.run` postMessage 無法序列化，`withSuccessHandler` 收到 `null` | `Schema.gs` `parseSheetData` 加入 `instanceof Date` 檢查，以 `Utilities.formatDate()` 轉字串 |
| 管理後台回傳 FORBIDDEN | `SchoolPortalLib.getUser().systemAccess` 可能已是 JS Object，`JSON.parse(Object)` 拋 SyntaxError，catch 後誤判無權限 | `程式碼.gs` Level 2 改為先 `typeof sa === 'object'` 判斷再決定是否 parse |
| 導覽列出現兩個「管理後台」連結 | `Admin.html` 靜態 `<a>` 缺 `data-admin-link="1"`，`_renderAdminNav()` 重複插入 | `Admin.html` 靜態連結補上屬性 |
| 送出成功後頁面不跳轉 | GAS iframe `allow-top-navigation-by-user-activation` 屬性，`setTimeout` 非同步回呼無使用者手勢，瀏覽器封鎖導覽 | `Submit.html` 改為成功後按鈕變「前往我的紀錄 →」由使用者點擊觸發 |
| 按鈕點擊報 `SyntaxError: Unexpected end of input` | `JSON.stringify(id)` 產生帶雙引號字串嵌入 `onclick=""` 屬性，HTML 解析截斷 | 所有 inline onclick 改用單引號包純 ID；複雜物件改從全域陣列查詢 |
| 退件後靜默失敗 | `confirmReject()` 先呼叫 `closeRejectModal()` 清空了 `_rejectTargetId`，再讀取時已為空 | 先儲存 `var targetId = _rejectTargetId` 再關 Modal |
| Hub.TrainingStats 工作表不存在時 null pointer | `getSheetByName()` 回傳 null，直接 `clearContents()` 爆錯 | `Sync.gs` 改為工作表不存在時自動建立 |
| 管理者信箱收到大量 Drive 共用通知 | `file.addViewer(email)` 預設寄送共用通知信 | `Drive.gs` 改用 Drive API v2 `Permissions.insert`，傳入 `sendNotificationEmails:false` |
| 通知系統不發信（N2 靜默失敗） | `TRAINING_CATALOG` 日期欄位儲存格格式為日期型，`parseSheetData` 轉出 `YYYY-MM-DD`，但 `Notify.gs` 用 `/` 做 split | 解析前加 `.replace(/-/g, '/')` 統一格式 |
| 通知預覽前端永遠空白 | `previewNotification()` 回傳平面陣列，前端期望 `{ n1:[], n2:[], n3:[] }` 分組格式，且欄位名稱不符 | 後端改為分組回傳，欄位統一為 `userId`、`title` |

---

## 本地開發

```bash
# 安裝 clasp
npm install -g @google/clasp

# 登入 Google 帳號
clasp login

# 克隆專案
git clone https://github.com/chen-hwei/training-registration-gas.git
cd training-registration-gas

# 填入 .clasp.json 的 scriptId（部署後取得）
# 推送至 GAS
clasp push
```

---

## 注意事項

- 研習證明檔案依個資法限制存取，僅管理者可讀寫，上傳教師本人唯讀
- 所有含個人資料的備份禁止設定公開連結
- 共用 PIN 碼存放於 GAS `PropertiesService`，不得寫入程式碼或推送至 GitHub
- Token 使用 `CacheService`（非 `PropertiesService`），TTL 6 小時，自動回收
- 所有試算表寫入操作（`submitRecord`、`reviewRecord`）均以 `LockService` 保護，防止多人同時送出時資料錯位
- 手機拍攝的研習證明照片會在前端自動以 Canvas API 壓縮至 2MB 以下，再轉 Base64 上傳
- 通知信從腳本擁有者的學校 Gmail 寄出（`MailApp`），每日配額 1,500 封；以 `CacheService` 防止同一教師同一天重複收到相同通知
- 管理者收件對象依**教師所屬處室**對應，不會跨處室通知

## 系統設計哲學

本系統的定位是「**輔助收件 + 清單管理 + 提醒通知**」，不是自動認列系統。所有研習時數的認列均由行政人員**人工確認後點擊核准**，系統不自動判斷時數、日期或研習對象是否符合規定，確保行政彈性。

- ✅ 系統負責：收件、附件保存、清單管理、通過登錄、查詢紀錄、逾期提醒
- ❌ 系統不做：自動判斷時數是否達標、自動判斷研習對象是否符合、超過截止日自動拒絕
