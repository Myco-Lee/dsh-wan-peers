/**
 * 真实网络端到端测试（stream 模式）：靠长连接订阅完成发现与接收，
 * 不做手动轮询，用来验证默认接收路径。
 *
 * 用法：
 *   node test/e2e-stream.mjs --name a --room <room> --secret <secret> --home <dir> \
 *        --wait-ms 30000 [--send "文本"]
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
const home = argOf('--home', fs.mkdtempSync(path.join(os.tmpdir(), `wan-stream-${name}-`)))
const waitMs = Number(argOf('--wait-ms', '30000'))
const sendText = argOf('--send', '')

if (!room || !secret) {
  console.error('need --room and --secret')
  process.exit(2)
}

const hub = createHub({ service, room, secret, name, home, mode: 'stream' }, { home, verbose: false })
hub.start()

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const startedAt = Date.now()
let sent = null

await hub.announce()

while (Date.now() - startedAt < waitMs) {
  await sleep(1000)
  const online = hub.listPeers().filter((peer) => peer.online)
  if (online.length > 0 && !sent && sendText) {
    try {
      await hub.publish({
        v: 1,
        kind: 'message',
        id: hub.self.id,
        name: hub.settings.name,
        to: online[0].id,
        text: sendText,
        ts: new Date().toISOString(),
      })
      sent = { to: online[0].name, text: sendText }
    } catch (error) {
      sent = { error: String(error.message ?? error) }
    }
  }
  if (sent && hub.getInbox().length > 0) break
}

const snap = hub.snapshot()
const inbox = hub.getInbox()
hub.stop()

console.log(
  JSON.stringify(
    {
      name,
      room,
      mode: 'stream',
      elapsedMs: Date.now() - startedAt,
      self: snap.self.id,
      peers: snap.peers.map((peer) => ({ name: peer.name, id: peer.id, online: peer.online })),
      sent,
      inbox: inbox.map((row) => ({ from: row.fromName, text: row.text })),
      lastError: snap.lastError,
    },
    null,
    2,
  ),
)
