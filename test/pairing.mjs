// Pairing-code test: hub A generates a code, hub B imports it and both must meet in the room.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createHub } from '../lib/index.js'
import { startMockNtfy } from './mock-ntfy.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-pair-'))
const mock = await startMockNtfy()
const service = mock.url
const homeA = path.join(tmp, 'a')
const homeB = path.join(tmp, 'b')

const a = createHub({ service, room: 'pair-room-1', secret: 'pair-secret-1', name: 'pair-a' }, { home: homeA, verbose: false })
const b = createHub({ service, name: 'pair-b' }, { home: homeB, verbose: false })
a.start()
b.start()

const code = a.pairingCode()
console.log('code length:', code.length)

const snapB = b.importPairing(code)
console.log('B room after import:', snapB.room, 'configured:', snapB.configured)

a.announce({ force: true })
b.announce({ force: true })
await b.pollOnce({ force: true })
await a.pollOnce({ force: true })

const aSees = a.listPeers().map((p) => p.name)
const bSees = b.listPeers().map((p) => p.name)
console.log('A sees:', aSees.join(',') || '(none)')
console.log('B sees:', bSees.join(',') || '(none)')

const pairingFile = path.join(homeB, 'pairing.json')
console.log('pairing.json exists:', fs.existsSync(pairingFile))

a.stop()
b.stop()
await mock.close?.()
fs.rmSync(tmp, { recursive: true, force: true })

if (!snapB.configured || aSees.length === 0 || bSees.length === 0) {
  console.error('pairing FAILED')
  process.exit(1)
}
console.log('pairing ok: 两台机器用配对码进入同一房间并互相发现')
process.exit(0)
