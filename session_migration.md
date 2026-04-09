# Session Migration Guide - OpenCode TG Plugin SDK 升級

> 最後更新：2026-04-09
> 目標：修復 tg-bot.ts 在 `@opencode-ai/plugin` v1.4.1 環境下的相容性問題
> 狀態：**Phase 1-4 全部完成，tsc 零錯誤通過，待 commit**

---

## ⚠️ 關鍵發現：v1.4.1 仍使用 v1 API

原始風險評估假設 v1.4.1 引入了 v2 API（扁平化參數），但經過深度分析 SDK 型別定義後發現：

- `@opencode-ai/plugin` v1.4.1 傳給 plugin 的 `client` 仍是 **v1 的 `OpencodeClient`**（從 `@opencode-ai/sdk` 根路徑導出）
- 證據：`@opencode-ai/plugin/dist/index.d.ts` L1 → `import type { ..., createOpencodeClient } from "@opencode-ai/sdk"`
- v1 API 使用 `{ path: { id }, body: { ... } }` 格式，**不是** v2 的 `{ sessionID, ...flatParams }` 格式
- **因此，原始風險評估中「核心功能會完全失效」的結論是錯誤的**

實際需要修復的問題是**插件中 3 處已存在的 bug（混用 v2 風格參數呼叫 v1 SDK）** 以及若干不存在的方法呼叫。

---

## 當前進度

### ✅ 已完成

1. **風險評估**：完整閱讀 tg-bot.ts 2440 行、分析 SDK v1/v2 型別定義、撰寫 `風險評估.md`（519 行）
2. **測試驗證計畫**：撰寫 `測試驗證計畫.md`
3. **Phase 1**：修復參數格式不匹配（3 處高風險 bug）
4. **Phase 2**：修復不存在的方法呼叫
5. **Phase 3**：型別安全改進（`as any` 從 49 個減少到 26 個）
6. **Phase 4**：型別檢查（`npx tsc --noEmit` 零錯誤通過）

### ⏳ 待完成

1. **Git commit** — 目前所有修改未提交（`tg-bot.ts` 有 188 行變更）
2. **更新 `風險評估.md`** — 修正錯誤結論（v1 API 在 1.4.1 上仍有效）
3. **實際運行測試** — 啟動 OpenCode + TG bot 進行端到端測試
4. **決定是否保留** `tsconfig.json` 和 devDependencies（typescript, @types/bun）

---

## 修改詳情

### Phase 1: 修復參數格式不匹配（3 處原始 bug）

這 3 處是插件**原本就存在的 bug**，使用了 v2 風格參數呼叫 v1 SDK：

| 行號 | 修改前 | 修改後 |
|------|--------|--------|
| L685 | `session.get({ sessionID })` | `session.get({ path: { id: sessionId } })` |
| L639 | `session.messages({ sessionID, limit })` | `session.messages({ path: { id: sessionId }, query: { limit: 1000 } })` |
| L774 | `session.children({ sessionID })` | `session.children({ path: { id: sessionId } })` |

### Phase 2: 修復不存在的方法呼叫

| 行號 | 問題 | 修復方式 |
|------|------|----------|
| L814,840 | `client.model.list()` — v1 無 model 命名空間 | 加上 `typeof (client as any).model?.list === "function"` 存在性檢查 |
| L2129-2134 | `tui.toast.show()` / `event.send()` — v1 無此方法 | 改為 `client.tui.showToast({ body: { message, variant: "info" } })` |

### Phase 3: 型別安全改進（移除 23 個 `as any`，49 → 26）

主要改進類別：
- **SDK 方法呼叫**：`session.messages`, `session.get`, `session.children`, `provider.list`, `session.prompt`, `postSessionIdPermissionsPermissionId`, `tui.showToast` — 移除 `as any`
- **回傳值**：`(res as any)?.data ?? res` → `res.data ?? res`（10+ 處）
- **Event narrowing**：已知事件直接用 `event.properties`，未知事件用 `eventType` 字串比較
- **`modelObj` 型別**：`any` → `{ providerID: string; modelID: string } | undefined`
- **`session.prompt` 參數**：加 `type: "text" as const`，移除外層 `as any`
- **`postSessionIdPermissionsPermissionId`**：從 dynamic dispatch 改為直接呼叫
- **`permission.asked` hook**：加型別標註 `(inputPermission: any, output: any)`
- **session.error handler**：重構為巢狀 `if (sid)` 確保 TypeScript 型別安全

### Phase 4: 型別檢查

- 安裝 TypeScript 6.0.2 和 @types/bun 作為 devDependencies
- 建立 `tsconfig.json`（strict mode, noEmit）
- `npx tsc --noEmit` → **零錯誤通過** ✅

---

## 仍保留的 26 個 `as any`（經分析必須保留或低優先）

| 類別 | 行號 | 原因 |
|------|------|------|
| `_client` protected 存取 | L390, L511, L2225 | v1 SDK 的 `_client` 是 protected，必須用 `as any` 存取 |
| `client as any` — question/sdkPost | L1405, L1424, L1490 | v1 無 `question` 命名空間 |
| `model.list()` 前向兼容 | L815, L817, L818, L844, L846, L847 | v1 無 `model` 命名空間，加上存在性檢查 |
| Event properties（未知事件） | L2272, L2279 | `permission.asked`, `question.*` 不在 v1 Event union 中 |
| 回傳值防禦性型別斷言 | L597, L686, L804, L830, L871 | 保護性斷言，確保不同 SDK 版本回傳結構都能處理 |
| 其他合理的 as any | L200, L642, L874, L1679, L2119, L2295, L2392 | 各有具體原因（Event cast, debug log 等） |

---

## SDK v1 vs v2 結構速查

| 特性 | v1 (`@opencode-ai/sdk`) | v2 (`@opencode-ai/sdk/v2`) |
|------|------------------------|---------------------------|
| Session 方法參數 | `{ path: { id }, body: { ... } }` | `{ sessionID, ...flatParams }` |
| Permission | `client.postSessionIdPermissionsPermissionId()` | `client.permission.reply()` |
| Question | 不存在命名空間 | `client.question.reply()`, `.reject()`, `.list()` |
| Model | 不存在命名空間 | `client.model.list()` |
| TUI Toast | `client.tui.showToast()` | 不同結構 |
| Client 基類 | `_HeyApiClient` (有 `_client` 屬性) | `HeyApiClient` (有 `client` 屬性) |

---

## 相關檔案

| 檔案 | 說明 |
|------|------|
| `.opencode/plugins/tg-bot.ts` | 主插件檔案（2440+ 行，已完成 Phase 1-4 修改） |
| `.opencode/tsconfig.json` | 型別檢查用 tsconfig（strict mode） |
| `.opencode/package.json` | 新增 devDependencies: typescript, @types/bun |
| `風險評估.md` | 深度風險評估（519 行，**部分結論已過時**） |
| `測試驗證計畫.md` | 完整測試驗證計畫 |

---

## 注意事項

- v1.4.1 的 plugin client 仍為 v1 API，**不需要**做 v1 → v2 的扁平化遷移
- 插件中 `sdkPost()`, `ocFetch()`, `getAuthHeaders()` 等輔助函數在 v1 中仍然需要（question/permission 等 v1 無原生支援的功能）
- 如果未來 OpenCode 升級到真正使用 v2 client 的版本，需要重新評估遷移需求
- 每個 Phase 完成後需進行型別檢查和 lint 驗證
- 大改動前先輸出修改計畫，待確認後再執行
- 高風險操作前提示 Git Commit
