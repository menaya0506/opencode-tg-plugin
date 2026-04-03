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
 *   /compaction progress on|off - 設定壓縮過程顯示
 *   /stream mode cover|full     - 切換串流輸出模式
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
import { execFileSync } from "node:child_process"
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
  showCompactionProgress?: boolean
  streamMode?: "cover" | "full"
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
  initiatedBy?: "tg" | "computer"
}

type SessionTokenSummary = {
  messages: number
  userMessages: number
  assistantMessages: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  latestPromptTokens?: number
  latestCompletionTokens?: number
  latestReasoningTokens?: number
  latestCacheReadTokens?: number
  latestCacheWriteTokens?: number
  latestTotalTokens?: number
  estimatedContextLimit?: number
  estimatedContextUsage?: number
  estimatedRemainingTokens?: number
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
  sentLength?: number
}

type PluginState = {
  currentSessionByChat: Record<string, string>
  sessions: SessionRecord[]
  approvals: Record<string, { id: string; decision: string; createdAt: number; resolvedAt: number }>
  permissionRules: Record<string, "deny" | "always">
  activeModelByChat: Record<string, string>
  sessionUsageById: Record<string, SessionTokenSummary>
  showCompactionProgress: boolean
  streamMode: "cover" | "full"
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
const MAX_TG_MESSAGE_LENGTH = 3800 // Telegram 單一訊息上限約 4000，保留 200 安全邊界
const MAX_STATE_SESSIONS = 200 // 最大保留的 session 數量
const MAX_STATE_APPROVALS = 500 // 最大保留的 approval 數量
const STATE_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000 // approval 保留 7 天

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
  if (v instanceof Error) {
    // 確保 Error 物件的 message、cause 都能顯示出來（避免 {} 的情況）
    const msg = v.message || v.name || String(v)
    const cause = (v as any).cause ? ` (cause: ${String((v as any).cause)})` : ""
    return `${msg}${cause}`.slice(0, 2000)
  }
  try { return JSON.stringify(v).slice(0, 2000) } catch { return String(v) }
}

