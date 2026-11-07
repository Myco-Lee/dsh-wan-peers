/**
 * dsh-wan-peers — 跨互联网的 DSH 节点发现与消息互发。
 *
 * 与 dsh-lan-peers（UDP 广播、同一子网）完全独立：本插件不依赖任何局域网能力，
 * 两台互不相干的机器、只要都能访问互联网，就能通过一个公共"会合频道"互相看见。
 *
 * 发现方式：
 *   双方各自向同一个 ntfy 兼容的 pub/sub 端点（默认 https://ntfy.sh）订阅同一个
 *   房间号（topic），把 announce 与消息加密后发布到该 topic。这是纯出站 HTTPS，
 *   不需要公网 IP、端口映射、账号或 VPN。
 *
 * 安全：
 *   - payload 用 room + secret 派生出的 AES-256-GCM 密钥加密（scrypt 派生）；
 *   - 房间号同时充当不可猜的频道名，口令是真正的密钥；
 *   - 公共端点只能看到密文，读不懂内容、也伪造不出合法消息（GCM 认证会失败）。
 *
 * 工具：wan_room / wan_peers / wan_send / wan_inbox / wan_ping
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-wan-peers'

const VERSION = '0.1.0'

/**
 * apply 早期就写一条诊断日志，宿主只把插件错误打到 stderr 时也能在磁盘上看到进度。
 * 不依赖 tools 服务，也不依赖配置是否合法。
 */
function bootLine(_settings, message) {
  try {
    const home = process.env.DSH_WAN_PEERS_HOME || path.join(os.homedir(), '.dsh', 'wan-peers')
    fs.mkdirSync(home, { recursive: true })
    fs.appendFileSync(path.join(home, 'boot.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    /* 诊断日志失败不影响插件 */
  }
}

/** 工具返回值统一的开放对象 schema（harness 只接受 JSON Schema 子集）。 */
const VALUE_SCHEMA = { type: 'object', additionalProperties: true }

/** 把返回值渲染成给模型看的一段文本：优先 message，否则整段 JSON。 */
function renderToolValue(_args, value) {
  return [{ type: 'text', text: typeof value?.message === 'string' ? value.message : JSON.stringify(value) }]
}

const DEFAULTS = {
  /** 会合服务基址，任意 ntfy 兼容端点（自建 ntfy 也可以）。 */
  service: 'https://ntfy.sh',
  /** 房间号（topic）。两台机器填同一个才会互相看见。 */
  room: '',
  /** 配对口令，用于派生加密密钥。两台机器必须一致。 */
  secret: '',
  /** 本节点展示名，留空则用主机名。 */
  name: '',
  /** 接收方式：stream = 长连接订阅（默认，省请求配额）；poll = 定时拉取。 */
  mode: 'stream',
  /** 拉取间隔（毫秒）。poll 模式用它，stream 模式只作为断线兜底。 */
  pollMs: 5000,
  /** 心跳宣告间隔（毫秒）。0 = 只在启动/收到新对端/手动 wan_ping 时宣告（省消息配额）。 */
  announceMs: 0,
  /** 多久没收到对端宣告就算离线（毫秒）。 */
  ttlMs: 60000,
  /** 单条文本上限（字符）。 */
  maxTextChars: 2000,
  /** 单条文本上限（UTF-8 字节）。公共 ntfy 单条上限 4096 字节，密文 base64 会膨胀。 */
  maxTextBytes: 2600,
  /** 收件箱最大保留条数。 */
  maxInbox: 500,
}

const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/
const STATE_VERSION = 1

// ---------------------------------------------------------------- 基础工具

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function resolveHome() {
  if (process.env.DSH_WAN_PEERS_HOME) return process.env.DSH_WAN_PEERS_HOME
  return path.join(os.homedir(), '.dsh', 'wan-peers')
}

function pairingPath(home) {
  return path.join(home, 'pairing.json')
}

function readPairing(home) {
  const data = readJson(pairingPath(home), null)
  if (!data || typeof data.room !== 'string' || typeof data.secret !== 'string') return null
  return data
}

function writePairing(home, data) {
  try {
    ensureDir(home)
    writeJson(pairingPath(home), {
      v: 1,
      room: data.room,
      secret: data.secret,
      service: data.service,
      updatedAt: nowIso(),
    })
  } catch {
    /* persistence failure must not break the live hub */
  }
}

function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const settings = {}

  settings.service = String(cfg.service || DEFAULTS.service).trim().replace(/\/+$/u, '')
  if (!/^https?:\/\/[^\s]+$/u.test(settings.service)) {
    throw new Error(`dsh-wan-peers: service 必须是 http(s) 地址，收到 "${settings.service}"`)
  }
  settings.room = String(cfg.room || '').trim()
  settings.secret = String(cfg.secret || '').trim()
  settings.configured = settings.room.length > 0 && settings.secret.length > 0
  if (settings.room.length > 0 && !ROOM_RE.test(settings.room)) {
    throw new Error(
      `dsh-wan-peers: room 只能包含字母/数字/下划线/连字符，长度 4-64，收到 "${settings.room}"`,
    )
  }
  if (settings.configured && settings.secret.length < 8) {
    throw new Error('dsh-wan-peers: secret 至少 8 个字符（它决定加密强度）')
  }
  settings.name = String(cfg.name || '').trim() || os.hostname()
  settings.home = String(cfg.home || '').trim() || resolveHome()
  settings.mode = String(cfg.mode || DEFAULTS.mode).toLowerCase() === 'poll' ? 'poll' : 'stream'
  settings.pollMs = Math.max(2000, Number(cfg.pollMs) || DEFAULTS.pollMs)
  settings.announceMs = Math.max(0, Number(cfg.announceMs ?? DEFAULTS.announceMs) || 0)
  settings.ttlMs = Math.max(15000, Number(cfg.ttlMs) || DEFAULTS.ttlMs)
  settings.maxTextChars = Math.max(64, Number(cfg.maxTextChars) || DEFAULTS.maxTextChars)
  settings.maxTextBytes = Math.max(256, Number(cfg.maxTextBytes) || DEFAULTS.maxTextBytes)
  settings.maxInbox = Math.max(10, Number(cfg.maxInbox) || DEFAULTS.maxInbox)
  return settings
}

// ---------------------------------------------------------------- 加解密

/** 按 UTF-8 字节截断（不切开多字节字符），并在截断时补一个省略号。 */
function truncateBytes(text, maxBytes) {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let out = ''
  let used = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes - 3) break
    out += char
    used += size
  }
  return `${out}…`
}

