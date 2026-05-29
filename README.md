# 研習登錄與審核系統

> 學校資訊系統整合平台 · 第五個子系統

以 Google Apps Script 建構的研習登錄與審核系統，讓教師可以線上登錄研習紀錄、上傳研習證明，並由各處室管理者進行審核與退件。

---

## 功能概覽

### 教師端
- 瀏覽各處室推薦的研習課程（含必修標記）
- 選擇推薦課程或自訂課程進行登錄
- 上傳研習證明（PDF / JPG / PNG，上限 8MB）
- 即時查詢審核狀態，退件時顯示原因並可重新送出

### 管理者端
- 新增、編輯、封存所屬處室的推薦研習課程
- 批次審核教師上傳的研習證明（核准 / 退件並附理由）
- 匯出研習紀錄報表（CSV）

---

## 技術架構

| 項目 | 技術 |
|---|---|
| 後端 | Google Apps Script（clasp 管理） |
| 資料庫 | Google Sheets（2 個工作表） |
| 檔案儲存 | Google Drive（依年份/教師 ID 分層管理） |
| 身分驗證 | SchoolPortalLib（共用函式庫，txxxx + PIN） |
| 前端 | HTML / CSS / Vanilla JS（GAS HtmlService） |

---

## 資料庫 Schema

### TRAINING_CATALOG（研習目錄）
`catalogId` · `title` · `hours` · `organizer` · `department` · `createdBy` · `startDate` · `endDate` · `description` · `isRequired` · `status` · `createdAt`

### TRAINING_RECORD（登錄紀錄）
`recordId` · `userId` · `catalogId` · `title` · `hours` · `isCustom` · `trainingDate` · `organizer` · `fileId` · `fileName` · `status` · `reviewedBy` · `reviewNote` · `reviewedAt` · `submittedAt`

---

## 專案結構

```
研習登錄系統/
├── 程式碼.gs      # doGet / doPost / handleRequest 路由
├── Schema.gs      # SHEET_SCHEMA 定義與系統常數
├── Catalog.gs     # 研習目錄 CRUD
├── Record.gs      # 登錄紀錄與檔案上傳
├── Review.gs      # 審核流程
├── Drive.gs       # Google Drive 操作封裝
├── Sync.gs        # 定時同步至 Portal Hub
├── Index.html     # 教師端首頁
├── Submit.html    # 選課與上傳頁面
├── Admin.html     # 管理者審核後台
├── style.html     # 共用 CSS
└── config.html    # 共用 JS（API bridge）
```

---

## 開發狀態

```
✅ 架構設計完成（2026-05-29）
⬜ Phase 0：基礎建設（試算表 + Drive 資料夾）
⬜ Phase 1：後端骨架（Schema / 路由 / 上傳）
⬜ Phase 2：審核流程
⬜ Phase 3：前端介面
⬜ Phase 4：整合收尾與部署
```

---

## 與整合平台的關係

本系統是[學校資訊系統整合平台](https://github.com/chen-hwei/school-portal-gas)的第五個子系統，透過共用函式庫 `SchoolPortalLib` 對接統一的身分驗證機制（`txxxx` userId），並定時同步研習統計至 Portal Hub 試算表，供主門戶儀表板呈現。

---

## 本地開發

```bash
# 安裝 clasp
npm install -g @google/clasp

# 登入 Google 帳號
clasp login

# 克隆並連結既有 GAS 專案（部署後填入 scriptId）
git clone https://github.com/chen-hwei/training-registration-gas.git
cd training-registration-gas
# 編輯 .clasp.json 填入 scriptId

# 推送至 GAS
clasp push
```

---

## 注意事項

- 研習證明檔案依個資法限制存取，僅管理者可讀寫，上傳教師本人唯讀
- 所有含個人資料的備份禁止設定公開連結
- 共用 PIN 碼存放於 GAS `PropertiesService`，不得寫入程式碼或推送至 GitHub