function splitText(text: string, max = MAX_TG_MESSAGE_LENGTH) {
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

function formatNumber(v?: number) {
  return Number.isFinite(v) ? Intl.NumberFormat("en-US").format(v!) : "(unknown)"
}

function pct(value?: number) {
  return Number.isFinite(value) ? `${value!.toFixed(1)}%` : "(unknown)"
}

function splitModelName(modelName?: string) {
  const name = (modelName ?? "").trim()
  const slash = name.indexOf("/")
  if (!name || slash <= 0 || slash >= name.length - 1) return undefined
  return {
    providerID: name.slice(0, slash),
    modelID: name.slice(slash + 1),
  }
}

function detectOpencodeBaseUrlFromProcess() {
  try {
    const ps = `
$p = Get-CimInstance Win32_Process -Filter "Name = 'opencode-cli.exe'" | Select-Object -First 1 -ExpandProperty CommandLine
if ($p -and $p -match '--port\\s+(\\d+)') { $Matches[1] }
`
    const out = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", ps], { encoding: "utf8" }).trim()
    if (!out) return undefined
    const port = Number(out)
    if (!Number.isFinite(port) || port <= 0) return undefined
    return `http://127.0.0.1:${port}`
  } catch {
    return undefined
  }
}

type CompactionTracker = {
  chatId: number
  startedAt: number
  startMessageId?: number
  progressMessageId?: number
}

function hasTokenValues(tokens?: { input?: number; output?: number; reasoning?: number; total?: number; cache?: { read?: number; write?: number } }) {
  if (!tokens) return false
  return Boolean(
    Number(tokens.input ?? 0) ||
    Number(tokens.output ?? 0) ||
    Number(tokens.reasoning ?? 0) ||
    Number(tokens.total ?? 0) ||
    Number(tokens.cache?.read ?? 0) ||
    Number(tokens.cache?.write ?? 0)
  )
}

function estimateTokensFromText(text: string) {
  const clean = text.trim()
  if (!clean) return 0
  return Math.max(1, Math.ceil(clean.length / 4))
}

function estimateTokensFromMessage(item: any) {
  const info = item?.info ?? item
  const parts = Array.isArray(item?.parts) ? item.parts : []
  const text = parts
    .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim() || String(info?.summary?.body ?? "").trim()
  const estimated = estimateTokensFromText(text)
  if (!estimated) return undefined
  if (info?.role === "assistant") {
    return { input: 0, output: estimated, reasoning: 0, total: estimated, cache: { read: 0, write: 0 } }
  }
  return { input: estimated, output: 0, reasoning: 0, total: estimated, cache: { read: 0, write: 0 } }
}

function accumulateTokens(summary: SessionTokenSummary, tokens: { input?: number; output?: number; reasoning?: number; total?: number; cache?: { read?: number; write?: number } }) {
  summary.promptTokens += Number(tokens.input ?? 0)
  summary.completionTokens += Number(tokens.output ?? 0)
  summary.reasoningTokens += Number(tokens.reasoning ?? 0)
  summary.cacheReadTokens += Number(tokens.cache?.read ?? 0)
  summary.cacheWriteTokens += Number(tokens.cache?.write ?? 0)
  summary.totalTokens += Number(tokens.total ?? (Number(tokens.input ?? 0) + Number(tokens.output ?? 0)))
}

function setLatestTokens(summary: SessionTokenSummary, tokens: { input?: number; output?: number; reasoning?: number; total?: number; cache?: { read?: number; write?: number } }) {
  summary.latestPromptTokens = Number(tokens.input ?? 0)
  summary.latestCompletionTokens = Number(tokens.output ?? 0)
  summary.latestReasoningTokens = Number(tokens.reasoning ?? 0)
  summary.latestCacheReadTokens = Number(tokens.cache?.read ?? 0)
  summary.latestCacheWriteTokens = Number(tokens.cache?.write ?? 0)
  summary.latestTotalTokens = Number(tokens.total ?? (Number(tokens.input ?? 0) + Number(tokens.output ?? 0)))
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
  const streamModeFromConfig = (process.env.TG_STREAM_MODE ?? fileSettings.streamMode ?? "cover").toString().toLowerCase() === "full" ? "full" : "cover"
  // opencode server 的 base URL
  // 優先從 ctx.client 取出（最可靠，包含動態分配的 port）
  // fallback 先從目前 opencode-cli 進程命令列抓 --port，再回退到設定值
  const opencodePort = Number(process.env.OPENCODE_PORT ?? fileSettings.opencodePort ?? 13599)
  const _clientBaseUrl: string = (() => {
    const c = client as any
    // SDK v2: client._client?.baseURL 或 client.baseURL 或 client._options?.baseURL
    const raw = c?._client?.baseURL ?? c?.baseURL ?? c?._options?.baseURL ?? c?._baseURL ?? ""
    if (raw) return raw.replace(/\/$/, "")
    const detected = detectOpencodeBaseUrlFromProcess()
    if (detected) return detected
    // 最後 fallback
    return `http://127.0.0.1:${opencodePort}`
  })()
  // 串流靜止多久（ms）後觸發 watchdog 警告（預設 15 分鐘）
  const watchdogMs = Number(process.env.TG_WATCHDOG_MS ?? fileSettings.watchdogMs ?? 15 * 60 * 1000)

  // ─── 執行期狀態 ─────────────────────────────────────────────────────────

  const DEFAULT_STATE: PluginState = {
    currentSessionByChat: {},
    sessions: [],
    approvals: {},
    permissionRules: {},
    activeModelByChat: {},
    sessionUsageById: {},
    showCompactionProgress: false,
    streamMode: streamModeFromConfig,
    enabled: enabledFromConfig,
    startedAt: now(),
    lastUpdateId: 0,
  }

  let state: PluginState = await readJson<PluginState>(stateFile, DEFAULT_STATE)
  state.sessions ??= []
  state.approvals ??= {}
  state.permissionRules ??= {}
  state.activeModelByChat ??= {}
  state.sessionUsageById ??= {}
  state.showCompactionProgress ??= false
  state.streamMode ??= streamModeFromConfig
  state.currentSessionByChat ??= {}
  state.enabled ??= enabledFromConfig
  state.startedAt ??= now()
  state.lastUpdateId ??= 0

function pruneState() {
  // sessions: keep newest MAX_STATE_SESSIONS
  if (state.sessions.length > MAX_STATE_SESSIONS) {
    state.sessions = state.sessions
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_STATE_SESSIONS)
  }
  // approvals: remove old based on TTL then limit
  const cutoff = now() - STATE_APPROVAL_TTL_MS
  for (const [key, val] of Object.entries(state.approvals)) {
    if (val.resolvedAt && val.resolvedAt < cutoff) delete state.approvals[key]
  }
  const keys = Object.keys(state.approvals)
  if (keys.length > MAX_STATE_APPROVALS) {
    keys
      .sort((a, b) => (state.approvals[a].resolvedAt ?? 0) - (state.approvals[b].resolvedAt ?? 0))
      .slice(0, keys.length - MAX_STATE_APPROVALS)
      .forEach(k => delete state.approvals[k])
  }
}

  const pendingApprovals = new Map<string, PendingApproval>()
  const pendingQuestions = new Map<string, PendingQuestion>()  // ← 新增
  const streamStates = new Map<string, StreamState>()
  const compactionTrackers = new Map<string, CompactionTracker>()
pruneState();

  // ─── 新增：Busy guard ─────────────────────────────────────────────────────
  // 記錄每個 session 目前是否正在執行中（由 plugin 自己維護，避免撞 BusyError）
  const runningSessions = new Set<string>()
  // 新增：執行隊列，防止競態條件
  const executionQueue = new Map<string, Promise<void>>()
// 新增：session initiator 記錄（tg 或 computer 發起）
const sessionInitiators = new Map<string, "tg" | "computer">()
let watchdogIntervalId: ReturnType<typeof setInterval> | undefined

  let currentChatId: number | undefined
  let currentSessionId: string | undefined = state.currentSessionByChat[Object.keys(state.currentSessionByChat)[0]]
  let pollStopped = false

  const persist = () => writeJson(stateFile, state).catch(() => undefined)

  // ─── 輔助：opencode REST ──────────────────────────────────────────────────

  async function ocFetch(path: string, opts?: RequestInit) {
    // 使用從 ctx.client 萃取的正確 base URL（含動態 port）
    return fetch(`${_clientBaseUrl}${path}`, {
      headers: { "content-type": "application/json" },
      ...opts,
    })
  }

  function getAuthHeaders() {
    const c = client as any
    const headers = c?._client?.headers ?? c?.headers ?? c?._options?.headers ?? {}
    return headers && typeof headers === "object" ? headers : {}
  }

  // ─── 輔助：Session ──────────────────────────────────────────────────────

  function rememberSession(chatId: number, sessionId: string, parentID?: string) {
    currentChatId = chatId
    currentSessionId = sessionId
    state.currentSessionByChat[String(chatId)] = sessionId
    if (!state.sessions.find(s => s.id === sessionId)) {
      state.sessions.push({ id: sessionId, createdAt: now(), parentID })
      pruneState();
    }
    const rec = state.sessions.find(s => s.id === sessionId)
    if (rec) rec.initiatedBy ??= sessionInitiators.get(sessionId) ?? undefined
  }

  function resolveChatForSession(sessionID: string) {
    const entry = Object.entries(state.currentSessionByChat).find(([, sid]) => sid === sessionID)
    return entry ? Number(entry[0]) : currentChatId
  }

  function isTGInitiatedSession(sessionID?: string) {
    return !!sessionID && sessionInitiators.get(sessionID) === "tg"
  }

  async function notifyCompactionStart(sessionID: string) {
    if (!isTGInitiatedSession(sessionID)) return
    const chatId = resolveChatForSession(sessionID)
    if (chatId == null || Number.isNaN(chatId)) return
    if (compactionTrackers.has(sessionID)) return
    const mid = await sendMsg(chatId, `🗜️ 開始上下文壓縮\nsession: ${sessionID}`)
    const tracker: CompactionTracker = { chatId, startedAt: now(), startMessageId: mid }
    if (state.showCompactionProgress) {
      tracker.progressMessageId = await sendMsg(chatId, `↻ 壓縮進行中...\nsession: ${sessionID}`)
    }
    compactionTrackers.set(sessionID, tracker)
  }

  async function notifyCompactionEnd(sessionID: string) {
    if (!isTGInitiatedSession(sessionID)) return
    const tracker = compactionTrackers.get(sessionID)
    const chatId = tracker?.chatId ?? resolveChatForSession(sessionID)
    if (chatId == null || Number.isNaN(chatId)) return

    const msg = `✅ 上下文壓縮完成\nsession: ${sessionID}`
    await sendMsg(chatId, msg)
    if (tracker?.progressMessageId) {
      await editMsg(chatId, tracker.progressMessageId, `✅ 壓縮進度已完成\nsession: ${sessionID}`)
    }
    compactionTrackers.delete(sessionID)
  }

  function resolveSession(chatId: number) {
    return state.currentSessionByChat[String(chatId)] ?? currentSessionId
  }

  async function createSession() {
    const res = await client.session.create({ body: {} })
    const id = (res as any)?.data?.id ?? (res as any)?.id
    if (!id) throw new Error("OpenCode did not return a session id")
    rememberSession(currentChatId ?? 0, id)
    sessionInitiators.set(id, "tg")
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

  async function getSessionTokenSummary(sessionId: string): Promise<SessionTokenSummary> {
    const runtime = state.sessionUsageById[sessionId]
    const summary: SessionTokenSummary = {
      messages: 0,
      userMessages: 0,
      assistantMessages: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    }

    try {
      const res = await (client as any).session.messages({ sessionID: sessionId, limit: 1000 })
      const data = (res as any)?.data ?? res
      const msgs = Array.isArray(data) ? data : []
      summary.messages = Math.max(summary.messages, msgs.length)
      syncUsageFromMessages(summary, msgs as any)
    } catch (err) {
      await log(`getSessionTokenSummary error sid=${sessionId}: ${summarizeError(err)}`)
    }

    if (summary.totalTokens === 0 && runtime) {
      summary.messages = runtime.messages || summary.messages
      summary.userMessages = runtime.userMessages || summary.userMessages
      summary.assistantMessages = runtime.assistantMessages || summary.assistantMessages
      summary.promptTokens = runtime.promptTokens || summary.promptTokens
      summary.completionTokens = runtime.completionTokens || summary.completionTokens
      summary.reasoningTokens = runtime.reasoningTokens || summary.reasoningTokens
      summary.cacheReadTokens = runtime.cacheReadTokens || summary.cacheReadTokens
      summary.cacheWriteTokens = runtime.cacheWriteTokens || summary.cacheWriteTokens
      summary.totalTokens = runtime.totalTokens || summary.totalTokens
      summary.latestPromptTokens = runtime.latestPromptTokens ?? summary.latestPromptTokens
      summary.latestCompletionTokens = runtime.latestCompletionTokens ?? summary.latestCompletionTokens
      summary.latestReasoningTokens = runtime.latestReasoningTokens ?? summary.latestReasoningTokens
      summary.latestCacheReadTokens = runtime.latestCacheReadTokens ?? summary.latestCacheReadTokens
      summary.latestCacheWriteTokens = runtime.latestCacheWriteTokens ?? summary.latestCacheWriteTokens
      summary.latestTotalTokens = runtime.latestTotalTokens ?? summary.latestTotalTokens
    }

    return summary
  }

  async function getSessionInfo(sessionId: string) {
    try {
      const res = await client.session.get({ sessionID: sessionId })
      const info = ((res as any)?.data ?? res) as any
      if (info?.time?.updated) return info

      const listRes = await client.session.list()
      const listData = (listRes as any)?.data ?? listRes
      const fromList = Array.isArray(listData) ? listData.find((s: any) => s?.id === sessionId) : undefined
      if (fromList) {
        return {
          ...fromList,
          ...info,
          time: {
            ...(fromList.time ?? {}),
            ...(info?.time ?? {}),
          },
        }
      }

      return info
    } catch (err) {
      await log(`getSessionInfo error sid=${sessionId}: ${summarizeError(err)}`)
      return undefined
    }
  }

  function getSessionUsage(sessionId: string) {
    state.sessionUsageById[sessionId] ??= {
      messages: 0,
      userMessages: 0,
      assistantMessages: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    }
    return state.sessionUsageById[sessionId]
  }

  function syncUsageFromMessages(messages: Array<{ info: any; parts: any[] }>) {
    const usage: SessionTokenSummary = {
      messages: 0,
      userMessages: 0,
      assistantMessages: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    }

    for (const item of messages) {
      const info = item?.info ?? item
      const parts = Array.isArray(item?.parts) ? item.parts : []
      usage.messages += 1
      if (info?.role === "user") usage.userMessages += 1
      if (info?.role === "assistant") usage.assistantMessages += 1
      const stepFinish = [...parts].reverse().find((part: any) => part?.type === "step-finish" && part?.tokens)
      const tokens = hasTokenValues(info?.tokens) ? info.tokens : stepFinish?.tokens ?? estimateTokensFromMessage(item)
      if (!tokens) continue
      usage.promptTokens += Number(tokens.input ?? 0)
      usage.completionTokens += Number(tokens.output ?? 0)
      usage.reasoningTokens += Number(tokens.reasoning ?? 0)
      usage.cacheReadTokens += Number(tokens.cache?.read ?? 0)
      usage.cacheWriteTokens += Number(tokens.cache?.write ?? 0)
      usage.totalTokens += Number(tokens.total ?? (Number(tokens.input ?? 0) + Number(tokens.output ?? 0)))
      if (info?.role === "assistant") setLatestTokens(usage, tokens)
    }

    return usage
  }

  function addUsageFromTokens(sessionId: string, role: string | undefined, tokens: { input?: number; output?: number; reasoning?: number; total?: number; cache?: { read?: number; write?: number } }) {
    const usage = getSessionUsage(sessionId)
    usage.messages += 1
    if (role === "user") usage.userMessages += 1
    if (role === "assistant") usage.assistantMessages += 1
    usage.promptTokens += Number(tokens.input ?? 0)
    usage.completionTokens += Number(tokens.output ?? 0)
    usage.reasoningTokens += Number(tokens.reasoning ?? 0)
    usage.cacheReadTokens += Number(tokens.cache?.read ?? 0)
    usage.cacheWriteTokens += Number(tokens.cache?.write ?? 0)
    usage.totalTokens += Number(tokens.total ?? (Number(tokens.input ?? 0) + Number(tokens.output ?? 0)))
  }

  async function getSessionChildrenCount(sessionId: string) {
    try {
      const res = await client.session.children({ sessionID: sessionId })
      const data = (res as any)?.data ?? res
      return Array.isArray(data) ? data.length : 0
    } catch {
      return 0
    }
  }

  async function getSessionStatus(sessionId: string) {
    try {
      const res = await client.session.status()
      const data = (res as any)?.data ?? res
      return data?.[sessionId]
    } catch {
      return undefined
    }
  }

  function formatSessionStatus(status: any) {
    if (!status) return undefined
    if (status.type === "retry") return `retry #${status.attempt} (next ${new Date(status.next).toLocaleString()})`
    return status.type ?? undefined
  }

  async function getModelContextLimit(modelName?: string) {
    const model = splitModelName(modelName)
    if (!model) return undefined

    try {
      const res = await (client as any).provider.list()
      const data = (res as any)?.data ?? res
      const providers = Array.isArray(data) ? data : Array.isArray(data?.all) ? data.all : []
      const foundProvider = providers.find((p: any) => (p?.id ?? p?.providerID) === model.providerID)
      const limit = foundProvider?.models?.[model.modelID]?.limit?.context
      if (Number(limit) > 0) return Number(limit)
    } catch (err) {
      await log(`getModelContextLimit provider.list error model=${modelName ?? "(none)"}: ${summarizeError(err)}`)
    }

    try {
      const res = await (client as any).model.list()
      const data = (res as any)?.data ?? res
      const models = Array.isArray(data) ? data : Array.isArray(data?.all) ? data.all.flatMap((p: any) => Object.values(p?.models ?? {})) : []
      const found = models.find((m: any) => (m?.providerID ?? m?.provider?.id) === model.providerID && (m?.id ?? m?.modelID) === model.modelID)
      const limit = found?.limit?.context
      if (Number(limit) > 0) return Number(limit)
    } catch (err) {
      await log(`getModelContextLimit model.list error model=${modelName ?? "(none)"}: ${summarizeError(err)}`)
    }

    try {
      const res = await client.config.get()
      const cfg = (res as any)?.data ?? res
      const limit = cfg?.provider?.[model.providerID]?.models?.[model.modelID]?.limit?.context
      return Number(limit) || undefined
    } catch (err) {
      await log(`getModelContextLimit config.get error model=${modelName ?? "(none)"}: ${summarizeError(err)}`)
      return undefined
    }
  }

  // ─── 修改：listModels 支援動態 OAuth provider ────────────────────────────

  async function listModels(): Promise<string[]> {
    // 優先嘗試動態模型清單（包含 GitHub Copilot 等 OAuth provider）
    try {
      const res = await (client as any).model.list()
      const data = (res as any)?.data ?? res
      const models = Array.isArray(data)
        ? data
        : Array.isArray(data?.all)
          ? data.all.flatMap((p: any) => Object.values(p?.models ?? {}).map((m: any) => ({ provider: p?.id ?? p?.providerID ?? "", model: m?.id ?? m?.modelID ?? "" })))
          : []
      if (models.length > 0) {
        return models
          .map((m: any) => {
            const provider = m?.provider?.id ?? m?.providerID ?? m?.provider ?? m?.provider ?? ""
            const model = m?.id ?? m?.modelID ?? m?.model ?? ""
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
        // 如果錯誤是權限相關，提供更詳細的訊息
        if (err?.message?.includes("403")) {
          void log(`sendMsg: bot 可能沒有權限發送訊息到 chat ${chatId}`)
        }
        return null
      })
      lastMsgId = (res as any)?.result?.message_id as number | undefined
    }
    return lastMsgId
  }

  async function registerTelegramCommands() {
    if (!token) return
    const commands = [
      { command: "help", description: "顯示指令說明" },
      { command: "status", description: "查看目前 session 與任務狀態" },
      { command: "health", description: "檢查 bridge 與輪詢狀態" },
      { command: "settings", description: "顯示插件設定" },
      { command: "ping", description: "測試 bot 是否可用" },
      { command: "enable", description: "啟用 TG bridge" },
      { command: "disable", description: "停用 TG bridge" },
      { command: "run", description: "在目前 session 執行任務" },
      { command: "abort", description: "中止目前 session" },
      { command: "session", description: "管理 session（new/list/switch/info）" },
      { command: "model", description: "管理模型（list/show/use）" },
      { command: "approve", description: "回覆授權請求" },
      { command: "answer", description: "回覆 AI 提問" },
      { command: "interrupt", description: "中斷串流但保留內容" },
      { command: "continue", description: "在目前對話基礎上繼續" },
      { command: "compaction", description: "設定上下文壓縮進度訊息" },
      { command: "stream", description: "設定串流輸出模式" },
    ]

    try {
      await tgPost(token, "setMyCommands", { commands })
      await log(`telegram commands registered: ${commands.length}`)
    } catch (err) {
      await log(`registerTelegramCommands error: ${summarizeError(err)}`)
    }
  }

  async function editMsg(chatId: number, messageId: number, text: string, extra?: Record<string, unknown>) {
    if (!token) return
    await tgPost(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, MAX_TG_MESSAGE_LENGTH + 200), // Telegram 實際上限約 4000，保留安全邊界
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

    const mode = state.streamMode ?? "cover"
    ss.lastActivityAt = now()

    if (mode === "cover") {
      ss.buffer = text

      const nowMs = now()
      if (nowMs - ss.lastEditAt < 1000) return
      ss.lastEditAt = nowMs

      const displayText = ss.buffer.slice(0, MAX_TG_MESSAGE_LENGTH)
      if (ss.messageId) {
        await editMsg(ss.chatId, ss.messageId, displayText)
      } else {
        const mid = await sendMsg(ss.chatId, displayText)
        if (mid) ss.messageId = mid
      }
      return
    }

    const segmentSize = 1024
    let pending = text.slice(ss.sentLength ?? 0)
    if (!pending) return

    while (pending.length > 0) {
      if (!ss.messageId) {
        const chunk = pending.slice(0, segmentSize)
        const mid = await sendMsg(ss.chatId, chunk)
        if (mid) {
          ss.messageId = mid
          ss.buffer = chunk
        }
        ss.sentLength = (ss.sentLength ?? 0) + chunk.length
        pending = pending.slice(chunk.length)
        continue
      }

      const room = segmentSize - ss.buffer.length
      if (room > 0) {
        const chunk = pending.slice(0, room)
        ss.buffer += chunk
        await editMsg(ss.chatId, ss.messageId, ss.buffer)
        ss.sentLength = (ss.sentLength ?? 0) + chunk.length
        pending = pending.slice(chunk.length)
        continue
      }

      const chunk = pending.slice(0, segmentSize)
      const mid = await sendMsg(ss.chatId, chunk)
      if (mid) {
        ss.messageId = mid
        ss.buffer = chunk
      }
      ss.sentLength = (ss.sentLength ?? 0) + chunk.length
      pending = pending.slice(chunk.length)
    }
}

  async function handleStreamDone(sessionId: string) {
    const ss = streamStates.get(sessionId)
    if (!ss || ss.done) return
    ss.done = true

    runningSessions.delete(sessionId)
    // 清理 session initiator 記錄
    sessionInitiators.delete(sessionId)

    const finalText = ss.buffer || "(任務完成，無文字回覆)"
    let chunkCount = 0
    if (state.streamMode === "full") {
      if (ss.messageId) {
        await editMsg(ss.chatId, ss.messageId, finalText)
      } else {
        await sendMsg(ss.chatId, finalText)
      }
      chunkCount = chunkByLength(finalText, 1024).length
    } else {
      const chunks = splitText(finalText)
      chunkCount = chunks.length

      // 第一段：編輯原有的進度訊息或發送新訊息
      if (ss.messageId) {
          await editMsg(ss.chatId, ss.messageId, chunks[0])
      } else {
          await sendMsg(ss.chatId, chunks[0])
      }

      // 後續段落：逐一發新訊息
      for (let i = 1; i < chunks.length; i++) {
          await sendMsg(ss.chatId, chunks[i])
      }
    }

    streamStates.delete(sessionId)
    await log(`stream done sid=${sessionId} totalLen=${finalText.length} chunks=${chunkCount}`)
  }

  // ─── 新增：Watchdog ───────────────────────────────────────────────────────
  // 定期檢查所有 streaming session 是否靜止過久

function startWatchdog() {
    watchdogIntervalId = setInterval(async () => {
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

function stopWatchdog() {
    if (watchdogIntervalId !== undefined) {
        clearInterval(watchdogIntervalId)
        watchdogIntervalId = undefined
    }
}

function chunkByLength(text: string, maxLen: number) {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLen))
    start += maxLen
  }
  return chunks.length ? chunks : [""]
}

// ─── 執行 Prompt ────────────────────────────────────────────────────────

  async function runPrompt(chatId: number, prompt: string, sessionId: string) {
    // ─ Busy guard：避免同一 session 同時執行兩個 prompt ─
    // 但如果 session 是被中斷的（done === true），允許繼續
    if (runningSessions.has(sessionId)) {
      const ss = streamStates.get(sessionId)
      if (ss && ss.done) {
        // 被中斷的 session，允許繼續
        await log(`busy guard: session ${sessionId} 被中斷，允許繼續`)
      } else {
        await sendMsg(chatId, [
          `⚠️ session ${sessionId} 目前正在執行中`,
          `請等待完成後再下指令，或用 /abort 中止，或用 /interrupt 中斷`,
        ].join("\n"))
        return
      }
    }

    // 防止競態條件：確保同一 session 不會同時執行多個 prompt
    if (executionQueue.has(sessionId)) {
      await log(`session ${sessionId} 已在執行隊列中，跳過重複請求`)
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
      sentLength: 0,
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
      throw err // 重新拋出錯誤讓上層處理
    }
  }

  // ─── 權限授權流程 ───────────────────────────────────────────────────────

  async function resolveApproval(id: string, decision: "deny" | "once" | "always") {
    const item = pendingApprovals.get(id)
    if (!item) return false
    clearTimeout(item.timer)
    pendingApprovals.delete(id)
    state.approvals[id] = { id, decision, createdAt: item.createdAt, resolvedAt: now() }
    pruneState();
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

    // 檢查 session 是否由 TG 發起，如果不是則不轉發到 Telegram
    if (sessionID && sessionInitiators.get(sessionID) !== "tg") {
      await log(`permission.asked: session ${sessionID} not initiated by TG, ignoring`)
      if (output) output.status = "deny"
      return
    }

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

  async function replyQuestion(requestID: string, answers: string[][]) {
    try {
      const clientAny = client as any
      await log(`question.reply try requestID=${requestID} answers=${JSON.stringify(answers)}`)
      if (typeof clientAny.question?.reply === "function") {
        await clientAny.question.reply({
          requestID,
          directory: projectRoot,
          body: { answers },
        })
      } else {
        // fallback：直接打 REST，補上 SDK client 的 auth headers
        const res = await ocFetch(`/question/${encodeURIComponent(requestID)}/reply?directory=${encodeURIComponent(projectRoot)}`, {
          method: "POST",
          headers: {
            ...getAuthHeaders(),
          },
          body: JSON.stringify({ answers }),
        })
        if (!res.ok) {
          const txt = await res.text().catch(() => "")
          throw new Error(`HTTP ${res.status}: ${txt}`)
        }
      }
      await log(`question.reply sent requestID=${requestID} answers=${JSON.stringify(answers)}`)
    } catch (err) {
      await log(`question.reply error requestID=${requestID}: ${summarizeError(err)}`)
    }
  }

  async function rejectQuestion(requestID: string) {
    try {
      const clientAny = client as any
      if (typeof clientAny.question?.reject === "function") {
        await clientAny.question.reject({ requestID })
      } else {
        const res = await ocFetch(`/question/${requestID}/reject`, { method: "POST", headers: { ...getAuthHeaders() } })
        if (!res.ok) {
          const txt = await res.text().catch(() => "")
          throw new Error(`HTTP ${res.status}: ${txt}`)
        }
      }
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

    // 檢查 session 是否由 TG 發起，如果不是則不轉發到 Telegram
    if (sessionID && sessionInitiators.get(sessionID) !== "tg") {
      await log(`question.asked: session ${sessionID} not initiated by TG, ignoring`)
      return
    }

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

    // 短 ID 先產生，供 timer 與後續使用
    const shortID = requestID.replace(/-/g, "").slice(0, 8)
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
/interrupt - 中斷目前串流（保留已輸出內容）
/continue <prompt> - 在當前對話基礎上繼續
/compaction progress on|off - 設定上下文壓縮過程是否顯示
/stream mode cover|full - 設定串流輸出模式

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
      await replyQuestion(pq.requestID, [[answer]])
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
        `compaction progress: ${state.showCompactionProgress ? "on" : "off"}`,
        `stream mode: ${state.streamMode === "full" ? "full" : "cover"}`,
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
        sessionInitiators.delete(sid) // 清理 session initiator 記錄
        await sendMsg(chatId, `⛔ 已中止 session ${sid}`)
      } catch (err) {
        await sendMsg(chatId, `abort 失敗: ${summarizeError(err).slice(0, 200)}`)
      }
      return
    }

    // /interrupt
    if (t === "/interrupt") {
      const sid = resolveSession(chatId)
      if (!sid) { await sendMsg(chatId, "沒有活躍的 session"); return }
      
      // 停止串流但保留已輸出內容
      const ss = streamStates.get(sid)
      if (ss) {
        ss.done = true // 標記為完成，防止後續串流更新
        await log(`interrupt: session ${sid} 被手動中斷`)
        await sendMsg(chatId, `⏸️ 已中斷 session ${sid} 的串流輸出`)
      } else {
        await sendMsg(chatId, `session ${sid} 沒有正在串流的內容`)
      }
      
      // 不移除 runningSessions，讓用戶可以用 /continue 繼續
      return
    }

    // /continue <prompt>
    if (t.startsWith("/continue ")) {
      const prompt = t.slice("/continue ".length).trim()
      if (!prompt) { await sendMsg(chatId, "請提供 prompt"); return }
      
      const sid = resolveSession(chatId)
      if (!sid) { await sendMsg(chatId, "沒有活躍的 session"); return }
      
      // 標記這個 session 是由 TG 發起的（如果尚未標記）
      if (!sessionInitiators.has(sid)) {
        sessionInitiators.set(sid, "tg")
      }
      
      try {
        await runPrompt(chatId, prompt, sid)
      } catch (err) {
        await log(`continue error: ${summarizeError(err)}`)
        await sendMsg(chatId, `❌ 繼續對話失敗: ${summarizeError(err).slice(0, 200)}`)
      }
      return
    }

    // /session new
    if (t === "/session new") {
      try {
        const id = await createSession()
        sessionInitiators.set(id, "tg")
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
      const info = await getSessionInfo(sid)
      const childrenCount = await getSessionChildrenCount(sid)
      const status = await getSessionStatus(sid)
      const tokenSummary = await getSessionTokenSummary(sid)
      const activeModel = state.activeModelByChat[String(chatId)] || defaultModel || undefined
      const contextLimit = await getModelContextLimit(activeModel)
      const estimatedUsedTokens = tokenSummary.latestTotalTokens ?? tokenSummary.latestPromptTokens ?? tokenSummary.totalTokens ?? 0
      const hasContextLimit = Number.isFinite(contextLimit)
      const estimatedUsage = hasContextLimit ? (estimatedUsedTokens / (contextLimit as number)) * 100 : undefined
      const estimatedRemaining = hasContextLimit ? Math.max((contextLimit as number) - estimatedUsedTokens, 0) : undefined
      const statusText = formatSessionStatus(status)

      const lines = [
        `session: ${sid}`,
        `model: ${activeModel ?? "(none)"}`,
        `title: ${info?.title ?? rec?.title ?? "(無)"}`,
        `parent: ${info?.parentID ?? rec?.parentID ?? "(無)"}`,
        `created: ${info?.time?.created ? new Date(info.time.created).toLocaleString() : rec ? new Date(rec.createdAt).toLocaleString() : "unknown"}`,
        `updated: ${info?.time?.updated ? new Date(info.time.updated).toLocaleString() : "unknown"}`,
        `status: ${statusText ?? (runningSessions.has(sid) ? "busy" : "idle")}`,
        `busy: ${runningSessions.has(sid)}`,
        `children: ${childrenCount}`,
        `summary: +${info?.summary?.additions ?? 0} / -${info?.summary?.deletions ?? 0} / files ${info?.summary?.files ?? 0}`,
        `tokens: prompt ${formatNumber(tokenSummary.promptTokens)}, completion ${formatNumber(tokenSummary.completionTokens)}, reasoning ${formatNumber(tokenSummary.reasoningTokens)}, cache(read/write) ${formatNumber(tokenSummary.cacheReadTokens)}/${formatNumber(tokenSummary.cacheWriteTokens)}, total ${formatNumber(tokenSummary.totalTokens)}`,
        `context limit: ${formatNumber(contextLimit)}`,
        `context usage: ${pct(estimatedUsage)}${estimatedUsedTokens ? ` (estimated ${formatNumber(estimatedUsedTokens)} tokens)` : ""}`,
        `context remaining: ${formatNumber(estimatedRemaining)}`,
        `note: context usage is estimated from session messages and current model limit; it is not a server-side exact value`,
      ]
      await sendMsg(chatId, lines.join("\n"))
      return
    }

    if (t.startsWith("/compaction ")) {
      const rest = t.slice("/compaction ".length).trim()
      if (!rest.startsWith("progress ")) {
        await sendMsg(chatId, "用法：/compaction progress on|off")
        return
      }
      const mode = rest.slice("progress ".length).trim().toLowerCase()
      if (!["on", "off"].includes(mode)) {
        await sendMsg(chatId, "用法：/compaction progress on|off")
        return
      }
      state.showCompactionProgress = mode === "on"
      await persist()
      await sendMsg(chatId, `✅ 壓縮過程顯示已設為 ${mode}`)
      return
    }

    if (t.startsWith("/stream mode ")) {
      const mode = t.slice("/stream mode ".length).trim().toLowerCase()
      if (![
        "cover",
        "full",
      ].includes(mode)) {
        await sendMsg(chatId, "用法：/stream mode cover|full")
        return
      }
      state.streamMode = mode as "cover" | "full"
      await persist()
      await sendMsg(chatId, `✅ 串流模式已設為 ${mode}`)
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
        sessionInitiators.set(sid, "tg")
      } catch (err) {
        await sendMsg(chatId, `無法建立 session: ${summarizeError(err).slice(0, 200)}`)
        return
      }

      // 記錄這個 session 是由 TG 發起的
      sessionInitiators.set(sid, "tg")
      
      // 等待 runPrompt 完成，避免競態條件
      try {
        await runPrompt(chatId, prompt, sid)
      } catch (err) {
        await log(`runPrompt error: ${summarizeError(err)}`)
        await sendMsg(chatId, `❌ 執行過程中發生錯誤: ${summarizeError(err).slice(0, 200)}`)
      }
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
          await replyQuestion(pq.requestID, [[answer]])
          // 觸發 TUI 重新渲染，讓問題選單立即消失，不需要手動點擊
          try {
            const clientAny = client as any
            if (typeof clientAny.tui?.toast?.show === "function") {
              await clientAny.tui.toast.show({ body: { message: `已選擇: ${answer}` } }).catch(() => undefined)
            } else if (typeof clientAny.event?.send === "function") {
              await clientAny.event.send({
                body: { type: "tui.toast.show", properties: { message: `已選擇: ${answer}` } },
              }).catch(() => undefined)
            }
          } catch { /* TUI toast 是非必要的，失敗不影響主流程 */ }
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
  await log(`ocFetch baseURL=${_clientBaseUrl}`)

  void registerTelegramCommands()

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
            state.sessions.push({ id: sid, title: info?.title, createdAt: now(), parentID, initiatedBy: sessionInitiators.get(sid) ?? undefined })
            pruneState();
            if (parentID) {
                await log(`subagent session detected: ${sid} (parent: ${parentID})`)
                // 若 parent 在 running，subagent 也可能需要處理 question/permission
                // 這裡只記錄，實際 event 會透過同一個 event hook 收到
            }
        }
          const currentRec = state.sessions.find(s => s.id === sid)
          if (currentRec) currentRec.initiatedBy ??= sessionInitiators.get(sid) ?? currentRec.initiatedBy
          // 如果 session 不是由 TG 發起的，記錄為 computer 發起
          if (!sessionInitiators.has(sid)) {
            sessionInitiators.set(sid, "computer")
            await log(`session ${sid} marked as initiated by computer`)
          }
          if (info?.time?.compacting && isTGInitiatedSession(sid)) {
            await notifyCompactionStart(sid).catch(err => log(`notifyCompactionStart error sid=${sid}: ${summarizeError(err)}`))
          }
          await persist()
        }
      }

      if (event?.type === "session.compacted") {
        const sid = (event as any)?.properties?.sessionID
        if (sid) {
          await notifyCompactionEnd(sid).catch(err => log(`notifyCompactionEnd error sid=${sid}: ${summarizeError(err)}`))
          compactionTrackers.delete(sid)
          await persist()
        }
      }

      if (event?.type === "session.status") {
        const sid = (event as any)?.properties?.sessionID
        const status = (event as any)?.properties?.status
        if (sid && status?.type === "busy") {
          await log(`session.status sid=${sid} busy`)
        }
      }

      // session.idle: 任務完成
      if (event?.type === "session.idle") {
        const sid = (event as any)?.properties?.sessionID ?? (event as any)?.properties?.id
        if (sid) {
          runningSessions.delete(sid)  // 確保 busy guard 解除
          compactionTrackers.delete(sid)

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

      if (event?.type === "message.updated") {
        const props = (event as any)?.properties ?? {}
        const sessionID = props?.sessionID
        const info = props?.info
        if (sessionID && info?.role === "assistant") {
          const tokens = info?.tokens ?? estimateTokensFromMessage(props)
          if (tokens) {
            addUsageFromTokens(sessionID, info.role, tokens)
            setLatestTokens(getSessionUsage(sessionID), tokens)
          }
          await persist()
        }
      }

      // session.error: 任務失敗
      if (event?.type === "session.error") {
        const sid = (event as any)?.properties?.sessionID
        const err = (event as any)?.properties?.error
        await log(`session.error sid=${sid}: ${summarizeError(err)}`)
        if (sid) runningSessions.delete(sid)
        if (sid) compactionTrackers.delete(sid)
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
