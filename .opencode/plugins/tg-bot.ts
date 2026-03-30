/**
 * OpenCode Telegram Bridge Plugin
 *
 * 載入設定優先序：
 *   1. .opencode/tg-plugin.local.json
 *   2. 環境變數 TG_BOT_TOKEN / TG_ALLOW_CHAT_IDS / TG_DEFAULT_MODEL ...
 *
 * 指令（TG 發訊息）：
 *   /help              - 顯示說明
 *   /status            - 顯示目前 session / model / task 狀態
 *   /health            - 顯示 bot 連線與 poll 狀態
 *   /ping              - 測試 bot 是否可回應
 *   /settings          - 顯示插件設定詳情
 *   /enable / /disable - 啟用 / 停用 TG bridge
 *
 *   /run <prompt>      - 在目前 session 執行任務
 *   /run --new <prompt>- 新建 session 後執行
 *   /abort             - 中止目前 session 的執行
 *
 *   /session new       - 新建 session
 *   /session list      - 列出所有 session
 *   /session switch <id> - 切換 session
 *   /session info      - 查看目前 session 資訊
 *
 *   /model list        - 列出可用模型（含 OAuth provider 動態模型）
 *   /model show        - 顯示目前模型
 *   /model use <n>     - 切換模型（格式：provider/model）
 *
 *   /approve <id> once|always|deny - 手動回覆授權請求
 *   /answer <requestID> <回答>     - 手動回覆 AI 提問
 */

import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode-ai/plugin"

// ─── 型別 ────────────────────────────────────────────────────────────────────

type TgSettings = {
  token?: string
  allowChatIds?: Array<string | number>
  defaultModel?: string
  pollIntervalMs?: number
  requestTimeoutMs?: number
  enabled?: boolean
  opencodePort?: number
  watchdogMs?: number
}

type PendingApproval = {
  id: string
  chatId: number
  text: string
  sessionID?: string
  permissionID?: string
  decision?: "deny" | "once" | "always"
  resolve: (v: "deny" | "once" | "always") => void
  timer: ReturnType<typeof setTimeout>
  createdAt: number
}

// ─── 新增：PendingQuestion ────────────────────────────────────────────────────
type QuestionItem = {
  id?: string
  text: string
  options?: string[]
}

type PendingQuestion = {
  requestID: string
  sessionID?: string
  chatId: number
  questions: QuestionItem[]
  createdAt: number
  timer: ReturnType<typeof setTimeout>
}

type SessionRecord = {
  id: string
  title?: string
  createdAt: number
  parentID?: string   // 記錄 subagent 的 parent session
}

type StreamState = {
  chatId: number
  sessionId: string
  buffer: string
  messageId?: number
  extraMessageIds: number[]  // 超過 4000 字後的延續訊息
  lastEditAt: number
  lastActivityAt: number
  done: boolean
}

type PluginState = {
  currentSessionByChat: Record<string, string>
  sessions: SessionRecord[]
  approvals: Record<string, { id: string; decision: string; createdAt: number; resolvedAt: number }>
  permissionRules: Record<string, "deny" | "always">
  activeModelByChat: Record<string, string>
  enabled: boolean
  startedAt: number
  lastUpdateId: number
  lastPollAt?: number
  lastPollOkAt?: number
  lastError?: string
}

type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    date: number
    chat: { id: number; type: string }
    text?: string
  }
  callback_query?: {
    id: string
    data?: string
    message?: { message_id: number; chat: { id: number } }
    from?: { id: number }
  }
}