function deriveKey(room, secret) {
  return crypto.scryptSync(secret, `dsh-wan-peers|${room}`, 32)
}

function seal(key, room, payload) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(room, 'utf8'))
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

function unseal(key, room, blob) {
  try {
    const raw = Buffer.from(String(blob).trim(), 'base64url')
    if (raw.length < 12 + 16 + 2) return null
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const body = raw.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(room, 'utf8'))
    decipher.setAuthTag(tag)
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- HTTP

function requestText(url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  const payload = body === undefined ? null : Buffer.from(String(body), 'utf8')
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          'user-agent': `dsh-wan-peers/${VERSION}`,
          ...(payload ? { 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(text)
          else reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
        })
        response.on('error', reject)
      },
    )
    request.setTimeout(timeoutMs, () => request.destroy(new Error('request timeout')))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

// ---------------------------------------------------------------- hub

/**
 * 打开一个 NDJSON 事件流（ntfy 的 /json 不传 poll 参数时就是长连接订阅）。
 * 返回的句柄可以 close()；回调只会各自触发一次结束。
 */
function openEventStream(url, handlers) {
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  let settled = false
  let closed = false
  const settle = (error) => {
    if (settled) return
    settled = true
    handlers.onEnd?.(error)
  }
  const request = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        'user-agent': `dsh-wan-peers/${VERSION}`,
        accept: 'application/x-ndjson, application/json',
        'keep-alive': '115',
      },
    },
    (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        settle(new Error(`HTTP ${response.statusCode}`))
        return
      }
      handlers.onOpen?.()
      response.setEncoding('utf8')
      let buffer = ''
      response.on('data', (chunk) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          if (line.trim()) {
            try {
              handlers.onLine?.(line)
            } catch {
              /* 单行失败不影响整条流 */
            }
          }
          index = buffer.indexOf('\n')
        }
      })
      response.on('end', () => settle(new Error('stream ended')))
      response.on('error', (error) => settle(error))
    },
  )
  request.setTimeout(0)
  request.on('error', (error) => settle(error))
  request.end()
  return {
    close() {
      closed = true
      request.destroy()
    },
    get closed() {
      return closed
    },
  }
}

