#!/usr/bin/env node
// Hold one local Add-phone pairing open, and keep the QR in front of it fresh.
//
//   node scripts/local-pair-qr.mjs            # started by local-pair-qr-server.mjs
//
// Two codes are on that QR and they age differently:
//
//   · `h=` the handoff code — how the phone gets a session. Lives 90 seconds, so a QR left on
//     screen goes stale on its own;
//   · `c=` the pair code — the CPace password the phone and `harness pair` must both name. It is
//     only ever compared at handshake time, so it never needs to be replaced while nobody is
//     scanning.
//
// This helper therefore mints a new handoff code every HANDOFF_REFRESH_MS and republishes the QR
// under the SAME pair code, while one watcher (local-pair-watch.ts) waits for the phone's intent.
// Earlier versions started a whole new generation — new pair code, previous watcher killed — every
// 40 seconds, which could tear down a handshake that started a moment before the rotation, and left
// readers of /code holding the previous generation's link.
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
const qrFile = process.env.PAIR_QR_FILE || '/tmp/qr.svg'
const urlFile = process.env.PAIR_URL_FILE || '/tmp/harness-pair-url.txt'
/// Well inside the handoff code's 90 seconds, so a QR on screen is never a dead one.
const HANDOFF_REFRESH_MS = Number(process.env.HANDOFF_REFRESH_MS || 30_000)

const author = JSON.parse(readFileSync(authSessionFile, 'utf8'))
const env = author.autonomousEnv ?? 'prod'

// The durable CLI session, refreshed when needed: a pairing helper must still work hours after
// the bootstrap token it was set up with has gone away.
let token = author.accessToken
async function accessToken() {
  if (author.expiresAt && Date.now() + 30_000 < author.expiresAt) return token
  const response = await fetch(`${backend}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: author.refreshToken }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.data?.token) {
    throw new Error(`computer session refresh failed (${response.status})`)
  }
  const tokens = payload.data
  token = tokens.token
  author.accessToken = tokens.token
  if (tokens.refreshToken) author.refreshToken = tokens.refreshToken
  author.expiresAt = Date.now() + (tokens.expiresIn ?? 3600) * 1000
  author.updatedAt = Date.now()
  const temp = `${authSessionFile}.tmp.${process.pid}`
  writeFileSync(temp, JSON.stringify(author), { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, authSessionFile)
  return token
}

async function mintHandoff() {
  const response = await fetch(`${backend}/api/auth/handoff`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', 'x-autonomous-env': env },
    body: '{}',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.data?.code) {
    throw new Error(`handoff failed (${response.status}): ${JSON.stringify(payload)}`)
  }
  return payload.data.code
}

// No need to call /api/auth/me here: this local bootstrap session was created for local-owner.
const email = process.env.HARNESS_LOCAL_EMAIL || 'owner@local.harness'
const machineId = process.env.HARNESS_LOCAL_MACHINE_ID || author.machineId
if (!machineId) throw new Error('no CLI machineId; run auth status first')

/// Printed in this shape so the server can hand out the link without parsing prose.
function link(pairCode, handoffCode) {
  const url = new URL('/pair', backend)
  url.hash = [
    `e=${encodeURIComponent(email)}`,
    `m=${encodeURIComponent(machineId)}`,
    `c=${encodeURIComponent(pairCode)}`,
    `h=${encodeURIComponent(handoffCode)}`,
  ].join('&')
  return url.toString()
}

function svgOf(link) {
  const qr = qrcode(0, 'M')
  qr.addData(link)
  qr.make()
  const count = qr.getModuleCount()
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 ${count + 8} ${count + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path fill="black" d="`
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) svg += `M${col + 4},${row + 4}h1v1h-1z`
    }
  }
  return `${svg}"/></svg>`
}

/// Write beside the target and rename: a reader must never catch half an SVG or half a link.
function publish(link) {
  const svgTemp = `${qrFile}.tmp.${process.pid}`
  writeFileSync(svgTemp, svgOf(link))
  renameSync(svgTemp, qrFile)
  const urlTemp = `${urlFile}.tmp.${process.pid}`
  writeFileSync(urlTemp, `${link}\n`)
  renameSync(urlTemp, urlFile)
}

const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const pairCode = (process.env.PAIR_CODE || '').trim()
  || Array.from(randomBytes(16)).map(b => alphabet[b % alphabet.length]).join('')

// One pairing per helper: the watcher runs a single handshake and exits when it is done (paired)
// or out of time. A fresh QR for the next phone is a fresh process.
const watcher = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'scripts/local-pair-watch.ts'), pairCode], {
  cwd: resolve(root, 'cli'),
  stdio: 'inherit',
  env: { ...process.env, BACKEND_WS_URL: wsUrl, WEB_URL: webUrl, ADAPTER_DATA_DIR: dataDir, HERDR_BIN: herdrBin, TERMINAL_BACKENDS: 'herdr' },
})
let finished = false
let wake = () => {}
watcher.on('exit', code => { finished = true; wake(); process.exitCode = code ?? 1 })
process.on('SIGTERM', () => {
  try { watcher.kill('SIGTERM') } catch {}
  process.exit(0)
})

while (!finished) {
  try {
    const current = link(pairCode, await mintHandoff())
    publish(current)
    console.log(`url: ${current}`)
  } catch (error) {
    // A failed mint is not fatal: the QR just keeps the code it already had until the next round.
    console.error(`handoff failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, HANDOFF_REFRESH_MS)
    wake = () => { clearTimeout(timer); resolve() }
  })
}
