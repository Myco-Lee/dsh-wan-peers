import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../lib/index.js'

const room = `wan-probe-${Math.random().toString(16).slice(2, 8)}`
const secret = 'probe-secret-123456'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-probe-'))
const hub = createHub(
  { service: 'https://ntfy.sh', room, secret, name: 'probe-1', home, pollMs: 3000, announceMs: 8000, ttlMs: 60000 },
  { home, verbose: true },
)
console.log('room', room, 'home', home)
console.log('announce:', await hub.announce())
const r1 = await hub.pollOnce()
console.log('poll1:', r1, 'err:', hub.snapshot().lastError)
await new Promise((done) => setTimeout(done, 1500))
const r2 = await hub.pollOnce()
console.log('poll2:', r2, 'err:', hub.snapshot().lastError)
console.log(JSON.stringify(hub.snapshot(), null, 2))
hub.stop()
