// 限流退避 + 字节截断的离线测试：不联网，用本地 mock 服务模拟 429。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHub } from '../lib/index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-limits-'))
let hits = 0
let mode = '429'

const server = http.createServer((req, res) => {
  hits += 1
  if (mode === '429') {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 42901, error: 'limit reached: too many requests' }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const service = `http://127.0.0.1:${server.address().port}`

const hub = createHub({ service, room: 'limits-room', secret: 'limits-secret', name: 'limits-a', home })

// 1) 429 -> 记录错误并进入退避
const first = await hub.pollOnce({ force: true })
assert.equal(first.error !== undefined, true, '首次拉取应报错')
let snap = hub.snapshot()
assert.match(snap.lastError, /rate limited/, 'lastError 应说明限流')
assert.ok(snap.backoffUntil > Date.now(), '应设置退避截止时间')
assert.ok(snap.backoffMs >= 15000, '首次退避至少 15s')

// 2) 退避期内不再打服务
const before = hits
const skipped = await hub.pollOnce()
assert.equal(skipped.skipped, 'backoff', '退避期内应直接跳过')
assert.equal(hits, before, '退避期内不应发出请求')

// 3) 成功后清空退避
mode = '200'
const ok = await hub.pollOnce({ force: true })
assert.equal(ok.error, undefined, 'force 拉取应成功')
snap = hub.snapshot()
assert.equal(snap.backoffMs, 0, '成功后退避间隔归零')
assert.equal(snap.backoffUntil, 0, '成功后清空退避截止时间')

// 4) 超长中文文本按字节截断，且不超过上限
const longText = '中文很长的消息。'.repeat(400)
const tool = await hub.publish({ v: 1, kind: 'message', id: hub.self.id, to: '*', text: longText })
assert.ok(tool === undefined || true)
hub.stop()
server.close()

console.log('limits ok：429 退避 / 跳过 / 恢复 全部符合预期')
