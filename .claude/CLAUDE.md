# 本專案：研習登錄與審核系統（TRAIN）

## 開工必讀（依序）
1. `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\training.md` — 架構與待辦
2. `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\latest_status\training_latest.md` — 接關點

## 本專案特別注意
- Auth 統一使用 SchoolPortalLib（Token TTL 6 小時）
- 管理者識別：`systemAccess.training_admin = true`
- Hub.TrainingStats 只計入 `approvalStatus = 'APPROVED'`
- 視覺主色：`--color-primary: #3730A3`（藍靛）
- 共用 CSS 從 `SchoolPortalLib.getSharedCSS()` 取得

## 開工確認流程（收到 current_task.md 後必做）

收到任務描述後，動手前必須先輸出「理解確認單」，格式如下：

---
### 📋 理解確認單

**我理解您想做的是：**
（用一句話複述您的目標）

**我打算這樣做：**
（列出 2-4 個具體步驟）

**這次會動到的檔案：**
（列出具體檔案名稱與函式）

**需要注意的技術限制：**
（從知識庫查到的相關規範）

**不會動到的部分：**
（明確說明範圍邊界）

✅ 以上理解正確嗎？確認後我開始動手。
---

收到您「確認」或「對」之後，才開始寫程式碼。
若理解有誤，請直接指正，我重新確認。

## 收工流程（說「收工」後 Claude 直接執行，您只做確認）

說「**收工**」時，Claude 依序執行下列步驟，每步驟先預覽再等您說「確認」：

### 步驟 1｜預覽 Commit Message
Claude 先顯示：
```
即將執行：
git add [這次動過的檔案]
git commit -m "類型(範疇): 摘要
- 修改點1
- 修改點2"
```
您說「確認」→ Claude 直接執行 git commit。

### 步驟 2｜覆寫 latest_status
Claude 先顯示新的 latest_status 內容預覽，
您說「確認」→ Claude 直接覆寫
`G:\我的雲端硬碟\Obsidian\Claude專案\_projects\latest_status\[系統]_latest.md`

### 步驟 3｜接口變更通知信（僅在有對外 API 異動時）
Claude 先顯示通知信內容，
您說「確認」→ Claude 直接寫入
`G:\我的雲端硬碟\Obsidian\Claude專案\_log\YYYY-MM-DD-[系統]-interface-change.md`

### 步驟 4｜提醒手動執行（Claude 無法代勞）
```
請您手動執行：
1. clasp push（需在專案資料夾執行）
2. git push origin main
```