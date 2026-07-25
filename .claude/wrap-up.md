# TRAINING 收工設定

| 項目 | 值 |
|---|---|
| 專案代號 | TRAINING |
| 專案全名 | 研習登錄與審核系統 |
| 專案目錄 | `C:\Users\User\Documents\Claude Desktop\研習登錄系統\` |
| 開發進度說明.md | `C:\Users\User\Documents\Claude Desktop\研習登錄系統\開發進度說明.md` |
| README.md | `C:\Users\User\Documents\Claude Desktop\研習登錄系統\README.md` |
| 知識卡片 | `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\training.md` |
| latest_status | `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\latest_status\training_latest.md` |

## git add 預設清單

`程式碼.gs Sync.gs Schema.gs Catalog.gs Record.gs Requirement.gs Review.gs Notify.gs Drive.gs TrainAuth.gs TrainingReport.gs HealthCheck.gs Index.html Admin.html Records.html Submit.html config.html style.html appsscript.json 開發進度說明.md README.md .claude/CLAUDE.md .claude/wrap-up.md`

> 本清單刻意偏離迴歸條款 B。**大小寫差異**：舊清單的 `index.html` 實際為
> **`Index.html`**。本機 repo `core.ignorecase = true`（Windows 預設），舊寫法實測
> **exit 0 不會造成 `git add` 失敗**；統一改採實際檔名是衛生做法，用意在於跨平台或
> 未來 clone 設定改變時不致失效。本專案無異名錯值。
> 另補入舊清單漏列但已追蹤的 10 個 `.gs` 模組與 3 個頁面。
> 2026-07-25 實測 `git ls-files`。

## 知識卡片 Schema 焦點（步驟 3 第 4 點）

`Hub.TrainingStats` Schema 異動 → 同步更新欄位說明

## 跨系統通知規則（步驟 5）

**有 —— Hub.TrainingStats 異動通知**

觸發條件（符合任一即需執行）：

- `syncTrainingStats()` 的寫入欄位有新增或改名
- `TrainingStats` 工作表 Schema 有異動
- 每晚同步排程時間（23:30）有調整
- **`syncTrainingStats()` 的寫入邏輯有異動（即使欄位不變）** —— 例如有效時數的取值
  規則改變，欄位名稱相同但語意已偏移

動作：提醒使用者主門戶儀表板讀取 `Hub.TrainingStats` 顯示 KPI，異動後需確認主門戶端
讀取邏輯相容。

若本次無上述異動，跳過並告知使用者。

> 來源：`研習登錄系統\.claude\CLAUDE.md`「收工補充（專案專屬）」節，原文為
> 「Hub.TrainingStats 的欄位結構**或寫入邏輯**有異動才需通知（影響主門戶儀表板）」。
> 第 4 條即對應原文的「寫入邏輯」半句。

## 專屬遺漏檢查條目（步驟 7）

- [ ] `Sync.gs` 的每晚排程若有異動，是否已在 GAS 觸發器設定中同步更新
- [ ] `Hub.TrainingStats` 若有欄位異動，是否已確認主門戶讀取相容

## 專案鐵律

禁止主門戶直接 `openById` 研習系統試算表，統一透過 `Hub.TrainingStats` 中介。

## 環境註記

無
