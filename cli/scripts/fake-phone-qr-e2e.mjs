// A phone, without a phone: the mobile app's exact relay path, driven from the CLI.
//
// The app dials `/api/web-ws` with `client=mobile`, pairs with the machine over CPace (the QR's
// one-time code), opens an E2EE session (`e2e_hello` → `e2e_welcome`), and then asks the machine
// for a conversation (`session_get`) in a SEALED frame. This script does exactly that, so the
// phone's transcript path can be proved end to end without a camera.
//
//   npx tsx cli/scripts/fake-phone-session-get.mjs [agentId] [pairCode]
//
// fake-phone-qr-e2e.mjs is the same phone, but it takes the QR the page is showing
// right now (its handoff code and its pair code) and lets the workstation side — the
// waiting watcher — drive the pairing, exactly as a camera scan would.
//
// It mints a local viewer token the way the app does after scanning (handoff → redeem), pairs
// with the daemon (`harness pair <code>`), and prints what the machine answered.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(join(repo, 'cli/package.json'))
const { WebSocket } = require('ws')
const C = await import(pathToFileURL(join(repo, 'cli/src/lib/e2ee/core.ts')))

const BACKEND = process.env.HARNESS_LOCAL_BACKEND || 'http://10.126.126.10:8085'
const MACHINE_ID = process.env.HARNESS_LOCAL_MACHINE_ID || 'dfb203716baf7e104757968e3b7bedd8'
const WANTED_AGENT = process.argv[2] || ''
const PAIR_CODE = process.argv[3] || 'FAKEPHONE1'
const HARNESS_BIN = process.env.HARNESS_BIN || `${process.env.HOME}/.local/bin/harness-local`

const wsUrl = `${BACKEND.replace(/^http/, 'ws')}/api/web-ws?autonomousEnv=prod&client=mobile`
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1) }

// ── the phone's sign-in: the QR's handoff code, redeemed for a token ───────────────────────────────
async function phoneToken() {
  let code = process.env.QR_HANDOFF || ''
  if (!code) {
    const session = JSON.parse(readFileSync(`${process.env.HOME}/.harness/auth/session.json`, 'utf8'))
    const handoff = await fetch(`${BACKEND}/api/auth/handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json', 'x-autonomous-env': 'prod' },
      body: '{}',
    })
    const handoffPayload = await handoff.json().catch(() => ({}))
    code = handoffPayload?.data?.code
  }
  if (!code) fail('handoff failed: no code')
  const redeem = await fetch(`${BACKEND}/api/auth/handoff/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  })
  const redeemPayload = await redeem.json().catch(() => ({}))
  const token = redeemPayload?.data?.token
  if (!token) fail(`redeem failed (${redeem.status}): ${JSON.stringify(redeemPayload)}`)
  console.log('· phone token minted (local viewer session)')
  return token
}

// ── the socket ────────────────────────────────────────────────────────────────────────────────────
const token = await phoneToken()
const ws = new WebSocket(wsUrl, [token])
const waiters = []
let session = null
let clientCounter = 0

const onFrame = (frame) => {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1) }
  }
}
const waitFor = (match, what, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    const i = waiters.findIndex((w) => w.resolve === resolve)
    if (i >= 0) waiters.splice(i, 1)
    reject(new Error(`timeout waiting for ${what}`))
  }, timeoutMs)
  waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f) } })
})
const send = (type, payload) => ws.send(JSON.stringify({ type, payload }))

ws.on('message', (raw) => {
  let frame
  try { frame = JSON.parse(raw.toString()) } catch { return }
  const type = frame.type
  // A sealed frame from the machine: opened under the pairwise key.
  if (session && frame.payload && typeof frame.payload === 'object' && '__e2e' in frame.payload) {
    const plain = C.unwrapPayload(session.s2c, frame.payload.__e2e, type, frame.dbSessionId)
    if (plain !== null) frame = { ...frame, payload: plain }
  }
  if (type !== 'text_delta' && type !== 'turn_heartbeat') {
    console.log(`  ← ${type} ${JSON.stringify(frame.payload ?? {}).slice(0, 160)}`)
  }
  onFrame(frame)
})
ws.on('error', (err) => fail(`socket error: ${err.message}`))

await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
console.log(`· connected ${wsUrl}`)

// ── select the machine ───────────────────────────────────────────────────────────────────────────
send('machine_select', { machineId: MACHINE_ID })
await waitFor((f) => f.type === 'connected' && f.payload?.machineId === MACHINE_ID, 'machine_selected')
console.log(`· machine selected ${MACHINE_ID}`)

// ── pair over CPace, the way the QR's code does ──────────────────────────────────────────────────
const identity = C.newIdentity()
const pairId = C.newPairId()
const pairIdB64 = C.b64e(pairId)
const ci = C.pairContext(MACHINE_ID, 'web')
const requestId = C.b64e(C.newPairId())
send('e2e_pair_intent', { requestId, pairId: pairIdB64, label: 'fake-phone', role: 'web' })
const intent = await waitFor((f) => f.type === 'e2e_pair_intent_result', 'e2e_pair_intent_result')
if (intent.payload?.accepted !== true) fail(`pair intent refused: ${JSON.stringify(intent.payload)}`)

// The workstation side of the QR is already waiting (the watcher in local-pair-qr.mjs);
// the phone only has to announce its intent and answer the CPace rounds.

