# TRAINING 術語表（研習登錄與審核系統）

> 本檔定義本專案的共用詞彙，並且是這些術語的**唯一定義處**。對話中直接使用這些詞，不需展開解釋。
> 跨專案通用詞彙（接關點、任務單代號、純工具鏈異動、Hub 試算表、systemAccess、色標系統等）
> 見 `~/.claude/CONTEXT.md`。
>
> **切分線**：本檔只寫「這個詞是什麼」；系統 ID 清單、白屏根因的完整推導與已知問題對照表
> 屬操作參考，權威來源仍是專案根 `CLAUDE.md`，本檔不複製表格。

## 業務流程

**研習目錄** —— 管理者建立的研習場次清單（`Catalog.gs`），教師端首頁的公告來源。

**登錄紀錄** —— 教師報名／參與後提交的紀錄（`Record.gs`），可附 Base64 上傳的證明檔案。

**審核狀態** —— 登錄紀錄的三態：`PENDING`（待審）、`APPROVED`（核准）、`REJECTED`（退件）。
**只有 `APPROVED` 會計入時數統計**，其餘一律不計。

**必修（isRequired）** —— 研習場次的屬性。`isRequired = TRUE` 且審核為 `APPROVED` 的筆數，
即教師的「必修達成數」。

**每晚同步** —— `Sync.gs` 於每晚 23:30 執行 `syncTrainingStats()`，
把本學年統計批次寫入 `Hub.TrainingStats`（**覆寫，非累加**）。主門戶儀表板讀的就是它。

**管理者識別** —— `systemAccess.training_admin = true`（存於 `Hub.UserStatusCache`）。
改了這個欄位必須登出重新登入，Token 才會帶到新的 `systemAccess`。

## 平台陷阱

**消費者 URL 白屏** —— 使用 `script.google.com/macros/s/...`（消費者 URL）時，
Google 會把使用者轉到 `googleusercontent.com` 的 hash 子網域；該 hash 每次更新部署都可能改變，
localStorage 的 Token 隨之消失而白屏。**正確入口只有 `/a/macros/zlsh.tp.edu.tw/` 域 URL。**
完整推導見專案根 `CLAUDE.md`「白屏問題的根本原因」節。

**Script Properties 優先** —— 系統 ID 與 `WEB_APP_BASE_URL` 一律先讀 GAS 指令碼屬性，
讀不到才 fallback 回 `Schema.gs` 的 `*_FALLBACK` 常數。**常數只是保底，不是唯一維護點**；
換校部署或重新部署時改指令碼屬性即可，不必改程式碼重推。

**通知（N1／N2／N3）** —— `Notify.gs` 的三類定時通知。改動通知條件前，
必須確認 `setupNotifyTriggers()` 的觸發器仍存在。
