/**
 * 最小 ntfy 兼容会合服务，只实现 dsh-wan-peers 用到的两条路径：
 *   POST /<topic>                         发布（body 就是消息体）
 *   GET  /<topic>/json?poll=1&since=<sec> 拉取（NDJSON，一行一条 event）
 *   GET  /<topic>/json?since=<sec>        订阅（长连接，持续推送新消息）
 * 仅供测试使用。
 */
import http from 'node:http'
import crypto from 'node:crypto'

export function startMockNtfy(port = 0) {
  /** topic -> [{ id, time, event, topic, message }] */
  const rooms = new Map()
  /** topic -> Set<response> */
  const subscribers = new Map()

  const pushToSubscribers = (topic, event) => {
    const listeners = subscribers.get(topic)
    if (!listeners) return
    const line = `${JSON.stringify(event)}\n`
    for (const response of listeners) {
      try {
        response.write(line)
      } catch {
        listeners.delete(response)
      }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)

    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type })
      res.end(body)
    }

    if (req.method === 'POST' && parts.length === 1) {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const topic = decodeURIComponent(parts[0])
        const message = Buffer.concat(chunks).toString('utf8')
        const event = {
          id: crypto.randomBytes(6).toString('base64url'),
          time: Math.floor(Date.now() / 1000),
          event: 'message',
          topic,
          message,
        }
        if (!rooms.has(topic)) rooms.set(topic, [])
        const list = rooms.get(topic)
        list.push(event)
        if (list.length > 500) list.splice(0, list.length - 500)
        pushToSubscribers(topic, event)
        send(200, JSON.stringify(event), 'application/json')
      })
      return
    }

    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'json') {
      const topic = decodeURIComponent(parts[0])
      const since = Number(url.searchParams.get('since') ?? '0') || 0
      const list = (rooms.get(topic) ?? []).filter((event) => event.time >= since)

      // poll=1：一次性把缓存回放完
      if (url.searchParams.get('poll') === '1') {
        const body = list.map((event) => JSON.stringify(event)).join('\n')
        send(200, body ? `${body}\n` : '', 'application/x-ndjson')
        return
      }

      // 其余：长连接订阅，先回放缓存，再推送新消息
      res.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('')
      if (!subscribers.has(topic)) subscribers.set(topic, new Set())
      const set = subscribers.get(topic)
      set.add(res)
      if (list.length > 0) res.write(`${list.map((event) => JSON.stringify(event)).join('\n')}\n`)
      const keepalive = setInterval(() => {
        try {
          res.write(`${JSON.stringify({ id: 'keepalive', time: Math.floor(Date.now() / 1000), event: 'keepalive' })}\n`)
        } catch {
          clearInterval(keepalive)
        }
      }, 5000)
      req.on('close', () => {
        clearInterval(keepalive)
        set.delete(res)
      })
      return
    }

    send(404, 'not found')
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        rooms,
        subscribers,
        stop: () =>
          new Promise((done) => {
            for (const set of subscribers.values()) for (const response of set) response.end()
            server.close(() => done())
          }),
      })
    })
  })
}
