# OpenCode TG Plugin

把 OpenCode 接到 Telegram 的專案內插件，讓你可以直接在 TG 上下指令、看進度、處理授權，並管理 session 與模型。

## 這個插件能做什麼

- 在 Telegram 送任務給 OpenCode
- 即時接收 agent 串流輸出與任務狀態
- 透過按鈕或 `/approve` 處理 permission 授權
- 管理 session、切換模型、暫停或啟用 bridge
- 將狀態與日誌寫到本機，方便除錯

## 專案結構

```text
.
├─ README.md
├─ opencode.json
└─ .opencode/
   ├─ package.json
   ├─ bun.lock
   ├─ plugins/
   │  └─ tg-bot.ts
   ├─ tg-plugin.local.example.json
   └─ tg-plugin.local.json
```

## 核心檔案

- `.opencode/plugins/tg-bot.ts`：實際執行的 OpenCode plugin
- `.opencode/tg-plugin.local.json`：每個專案自己的本機設定
- `.opencode/tg-plugin/state.json`：插件執行狀態
- `.opencode/tg-plugin/log.txt`：除錯日誌

## 功能清單

### Telegram 
- `/interrupt`：中斷當前串流
- `/continue <prompt>`：在被中斷的對話基礎上繼續指令

- `/help`：顯示指令說明
- `/ping`：測試 bot 是否可用
- `/health`：檢查 bridge、輪詢與錯誤狀態
- `/settings`：顯示目前設定與路徑
- `/status`：顯示目前 session、模型與任務狀態
- `/enable`：啟用 TG bridge
- `/disable`：停用 TG bridge
- `/run <prompt>`：沿用目前 session 執行任務
- `/run --new <prompt>`：建立新 session 後執行
- `/abort`：中止目前 session
- `/session new`：建立新 session
- `/session list`：列出 session
- `/session switch <id>`：切換 session
- `/session info`：查看目前 session 資訊
- `/model list`：列出可用模型
- `/model show`：顯示目前模型
- `/model use <provider/model>`：切換模型
- `/approve <id> once|always|deny`：回覆授權請求

### 授權流程

- 監聽 OpenCode 的 `permission.ask` / `permission.updated`
- 在 TG 顯示「拒絕 / 允許一次 / 永遠允許」按鈕
- `always` 與 `deny` 會寫入本機規則快取
- 任務進度會綁定 session 顯示在同一則 TG 訊息上

## 安裝與啟用

1. 安裝專案相依：
   ```bash
   cd .opencode
   bun install
   ```

2. 建立本機設定檔：
   - 複製 `.opencode/tg-plugin.local.example.json` 為 `.opencode/tg-plugin.local.json`
   - 填入你的 Telegram Bot Token 與允許的 chat id

3. 啟動 OpenCode：
   - 讓 OpenCode 載入 `.opencode/plugins/tg-bot.ts`

4. 到 Telegram 對 bot 發 `/ping`：
   - 成功會回 `pong ✅`

## 設定檔

### `.opencode/tg-plugin.local.json`

範例：

```json
{
  "token": "123456:abc",
  "allowChatIds": [123456789],
  "defaultModel": "openai/gpt-5.4-mini",
  "enabled": true,
  "pollIntervalMs": 1500,
  "requestTimeoutMs": 120000
}
```

### 欄位說明

- `token`：Telegram bot token
- `allowChatIds`：允許操作的 chat id，可填多個
- `defaultModel`：預設模型名稱，格式為 `provider/model`
- `enabled`：是否預設啟用 bridge
- `pollIntervalMs`：輪詢間隔，單位毫秒
- `requestTimeoutMs`：授權等待超時，單位毫秒

## 環境變數

可用環境變數覆蓋設定檔：

- `TG_BOT_TOKEN`
- `TG_ALLOW_CHAT_IDS`
- `TG_DEFAULT_MODEL`
- `TG_POLL_INTERVAL_MS`
- `TG_REQUEST_TIMEOUT_MS`
- `TG_PLUGIN_ENABLED`
- `TG_PLUGIN_STATE_DIR`

> `TG_ALLOW_CHAT_IDS` 可用逗號、分號或空白分隔。

## 測試方式

### 基本驗證

1. 啟動 OpenCode
2. 在 TG 發 `/ping`
3. 發 `/health`
4. 發 `/settings`
5. 發 `/status`

### 任務流程驗證

1. 發 `/run hello`
2. 確認有出現「執行中」訊息
3. 確認後續內容會持續更新到同一則訊息
4. 發 `/session list`、`/session info` 檢查 session 是否被記錄

### 授權流程驗證

1. 觸發一個需要 permission 的操作
2. 確認 TG 收到授權卡片
3. 測試三個按鈕是否正常作用
4. 也可以用 `/approve <id> once|always|deny` 手動回覆

## 日誌與狀態

- 狀態檔：`.opencode/tg-plugin/state.json`
- 日誌檔：`.opencode/tg-plugin/log.txt`
- 狀態目錄可透過 `TG_PLUGIN_STATE_DIR` 自訂

常見觀察點：

- `lastPollAt` / `lastPollOkAt`
- `lastError`
- `currentSessionByChat`
- `permissionRules`

## 疑難排解

- **`/ping` 失敗**：確認 token 是否正確、bot 是否已啟動、chat id 是否在允許清單內
- **沒有回應**：檢查 `state.enabled` 是否為 `true`，或先下 `/enable`
- **無法送出任務**：確認 OpenCode 已啟動，且 plugin 有被載入
- **授權一直逾時**：調高 `requestTimeoutMs`
- **看不到串流更新**：確認 OpenCode 有產生 `message.part.updated` 事件

## 開發提醒

- 實際執行的 plugin 在 `.opencode/plugins/tg-bot.ts`
- 變更設定或程式後，重新啟動 OpenCode 以套用

## 安全建議

- 不要把 `.opencode/tg-plugin.local.json` 提交到版本控制
- 不要公開 Telegram bot token
- `allowChatIds` 建議只填自己的 chat id 或群組 id

如果您喜歡我的項目歡迎打賞:
ETH:0xAe42D0d8a25530fCb99B906f42a0eE6DF1830EA9。
