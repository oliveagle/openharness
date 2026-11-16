# A local Harness, on one LAN

This is the deployment Harness runs on here: no cloud account, no `autonomous.ai` in the path. A
workstation (this machine) holds the backend, the agent daemon and the phone's pair QR; the phone
is an ordinary Android build compiled against those addresses, installed side by side with the
store app.

The whole thing is six systemd user units plus the scripts they run. `systemd/` in this folder is
their source of truth; `~/.config/systemd/user/` is where they are installed from.

## What listens where

| Port | Unit | What it is |
| --- | --- | --- |
| 8085 | `openharness-backend-server` (+ `-worker`) | The control plane and ws hub the phone dials (`/api/web-ws?client=mobile`) |
| 8088 | `openharness-apk` | The phone app: `/` names the exact build (package, version, sha256, API origin), `/harness.apk` is the file |
| 8089 | `openharness-pair-qr` | `/pair` shows the Add-phone QR, `/code` prints the same link as text |
| 8091 | `openharness-web` | The web viewer |
| — | `openharness-cli-daemon` | `harness-local start --foreground`: the machine side of every agent session |

Postgres and Redis are not in this folder: they are services elsewhere on the LAN, named only in
`backend/.env.local` (`DATABASE_URL`, `REDIS_URL`). That file is **not** in the repository — it is
the one piece of this deployment that has to be written by hand:

```
DATABASE_URL=postgresql://…@10.126.126.6:5432/harness
REDIS_URL=redis://10.126.126.6:6379
PORT=8085
NODE_ENV=development
```

## Installing

```bash
# 1. the units (edit the absolute paths inside them if this checkout moves)
install -Dm644 deploy/local/systemd/openharness-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openharness-backend-server openharness-backend-worker \
  openharness-cli-daemon openharness-pair-qr openharness-apk openharness-web

# 2. the phone app — never a plain `flutter build apk`
./scripts/build-local-apk.sh          # 8088 serves the result, and its page proves which build
```

`build-local-apk.sh` is not a convenience wrapper. A plain `flutter build apk` produces the **cloud**
app: it offers Google/Apple sign-in, sends `autonomous.ai/go` to the workstation, and its camera
reads our `/pair#…` QR as nothing at all — silently, which is why that failure looked like a broken
deployment rather than a wrong binary. The script compiles the three `--dart-define`s in, gives the
package a `.local` id suffix so it sits beside the store app instead of fighting it for one slot,
and then checks the API origin is really inside `libapp.so` before it publishes anything.

The tell that the phone is running *this* build, when a conversation will not load: launch it and the
camera opens by itself, the entry in its settings is **Pair a computer**, and the icon is **Harness
Local**. Google/Apple sign-in, "Sign in a computer", or a page that says `autonomous.ai/go` is the
store app talking to the cloud — it can neither read our QR nor see this machine, and its chat stays
empty however healthy the LAN stack is. Both can sit on the phone at once, so the icon matters.

## Proving it works, without a phone

`cli/scripts/fake-phone-qr-e2e.mjs` is the phone: same relay, same sealed frames. With no arguments
it takes the QR currently on the 8089 page — pair code and handoff code together — so it tests the
QR a camera would be pointing at, not a code the script made up:

```bash
node cli/scripts/fake-phone-qr-e2e.mjs
# · took the QR on screen (pair code 4TEFGCPRRZS8XJKW)
# · paired with the machine (fingerprint D72A·FFA2·62DE·4C29)
# · agents_list → 12 agents
# ✓ session_get → 81 events (title "启动项目并运行")
```

A `CODE_MISMATCH` there means the two sides named different codes, not that the deployment is down:
check `/code` and the QR image belong to the same pairing (they do by construction now — one watcher
per pairing, one fixed pair code, a handoff code republished every 30 seconds).

## Two things that bite

- **`pkill -f local-pair-qr-server.mjs` kills the shell you typed it in**, because that string is in
  the shell's own command line. Use `systemctl --user restart openharness-pair-qr`.
- **Under `set -o pipefail`, `unzip -p … | strings | rg -q …` fails on a hit**: `rg -q` exits at the
  first match, `strings` dies of SIGPIPE, and the pipeline reports failure. Write the snapshot to a
  file first.
