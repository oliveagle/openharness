#!/usr/bin/env node
// A stand-in for Intern 3's locked startup page: what `os/root/usr/lib/harness-os/unlock/http` answers
// over its setup hotspot, without a computer, a disk or a hotspot. The locked-device integration test
// (`integration_test/add_device_unlock_test.dart`) points the app's Dio at this instead of at
// 10.42.0.1, so the password → Wi-Fi walk can be driven on an emulator.
//
//     node mobile/scripts/fake_unlock_device.mjs [--port 8042]
//
// From an emulator the host is 10.0.2.2, or 127.0.0.1 with `adb reverse tcp:8042 tcp:8042` (what the
// test's own base URL expects). The password it takes is `harness`, as the test types it; nothing is
// opened and nothing is logged beyond the requests.
import { createServer } from 'node:http'

const port = (() => {
  const at = process.argv.indexOf('--port')
  return at >= 0 ? Number(process.argv[at + 1]) : 8042
})()

const PASSWORD = 'harness'
const HOTSPOT = 'Harness-Intern3'
const NETWORKS = [
  { ssid: 'Glinks 1', signal: 82, security: 'wpa2' },
  { ssid: 'Glinks 2', signal: 55, security: 'wpa2' },
  { ssid: 'Glinks-guest', signal: 40, security: '' },
]

/** The page's own first answer (protocol 1: the password opens the disk) and its state after opening. */
let state = 'locked'
let run = 0

const send = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** A request's body, minus the setup JSON the phone appends after the password (X-Harness-Setup-Length). */
const body = async (req) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  const length = Number(req.headers['x-harness-setup-length'] ?? 0)
  return length > 0 ? raw.slice(0, raw.length - length) : raw
}

const page = () => state === 'locked'
  ? { protocol: 1, hotspot: HOTSPOT, locked: true, online: false, signedIn: false, computerId: null }
  : { protocol: 1, hotspot: HOTSPOT, locked: false, online: false, signedIn: false, computerId: 'fake-intern-3', result: { state: 'unlocked', run } }

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  console.log(`${req.method} ${path}`)
  try {
    if (req.method === 'GET' && path === '/setup') return send(res, 200, page())
    if (req.method === 'GET' && path === '/setup/networks') return send(res, 200, { networks: NETWORKS })
    if (req.method === 'POST' && (path === '/setup/unlock' || path === '/setup/check')) {
      const secret = await body(req)
      if (secret !== PASSWORD) {
        return send(res, 401, { state: 'wrong', message: 'That is not Intern 3\'s password.' })
      }
      if (path === '/setup/unlock') state = 'unlocked'
      return send(res, 200, { state: path === '/setup/check' ? 'right' : 'unlocked', run })
    }
    if (req.method === 'POST' && path === '/setup/connect') return send(res, 202, { run: ++run })
    return send(res, 404, { error: 'NOT_FOUND' })
  } catch (error) {
    return send(res, 500, { error: String(error) })
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`fake Intern 3's locked page on http://0.0.0.0:${port} · password "${PASSWORD}" · hotspot ${HOTSPOT}`)
})
