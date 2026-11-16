#!/usr/bin/env node
// Serve a fresh local Add-phone QR at /pair. A browser on the workstation can
// display this; the phone scans it while the server holds `harness pair`.
//
// The QR encodes a handoff code (90s) and a pair code that the daemon holds in a
// pairing slot (60s). Both windows are short, so the pairing is regenerated often.
// The hard part is that a regeneration must never clobber the QR of a newer
// generation: the old helper's exit handler used to write the "expired" placeholder
// over the fresh file, which left the page showing "QR expired" most of the time.
// Every pairing therefore carries a generation number, and only the newest
// generation may write the placeholder.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = resolve(root, 'scripts/local-pair-qr.mjs')
const qrFile = '/tmp/qr.svg'
const urlFile = '/tmp/harness-pair-url.txt'
const port = Number(process.env.PORT || 8089)

/// Regenerate before the daemon's 60s pairing slot closes, so a QR on screen is
/// always one the machine is still willing to pair with.
const REFRESH_MS = Number(process.env.PAIR_REFRESH_MS || 40_000)

let child
let generation = 0
let startedAt = 0
let lastUrl = ''

const expiredSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="160" viewBox="0 0 512 160"><rect width="100%" height="100%" fill="#fff"/><text x="50%" y="85" text-anchor="middle" font-family="sans-serif" font-size="34" fill="#111">QR expired — refresh</text></svg>`

async function exists(path) {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

function alive() {
  return !!child && child.exitCode === null && child.signalCode === null
}

/// Start a new pairing generation. The previous helper is stopped first so that two
/// helpers never write the same files at the same time.
async function startPairing() {
  const myGeneration = ++generation
  const previous = child
  child = null
  if (previous && previous.exitCode === null && previous.signalCode === null) {
    previous.kill('SIGTERM')
  }
  await rm(qrFile, { force: true })
  startedAt = Date.now()
  const next = spawn(process.execPath, [helper], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  child = next
  let out = ''
  next.stdout.on('data', data => {
    out = `${out}${data}`.slice(-16 * 1024)
    const line = out.split('\n').find(l => l.includes('/pair#'))
    if (line) lastUrl = line.trim()
  })
  next.stderr.on('data', data => { out = `${out}${data}`.slice(-16 * 1024) })
  next.on('exit', () => {
    // Only the newest generation may mark the QR expired. An older helper that exits
    // late must never overwrite the QR a newer one just produced.
    if (generation !== myGeneration) return
    writeFile(qrFile, expiredSvg).catch(() => {})
  })
}

/// Make sure there is a pairing in flight whose QR is still inside both windows.
async function ensurePairing() {
  const age = Date.now() - startedAt
  if (alive() && age < REFRESH_MS) return
  await startPairing()
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (path !== '/' && path !== '/pair' && path !== '/qr.svg' && path !== '/code') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  await ensurePairing()
  for (let i = 0; i < 60 && !(await exists(qrFile)); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (path === '/code') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(lastUrl || (await readFile(urlFile, 'utf8').catch(() => '')))
    return
  }
  if (!(await exists(qrFile))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('QR is still being generated; refresh in one second')
    return
  }
  if (path === '/pair') {
    const svg = await readFile(qrFile)
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair phone</title><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}img{width:min(90vw,520px);height:auto}</style><img id="qr" alt="Pair QR" src="/qr.svg?t=${Date.now()}"><script>setInterval(()=>{document.getElementById('qr').src='/qr.svg?t='+Date.now()},20000)</script>`)
    return
  }
  const svg = await readFile(qrFile)
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(svg)
})
server.listen(port, '0.0.0.0', () => console.log(`local pair QR: http://10.126.126.10:${port}/pair`))
