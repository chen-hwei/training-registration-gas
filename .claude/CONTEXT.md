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

**`owner`（負責處室）與 `OWNER_DEPTS`** —— `TRAINING_REQUIREMENT.owner` 是任務的
「主責單位」，v3.22（`task_6e2d40af` Stage A）起收斂為受控清單 `OWNER_DEPTS`
（`Schema.gs`：教務處／學務處／輔導室／圖書館，可留空）。**與 `VALID_DEPT`
（`Hub.UserStatusCache.department`，教師部別：高中部／國中部）是完全不同的兩個概念**，
前者是行政處室、後者是學制部別，命名相近但不可互相 fallback。`TRAINING_CATALOG.department`
（推薦處室）同樣不等於 `owner`，且**永不參與權限判定**（`task_6e2d40af` §S1/S2 裁示）。

**`training_scope`** —— 存於 `Hub.UserStatusCache.systemAccess.training_scope`
（既有 JSON 字串欄內的 key，非新增欄位），v3.23（`task_6e2d40af` Stage B）起生效。
未設定或含 `"ALL"` ＝全權管理者；設處室清單（如 `["教務處"]`）則僅能操作/檢視
落在該處室的資料；三段瀑布查不到處室者（自由研習等）v3.28 起**僅全權管理者可見**
（`task_c95dbe21` Stage 2a，Q3 裁示，原「空值＝全體可見」已廢止）。判準函式 `Schema.gs`
`_isAllScope_()`／`_inScope_()`，前端 `config.html getTrainingScope()`／
`isAllScope()` 須同步套用相同正規化規則（`_normalizeScope_()`），
避免人工填寫漏寫中括號時 fail-open 成全權。**與 `owner` 是同一組概念的一體兩面**：
`owner` 是資料的歸屬標記，`training_scope` 是使用者的存取範圍，兩者靠三段瀑布
（`_resolveRecordOwner_()`）串起來判定。

**通知收件者路由（處室桶）** —— v3.24（`task_6e2d40af` Stage D）起，`Notify.gs`
`_buildAdminBuckets_()` 把管理者依 `training_scope` 分成 `scoped[dept]`（明列
該處室者）與 `all[]`（ALL-scope／全權）兩桶；`_adminEmailsForOwner_(owner)`
收件人＝`scoped[owner]∪all[]`，union 為空才退回全體管理者（並寫 AuditLog 留痕，
同一 owner 每次執行僅留一筆）。**彙整信 Reply-To 判定基準是信內 items 的
`owner`，不是 `replyTo`**（`_digestReplyTo_()`）：非空 owner 相異值恰好 1 個
才動態指向該處室承辦人，0 個或 2 個以上一律退回系統信箱 `getMailReplyTo_()`
——用 `replyTo` 直接去重會在「A 處室有承辦人、B 處室無承辦人混一封信」時
誤判成只剩 1 個相異值，錯把信件指向 A（S-D-3 教訓，改動這支函式前務必重讀）。

**自訂 vs 自由研習** —— 兩個獨立維度，**不可混用**。「自訂」（`isCustom`，待審列上的標籤）
是教師手動輸入課程名稱、未從研習目錄選課；「自由研習」是教師送出時選了「不歸屬年度任務」
（`requirementId` 空）。自訂課程可以掛任務（有處室），目錄課程也可以留在自由研習。
判斷一筆紀錄是否「查不到處室」要看三段瀑布結果，不能看「自訂」標籤
（`task_c95dbe21` Stage 2a 驗收時曾混淆，見任務單 S2-1 訂正）。

**改歸屬（reassign）** —— v3.29 起全權管理者可把任一 PENDING 紀錄的 `requirementId`
改為同學年 ACTIVE 任務（`v1/admin/reassignRecordRequirement`），處室隨新任務走，
`catalogId` 不動。核准後時數計入新任務；`approvedMap` 不套計算區間，**學年檢查是防止
跨學年誤計的唯一防線**。目標不可為空（不能改回自由研習）。AuditLog `REASSIGN_RECORD`。

**研習日期嚴格解析** —— `Schema.gs` `_parseTrainingDateStrict_()`：只接受 `yyyy/M/d`
（寫入格式）與 `yyyy-MM-dd`（Sheets 判讀為日期後 `parseSheetData` 的輸出），Date 物件先轉字串，
其餘回 null。凡「依研習日期判學年且判錯會改資料」的場合一律用它，**禁用 `toAcademicYear_()`**
——後者解析失敗時回傳當前學年，壞日期會靜默通過（`task_f4b8c2d1` R-5 同型）。

**部別桶（hs／jh／other）** —— 統計回傳依教師部別分三桶：`高中部`→`hs`、`國中部`→`jh`、
其餘（含部別空白）→`other`，三桶加總恆等於全校數。`calcRequirementStats` 與 `getCatalogStats`
的後端、以及 `Admin.html` 的 `_rsDeptKey()` 使用同一規則。**不同於 `calcStats` 的
「非高中部一律國中部」**——後者母體經 `VALID_DEPT` 篩選，前者未篩，沿用會把部別空白者灌進國中部。
「其他」桶多為行政人員（`t9xxx` 帳號），使用者裁示視為正常分類（P-3b-1，2026-09-29）。

**課程統計 vs 任務統計（口徑差異）** —— 兩者依不同欄位歸屬。**課程統計**（`getCatalogStats`）依紀錄的
`catalogId` 歸課程、以課程所掛任務的 `owner` 決定處室；**任務統計**（`calcRequirementStats`）依
紀錄自己的 `requirementId` 歸任務。紀錄被「改歸屬」後兩邊可能歸到不同處室，屬合理結果，
畫面說明文字已註明。`catalogId` 為空的自訂課程紀錄不計入課程統計。

**一人一狀態（`_statusRank_`）** —— 同一教師同一課程（或催辦名單的同 key）有多筆紀錄時，
取最高狀態計一人：`APPROVED`(3) > `PENDING`(2) > `REJECTED`(1)，其餘 0。
`Schema.gs` `_statusRank_()` 為唯一定義，`Notify.gs` 催辦名單與 `CatalogStats.gs` 共用。

**名冊查無（`inRoster=false`）** —— 課程統計的已登錄名單中，教師帳號在 `Hub.UserStatusCache`
**完全無此帳號**才算查無（在名冊但已離職者仍顯示部別與 email）。查無者姓名／部別／email 留空，
部別歸 `other`，CSV 姓名欄標「（名冊查無）」。

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

## SSO 接手（v3.15）

**`_bootPage()`** —— `config.html` 包裝既有 `initPage()` 的 SSO 交換碼兌換入口，四頁
`DOMContentLoaded` 皆改呼叫它取代直接呼叫 `initPage()`。跨專案共用術語「一次性交換碼」
定義見 `~/.claude/CONTEXT.md`。

**`train/redeemHandoff`** —— PUBLIC 路由，兌換門戶交換碼換發 `train_` token，見 `TrainAuth.gs`
的 `trainRedeemHandoff_()`。失敗路徑零 AuditLog 寫入。