// ─── 工具函數 ──────────────────────────────────────────────────────────────

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function now() { return Date.now() }

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`
}

function parseCsv(v?: string) {
  return (v ?? "").split(/[;,\s]+/).map(s => s.trim()).filter(Boolean)
}

function toIntSet(values: string[]) {
  return new Set(values.map(Number).filter(Number.isFinite))
}

function normalizeChatIds(values?: Array<string | number>) {
  return (values ?? []).map(Number).filter(Number.isFinite).map(String)
}

function parseToggle(v: unknown) {
  if (typeof v === "boolean") return v
  if (typeof v === "string") return ["1", "true", "on", "yes", "enable", "enabled"].includes(v.toLowerCase())
  return undefined
}

function summarizeError(v: unknown) {
  if (!v) return "(none)"
  try { return JSON.stringify(v).slice(0, 2000) } catch { return String(v) }
}

function splitText(text: string, max = 3800) {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + max, text.length)
    if (end < text.length) {
      const lb = text.lastIndexOf("\n", end)
      if (lb > start + 100) end = lb + 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T } catch { return fallback }
}

async function writeJson(file: string, value: unknown) {
  await ensureDir(path.dirname(file))
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function appendLog(file: string, msg: string) {
  await ensureDir(path.dirname(file))
  await fs.appendFile(file, `[${new Date().toISOString()}] ${msg}\n`, "utf8").catch(() => undefined)
}

// ─── Telegram API ──────────────────────────────────────────────────────────

async function tgPost(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    throw new Error(`TG ${method} failed: ${res.status} ${txt}`)
  }
  return res.json() as Promise<{ ok: boolean; result: unknown }>
}

function btn(label: string, data: string) {
  return { text: label, callback_data: data }
}

// ─── 插件主體 ──────────────────────────────────────────────────────────────

export const TelegramPlugin: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const projectRoot = directory || PLUGIN_ROOT
  const settingsFile = path.join(projectRoot, ".opencode", "tg-plugin.local.json")
  const stateDir = process.env.TG_PLUGIN_STATE_DIR ?? path.join(projectRoot, ".opencode", "tg-plugin")
  const stateFile = path.join(stateDir, "state.json")
  const logFile = path.join(stateDir, "log.txt")

  fsSync.mkdirSync(stateDir, { recursive: true })

  const log = (msg: string) => appendLog(logFile, msg)

  // ─── 讀取設定 ───────────────────────────────────────────────────────────

  const fileSettings = await readJson<TgSettings>(settingsFile, {})

  const token = process.env.TG_BOT_TOKEN ?? fileSettings.token
  const allowChatIds = toIntSet(
    normalizeChatIds(fileSettings.allowChatIds).length
      ? normalizeChatIds(fileSettings.allowChatIds)
      : parseCsv(process.env.TG_ALLOW_CHAT_IDS)
  )
  const defaultModel = (process.env.TG_DEFAULT_MODEL ?? fileSettings.defaultModel ?? "").trim()
  const pollIntervalMs = Number(process.env.TG_POLL_INTERVAL_MS ?? fileSettings.pollIntervalMs ?? 2000)
  const requestTimeoutMs = Number(process.env.TG_REQUEST_TIMEOUT_MS ?? fileSettings.requestTimeoutMs ?? 120000)
  const enabledFromConfig = parseToggle(fileSettings.enabled) ?? parseToggle(process.env.TG_PLUGIN_ENABLED) ?? true
  // opencode server port（預設 4096）
  const opencodePort = Number(process.env.OPENCODE_PORT ?? fileSettings.opencodePort ?? 4096)
  // 串流靜止多久（ms）後觸發 watchdog 警告（預設 5 分鐘）
  const watchdogMs = Number(process.env.TG_WATCHDOG_MS ?? fileSettings.watchdogMs ?? 5 * 60 * 1000)

  // ─── 執行期狀態 ─────────────────────────────────────────────────────────

  const DEFAULT_STATE: PluginState = {
    currentSessionByChat: {},
    sessions: [],
    approvals: {},
    permissionRules: {},
    activeModelByChat: {},
    enabled: enabledFromConfig,
    startedAt: now(),
    lastUpdateId: 0,
  }

  let state: PluginState = await readJson<PluginState>(stateFile, DEFAULT_STATE)
  state.sessions ??= []
  state.approvals ??= {}
  state.permissionRules ??= {}
  state.activeModelByChat ??= {}
  state.currentSessionByChat ??= {}
  state.enabled ??= enabledFromConfig
  state.startedAt ??= now()
  state.lastUpdateId ??= 0

  const pendingApprovals = new Map<string, PendingApproval>()
  const pendingQuestions = new Map<string, PendingQuestion>()  // ← 新增
  const streamStates = new Map<string, StreamState>()

  // ─── 新增：Busy guard ─────────────────────────────────────────────────────
  // 記錄每個 session 目前是否正在執行中（由 plugin 自己維護，避免撞 BusyError）
  const runningSessions = new Set<string>()

  let currentChatId: number | undefined
  let currentSessionId: string | undefined = state.currentSessionByChat[Object.keys(state.currentSessionByChat)[0]]
  let pollStopped = false

  const persist = () => writeJson(stateFile, state).catch(() => undefined)

  // ─── 輔助：opencode REST ──────────────────────────────────────────────────

  async function ocFetch(path: string, opts?: RequestInit) {
    return fetch(`http://localhost:${opencodePort}${path}`, {
      headers: { "content-type": "application/json" },
      ...opts,
    })
  }

  // ─── 輔助：Session ──────────────────────────────────────────────────────

  function rememberSession(chatId: number, sessionId: string, parentID?: string) {
    currentChatId = chatId
    currentSessionId = sessionId
    state.currentSessionByChat[String(chatId)] = sessionId
    if (!state.sessions.find(s => s.id === sessionId)) {
      state.sessions.push({ id: sessionId, createdAt: now(), parentID })
    }
  }

  function resolveSession(chatId: number) {
    return state.currentSessionByChat[String(chatId)] ?? currentSessionId
  }

  async function createSession() {
    const res = await client.session.create({ body: {} })
    const id = (res as any)?.data?.id ?? (res as any)?.id
    if (!id) throw new Error("OpenCode did not return a session id")
    rememberSession(currentChatId ?? 0, id)
    await persist()
    return id as string
  }

  async function listSessions(): Promise<SessionRecord[]> {
    try {
      const res = await client.session.list()
      const data = (res as any)?.data ?? res
      if (Array.isArray(data)) {
        return data
          .map((item: any) => ({
            id: item?.id,
            title: item?.title,
            createdAt: Number(item?.createdAt ?? now()),
          }))
          .filter((s: SessionRecord) => s.id)
      }
    } catch (err) {
      await log(`listSessions error: ${summarizeError(err)}`)
    }
    return state.sessions
  }

  // ─── 修改：listModels 支援動態 OAuth provider ────────────────────────────

  async function listModels(): Promise<string[]> {
    // 優先嘗試動態模型清單（包含 GitHub Copilot 等 OAuth provider）
    try {
      const res = await (client as any).model.list()
      const data = (res as any)?.data ?? res
      if (Array.isArray(data) && data.length > 0) {
        return data
          .map((m: any) => {
            const provider = m?.provider?.id ?? m?.providerID ?? ""
            const model = m?.id ?? m?.modelID ?? ""
            return provider && model ? `${provider}/${model}` : null
          })
          .filter(Boolean)
          .sort() as string[]
      }
    } catch (err) {
      await log(`listModels (dynamic) error: ${summarizeError(err)}`)
    }

    // fallback：從靜態設定讀取
    try {
      const res = await client.config.get()
      const cfg = (res as any)?.data ?? res
      const names: string[] = []
      for (const [pid, provider] of Object.entries(cfg?.provider ?? {})) {
        for (const mid of Object.keys((provider as any)?.models ?? {})) {
          names.push(`${pid}/${mid}`)
        }
      }
      if (names.length) return [...new Set(names)].sort()
    } catch (err) {
      await log(`listModels (static) error: ${summarizeError(err)}`)
    }
    return []
  }

  // ─── 輔助：發訊息 ───────────────────────────────────────────────────────

  async function sendMsg(chatId: number, text: string | string[], extra?: Record<string, unknown>): Promise<number | undefined> {
    if (!token) return undefined
    const normalized = Array.isArray(text) ? text.join("\n") : text
    const chunks = splitText(normalized)
    let lastMsgId: number | undefined
    for (const chunk of chunks) {
      const res = await tgPost(token, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...(chunk === chunks[chunks.length - 1] ? extra : {}),
      }).catch(err => {
        void log(`sendMsg error: ${err?.message}`)
        return null
      })
      lastMsgId = (res as any)?.result?.message_id as number | undefined
    }
    return lastMsgId
  }

  async function editMsg(chatId: number, messageId: number, text: string, extra?: Record<string, unknown>) {
    if (!token) return
    await tgPost(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4000),
      ...extra,
    }).catch(err => {
      const msg = err?.message ?? String(err)
      if (!msg.includes("message is not modified")) {
        void log(`editMsg error: ${msg}`)
      }
    })
  }

  async function answerCallback(callbackQueryId: string, text?: string) {
    if (!token) return
    await tgPost(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: Boolean(text),
    }).catch(() => undefined)
  }

  // ─── Stream 推送邏輯 ────────────────────────────────────────────────────

  async function handleStreamPart(sessionId: string, text: string) {
    const ss = streamStates.get(sessionId)
    if (!ss) return

    ss.buffer = text
    ss.lastActivityAt = now()

    const nowMs = now()
    if (nowMs - ss.lastEditAt < 1000) return
    ss.lastEditAt = nowMs

    // 超過 3800 字的部分先只更新第一則（讓使用者知道還在跑）
    // 完整超長內容在 handleStreamDone 時才切分發送
    const displayText = text.slice(0, 3800)
    if (ss.messageId) {
      await editMsg(ss.chatId, ss.messageId, displayText)
    } else {
      const mid = await sendMsg(ss.chatId, displayText)
      if (mid) ss.messageId = mid
    }
  }

  async function handleStreamDone(sessionId: string) {
    const ss = streamStates.get(sessionId)
    if (!ss || ss.done) return
    ss.done = true

    runningSessions.delete(sessionId)

    const finalText = ss.buffer || "(任務完成，無文字回覆)"
    const chunks = splitText(finalText, 3800)

    // 第一段 edit 進原有的進度訊息
    if (ss.messageId) {
      await editMsg(ss.chatId, ss.messageId, chunks[0])
    } else {
      await sendMsg(ss.chatId, chunks[0])
    }

    // 後續段落發新訊息
    for (let i = 1; i < chunks.length; i++) {
      await sendMsg(ss.chatId, chunks[i])
    }

    streamStates.delete(sessionId)
    await log(`stream done sid=${sessionId} chunks=${chunks.length}`)
  }

  // ─── 新增：Watchdog ───────────────────────────────────────────────────────
  // 定期檢查所有 streaming session 是否靜止過久

  function startWatchdog() {
    setInterval(async () => {
      const staleThreshold = now() - watchdogMs
      for (const [sid, ss] of streamStates) {
        if (ss.done) continue
        if (ss.lastActivityAt < staleThreshold) {
          await log(`watchdog: sid=${sid} stale for ${watchdogMs}ms, notifying`)
          await sendMsg(ss.chatId, [
            `⚠️ 警告：session 已靜止超過 ${Math.round(watchdogMs / 60000)} 分鐘`,
            `session: ${sid}`,
            `可能原因：LLM 無回應、subagent 卡住、或等待未收到的互動`,
            `輸入 /abort 強制中止，或繼續等待`,
          ].join("\n"))
          // 更新時間避免連續發警告（再等一個 watchdogMs）
          ss.lastActivityAt = now()
        }
      }
    }, Math.min(watchdogMs, 60_000))  // 最多每分鐘檢查一次
  }

  // ─── 執行 Prompt ────────────────────────────────────────────────────────

  async function runPrompt(chatId: number, prompt: string, sessionId: string) {
    // ─ Busy guard：避免同一 session 同時執行兩個 prompt ─
    if (runningSessions.has(sessionId)) {
      await sendMsg(chatId, [
        `⚠️ session ${sessionId} 目前正在執行中`,
        `請等待完成後再下指令，或用 /abort 中止`,
      ].join("\n"))
      return
    }

    rememberSession(chatId, sessionId)
    runningSessions.add(sessionId)

    const model = state.activeModelByChat[String(chatId)] || defaultModel || undefined

    const progressMsgId = await sendMsg(
      chatId,
      `⏳ 執行中...${model ? ` (${model})` : ""}\nsession: ${sessionId}`
    )

    streamStates.set(sessionId, {
      chatId,
      sessionId,
      buffer: "",
      messageId: progressMsgId,
      extraMessageIds: [],
      lastEditAt: now(),
      lastActivityAt: now(),
      done: false,
    })

    let modelObj: any = undefined
    if (model) {
      const slash = model.indexOf("/")
      if (slash > 0) {
        modelObj = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
      } else {
        await log(`runPrompt invalid model format: ${model}`)
      }
    }

    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: prompt }],
          model: modelObj,
        },
      } as any)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : summarizeError(err)
      await log(`runPrompt error sid=${sessionId}: ${errMsg}`)
      runningSessions.delete(sessionId)
      streamStates.delete(sessionId)
      if (progressMsgId) {
        await editMsg(chatId, progressMsgId, `❌ 執行失敗\n${errMsg.slice(0, 500)}`)
      } else {
        await sendMsg(chatId, `❌ 執行失敗\n${errMsg.slice(0, 500)}`)
      }
    }
  }

  // ─── 權限授權流程 ───────────────────────────────────────────────────────

  async function resolveApproval(id: string, decision: "deny" | "once" | "always") {
    const item = pendingApprovals.get(id)
    if (!item) return false
    clearTimeout(item.timer)
    pendingApprovals.delete(id)
    state.approvals[id] = { id, decision, createdAt: item.createdAt, resolvedAt: now() }
    await persist()

    if (item.sessionID && item.permissionID) {
      const response = decision === "deny" ? "reject" : decision
      const method = (client as any).postSessionIdPermissionsPermissionId
      if (typeof method === "function") {
        try {
          await method.call(client, {
            path: { id: item.sessionID, permissionID: item.permissionID },
            body: { response },
          })
          await log(`permission.reply sent id=${id} session=${item.sessionID} permission=${item.permissionID} response=${response}`)
        } catch (err) {
          await log(`permission.reply error id=${id}: ${summarizeError(err)}`)
        }
      }
    }

    item.resolve(decision)
    return true
  }

  async function handlePermissionAsked(raw: any, output?: { status: "ask" | "deny" | "allow" }) {
    const props = raw?.properties ?? raw
    const permID = props?.id ?? uid("perm")
    const permType = props?.permission ?? "permission"
    const title = props?.title ?? permType
    const sessionID = props?.sessionID ?? props?.sessionId
    const callID = props?.tool?.callID ?? props?.callID
    const patterns = Array.isArray(props?.patterns) ? props.patterns : []
    const pattern = patterns.join(", ")

    const ruleKey = JSON.stringify({ permType, pattern, sessionID })
    const cached = state.permissionRules[ruleKey]
    if (cached === "always") {
      if (output) output.status = "allow"
      return
    }
    if (cached === "deny") {
      if (output) output.status = "deny"
      return
    }

    const chatId = currentChatId ?? [...allowChatIds][0]
    if (!chatId) {
      await log(`permission.asked: no chatId available, denying. type=${permType}`)
      if (output) output.status = "deny"
      return
    }

    const id = uid("apr")
    const msgLines = [
      `🔐 需要授權`,
      `id: \`${id}\``,
      `permissionID: ${permID}`,
      sessionID ? `session: ${sessionID}` : undefined,
      callID ? `call: ${callID}` : undefined,
      `類型: ${permType}`,
      patterns.length ? `patterns: ${patterns.join(" | ")}` : undefined,
      title !== permType ? `說明: ${title}` : undefined,
      pattern ? `pattern: ${pattern}` : undefined,
    ].filter(Boolean).join("\n")

    await log(`permission.asked id=${id} type=${permType} title=${title}`)

    const timer = setTimeout(() => {
      void resolveApproval(id, "deny")
    }, requestTimeoutMs)

    pendingApprovals.set(id, {
      id,
      chatId,
      text: msgLines,
      sessionID,
      permissionID: permID,
      resolve: () => undefined,
      timer,
      createdAt: now(),
    })

    void sendMsg(chatId, msgLines, {
      reply_markup: {
        inline_keyboard: [[
          btn("拒絕", `approval:${id}:deny`),
          btn("允許一次", `approval:${id}:once`),
          btn("永遠允許", `approval:${id}:always`),
        ]],
      },
    }).catch(err => void log(`permission.asked sendMsg error: ${summarizeError(err)}`))

    if (output) output.status = "ask"
  }

  // ─── 新增：Question 流程 ─────────────────────────────────────────────────

  async function replyQuestion(requestID: string, answers: string[]) {
    try {
      await ocFetch(`/question/${requestID}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers }),
      })
      await log(`question.reply sent requestID=${requestID} answers=${JSON.stringify(answers)}`)
    } catch (err) {
      await log(`question.reply error requestID=${requestID}: ${summarizeError(err)}`)
    }
  }

  async function rejectQuestion(requestID: string) {
    try {
      await ocFetch(`/question/${requestID}/reject`, { method: "POST" })
      await log(`question.reject sent requestID=${requestID}`)
    } catch (err) {
      await log(`question.reject error requestID=${requestID}: ${summarizeError(err)}`)
    }
  }

  async function handleQuestionAsked(props: any) {
    // 完整 log 原始 props，方便 debug 實際的資料結構
    await log(`question.asked raw props: ${summarizeError(props)}`)

    const requestID = props?.requestID ?? props?.id
    const sessionID = props?.sessionID ?? props?.sessionId
    const questions: QuestionItem[] = (props?.questions ?? []).map((q: any) => ({
      id: q?.id,
      text: q?.text ?? q?.question ?? String(q),
      options: Array.isArray(q?.options) ? q.options : undefined,
    }))

    if (!requestID) {
      await log(`question.asked: missing requestID, props=${summarizeError(props)}`)
      return
    }
    if (!questions.length) {
      await log(`question.asked: no questions, requestID=${requestID}`)
      return
    }

    // 已在處理中則忽略
    if (pendingQuestions.has(requestID)) return

    const chatId = currentChatId ?? [...allowChatIds][0]
    if (!chatId) {
      await log(`question.asked: no chatId, rejecting requestID=${requestID}`)
      await rejectQuestion(requestID)
      return
    }

    await log(`question.asked: sending to chatId=${chatId} requestID=${requestID}`)

    const timer = setTimeout(async () => {
      const shortKey = requestID.replace(/-/g, "").slice(0, 8)
      pendingQuestions.delete(requestID)
      pendingQuestions.delete(shortKey)
      await rejectQuestion(requestID)
      await sendMsg(chatId, `⏰ AI 提問逾時，已自動拒絕\nid: ${shortID}`)
    }, requestTimeoutMs)

    pendingQuestions.set(requestID, { requestID, sessionID, chatId, questions, createdAt: now(), timer })

    // 用於 callback 的短 ID（取前 8 碼，確保 callback_data 在 64 bytes 內）
    // 格式：q:<8碼>:<選項索引> 最長 = 2+1+8+1+2 = 14 bytes，遠低於 64 限制
    const shortID = requestID.replace(/-/g, "").slice(0, 8)

    // 發送每個問題
    let globalIdx = 0;
    for (const q of questions) {
      const hasOptions = Array.isArray(q.options) && q.options.length > 0

      const lines = [
        `❓ AI 提問`,
        `id: \`${shortID}\``,
        sessionID ? `session: ${sessionID.slice(0, 12)}` : undefined,
        ``,
        q.text,
        !hasOptions ? `回覆方式：/answer ${shortID} <你的回答>` : undefined,
      ].filter(v => v !== undefined).join("\n")

      // Bug 1 修復：callback_data 格式改為 q:<shortID>:<index>
      // 最長：q: (2) + shortID (8) + : (1) + index (2) = 13 bytes，絕對安全
      const keyboard = hasOptions
        ? {
            reply_markup: {
              inline_keyboard: chunkArray(
                (q.options!).map((opt: any) => {
                  const currentIdx = globalIdx++;
                  const label = (typeof opt === "string" ? opt : (opt?.label ?? opt?.text ?? JSON.stringify(opt))) || "Option";
                  return btn(label.slice(0, 30), `q:${shortID}:${currentIdx}`);
                }),
                2
              ),
            },
          }
        : {}

      const mid = await sendMsg(chatId, lines, keyboard)
      await log(`question.asked: sent msgId=${mid} shortID=${shortID} hasOptions=${hasOptions}`)
    }

    // shortID → requestID 的對應已存在 pendingQuestions map 裡
    // 但 /answer 和 callback 都用 shortID 查，需要確保 map 可以被找到
    // 在 pendingQuestions 額外存一個 shortID 對應（透過更新 map key 或加 field）
    // 這裡用最簡單的方式：在 map 裡同時用 shortID 存一份參照
    if (shortID !== requestID) {
      pendingQuestions.set(shortID, pendingQuestions.get(requestID)!)
    }

    await log(`question.asked: done requestID=${requestID} shortID=${shortID} questions=${questions.length}`)
  }

  // 補齊 plugin 重啟後已 pending 的 question
  async function recoverPendingQuestions() {
    try {
      const res = await ocFetch("/question/")
      if (!res.ok) return
      const list = await res.json() as any[]
      if (!Array.isArray(list) || !list.length) return
      await log(`recoverPendingQuestions: found ${list.length} pending questions`)
      for (const q of list) {
        await handleQuestionAsked(q)
      }
    } catch (err) {
      await log(`recoverPendingQuestions error: ${summarizeError(err)}`)
    }
  }

  // ─── TG 指令處理 ────────────────────────────────────────────────────────

  const HELP = `OpenCode TG Bridge 指令：
/help - 說明
/status - 目前狀態
/health - 連線狀態
/settings - 設定詳情
/ping - 測試 bot
/enable / /disable - 啟用/停用

/run <prompt> - 執行任務（目前 session）
/run --new <prompt> - 新 session 執行
/abort - 中止目前任務

/session new - 新建 session
/session list - 列出 session
/session switch <id> - 切換 session
/session info - 查看目前 session

/model list - 列出模型
/model show - 目前模型
/model use <provider/model> - 切換模型

/approve <id> once|always|deny - 回覆授權
/answer <requestID> <回答> - 回覆 AI 提問`

  async function handleMessage(chatId: number, text: string) {
    const t = text.trim()

    if (allowChatIds.size && !allowChatIds.has(chatId)) {
      await sendMsg(chatId, "Not allowed.")
      return
    }

    const isEnabled = state.enabled
    const alwaysAllowed = ["/enable", "/help", "/health", "/ping", "/settings"]
    if (!isEnabled && !alwaysAllowed.includes(t)) {
      await sendMsg(chatId, "TG bridge 已停用，請輸入 /enable 重新啟用。")
      return
    }

    // ─ 新增：/answer 指令（手動回覆 AI 提問）─────────────────────────────
    if (t.startsWith("/answer ")) {
      const rest = t.slice(8).trim()
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx < 0) {
        await sendMsg(chatId, "用法：/answer <id> <回答>")
        return
      }
      const rid = rest.slice(0, spaceIdx).trim()
      const answer = rest.slice(spaceIdx + 1).trim()

      // 支援 shortID 或 requestID 前綴比對
      const pq = [...pendingQuestions.values()].find(q =>
        q.chatId === chatId && (
          q.requestID === rid ||
          q.requestID.startsWith(rid) ||
          q.requestID.replace(/-/g, "").startsWith(rid)
        )
      )
      if (!pq) {
        await sendMsg(chatId, `找不到 AI 提問 \`${rid}\`，可能已逾時或已回覆`)
        return
      }

      const shortKey = pq.requestID.replace(/-/g, "").slice(0, 8)
      clearTimeout(pq.timer)
      pendingQuestions.delete(pq.requestID)
      pendingQuestions.delete(shortKey)
      await replyQuestion(pq.requestID, [answer])
      await sendMsg(chatId, `✅ 已回覆 AI 提問`)
      return
    }

    if (t === "/help") { await sendMsg(chatId, HELP); return }

    if (t === "/ping") {
      const ok = token ? await tgPost(token, "getMe", {}).then(() => true).catch(() => false) : false
      await sendMsg(chatId, ok ? "pong ✅" : "ping 失敗 ❌")
      return
    }

    if (t === "/enable") {
      state.enabled = true
      await persist()
      await sendMsg(chatId, "TG bridge 已啟用 ✅")
      return
    }

    if (t === "/disable") {
      state.enabled = false
      await persist()
      await sendMsg(chatId, "TG bridge 已停用 ⛔")
      return
    }

    if (t === "/status") {
      const sid = resolveSession(chatId) ?? "(none)"
      const model = state.activeModelByChat[String(chatId)] || defaultModel || "(none)"
      const pendingA = pendingApprovals.size
      const pendingQ = pendingQuestions.size
      const streaming = streamStates.has(sid)
      const busy = runningSessions.has(sid)
      await sendMsg(chatId, [
        `session: ${sid}`,
        `model: ${model}`,
        `streaming: ${streaming}`,
        `busy: ${busy}`,
        `pending approvals: ${pendingA}`,
        `pending questions: ${pendingQ}`,
      ].join("\n"))
      return
    }

    if (t === "/health") {
      await sendMsg(chatId, [
        `bridge: ${state.enabled ? "enabled" : "disabled"}`,
        `token: ${token ? "configured" : "MISSING"}`,
        `allow chat ids: ${allowChatIds.size ? [...allowChatIds].join(", ") : "(all)"}`,
        `opencode port: ${opencodePort}`,
        `watchdog: ${Math.round(watchdogMs / 60000)} min`,
        `started: ${new Date(state.startedAt).toLocaleString()}`,
        `last poll: ${state.lastPollAt ? new Date(state.lastPollAt).toLocaleString() : "(none)"}`,
        `last ok: ${state.lastPollOkAt ? new Date(state.lastPollOkAt).toLocaleString() : "(none)"}`,
        `last error: ${state.lastError ?? "(none)"}`,
        `poll stopped: ${pollStopped}`,
        `log: ${logFile}`,
      ].join("\n"))
      return
    }

    if (t === "/settings") {
      await sendMsg(chatId, [
        `🔧 插件設定`,
        `token: ${token ? "✅" : "❌ 未設定"}`,
        `allow chat ids: ${allowChatIds.size ? [...allowChatIds].join(", ") : "(all)"}`,
        `default model: ${defaultModel || "(none)"}`,
        `active model: ${state.activeModelByChat[String(chatId)] || defaultModel || "(none)"}`,
        `current session: ${resolveSession(chatId) ?? "(none)"}`,
        `poll interval: ${pollIntervalMs}ms`,
        `approval timeout: ${requestTimeoutMs}ms`,
        `opencode port: ${opencodePort}`,
        `watchdog: ${Math.round(watchdogMs / 60000)} min`,
        `state dir: ${stateDir}`,
        `settings file: ${settingsFile}`,
      ].join("\n"))
      return
    }

    // /abort
    if (t === "/abort") {
      const sid = resolveSession(chatId)
      if (!sid) { await sendMsg(chatId, "沒有活躍的 session"); return }
      try {
        await client.session.abort({ path: { id: sid } })
        streamStates.delete(sid)
        runningSessions.delete(sid)
        await sendMsg(chatId, `⛔ 已中止 session ${sid}`)
      } catch (err) {
        await sendMsg(chatId, `abort 失敗: ${summarizeError(err).slice(0, 200)}`)
      }
      return
    }

    // /session new
    if (t === "/session new") {
      try {
        const id = await createSession()
        await sendMsg(chatId, `✅ 新建 session: ${id}`)
      } catch (err) {
        await sendMsg(chatId, `建立失敗: ${summarizeError(err).slice(0, 200)}`)
      }
      return
    }

    // /session list
    if (t === "/session list") {
      const sessions = await listSessions()
      const current = resolveSession(chatId)
      const lines = sessions.map(s => {
        const isCurrent = s.id === current ? "▶ " : "  "
        const sub = s.parentID ? " [sub]" : ""
        return `${isCurrent}${s.id}${sub}${s.title ? ` (${s.title})` : ""}`
      })
      await sendMsg(chatId, lines.length ? lines.join("\n") : "(無 session)")
      return
    }

    // /session switch <id>
    if (t.startsWith("/session switch ")) {
      const id = t.slice("/session switch ".length).trim()
      if (!id) { await sendMsg(chatId, "請提供 session id"); return }
      rememberSession(chatId, id)
      await persist()
      await sendMsg(chatId, `✅ 已切換到 ${id}`)
      return
    }

    // /session info
    if (t === "/session info") {
      const sid = resolveSession(chatId)
      const rec = state.sessions.find(s => s.id === sid)
      if (!sid) { await sendMsg(chatId, "(無 session)"); return }
      await sendMsg(chatId, [
        `session: ${sid}`,
        `title: ${rec?.title ?? "(無)"}`,
        `parent: ${rec?.parentID ?? "(無)"}`,
        `created: ${rec ? new Date(rec.createdAt).toLocaleString() : "unknown"}`,
        `busy: ${runningSessions.has(sid)}`,
      ].join("\n"))
      return
    }

    // /model list
    if (t === "/model list") {
      const models = await listModels()
      await sendMsg(chatId, models.length ? models.join("\n") : "(無可用模型)")
      return
    }

    // /model show
    if (t === "/model show") {
      await sendMsg(chatId, state.activeModelByChat[String(chatId)] || defaultModel || "(none)")
      return
    }

    // /model use <n>
    if (t.startsWith("/model use ")) {
      const model = t.slice("/model use ".length).trim()
      if (!model) { await sendMsg(chatId, "請提供模型名稱（格式：provider/model）"); return }
      if (!model.includes("/")) { await sendMsg(chatId, "格式錯誤，請使用 provider/model"); return }
      state.activeModelByChat[String(chatId)] = model
      await persist()
      await sendMsg(chatId, `✅ 模型已切換為 ${model}`)
      return
    }

    // /approve <id> once|always|deny
    if (t.startsWith("/approve ")) {
      const parts = t.split(/\s+/)
      const [, id, decision] = parts
      if (!id || !decision || !["deny", "once", "always"].includes(decision)) {
        await sendMsg(chatId, "用法：/approve <id> once|always|deny")
        return
      }
      const ok = await resolveApproval(id, decision as "deny" | "once" | "always")
      await sendMsg(chatId, ok ? `✅ 已回覆 ${id}: ${decision}` : `找不到授權請求 ${id}`)
      return
    }

    // /run [--new] <prompt>
    if (t.startsWith("/run ")) {
      const rest = t.slice(5).trim()
      const isNew = rest.startsWith("--new ")
      const prompt = isNew ? rest.slice("--new ".length).trim() : rest
      if (!prompt) { await sendMsg(chatId, "請提供 prompt"); return }

      let sid: string
      try {
        sid = isNew ? await createSession() : (resolveSession(chatId) ?? await createSession())
      } catch (err) {
        await sendMsg(chatId, `無法建立 session: ${summarizeError(err).slice(0, 200)}`)
        return
      }

      void runPrompt(chatId, prompt, sid).catch(err => log(`runPrompt unhandled: ${summarizeError(err)}`))
      return
    }

    await sendMsg(chatId, "未知指令，輸入 /help 查看說明。")
  }

  // ─── Telegram Update 處理 ───────────────────────────────────────────────

  async function handleUpdate(update: TelegramUpdate) {
    if (update.message?.text && update.message.chat?.id != null) {
      currentChatId = update.message.chat.id
      await log(`msg chatId=${update.message.chat.id} text=${JSON.stringify(update.message.text).slice(0, 120)}`)
      await handleMessage(update.message.chat.id, update.message.text).catch(err =>
        log(`handleMessage error: ${summarizeError(err)}`)
      )
    }

    const cbData = update.callback_query?.data
    const cbChatId = update.callback_query?.message?.chat?.id
    if (cbData && cbChatId != null) {
      currentChatId = cbChatId

      // ─ Approval callback ─
      const approvalMatch = cbData.match(/^approval:([^:]+):(deny|once|always)$/)
      if (approvalMatch) {
        const [, id, decision] = approvalMatch
        await log(`callback approval id=${id} decision=${decision} cbChatId=${cbChatId}`)
        await resolveApproval(id, decision as "deny" | "once" | "always")
        await answerCallback(update.callback_query!.id, `已回覆: ${decision}`)
        return
      }

      // ─ 新增：Question callback ─
      const questionMatch = cbData.match(/^q:([^:]+):(\d+)$/)
      if (questionMatch) {
        const [, shortID, idxStr] = questionMatch
        const pq = [...pendingQuestions.values()].find(q =>
          q.chatId === cbChatId &&
          (q.requestID.replace(/-/g, "").startsWith(shortID) || q.requestID === shortID)
        )
        if (pq) {
          const idx = parseInt(idxStr, 10)
          // 找對應問題的選項
          const rawAnswer = pq.questions.flatMap(q => q.options ?? []).at(idx) ?? idxStr
          const answer = (typeof rawAnswer === "object" && rawAnswer !== null)
            ? ((rawAnswer as any).label ?? (rawAnswer as any).text ?? JSON.stringify(rawAnswer))
            : rawAnswer;
          // 清除所有 shortID 的 key
          const shortKey = pq.requestID.replace(/-/g, "").slice(0, 8)
          clearTimeout(pq.timer)
          pendingQuestions.delete(pq.requestID)
          pendingQuestions.delete(shortKey)
          await replyQuestion(pq.requestID, [answer])
          await answerCallback(update.callback_query!.id, `✅ 已選擇: ${answer}`)
        } else {
          await answerCallback(update.callback_query!.id, "找不到對應的提問（可能已逾時）")
        }
        return
      }
    }
  }

  // ─── Long Polling ────────────────────────────────────────────────────────

  async function startPolling() {
    if (!token) {
      await log("poll: token 未設定，跳過")
      return
    }

    await log(`poll started; allowChatIds=${[...allowChatIds].join(",")}`)

    while (true) {
      if (pollStopped) {
        await new Promise(r => setTimeout(r, 10000))
        continue
      }
      if (!state.enabled) {
        await new Promise(r => setTimeout(r, pollIntervalMs))
        continue
      }

      try {
        state.lastPollAt = now()
        const res = await tgPost(token, "getUpdates", {
          offset: state.lastUpdateId + 1,
          timeout: 20,
          allowed_updates: ["message", "callback_query"],
        })
        state.lastPollOkAt = now()
        state.lastError = undefined

        const updates = Array.isArray((res as any).result) ? (res as any).result as TelegramUpdate[] : []
        for (const update of updates) {
          // 先處理，成功後才推進 offset，避免失敗時跳過後續訊息
          await handleUpdate(update).catch(err =>
            log(`handleUpdate error update_id=${update.update_id}: ${summarizeError(err)}`)
          )
          state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id)
        }
        await persist()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        state.lastError = msg.slice(0, 500)
        await log(`poll error: ${msg}`)

        if (msg.includes("401")) {
          pollStopped = true
          await log("poll: 401 Unauthorized，停止輪詢。請確認 token 是否正確。")
          await new Promise(r => setTimeout(r, 60000))
          continue
        }

        await new Promise(r => setTimeout(r, pollIntervalMs * 3))
      }
    }
  }

  // ─── 初始化 ──────────────────────────────────────────────────────────────

  await log(`plugin init; token=${Boolean(token)}; enabled=${state.enabled}; dir=${projectRoot}`)

  if (token && allowChatIds.size) {
    const firstChat = [...allowChatIds][0]
    sendMsg(firstChat, `✅ OpenCode TG Bridge 已啟動\n專案：${projectRoot}`)
      .then(mid => log(`bootstrap sent to ${firstChat} messageId=${mid}`))
      .catch(err => log(`bootstrap failed: ${err?.message}`))
  }

  // 補齊重啟前 pending 的 question（延遲 3 秒等 opencode server 就緒）
  setTimeout(() => void recoverPendingQuestions(), 3000)

  // 啟動 watchdog
  startWatchdog()

  // 啟動 long polling（非阻塞）
  void startPolling()

  // ─── Plugin Hooks ─────────────────────────────────────────────────────────

  return {
    async event({ event }) {
      if (event?.type === "file.watcher.updated") {
        const file = String((event as any)?.properties?.file ?? "")
        if (file.includes("tg-plugin")) return
      }

      const quietEvents = new Set(["file.watcher.updated", "session.status", "todo.updated", "message.part.delta"])
      if (!quietEvents.has(event?.type as string)) {
        await log(`event: ${event?.type}`)
      }

      if (event?.type === "permission.asked") {
        await handlePermissionAsked(event).catch(err =>
          log(`permission.asked error: ${summarizeError(err)}`)
        )
        return
      }

      // ─ 新增：question.asked ──────────────────────────────────────────────
      if (event?.type === "question.asked") {
        await handleQuestionAsked((event as any)?.properties ?? event).catch(err =>
          log(`question.asked error: ${summarizeError(err)}`)
        )
        return
      }

      // ─ 新增：追蹤 subagent session ─────────────────────────────────────
      // session.created 時，若有 parentID，記錄為 subagent
      if (event?.type === "session.created" || event?.type === "session.updated") {
        const info = (event as any)?.properties?.info ?? (event as any)?.properties
        const sid = info?.id
        const parentID = info?.parentID ?? info?.parentId
        if (sid) {
          currentSessionId = sid
          const existing = state.sessions.find(s => s.id === sid)
          if (!existing) {
            state.sessions.push({ id: sid, title: info?.title, createdAt: now(), parentID })
            if (parentID) {
              await log(`subagent session detected: ${sid} (parent: ${parentID})`)
              // 若 parent 在 running，subagent 也可能需要處理 question/permission
              // 這裡只記錄，實際 event 會透過同一個 event hook 收到
            }
          }
          await persist()
        }
      }

      // session.idle: 任務完成
      if (event?.type === "session.idle") {
        const sid = (event as any)?.properties?.sessionID ?? (event as any)?.properties?.id
        if (sid) {
          runningSessions.delete(sid)  // 確保 busy guard 解除

          // ─ 新增：檢查是否為 subagent 完成，parent 是否仍顯示 busy ────────
          const sessionRec = state.sessions.find(s => s.id === sid)
          if (sessionRec?.parentID) {
            const parentID = sessionRec.parentID
            if (runningSessions.has(parentID)) {
              await log(`subagent ${sid} idle, parent ${parentID} still in runningSessions`)
              // parent 的 session.idle 應該會跟著到來；若沒有，watchdog 會偵測到
            }
          }

          await handleStreamDone(sid).catch(err =>
            log(`stream done error: ${summarizeError(err)}`)
          )
        }
      }

      // message.part.updated: 串流文字到 TG
      if (event?.type === "message.part.updated") {
        const part = (event as any)?.properties?.part
        if (part?.type === "text" && part?.sessionID) {
          const txt = (part?.text ?? "") as string
          if (txt) {
            await handleStreamPart(part.sessionID, txt).catch(err =>
              log(`stream part error: ${summarizeError(err)}`)
            )
          }
        }
      }

      // session.error: 任務失敗
      if (event?.type === "session.error") {
        const sid = (event as any)?.properties?.sessionID
        const err = (event as any)?.properties?.error
        await log(`session.error sid=${sid}: ${summarizeError(err)}`)
        if (sid) runningSessions.delete(sid)
        const ss = sid ? streamStates.get(sid) : undefined
        if (ss) {
          streamStates.delete(sid)
          await sendMsg(ss.chatId, `❌ 任務失敗\n${summarizeError(err).slice(0, 400)}`)
        } else if (currentChatId) {
          await sendMsg(currentChatId, `❌ 任務失敗\n${summarizeError(err).slice(0, 400)}`)
        }
      }
    },

    async "permission.asked"(inputPermission, output) {
      await handlePermissionAsked(inputPermission, output)
    },

    async "permission.ask"(inputPermission, output) {
      await handlePermissionAsked(inputPermission, output)
    },
  }
}

// ─── 工具：陣列分組 ──────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

export default TelegramPlugin