/**
 * 创建一个发现/消息 hub。测试里可以直接起两个 hub（不同 home）互测，
 * 不必真的跨机器。
 */
export function createHub(rawSettings, options = {}) {
  const label = options.label ?? 'hub'
  // 允许直接传入未解析的配置（测试/脚本里常见），resolveConfig 是幂等的。
  let settings = resolveConfig(rawSettings)
  const home = options.home ?? settings.home ?? resolveHome()
  settings.home = home

  const stateFile = path.join(home, 'state.json')
  const inboxFile = path.join(home, 'inbox.jsonl')
  const logPath = path.join(home, 'wan-peers.log')

  ensureDir(home)

  const log = (...parts) => {
    const line = `[${nowIso()}] ${parts.join(' ')}`
    try {
      fs.appendFileSync(logPath, `${line}\n`, 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
    if (options.verbose) console.log(`[${label}] ${line}`)
  }

  // 身份：首次运行生成并持久化，之后固定
  const identityFile = path.join(home, 'identity.json')
  let identity = readJson(identityFile, null)
  if (!identity || typeof identity.id !== 'string' || identity.id.length < 8) {
    identity = { id: crypto.randomUUID(), createdAt: nowIso() }
    writeJson(identityFile, identity)
  }

  let key = settings.configured ? deriveKey(settings.room, settings.secret) : null

  /** peers: id -> { id, name, firstSeen, lastSeen } */
  const peers = new Map()
  /** inbox: [{ id, from, fromName, text, at, receivedAt, read }] */
  let inbox = []
  /** 已经处理过的远端消息 id，防重复。 */
  const seenMessages = new Set()
  const seenOrder = []

  const state = {
    cursor: null, // 上次拉取到的 unix 秒
    lastPollAt: null,
    lastAnnounceAt: null,
    lastError: null,
    startedAt: null,
    polls: 0,
    /** 被公共中继限流后，暂停拉取到此时间点（ms epoch）。 */
    backoffUntil: 0,
    /** 当前退避间隔（ms），成功一次就归零。 */
    backoffMs: 0,
  }

  let pollTimer = null
  let announceTimer = null
  let polling = false
  let stopped = true
  let streamHandle = null
  let streamRetryTimer = null
  let streamRetry = 0

  // ---- 限流退避（公共 ntfy 免费额度很容易 429）

  function isRateLimited(error) {
    return /\b429\b/.test(String(error?.message ?? ''))
  }

  function enterBackoff(scope) {
    state.backoffMs = state.backoffMs === 0 ? 15000 : Math.min(state.backoffMs * 2, 300000)
    state.backoffUntil = Date.now() + state.backoffMs
    state.lastError = `${scope}: rate limited, pause ${Math.round(state.backoffMs / 1000)}s`
    log(state.lastError)
  }

  function clearBackoff() {
    state.backoffMs = 0
    state.backoffUntil = 0
  }

  function inBackoff() {
    return Date.now() < state.backoffUntil
  }

  // ---- 持久化

  function loadInbox() {
    try {
      const text = fs.readFileSync(inboxFile, 'utf8')
      const rows = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          rows.push(JSON.parse(line))
        } catch {
          /* 跳过坏行 */
        }
      }
      inbox = rows.slice(-settings.maxInbox)
    } catch {
      inbox = []
    }
  }

  function saveInbox() {
    try {
      const body = inbox.map((row) => JSON.stringify(row)).join('\n')
      fs.writeFileSync(inboxFile, inbox.length > 0 ? `${body}\n` : '', 'utf8')
    } catch (error) {
      log(`inbox write failed: ${error.message}`)
    }
  }

  function saveState() {
    writeJson(stateFile, {
      v: STATE_VERSION,
      self: identity.id,
      name: settings.name,
      room: settings.room,
      service: settings.service,
      updatedAt: nowIso(),
      peers: [...peers.values()],
      counters: { polls: state.polls, lastPollAt: state.lastPollAt, lastAnnounceAt: state.lastAnnounceAt },
      lastError: state.lastError,
    })
  }

  loadInbox()

  // ---- 对端

  function isOnline(peer) {
    return Date.now() - Date.parse(peer.lastSeen) < settings.ttlMs
  }

  function touchPeer(id, peerName) {
    if (!id) return { peer: null, isNew: false }
    const existing = peers.get(id)
    const stamp = nowIso()
    if (existing) {
      existing.lastSeen = stamp
      if (peerName) existing.name = peerName
      return { peer: existing, isNew: false }
    }
    const created = { id, name: peerName || id.slice(0, 8), firstSeen: stamp, lastSeen: stamp }
    peers.set(id, created)
    return { peer: created, isNew: true }
  }

  function rememberMessage(messageId) {
    if (!messageId) return true
    if (seenMessages.has(messageId)) return false
    seenMessages.add(messageId)
    seenOrder.push(messageId)
    if (seenOrder.length > 1000) {
      const dropped = seenOrder.shift()
      seenMessages.delete(dropped)
    }
    return true
  }

  // ---- 网络

  async function publish(payload) {
    if (!settings.configured || key === null) throw new Error('not configured')
    const envelope = seal(key, settings.room, payload)
    const url = `${settings.service}/${encodeURIComponent(settings.room)}`
    await requestText(url, {
      method: 'POST',
      body: envelope,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-title': 'dsh-wan-peers' },
    })
  }

  async function announce(options = {}) {
    if (!settings.configured) return null
    if (!options.force && inBackoff()) return null
    const payload = {
      v: 1,
      kind: 'announce',
      id: identity.id,
      name: settings.name,
      version: VERSION,
      ts: nowIso(),
    }
    try {
      await publish(payload)
      state.lastAnnounceAt = nowIso()
      state.lastError = null
      return payload
    } catch (error) {
      if (isRateLimited(error)) enterBackoff('announce')
      else state.lastError = `announce: ${error.message}`
      log(`announce failed: ${error.message}`)
      return null
    }
  }

  function handleEnvelope(blob) {
    const payload = unseal(key, settings.room, blob)
    if (!payload || payload.v !== 1) return false
    if (payload.id === identity.id) return false

    if (payload.kind === 'announce') {
      const { isNew } = touchPeer(payload.id, payload.name)
      if (isNew) {
        log(`discovered peer ${payload.name} (${String(payload.id).slice(0, 8)})`)
        // 立刻回一个心跳，让对方也能马上看到自己（节流到 5s）
        const last = state.lastAnnounceAt ? Date.parse(state.lastAnnounceAt) : 0
        if (Date.now() - last > 5000) void announce()
      }
      saveState()
      return true
    }

    if (payload.kind === 'message') {
      const to = String(payload.to || '*')
      if (to !== '*' && to !== identity.id) return true
      const { peer } = touchPeer(payload.id, payload.name)
      const row = {
        id: crypto.randomUUID(),
        from: peer?.id ?? payload.id,
        fromName: peer?.name ?? payload.name ?? 'unknown',
        text: truncateBytes(payload.text ?? '', settings.maxTextBytes),
        at: payload.ts || nowIso(),
        receivedAt: nowIso(),
        read: false,
      }
      inbox.push(row)
      if (inbox.length > settings.maxInbox) inbox = inbox.slice(-settings.maxInbox)
      saveInbox()
      saveState()
      log(`message from ${row.fromName}: ${row.text.slice(0, 60)}`)
      return true
    }

    return true
  }

  async function pollOnce(options = {}) {
    // 显式调用（工具 wan_ping、测试）允许在 start 之前跑，只要配置齐全。
    if (!settings.configured || key === null) return { accepted: 0 }
    if (inBackoff() && options.force !== true) return { accepted: 0, skipped: 'backoff' }
    const since = state.cursor === null ? Math.floor(Date.now() / 1000) - 120 : state.cursor
    const url = `${settings.service}/${encodeURIComponent(settings.room)}/json?poll=1&since=${since}`
    let accepted = 0
    try {
      const text = await requestText(url)
      state.polls += 1
      state.lastPollAt = nowIso()
      state.lastError = null
      let maxTime = null
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.event !== 'message' || typeof event.message !== 'string') continue
        const eventTime = Number(event.time)
        if (Number.isFinite(eventTime) && (maxTime === null || eventTime > maxTime)) maxTime = eventTime
        if (!rememberMessage(event.id)) continue
        if (handleEnvelope(event.message)) accepted += 1
      }
      if (maxTime !== null) state.cursor = maxTime
      else if (state.cursor === null) state.cursor = Math.floor(Date.now() / 1000)
      clearBackoff()
      saveState()
      return { accepted }
    } catch (error) {
      if (isRateLimited(error)) enterBackoff('poll')
      else state.lastError = `poll: ${error.message}`
      log(`poll failed: ${error.message}`)
      saveState()
      return { accepted: 0, error: error.message }
    }
  }

  async function pollLoop() {
    if (polling || stopped) return
    polling = true
    try {
      await pollOnce()
    } finally {
      polling = false
    }
  }

  // ---- 事件流（默认接收方式：一条长连接，不消耗请求配额）

  function startStreamLoop() {
    if (stopped || !settings.configured) return
    const since = state.cursor === null ? Math.floor(Date.now() / 1000) - 120 : state.cursor
    const url = `${settings.service}/${encodeURIComponent(settings.room)}/json?since=${since}`
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      streamHandle = null
      if (stopped) return
      if (error) {
        if (isRateLimited(error)) enterBackoff('stream')
        else state.lastError = `stream: ${error.message}`
        log(`stream closed: ${error.message}`)
        saveState()
      }
      const wait = inBackoff() ? Math.min(state.backoffMs, 60000) : Math.min(30000, 1500 * 2 ** Math.min(streamRetry, 4))
      streamRetry = Math.min(streamRetry + 1, 6)
      streamRetryTimer = setTimeout(() => {
        streamRetryTimer = null
        if (!stopped) startStreamLoop()
      }, wait)
      streamRetryTimer.unref?.()
    }

    try {
      streamHandle = openEventStream(url, {
        onOpen: () => {
          streamRetry = 0
          clearBackoff()
          state.lastPollAt = nowIso()
          log('stream connected')
          saveState()
        },
        onLine: (line) => {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            return
          }
          if (event.event === 'keepalive') {
            state.lastPollAt = nowIso()
            return
          }
          if (event.event !== 'message' || typeof event.message !== 'string') return
          const eventTime = Number(event.time)
          if (Number.isFinite(eventTime) && (state.cursor === null || eventTime > state.cursor)) {
            state.cursor = eventTime
          }
          state.lastPollAt = nowIso()
          if (!rememberMessage(event.id)) return
          handleEnvelope(event.message)
          saveState()
        },
        onEnd: (error) => finish(error),
      })
    } catch (error) {
      finish(error)
    }
  }

  // ---- 生命周期

  function start() {
    if (!stopped) return
    stopped = false
    state.startedAt = nowIso()
    if (!settings.configured) {
      log('not configured: set room + secret in the profile cordis.patch.yml')
      return
    }
    const mode = settings.mode
    log(
      `started: room=${settings.room} service=${settings.service} mode=${mode} poll=${settings.pollMs}ms announce=${settings.announceMs}ms`,
    )
    if (mode === 'stream') {
      startStreamLoop()
      // 流模式下的兜底拉取：只在连接断开重连的空档里用，频率远低于 poll 模式
      pollTimer = setInterval(() => {
        if (!streamHandle) void pollLoop()
      }, Math.max(settings.pollMs, 60000))
    } else {
      void pollLoop()
      pollTimer = setInterval(() => void pollLoop(), settings.pollMs)
    }
    pollTimer.unref?.()
    if (settings.announceMs > 0) {
      void announce()
      announceTimer = setInterval(() => void announce(), settings.announceMs)
      announceTimer.unref?.()
    } else {
      // 关掉定时心跳时，启动仍然广播一次，否则对端永远无从发现自己
      void announce()
    }
    saveState()
  }

  function stop() {
    if (stopped) return
    stopped = true
    if (pollTimer) clearInterval(pollTimer)
    if (announceTimer) clearInterval(announceTimer)
    pollTimer = null
    announceTimer = null
    if (streamHandle) {
      streamHandle.close()
      streamHandle = null
    }
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer)
      streamRetryTimer = null
    }
    log('stopped')
  }

  // ---- 对外查询

  /** 换房间/口令后立即生效：停旧连接、重算密钥、用新配置重启。 */
  function reconfigure(patch = {}) {
    stop()
    settings = resolveConfig({ ...settings, ...patch })
    key = settings.configured ? deriveKey(settings.room, settings.secret) : null
    start()
    return snapshot()
  }

  /** Pairing code: one string carrying service + room + secret + name. */
  function pairingCode() {
    if (!settings.configured) throw new Error('room/secret not configured yet')
    const payload = {
      v: 1,
      service: settings.service,
      room: settings.room,
      secret: settings.secret,
      name: settings.name,
    }
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  }

  /** Import a pairing code: persist it and reconfigure the live hub immediately. */
  function importPairing(code) {
    let parsed
    try {
      parsed = JSON.parse(Buffer.from(String(code ?? '').trim(), 'base64url').toString('utf8'))
    } catch {
      throw new Error('pairing code is not valid base64url JSON')
    }
    if (parsed?.v !== 1 || typeof parsed.room !== 'string' || typeof parsed.secret !== 'string') {
      throw new Error('pairing code payload is invalid')
    }
    writePairing(home, parsed)
    return reconfigure({ service: parsed.service ?? settings.service, room: parsed.room, secret: parsed.secret })
  }

  function listPeers() {
    return [...peers.values()]
      .map((peer) => ({ ...peer, online: isOnline(peer) }))
      .sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)))
  }

  function resolvePeer(query) {
    const needle = String(query ?? '').trim()
    if (!needle) return null
    const all = [...peers.values()]
    const lower = needle.toLowerCase()
    return (
      all.find((peer) => peer.id === needle) ??
      all.find((peer) => String(peer.name).toLowerCase() === lower) ??
      all.find((peer) => peer.id.toLowerCase().startsWith(lower)) ??
      all.find((peer) => String(peer.name).toLowerCase().includes(lower)) ??
      null
    )
  }

  function peersMessage() {
    if (!settings.configured) {
      return '未配置：在 profile 的 cordis.patch.yml 里给 dsh-wan-peers 设置 room 与 secret（两台机器填同一组）'
    }
    const all = listPeers()
    if (all.length === 0) {
      return `房间 ${settings.room} 内还没有其他节点（本机 ${settings.name}，服务 ${settings.service}）`
    }
    return all
      .map((peer) => `${peer.name} ${String(peer.id).slice(0, 8)} ${peer.online ? 'online' : 'offline'}`)
      .join('\n')
  }

  function snapshot() {
    const all = listPeers()
    return {
      configured: settings.configured,
      room: settings.room,
      service: settings.service,
      self: { id: identity.id, name: settings.name },
      peers: all,
      online: all.filter((peer) => peer.online).length,
      unread: inbox.filter((row) => !row.read).length,
      inbox: inbox.length,
      lastPollAt: state.lastPollAt,
      lastAnnounceAt: state.lastAnnounceAt,
      lastError: state.lastError,
      backoffUntil: state.backoffUntil || 0,
      backoffMs: state.backoffMs || 0,
      startedAt: state.startedAt,
    }
  }

  return {
    settings,
    home,
    self: identity,
    start,
    stop,
    reconfigure,
    pairingCode,
    importPairing,
    announce,
    pollOnce,
    publish,
    noteRateLimit: (scope) => enterBackoff(scope),
    listPeers,
    resolvePeer,
    peersMessage,
    snapshot,
    getInbox: () => inbox,
    markRead: (ids) => {
      const wanted = new Set(ids)
      let changed = 0
      for (const row of inbox) {
        if (!row.read && (wanted.size === 0 || wanted.has(row.id))) {
          row.read = true
          changed += 1
        }
      }
      if (changed) saveInbox()
      return changed
    },
  }
}

