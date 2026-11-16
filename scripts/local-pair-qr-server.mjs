#!/usr/bin/env node
// Serve the Add-phone QR at http://<host>:8089/pair.
//
//   node scripts/local-pair-qr-server.mjs [port]
//
// One pairing at a time, and the page always shows the QR of the pairing that is actually live:
// the helper (local-pair-qr.mjs) republishes a fresh handoff code under one pair code, so the QR
// cannot go stale while a phone is walking over to it, and rotating it cannot kill a handshake
// that is already in flight.
//
// `/code` prints the link the QR encodes — for the e2e phone and for a human with no camera.
// Nothing here writes an "expired" placeholder over a live QR any more: the page reports the
// pairing's state instead, which is the only thing that could disagree with the image.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = resolve(root, 'scripts/local-pair-qr.mjs')
const qrFile = process.env.PAIR_QR_FILE || '/tmp/qr.svg'
const port = Number(process.env.PORT || 8089)
/// Longer than a helper's own life, so a stuck helper is replaced rather than served forever.
const MAX_AGE_MS = Number(process.env.PAIR_MAX_AGE_MS || 180_000)

const sleep = ms => new Promise(r => setTimeout(r, ms))

let child = null
let link = ''
let status = 'starting'   // starting | waiting | paired | expired
let startedAt = 0
/// When the last pairing finished. The confirmation stays on the page for a moment before a new QR
/// replaces it: a fresh QR ten milliseconds after "Paired" is an invitation to scan it again.
let pairedAt = 0
const PAIRED_HOLD_MS = Number(process.env.PAIRED_HOLD_MS || 25_000)
let starting = null

function alive() {
  return !!child && child.exitCode === null && child.signalCode === null
}

async function startPairing() {
  if (starting) return starting
  starting = (async () => {
    const previous = child
    child = null
    if (previous && previous.exitCode === null && previous.signalCode === null) previous.kill('SIGTERM')
    link = ''
    status = 'waiting'
    startedAt = Date.now()
    await rm(qrFile, { force: true })
    const next = spawn(process.execPath, [helper], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    child = next
    let out = ''
    const absorb = data => {
      out = `${out}${data}`.slice(-16 * 1024)
      // The helper prints one `url: <link>` per handoff code it mints; the last one is the QR now.
      for (const line of out.split('\n')) {
        if (line.startsWith('url: ')) link = line.slice('url: '.length).trim()
      }
      if (/\bPAIRED\b/.test(out) && status !== 'paired') {
        status = 'paired'
        pairedAt = Date.now()
      }
    }
    next.stdout.on('data', absorb)
    next.stderr.on('data', data => { out = `${out}${data}`.slice(-16 * 1024) })
    next.on('exit', () => {
      if (child !== next) return
      child = null
      if (status !== 'paired') status = 'expired'
    })
  })()
  try { await starting } finally { starting = null }
}

function ensurePairing({ holdPaired = false } = {}) {
  if (alive() && Date.now() - startedAt < MAX_AGE_MS) return starting ?? Promise.resolve()
  if (holdPaired && status === 'paired' && Date.now() - pairedAt < PAIRED_HOLD_MS) return Promise.resolve()
  return startPairing()
}

/// The file is removed before a generation starts, so once it exists it belongs to that generation.
async function waitForQr() {
  for (let i = 0; i < 100; i += 1) {
    const svg = await readFile(qrFile, 'utf8').catch(() => '')
    if (svg) return svg
    await sleep(100)
  }
  return ''
}

function page() {
  const refresh = '<meta http-equiv="refresh" content="30">'
  if (status === 'paired') {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paired</title>${refresh}<style>body{font:17px/1.6 system-ui,sans-serif;margin:0;height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;text-align:center;padding:24px}</style>
<div><h2>Paired ✓</h2><p>The phone is linked to ${'this computer'}.<br>This page refreshes with a new QR for the next phone.</p></div>`
  }
  if (status === 'expired') {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair phone</title>${refresh}<style>body{font:17px/1.6 system-ui,sans-serif;margin:0;height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;text-align:center;padding:24px}</style>
<div><h2>No phone scanned in time</h2><p>A new QR is on its way — this page refreshes itself.</p><p><a style="color:#58a6ff" href="/pair">Refresh now</a></p></div>`
  }
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair phone</title><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}figure{margin:0;text-align:center;font:16px/1.5 system-ui,sans-serif;color:#555}img{width:min(90vw,520px);height:auto}figcaption{padding:12px}</style>
<figure><img id="qr" alt="Pair QR" src="/qr.svg?t=${Date.now()}"><figcaption>Scan with <b>Ole-Harness</b></figcaption></figure>
<script>setInterval(()=>{document.getElementById('qr').src='/qr.svg?t='+Date.now()},15000)</script>`
}

createServer(async (req, res) => {
  const path = new URL(req.url || '/', 'http://localhost').pathname
  if (!['/', '/pair', '/qr.svg', '/code'].includes(path)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('not found\n')
  }
  // Only the page waits on a finished pairing; a request for the QR or the link wants a live one.
  await ensurePairing({ holdPaired: path === '/pair' || path === '/' })
  if (path === '/code') {
    for (let i = 0; i < 100 && !link; i += 1) await sleep(100)
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(`${link}\n`)
  }
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
  if (path === '/qr.svg') {
    const svg = await waitForQr()
    res.writeHead(svg ? 200 : 503, { ...headers, 'content-type': 'image/svg+xml; charset=utf-8' })
    return res.end(svg || '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><text x="16" y="48" font-family="sans-serif" font-size="16">starting the QR…</text></svg>')
  }
  res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
  res.end(page())
}).listen(port, '0.0.0.0', () => console.log(`local pair QR: http://10.126.126.10:${port}/pair`))
