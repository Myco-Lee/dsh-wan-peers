/**
 * 用假 ctx 起两个 hub（不同 home、同一房间），验证：
 *   1. 双方互相发现               2. 端到端加密的消息投递
 *   3. 错误口令读不到内容         4. 收件箱标记已读
 *   5. 五个工具都能注册并返回结果
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { startMockNtfy } from './mock-ntfy.mjs'

const ROOM = 'smoke-room-2026'
const SECRET = 'correct-horse-battery'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-peers-smoke-'))

function makeCtx(label) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    inject(_deps, cb) {
      cb(ctx)
    },
    effect(fn) {
      disposers.push(fn())
    },
    logger: { error: (...args) => console.log(`[${label}] error`, ...args), warn: () => {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, tools, disposers }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const mock = await startMockNtfy()

const nodeA = { home: path.join(tmp, 'a'), name: 'node-a' }
const nodeB = { home: path.join(tmp, 'b'), name: 'node-b' }
const nodeC = { home: path.join(tmp, 'c'), name: 'node-c-wrong-secret' }

const a = makeCtx('a')
const b = makeCtx('b')
const c = makeCtx('c')

apply(a.ctx, { service: mock.url, room: ROOM, secret: SECRET, name: nodeA.name, home: nodeA.home, pollMs: 2000, announceMs: 5000 })
apply(b.ctx, { service: mock.url, room: ROOM, secret: SECRET, name: nodeB.name, home: nodeB.home, pollMs: 2000, announceMs: 5000 })
apply(c.ctx, { service: mock.url, room: ROOM, secret: 'wrong-secret-value', name: nodeC.name, home: nodeC.home, pollMs: 2000, announceMs: 5000 })

assert.equal(a.tools.size, 6, 'node-a registered 6 tools')
assert.deepEqual([...a.tools.keys()].sort(), ['wan_inbox', 'wan_pair', 'wan_peers', 'wan_ping', 'wan_room', 'wan_send'])

// 三个 hub 各用自己的 home（上面已传），不会污染 ~/.dsh/wan-peers

await sleep(250)
await a.tools.get('wan_ping').execute({})
await b.tools.get('wan_ping').execute({})
await sleep(1200)
await a.tools.get('wan_ping').execute({})
await b.tools.get('wan_ping').execute({})

const peersA = await a.tools.get('wan_peers').execute({})
const peersB = await b.tools.get('wan_peers').execute({})
console.log('A sees:', peersA.message)
console.log('B sees:', peersB.message)
assert.ok(peersA.online >= 1, 'A 至少看到一个在线对端')
assert.ok(peersB.online >= 1, 'B 至少看到一个在线对端')

// 加密消息投递
const peersList = peersA.peers
const target = peersList.find((peer) => peer.name === 'node-b')
assert.ok(target, 'A 能定位到 node-b')

const sent = await a.tools.get('wan_send').execute({ peer: 'node-b', text: 'hello over the internet' })
console.log('send:', sent.message)
assert.equal(sent.ok, true)

await b.tools.get('wan_ping').execute({})
const inboxB = await b.tools.get('wan_inbox').execute({ limit: 10 })
console.log('B inbox:', inboxB.message)
assert.ok(inboxB.messages.some((row) => row.text === 'hello over the internet'), 'B 收到明文（说明解密成功）')
assert.equal(inboxB.unread, 0, '读取后未读数归零')

// 超长消息按 UTF-8 字节上限截断，不撑爆公共中继的单条上限
const longText = '这是一条很长的中文消息。'.repeat(500)
const longSent = await a.tools.get('wan_send').execute({ peer: 'node-b', text: longText })
assert.ok(Buffer.byteLength(longSent.text, 'utf8') <= 2600, '发送文本被截断到字节上限内')
assert.ok(longSent.text.endsWith('…'), '截断后带省略号')
await b.tools.get('wan_ping').execute({})
const inboxLong = await b.tools.get('wan_inbox').execute({ limit: 10 })
const rowLong = inboxLong.messages.find((row) => row.text.startsWith('这是一条很长的中文消息'))
assert.ok(rowLong, 'B 收到超长消息的截断版本')
assert.ok(Buffer.byteLength(rowLong.text, 'utf8') <= 2600, '收到文本同样不超过字节上限')

// 错误口令的节点看不到任何内容（GCM 认证失败）
await c.tools.get('wan_ping').execute({})
const peersC = await c.tools.get('wan_peers').execute({})
assert.equal(peersC.peers.length, 0, '错误口令看不到任何对端')

const room = await a.tools.get('wan_room').execute({})
console.log('room:', room.message)

for (const holder of [a, b, c]) for (const dispose of holder.disposers) dispose()
await mock.stop()
fs.rmSync(tmp, { recursive: true, force: true })

console.log('\nsmoke ok')