// ---------------------------------------------------------------- 插件入口

/** 每个插件上下文一个 hub（同一 ctx 重复 apply 时先停旧的，仅用于防御）。 */
const hubs = new WeakMap()

export function apply(ctx, config = {}) {
  let settings
  try {
    const raw = { ...(config && typeof config === 'object' ? config : {}) }
    settings = resolveConfig(raw)
    if (!settings.configured) {
      const saved = readPairing(settings.home)
      if (saved) {
        bootLine(settings, 'using persisted pairing file')
        settings = resolveConfig({
          ...raw,
          service: raw.service ?? saved.service,
          room: saved.room,
          secret: saved.secret,
        })
      }
    }
  } catch (error) {
    bootLine(config, `apply rejected: ${String(error?.message ?? error)}`)
    ctx.logger?.error?.(String(error?.message ?? error))
    return
  }

  const previous = hubs.get(ctx)
  if (previous) {
    try {
      previous.stop()
    } catch {
      /* 忽略旧实例停止失败 */
    }
    hubs.delete(ctx)
  }

  const hub = createHub(settings, { home: settings.home })
  hubs.set(ctx, hub)
  try {
    hub.start()
    bootLine(settings, `hub started room=${settings.room || '-'} mode=${settings.mode} announce=${settings.announceMs}ms`)
  } catch (error) {
    bootLine(settings, `hub start failed: ${String(error?.message ?? error)}`)
    throw error
  }

  attachTools(ctx, hub, settings)

  const dispose = () => {
    hub.stop()
    if (hubs.get(ctx) === hub) hubs.delete(ctx)
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)

  bootLine(settings, 'apply end')
}

