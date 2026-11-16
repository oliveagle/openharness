#!/usr/bin/env node
// Serves this deployment's phone app: http://<host>:8088/harness.apk
//
//   node scripts/local-apk-server.mjs [port]
//
// The file it serves is the one `flutter build apk` just wrote
// (mobile/build/app/outputs/flutter-apk/app-release.apk), so a rebuild needs no copy. `/` is a
// small page saying exactly which build is behind the link — package id, name, version, size and
// sha256 — because a phone that installs the wrong build is indistinguishable from a broken
// deployment once it is running: it shows a cloud sign-in and an empty chat.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'mobile', 'build', 'app', 'outputs', 'flutter-apk');
const apk = join(dir, 'app-release.apk');
// Written by scripts/build-local-apk.sh next to the APK it describes (`app-release-info.json`).
// Reading a different name here is how this page once said `unknown — unknown` while serving the
// right file: the phone had no way to tell which build it was being handed.
const info = join(dir, 'app-release-info.json');
const port = Number(process.argv[2] ?? process.env.APK_PORT ?? 8088);

let cached = { key: '', sha256: '' };
function sha256() {
  const st = statSync(apk);
  const key = `${st.size}:${st.mtimeMs}`;
  if (cached.key === key) return cached.sha256;
  const hash = createHash('sha256').update(readFileSync(apk)).digest('hex');
  cached = { key, sha256: hash };
  return hash;
}

function details() {
  const st = statSync(apk);
  const meta = existsSync(info) ? JSON.parse(readFileSync(info, 'utf8')) : {};
  return {
    package: meta.package ?? 'unknown',
    label: meta.label ?? 'unknown',
    versionName: meta.versionName ?? 'unknown',
    versionCode: meta.versionCode ?? 'unknown',
    bytes: st.size,
    builtAt: new Date(st.mtimeMs).toISOString(),
    sha256: sha256(),
    api: meta.api ?? 'unknown',
    pairHost: meta.pairHost ?? 'unknown',
    // The info file describes the build that was published; if the APK on disk is newer (a plain
    // `flutter build apk` overwrote it) the page must not present it as this build.
    stale: Boolean(meta.sha256) && meta.sha256 !== sha256(),
  };
}

function page() {
  const d = details();
  const rows = [
    ['app', `${d.label} — ${d.package}`],
    ['version', `${d.versionName} (${d.versionCode})`],
    ['built', d.builtAt],
    ['size', `${(d.bytes / 1048576).toFixed(1)} MB`],
    ['sha256', d.sha256],
    ['api', d.api],
    ['pair qr', `http://${d.pairHost}:8089/pair`],
    // The tell, on the page that hands out the file: the phone running the store app asks for a
    // Google or Apple account and its camera reads our QR as nothing, which reads as a broken
    // deployment. Named here so whoever installs can rule it out in one look.
    ['this build', `icon "${d.label}", package ${d.package}; one that offers Google or Apple sign-in is the store app`],
  ];
  if (d.stale) rows.push(['⚠ stale', 'this file is not the build in app-release-info.json — rebuild with scripts/build-local-apk.sh']);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness Local</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#0d1117;color:#e6edf3}
a.btn{display:inline-block;padding:14px 20px;background:#2ea043;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}
dt{color:#8b949e;font-size:13px;text-transform:uppercase;letter-spacing:.04em}dd{margin:0 0 12px}
code{word-break:break-all;font-size:13px}</style>
<h2>Harness Local</h2><p><a class="btn" href="/harness.apk">Download the APK</a></p><dl>
${rows.map(([k, v]) => `<dt>${k}</dt><dd><code>${v}</code></dd>`).join('')}
</dl>`;
}

createServer((req, res) => {
  if (req.url === '/harness.apk') {
    if (!existsSync(apk)) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('no APK built yet: run scripts/build-local-apk.sh\n');
    }
    const st = statSync(apk);
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': st.size,
      'content-disposition': 'attachment; filename=harness-local.apk',
    });
    return createReadStream(apk).pipe(res);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page());
}).listen(port, '0.0.0.0', () => console.log(`serving http://0.0.0.0:${port}/harness.apk`));