const round1 = await waitFor((f) => f.type === 'e2e_pake' && f.payload?.round === 1, 'pake round 1')
const Ya = C.b64d(round1.payload.ya)
const g = C.cpaceGenerator(PAIR_CODE, pairId, ci)
const { y, Y } = C.cpaceStart(g)
const K = C.cpaceShared(Ya, y)
const isk = C.cpaceISK(pairId, K, Ya, Y)
const th = C.transcriptHash(pairId, ci, Ya, Y)
const kc = C.kcKeys(isk, ci)
send('e2e_pake', { pairId: pairIdB64, round: 2, yb: C.b64e(Y), mac: C.b64e(C.macTag(kc.web, th)) })

const round3 = await waitFor((f) => f.type === 'e2e_pake' && f.payload?.round === 3, 'pake round 3')
if (!C.macVerify(kc.adapter, th, C.b64d(round3.payload.mac))) fail('round 3 MAC did not verify')
const identityOpened = C.aeadOpen(C.pairKey(isk, ci), 3, C.utf8('e2e-id'), C.b64d(round3.payload.enc))
if (!identityOpened) fail('round 3 identity did not open')
const machineIdentity = JSON.parse(new TextDecoder().decode(identityOpened))
const machinePub = C.b64d(machineIdentity.id)
if (!C.pairBindVerify(machinePub, th, C.b64d(machineIdentity.sig))) fail('machine identity signature did not verify')
send('e2e_pake', {
  pairId: pairIdB64, round: 4,
  enc: C.b64e(C.aeadSeal(C.pairKey(isk, ci), 4, C.utf8('e2e-id'), C.utf8(JSON.stringify({ id: C.b64e(identity.pub), sig: C.b64e(C.pairBindSig(identity.priv, th)) })))),
})
const round5 = await waitFor((f) => f.type === 'e2e_pake' && f.payload?.round === 5, 'pake round 5')
if (round5.payload?.ok !== true) fail(`pairing failed: ${JSON.stringify(round5.payload)}`)
console.log(`· paired with the machine (fingerprint ${round5.payload.fingerprint})`)

// ── open the E2EE session ────────────────────────────────────────────────────────────────────────
const eph = C.newEphemeral()
send('e2e_hello', { identityPub: C.b64e(identity.pub), ephPub: C.b64e(eph.pub), sig: C.b64e(C.helloSig(identity.priv, MACHINE_ID, eph.pub)) })
const welcome = await waitFor((f) => f.type === 'e2e_welcome' || f.type === 'e2e_denied', 'e2e_welcome')
if (welcome.type === 'e2e_denied') fail(`hello denied: ${JSON.stringify(welcome.payload)}`)
const adapterEphPub = C.b64d(welcome.payload.ephPub)
if (!C.welcomeVerify(machinePub, MACHINE_ID, eph.pub, adapterEphPub, C.b64d(welcome.payload.sig))) fail('welcome signature did not verify')
const keys = C.sessionKeys(eph.priv, adapterEphPub, MACHINE_ID, eph.pub, adapterEphPub)
const opened = C.aeadOpen(keys.s2c, 0, C.utf8('e2e-welcome'), C.b64d(welcome.payload.enc))
if (!opened) fail('welcome did not open')
session = { c2s: keys.c2s, s2c: keys.s2c }
console.log(`· E2EE session open (features ${JSON.stringify(opened.features)})`)

const sealed = (type, payload) => {
  const wrapped = C.wrapPayload(session.c2s, 'p', clientCounter++, type, undefined, payload)
  ws.send(JSON.stringify({ type, payload: wrapped }))
}

// ── the phone's agent list ────────────────────────────────────────────────────────────────────────
sealed('agents_list', { requestId: 'agents-1' })
const agentsResult = await waitFor((f) => f.type === 'agents_list_result', 'agents_list_result')
const agents = agentsResult.payload?.agents ?? []
console.log(`· agents_list → ${agents.length} agents`)
if (!agents.length) fail('the machine answered with no agents')
const withSession = agents.filter((a) => typeof a.sessionId === 'string' && a.sessionId)
console.log(`· agents with a sessionId: ${withSession.length}/${agents.length}`)
const target = WANTED_AGENT
  ? agents.find((a) => a.id === WANTED_AGENT || a.sessionId === WANTED_AGENT)
  : withSession[0] ?? agents[0]
if (!target) fail(`agent ${WANTED_AGENT} is not on this machine`)
console.log(`· target agent ${target.id} (${target.name ?? '?'}) sessionId=${target.sessionId ?? 'none'}`)

// ── the phone's transcript request ────────────────────────────────────────────────────────────────
const sessionId = target.sessionId ?? target.id
sealed('session_get', { requestId: 'session-1', sessionId, limit: 20 })
const got = await waitFor((f) => f.type === 'session_get_result', 'session_get_result')
const payload = got.payload ?? {}
if (payload.error) fail(`session_get error: ${payload.error}`)
const events = Array.isArray(payload.events) ? payload.events : []
console.log(`✓ session_get → ${events.length} events (title ${JSON.stringify(payload.title ?? '')})`)
for (const event of events.slice(0, 12)) {
  const p = event?.payload ?? {}
  const text = p.content ?? p.result ?? p.summary ?? p.tool ?? ''
  console.log(`   · ${event.type}${text ? `: ${String(text).slice(0, 140)}` : ''}`)
}
if (!events.length) fail('the machine answered with no events — the transcript is empty')
console.log('\n✓ the phone’s transcript path works end to end (sealed session_get → real events)')
// (the workstation watcher finishes on its own)
ws.close()
process.exit(0)
