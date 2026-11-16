#!/usr/bin/env node
// Minimal static server for the locally built Flutter web viewer.
import { createServer } from 'node:http'
import { stat, readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { localLoginPage, localViewerHandoff } from './local-login.mjs'

const root = resolve(process.argv[2] || new URL('../desktop/build/web-local', import.meta.url).pathname)
const port = Number(process.argv[3] || 8091)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/local-login') {
      try {
        const { code } = localViewerHandoff()
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        })
        res.end(localLoginPage(code))
      } catch (error) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(error instanceof Error ? error.message : 'local sign-in unavailable')
      }
      return
    }
    if (pathname === '/') pathname = '/index.html'
    const relative = normalize(pathname).replace(/^([.][.](\/|\\|$))+/, '')
    let file = join(root, relative)
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403).end()
      return
    }
    let info = await stat(file).catch(() => null)
    if (info?.isDirectory()) {
      file = join(file, 'index.html')
      info = await stat(file).catch(() => null)
    }
    if (!info?.isFile() && !pathname.startsWith('/assets/')) file = join(root, 'index.html')
    const body = await readFile(file)
    const seconds = pathname.startsWith('/assets/') ? 60 * 60 : 0
    res.writeHead(200, {
      'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': seconds ? `public, max-age=${seconds}` : 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
})
server.listen(port, '0.0.0.0', () => console.log(`local web: http://10.126.126.10:${port}`))
