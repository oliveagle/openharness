#!/usr/bin/env node
// Generate a fresh local Add-phone QR and immediately wait for the phone with
// `harness-local pair`. The handoff code expires in 90 seconds, so run this
// only when the phone is ready to scan.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const qrcode = require(resolve(root, 'cli/node_modules/qrcode-generator'))

const backend = process.env.HARNESS_LOCAL_BACKEND || 'http://10.126.126.10:8085'
const wsUrl = process.env.BACKEND_WS_URL || 'ws://10.126.126.10:8085'
const webUrl = process.env.WEB_URL || backend
const dataDir = process.env.ADAPTER_DATA_DIR || `${process.env.HOME}/.harness/cli/data`
const herdrBin = process.env.HERDR_BIN || `${process.env.HOME}/.local/bin/herdr`
const authSessionFile = process.env.HARNESS_AUTH_SESSION || `${process.env.HOME}/.harness/auth/session.json`
const authSession = JSON.parse(readFileSync(authSessionFile, 'utf8'))

// Use the durable CLI session and refresh it when needed. The bootstrap token in /tmp
// intentionally goes away; a pairing helper must still work hours after initial setup.
let accessToken = authSession.accessToken
if (!authSession.expiresAt || Date.now() + 30_000 >= authSession.expiresAt) {
  const refreshResponse = await fetch(`${backend}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: authSession.refreshToken }),
  })
  const refreshPayload = await refreshResponse.json().catch(() => ({}))
  if (!refreshResponse.ok || !refreshPayload?.data?.token) {
    throw new Error(`computer session refresh failed (${refreshResponse.status})`)
  }
  const tokens = refreshPayload.data
  authSession.accessToken = tokens.token
  if (tokens.refreshToken) authSession.refreshToken = tokens.refreshToken
  authSession.expiresAt = Date.now() + (tokens.expiresIn ?? 3600) * 1000
  authSession.updatedAt = Date.now()
  const temp = `${authSessionFile}.tmp.${process.pid}`
  writeFileSync(temp, JSON.stringify(authSession), { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, authSessionFile)
  accessToken = tokens.token
}

const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const pairCode = Array.from(randomBytes(16)).map(b => alphabet[b % alphabet.length]).join('')

const response = await fetch(`${backend}/api/auth/handoff`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'x-autonomous-env': authSession.autonomousEnv ?? 'prod',
  },
  body: '{}',
})
const payload = await response.json().catch(() => ({}))
if (!response.ok || !payload?.data?.code) {
  throw new Error(`handoff failed (${response.status}): ${JSON.stringify(payload)}`)
}

// No need to call /api/auth/me here: this local bootstrap session was created for local-owner.
const email = process.env.HARNESS_LOCAL_EMAIL || 'owner@local.harness'
const machineId = process.env.HARNESS_LOCAL_MACHINE_ID || authSession.machineId
if (!machineId) throw new Error('no CLI machineId; run auth status first')
const handoffCode = payload.data.code

const url = new URL('/pair', backend)
url.hash = [
  `e=${encodeURIComponent(email)}`,
  `m=${encodeURIComponent(machineId)}`,
  `c=${encodeURIComponent(pairCode)}`,
  `h=${encodeURIComponent(handoffCode)}`,
].join('&')
const link = url.toString()

const qr = qrcode(0, 'M')
qr.addData(link)
qr.make()
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 ${qr.getModuleCount() + 8} ${qr.getModuleCount() + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path fill="black" d="`
for (let row = 0; row < qr.getModuleCount(); row += 1) {
  for (let col = 0; col < qr.getModuleCount(); col += 1) {
    if (qr.isDark(row, col)) svg += `M${col + 4},${row + 4}h1v1h-1z`
  }
}
svg += '"/></svg>'
writeFileSync('/tmp/qr.svg', svg)
writeFileSync('/tmp/harness-pair-url.txt', `${link}\n`)

// The pairing must wait for the phone's intent: the code is on screen long before the
// camera points at it, and a one-shot `harness pair` would answer NO_INTENT at once. The
// watcher keeps asking the daemon until the phone has scanned.
const child = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'scripts/local-pair-watch.ts'), pairCode], {
  cwd: resolve(root, 'cli'),
  stdio: 'inherit',
  env: {
    ...process.env,
    BACKEND_WS_URL: wsUrl,
    WEB_URL: webUrl,
    ADAPTER_DATA_DIR: dataDir,
    HERDR_BIN: herdrBin,
    TERMINAL_BACKENDS: 'herdr',
  },
})
// A stopped helper must stop its `harness pair` too, or the orphaned pairing
// keeps the daemon's slot busy and the next QR cannot pair.
process.on('SIGTERM', () => {
  try { child.kill('SIGTERM') } catch {}
  process.exit(0)
})
console.log(link)
console.log('QR SVG: http://10.126.126.10:8089/  (curl http://10.126.126.10:8089/ > /tmp/scan.svg)')
child.on('exit', code => process.exitCode = code ?? 1)
