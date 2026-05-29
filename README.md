# 研習登錄與審核系統

> 學校資訊系統整合平台 · 第五個子系統

以 Google Apps Script 建構的研習登錄與審核系統，讓教師可以線上登錄研習紀錄、上傳研習證明，並由各處室管理者進行審核與退件。審核通過的紀錄定時彙整至整合平台 Hub，提供全校年度研習時數儀表板。

---

## 功能概覽

### 教師端
- 瀏覽各處室推薦的研習課程（含必修標記）
- 選擇推薦課程或自訂課程進行登錄
- 上傳研習證明（PDF / JPG / PNG，上限 8MB）
- 即時查詢審核狀態（待審核 / 已通過 / 已退件）
- 退件時顯示原因，可一鍵重新送出

### 管理者端（需 `training_admin` 權限）
- 新增、編輯、封存所屬處室的推薦研習課程
- 批次審核教師上傳的研習證明（核准 / 退件並附理由）
- 匯出研習紀錄報表（CSV）

---

## 技術架構

| 項目 | 技術 |
|---|---|
| 後端 | Google Apps Script（clasp 管理） |
| 資料庫 | Google Sheets（2 個工作表） |
| 檔案儲存 | Google Drive（依年份 / 教師 ID 分層管理） |
| 身分驗證 | SchoolPortalLib（共用函式庫，`txxxx` + PIN，CacheService Token） |
| 前端 | HTML / CSS / Vanilla JS（GAS HtmlService） |
| 檔案上傳 | FileReader → Base64 → `google.script.run`（單次上傳，上限 8MB） |

---

## 資料庫 Schema

### TRAINING_CATALOG（研習目錄）

| 欄位 | 說明 |
|---|---|
| `catalogId` | 課程編號，格式 `C{年份}{4位序號}` |
| `title` · `hours` · `organizer` | 課程名稱、時數、主辦單位 |
| `department` · `createdBy` | 推薦處室、建立者（txxxx） |
| `startDate` · `endDate` | 研習日期區間（格式 `YYYY/M/D`） |
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

---

## API 路由

### 教師端（Level 1：Token 驗證）

| action | 說明 |
|---|---|
| `v1/getCatalog` | 取得 ACTIVE 研習目錄 |
| `v1/getMyRecords` | 取得自己的登錄紀錄與審核狀態 |
| `v1/submitRecord` | 送出研習登錄（含 Base64 檔案） |
| `v1/deleteRecord` | 刪除自己的 PENDING 紀錄 |

### 管理者端（Level 2：Token + `training_admin` 角色）

| action | 說明 |
|---|---|
| `v1/admin/addCatalog` · `editCatalog` · `archiveCatalog` | 課程目錄管理 |
| `v1/admin/getPendingReviews` | 取得待審清單（可依處室篩選） |
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
├── 程式碼.gs      # doGet / doPost / handleRequest 路由
├── Schema.gs      # SHEET_SCHEMA 定義與系統常數
├── Catalog.gs     # 研習目錄 CRUD
├── Record.gs      # 登錄紀錄與 Base64 檔案上傳
├── Review.gs      # 審核流程（核准 / 退件 / 匯出）
├── Drive.gs       # Google Drive 資料夾與授權管理
├── Sync.gs        # 每晚同步 TrainingStats → Portal Hub
├── Index.html     # 教師端首頁（目錄 + 我的紀錄）
├── Submit.html    # 選課與上傳頁面
├── Admin.html     # 管理者審核後台（批次審核 + 目錄管理）
├── style.html     # 共用 CSS（狀態色彩 / RWD / 字型縮放）
└── config.html    # 共用 JS（api() bridge / Token / Base64 工具）
```

---

## 開發狀態

| 階段 | 說明 | 預估時程 | 狀態 |
|---|---|---|---|
| 架構設計 | Schema / API / Drive 結構確認 | ─ | ✅ 完成（2026-05-29） |
| Phase 0 | 基礎建設（試算表 + Drive 資料夾 + clasp 初始化） | 0.5 週 | ⬜ 待做 |
| Phase 1 | 後端骨架（Schema / 路由 / 上傳）— **MVP 核心** | 1.5 週 | ⬜ 待做 |
| Phase 2 | 審核流程（Review.gs + 管理者 Catalog API）— **MVP 完成** | 1 週 | ⬜ 待做 |
| Phase 3 | 前端介面（三頁 HTML）— 擴展 | 2 週 | ⬜ 待做 |
| Phase 4 | 整合收尾（Hub 同步 / 觸發器 / UAT）— 維運就緒 | 0.5 週 | ⬜ 待做 |

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
