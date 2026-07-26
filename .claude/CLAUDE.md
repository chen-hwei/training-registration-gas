# 本專案：研習登錄與審核系統（TRAIN）

## 開工必讀（依序）
1. `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\training.md` — 架構與待辦
2. `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\latest_status\training_latest.md` — 接關點

## 本專案特別注意
- Auth 統一使用 SchoolPortalLib（Token TTL 6 小時）
- 管理者識別：`systemAccess.training_admin = true`
- Hub.TrainingStats 只計入 `status = 'APPROVED'`
- 視覺主色：`--color-primary: #3730A3`（藍靛）
- 共用 CSS 從 `SchoolPortalLib.getSharedCSS()` 取得

## 收工補充（專案專屬）
> 本專案的收工路徑、`git add` 清單、接口通知觸發前提、專屬檢查條目與專案鐵律，
> 統一定義於 `.claude/wrap-up.md`，由全域 `/wrap-up` skill 讀取。本節不再重複記載，
> 避免兩套收工規格並存。
