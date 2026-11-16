# Herdr as the terminal backend

Herdr is a terminal workspace manager for AI coding agents: workspaces in a sidebar, each holding
tabs and panes, driven over a newline-delimited JSON socket API. With the `herdr` backend the daemon
starts every agent in a **real Herdr workspace**, so the same pane Harness drives is one the person
can see and attach to in the Herdr app — one agent, two windows onto it.

`TERMINAL_BACKENDS=herdr` pins it. Left unset, a machine that has `herdr` on its `PATH` gets
`['herdr', 'tmux']`: Herdr first (new agents become Herdr workspaces), tmux behind it as the
fallback so a machine whose Herdr is unreachable still runs agents. Windows has no Herdr backend.

## Auto-attach: no configuration

Nothing names a session. On every start the daemon asks `herdr session list --json` for the sessions
that are running, validates each socket (canonical path, owner, type, mode, and the socket's
device+inode generation), and drives those. The session the person already has open in their
terminal — usually `default` — is therefore adopted with no setup, and a session started later is
picked up on the next pass.

| Variable | Meaning |
|---|---|
| `TERMINAL_BACKENDS` | `herdr`, `tmux` or `ptyhost`, comma-separated, in preference order. Unset: this platform's default, with `herdr` first when it is installed. |
| `HERDR_SESSIONS` | Session names to drive, comma-separated. Unset or empty: **every running session**, discovered from Herdr. |
| `HERDR_BIN` | The Herdr executable (default `herdr`; an absolute path is allowed). |

A configured session that is not running is logged (`[terminal] herdr session <name>: unavailable`)
and skipped, never fatal.

## What the backend does with a pane

| Harness call | Herdr API |
|---|---|
| `create` | `workspace.create {cwd, label, env, focus: false}` — the workspace is the agent's own folder and name (its sidebar entry), then `pane.send_input` types the launch line into its root shell. `workspace.create` takes no argv, so the engine is started the way a person would start it: the argv is single-quoted into one line, and the send queues at the pane's PTY until the shell is ready. |
| `kill` | `pane.get` (identity is `terminal_id`, which survives a move), then `pane.close` — the pane, not its workspace, because a person may have moved it beside panes of their own. A pane Herdr no longer has counts as killed. |
| `capture` | `pane.read {source, lines, format, strip_ansi}` |
| `submitText` / `typeLiteral` / `pasteInput` | `pane.send_input` / `pane.send_text` |
| `sendKey` / `writeInput` | `pane.send_keys` (named keys); `writeInput` splits stream bytes into literal runs and the named keys people type (`Enter`, `Ctrl+C`, `Tab`, …) and refuses a control byte it has no key for. |
| `setTitle` | `pane.rename {label}` |
| `notify` | `notification.show` |
| `titles` / `inventory` | `session.snapshot`, plus `pane.process_info` per pane for its shell pid |
| `validate` | `pane.get` for the terminal identity, then `pane.process_info` + the process table to prove the engine is still the one registered, still under the terminal root |

A pane route is `w<workspace>:p<pane>`, and **both halves are Herdr's counters in base 36** —
`w1:p1` beside `w3:pY`, `w7:pK` and `wN:p1` on one machine. A digits-only pattern silently rejects
every pane made after the tenth and every workspace after the ninth; that is why the pattern is
`^w[0-9A-Za-z]{1,9}:p[0-9A-Za-z]{1,9}$` in `lib/terminalRuntime.ts` (`HERDR_PANE`), `hookServer.ts`
and `hook/notify.mjs`.

Herdr keeps the shell after an engine exits and reports no exit status for the foreground program,
so the pane is reported alive and the reconciler proves an engine gone from the process table by
identity, not from a status code. A *held* pane (the adoption path tmux has) is not offered.

## The sidebar, and every client's rail

Herdr's sidebar (workspace → pane) is what every client draws; the daemon reports each agent's
workspace on its frame (`rail`, `lib/agentRail.ts`) so the web page and the phone group agents the way
the person's Herdr does. See `docs/agent-conversation-layer.md`.

## Hooks

A shell inside a Herdr pane carries `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` (not `HERDR_SESSION`).
`hook/notify.mjs` reports that pane as a `herdr` runtime hint when there is no tmux or pty host pane;
the hook server validates the hint's shape and the daemon resolves it against the endpoints
discovery already trusted (`herdrHintSelects`, matching on the canonical socket path or the session
name). A hook can never introduce a socket — only point at one already resolved.

## Tests

```sh
cd cli
npx vitest run src/lib/herdrBackend.spec.ts src/lib/herdrApiClient.spec.ts src/lib/herdrSessions.spec.ts
npm run test:herdr-real      # creates a real workspace in the running Herdr, types into it, closes it
```

The real suite is gated on `RUN_HERDR_REAL=1` and reaches the person's own Herdr
(`HERDR_REAL_SOCKET`, else `~/.config/herdr/herdr.sock`; `HERDR_SESSION`, else `default`). It only
ever closes the pane it created.

An end-to-end check with an isolated data folder, against the Herdr the person is running:

```sh
export ADAPTER_DATA_DIR=/tmp/herdr-e2e PORT=18499 TERMINAL_BACKENDS=herdr HERDR_SESSIONS=default
chmod 700 "$ADAPTER_DATA_DIR"          # the registry refuses a group/world-writable folder
npx tsx src/cli.ts start -f            # logs: [terminal] herdr session default: available
npx tsx src/cli.ts new codex --name demo --json ~/work
herdr workspace list | grep demo       # the agent is a workspace, labelled with its name
npx tsx src/cli.ts close demo          # its pane closes; the workspace empties
```
