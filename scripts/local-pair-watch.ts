/**
 * Wait for a phone's pairing intent, then run the CPace pairing against the local daemon.
 *
 * The pairing has two sides and they must meet in a fixed order:
 *
 *   1. the phone scans the QR and sends `e2e_pair_intent` over its (already paired or
 *      freshly authenticated) relay connection — only then does the daemon hold a pairing
 *      slot for that phone;
 *   2. the workstation runs `harness pair <code>`, which starts CPace round 1 against
 *      that slot.
 *
 * A one-shot `harness pair` therefore fails with NO_INTENT whenever it is started
 * before the phone has scanned — which is exactly what a QR page does, since the code
 * is printed long before the camera points at it. `harness pair` answers NO_INTENT
 * immediately, so the QR helper used to die within seconds and the page sat on
 * "QR expired".
 *
 * This watcher closes that gap: it asks the daemon to pair, treats NO_INTENT as "the
 * phone has not scanned yet" and asks again. NO_INTENT is not a failed handshake, so it
 * never counts against the daemon's anti-guessing rate limit (only a real failed
 * handshake does).
 */
import { localDaemonCall } from '../cli/src/lib/daemonEndpoint.js'
import { daemonPort } from '../cli/src/lib/daemonState.js'
import { env } from '../cli/src/config/env.js'

// Every retry opens a fresh daemon socket; the default listener cap would warn.
process.setMaxListeners(64)

const code = (process.argv[2] ?? '').trim()
if (!code) {
  console.error('usage: local-pair-watch <code>')
  process.exit(2)
}

/// How long one QR stays worth waiting for. The handoff code behind it lives 90s.
const DEADLINE_MS = Number(process.env.PAIR_WAIT_MS || 150_000)
const RETRY_MS = 600

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS
  let reportedWaiting = false
  while (Date.now() < deadline) {
    let res: Response
    try {
      res = await localDaemonCall(
        env.ADAPTER_DATA_DIR,
        env.PORT,
        'POST',
        '/api/pair',
        { code },
        { tcpPort: daemonPort() },
      )
    } catch (error) {
      // The daemon is not answering yet. Keep waiting — the phone may scan later.
      if (!reportedWaiting) {
        console.log(`waiting for the daemon… ${(error as Error)?.message ?? ''}`)
        reportedWaiting = true
      }
      await sleep(RETRY_MS)
      continue
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; label?: string; fingerprint?: string }
    if (res.ok) {
      console.log(`PAIRED ${json.label ?? 'phone'} ${json.fingerprint ?? ''}`.trim())
      process.exit(0)
    }
    if (json.error === 'NO_INTENT') {
      if (!reportedWaiting) {
        console.log('waiting for the phone to scan the QR…')
        reportedWaiting = true
      }
      await sleep(RETRY_MS)
      continue
    }
    if (json.error === 'RATE_LIMITED') {
      console.error('RATE_LIMITED: too many failed pairings; wait a few minutes and refresh the QR')
      process.exit(1)
    }
    // TIMEOUT / EXPIRED / BUSY / CODE_MISMATCH: the slot is gone, so wait for the next
    // intent (the phone re-scans) and try again.
    console.log(`pairing did not finish (${json.error ?? res.status}); waiting for a fresh scan…`)
    reportedWaiting = true
    await sleep(RETRY_MS)
  }
  console.error('timed out waiting for the phone to scan')
  process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