/**
 * 工具层在部分宿主上要等依赖就绪才出现，所以注册必须是「尽力而为」：
 * 立刻试 → 走 ctx.inject 等依赖 → 再按秒重试，任何一个成功即可。
 */
function attachTools(ctx, hub, settings) {
  let registered = false
  const define = (toolCtx) => {
    if (registered) return true
    let tools
    try {
      tools = toolCtx?.tools
    } catch {
      return false
    }
    if (!tools || typeof tools.register !== 'function') return false
    try {
      const toolNames = defineHubTools(toolCtx, hub)
      registered = true
      bootLine(settings, `tools registered: ${toolNames.length} -> ${toolNames.join(', ')}`)
      return true
    } catch (error) {
      bootLine(settings, `tool registration failed: ${String(error?.message ?? error)}`)
      return false
    }
  }
  if (define(ctx)) return
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (toolCtx) => define(toolCtx))
    } catch (error) {
      bootLine(settings, `ctx.inject failed: ${String(error?.message ?? error)}`)
    }
  }
  let tries = 0
  const timer = setInterval(() => {
    tries += 1
    const done = define(ctx)
    if (done || tries >= 15) {
      clearInterval(timer)
      if (!done) bootLine(settings, 'tools never became available')
    }
  }, 1000)
  timer.unref?.()
}

