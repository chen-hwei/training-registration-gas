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

## 收工補充（專案專屬）
> 收工流程主體見全域 `~/.claude/CLAUDE.md` 第 5 節。

| 步驟 | 路徑 |
|---|---|
| 步驟 2 latest_status | `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\latest_status\training_latest.md` |
| 步驟 2.5 知識卡片 | `G:\我的雲端硬碟\Obsidian\Claude專案\_projects\training.md` |

**步驟 3 接口通知信觸發前提**：Hub.TrainingStats 的欄位結構或寫入邏輯有異動才需通知（影響主門戶儀表板）。