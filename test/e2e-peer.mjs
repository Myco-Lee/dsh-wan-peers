/**
 * 真实网络端到端测试用的单节点入口（可起两个进程互测）。
 *
 * 用法：
 *   node test/e2e-peer.mjs --name a --room <room> --secret <secret> --home <dir> \
 *        --wait-ms 30000 [--send "文本"]
 *
 * 行为：
 *   1. 起 hub（真实 service，默认 https://ntfy.sh）
 *   2. 广播心跳，轮询直到看到对端或超时
 *   3. 若给了 --send，则把文本发给第一个在线对端
 *   4. 继续轮询 wait-ms 收消息，最后把结果以 JSON 打到 stdout
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createHub } from '../lib/index.js'

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const name = argOf('--name', os.hostname())
const room = argOf('--room')
const secret = argOf('--secret')
const service = argOf('--service', 'https://ntfy.sh')
const home = argOf('--home', fs.mkdtempSync(path.join(os.tmpdir(), `wan-e2e-${name}-`)))
const waitMs = Number(argOf('--wait-ms', '30000'))
const sendText = argOf('--send', '')

if (!room || !secret) {
  console.error('need --room and --secret')
  process.exit(2)
}

const settings = {
  service,
  room,
  secret,
  name,
  home,
  pollMs: 5000,
  announceMs: 20000,
  ttlMs: 60000,
}
const hub = createHub(settings, { home })
hub.start()

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const startedAt = Date.now()

let sent = null
let sawPeer = false

// 先宣告，让对端尽快看到自己
await hub.announce()

while (Date.now() - startedAt < waitMs) {
  await sleep(2500)
  await hub.announce().catch(() => null)
  const polled = await hub.pollOnce()
  void polled
  const online = hub.listPeers().filter((peer) => peer.online)
  if (online.length > 0 && !sawPeer) {
    sawPeer = true
    if (sendText) {
      const target = online[0]
      try {
        await hub.publish({
          v: 1,
          kind: 'message',
          id: hub.self.id,
          name: hub.settings.name,
          to: target.id,
          text: sendText,
          ts: new Date().toISOString(),
        })
        sent = { to: target.name, text: sendText }
      } catch (error) {
        sent = { error: String(error.message ?? error) }
      }
    }
  }
  // 收到消息后可以提前结束
  if (hub.getInbox().length > 0 && sent) break
}

const snap = hub.snapshot()
const inbox = hub.getInbox()
hub.stop()

console.log(
  JSON.stringify(
    {
      name,
      room,
      service,
      home,
      elapsedMs: Date.now() - startedAt,
      self: snap.self.id,
      peers: snap.peers.map((peer) => ({ name: peer.name, id: peer.id, online: peer.online })),
      sent,
      inbox: inbox.map((row) => ({ from: row.fromName, text: row.text, read: row.read })),
      lastError: snap.lastError,
    },
    null,
    2,
  ),
)