/** 六个工具的定义；只有 tools 服务可用时才调用。返回注册成功的工具名。 */
function defineHubTools(toolCtx, hub) {
  {
    const toolNames = []
    const register = (definition) => {
      toolCtx.tools.register(definition)
      toolNames.push(definition.name)
    }

    register({
      name: 'wan_room',
      description:
        '显示当前跨互联网发现房间的状态：房间号、会合服务、本机 id/名字、已发现对端数与在线数、上次同步时间。用于确认两台机器是否配对在同一房间。',
      parameters: {},
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute() {
        const snap = hub.snapshot()
        if (!snap.configured) {
          return {
            ok: false,
            message:
              '未配置：在 profile 的 cordis.patch.yml 里给 dsh-wan-peers 加 config: { room: <房间号>, secret: <口令> }，两台机器填同一组后重启即可互相发现。',
          }
        }
        const lines = [
          `房间 ${snap.room} @ ${snap.service}`,
          `本机 ${snap.self.name} (${String(snap.self.id).slice(0, 8)})`,
          `对端 ${snap.peers.length} 个，在线 ${snap.online} 个，未读 ${snap.unread} 条`,
          `上次拉取 ${snap.lastPollAt ?? 'never'}，上次心跳 ${snap.lastAnnounceAt ?? 'never'}`,
        ]
        if (snap.lastError) lines.push(`最近错误 ${snap.lastError}`)
        return { ok: true, message: lines.join('\n'), ...snap }
      },
    })

    register({
      name: 'wan_pair',
      description:
        'Pair over the internet: action=show returns a one-line pairing code to hand to the other machine, ' +
        'action=import (with code) applies it immediately without a restart, action=reset clears the saved pairing.',
      parameters: {
        action: { type: 'string', enum: ['show', 'import', 'reset'], description: 'show | import | reset' },
        code: { type: 'string', description: 'pairing code produced by action=show on the other machine' },
      },
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute(args) {
        const action = String(args?.action ?? 'show').toLowerCase()
        if (action === 'show') {
          try {
            const code = hub.pairingCode()
            const snap = hub.snapshot()
            return {
              ok: true,
              code,
              room: snap.room,
              service: snap.service,
              name: snap.self.name,
              message: '配对码（对方执行 wan_pair action=import code=<配对码> 即可，无需重启）：' + String.fromCharCode(10) + code,
            }
          } catch (error) {
            return { ok: false, message: '生成配对码失败：' + error.message }
          }
        }
        if (action === 'import') {
          try {
            const snap = hub.importPairing(args?.code)
            return {
              ok: true,
              ...snap,
              message: '已导入配对并立即生效：房间 ' + snap.room + ' @ ' + snap.service + '。用 wan_peers 看对端是否出现。',
            }
          } catch (error) {
            return { ok: false, message: '导入配对码失败：' + error.message }
          }
        }
        if (action === 'reset') {
          try {
            const target = path.join(hub.home, 'pairing.json')
            try {
              fs.unlinkSync(target)
            } catch {
              /* already gone */
            }
            hub.reconfigure({ room: '', secret: '' })
            return { ok: true, message: '已清除本机配对，房间/口令回到未配置状态。' }
          } catch (error) {
            return { ok: false, message: '清除配对失败：' + error.message }
          }
        }
        return { ok: false, message: 'action 只能是 show / import / reset' }
      },
    })

    register({
      name: 'wan_peers',
      description:
        '列出跨互联网房间内已发现的 DSH 对端（名字、id 前缀、在线/离线）。只看到本机时说明对方还没开始监听或房间/口令不一致。',
      parameters: {},
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute() {
        const all = hub.listPeers()
        return { ok: true, peers: all, online: all.filter((peer) => peer.online).length, message: hub.peersMessage() }
      },
    })

    register({
      name: 'wan_send',
      description:
        '给房间内某个对端发一条文本消息（端到端加密后经会合服务转发）。peer 支持 id、名字或名字片段；对端用 wan_inbox 收取。',
      parameters: {
        peer: { type: 'string', description: '对端 id、名字或名字片段' },
        text: { type: 'string', description: '要发送的文本内容' },
      },
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute(args) {
        if (!hub.settings.configured) {
          return { ok: false, message: '未配置 room/secret，无法跨互联网发送。' }
        }
        const target = hub.resolvePeer(args?.peer)
        if (!target) {
          return { ok: false, message: `找不到对端 "${args?.peer ?? ''}"。${hub.peersMessage()}` }
        }
        const text = truncateBytes(String(args?.text ?? '').trimEnd(), hub.settings.maxTextBytes)
        if (!text.trim()) return { ok: false, message: '消息内容为空。' }
        try {
          await hub.publish({
            v: 1,
            kind: 'message',
            id: hub.self.id,
            name: hub.settings.name,
            to: target.id,
            text,
            ts: nowIso(),
          })
          return {
            ok: true,
            peer: target.id,
            peerName: target.name,
            text,
            message: `已发送给 ${target.name}（${String(target.id).slice(0, 8)}）：${text}`,
          }
        } catch (error) {
          if (/\b429\b/.test(String(error?.message ?? ''))) hub.noteRateLimit('send')
          return { ok: false, message: `发送失败：${error.message}` }
        }
      },
    })

    register({
      name: 'wan_inbox',
      description:
        '读取跨互联网房间收到的消息（按时间顺序，默认标记已读）。默认返回最近 20 条。',
      parameters: {
        limit: { type: 'number', description: '最多读取多少条，默认 20' },
        mark_read: { type: 'boolean', description: '是否标记为已读，默认 true' },
      },
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute(args) {
        const limit = Math.max(1, Math.min(200, Number(args?.limit) || 20))
        const markRead = args?.mark_read !== false
        const rows = hub.getInbox()
        const unread = rows.filter((row) => !row.read)
        const picked = (unread.length > 0 ? unread : rows).slice(-limit)
        if (markRead) hub.markRead(picked.map((row) => row.id))
        const message =
          picked.length === 0
            ? '收件箱为空。'
            : picked.map((row) => `[${row.read ? 'read' : 'unread'}] ${row.fromName}: ${row.text}`).join('\n')
        return { ok: true, messages: picked, unread: hub.getInbox().filter((row) => !row.read).length, message }
      },
    })

    register({
      name: 'wan_ping',
      description: '立刻向房间广播一次心跳，并马上拉取一次消息，用于加速跨互联网发现（新节点上线后调用一次）。',
      parameters: {},
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute() {
        if (!hub.settings.configured) {
          return { ok: false, message: '未配置 room/secret，无法广播。' }
        }
        const sent = await hub.announce({ force: true })
        const polled = await hub.pollOnce({ force: true })
        const all = hub.listPeers()
        return {
          ok: sent !== null,
          announced: sent !== null,
          accepted: polled.accepted,
          peers: all,
          online: all.filter((peer) => peer.online).length,
          message: sent
            ? `已广播并拉取 ${polled.accepted} 条新事件。${hub.peersMessage()}`
            : `广播失败：${hub.snapshot().lastError ?? 'unknown'}`,
        }
      },
    })

    return toolNames
  }
}

export default { name, apply }
