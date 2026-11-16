# One conversation, three windows: the shared agent layer

A person runs agents from three places: a shell (Herdr + the engine's own TUI), the web, and the
phone. All three must show the *same* agents, grouped the *same* way, and each must render them the
way its own UI is good at — a TUI in a real pane, a chat page, a phone list. That only holds if
nothing client-specific owns the truth. This is where the truth lives.

## The interception point

The daemon sits between the engine and every client. It never proxies the engine's own UI; it reads
what the engine already writes, and the pane it runs in:

| Layer | Where it comes from | Who reads it |
|---|---|---|
| Engine hooks (`core/engines/hooks.ts`, `hook/notify.mjs`) | The engine reports its session id, model, activity, questions | Everyone: it is what binds a pane to a session |
| Native transcript (`lib/attachTranscript.ts`, `lib/nativeConversation.ts`, `lib/sessionSearch`) | The engine's own JSONL (`~/.codex/sessions`, `~/.claude/projects`) | Everyone: turns, tool calls, token usage, recaps, search |
| Pane text (`TerminalBackend.capture`, Herdr `pane.read`) | The terminal as it looks now | The terminal view; a fallback when a transcript is unreadable |

So a conversation is not "a stream of bytes a client subscribes to": it is a session the daemon
knows, plus that session's native record. A client that draws a chat page reads the record; a client
that draws a terminal reads the pane. Both are the same agent (`agentId`), so a message typed on the
phone lands in the same pane the person is watching in Herdr, and vice versa.

Herdr panes are agents like any other: the `herdr` backend gives each one a runtime
(`herdr:<endpoint>:<paneId>`) and the hooks bind it to a session the same way tmux and the PTY host
do (`docs/herdr-backend.md`). No client has to know which backend a pane uses.

## The two levels every client draws

Herdr's sidebar has two levels — **workspace**, and the **pane/agent** inside it — and the person
reads their work that way. Every client draws the same two levels, from the daemon, and only the
arrangement differs:

| Client | Workspace level | Agent level |
|---|---|---|
| Shell | Herdr's own sidebar (the daemon does not draw it) | The Herdr pane itself, with the engine's TUI in it |
| Web | A tree column: workspace rows, collapsed by default | A chat pane beside it, plus a terminal view of the same pane |
| Phone | Section headers in the agents list (a drawer on a tablet/desktop layout) | The agent's page: conversation, and the terminal when wanted |

The wire says which workspace an agent is in, once, for all of them: `AgentFrame.rail`
(`lib/agentRail.ts`).

```json
"rail": { "kind": "herdr", "id": "w7", "label": "ole-eval", "order": 6, "cwd": "/mnt/data/repos/…/ole-eval" }
```

- `kind: "herdr"` — the agent runs in a Herdr pane. `id` is Herdr's workspace id (the pane id's
  prefix: `w7:pK` is in `w7`), and `label`/`order` are Herdr's own sidebar label and position, read
  from `workspace.list` and cached for a few seconds (`HerdrBackend.workspaceIndex`). A client groups
  exactly as the person's sidebar does, and sees a rename within one cache window.
- `kind: "folder"` — everything else (tmux, the PTY host, a stopped agent whose pane is gone, a cloud
  harness). `id` is the folder (or `cloud:<repository>`), and `label` is its name. Two agents in one
  folder are one workspace, which is the grouping a person would make by hand.

The second level needs no field of its own: it is `terminal.runtimes[].paneId`, which is what a
client opens, types into and reads. A rail groups; a runtime opens. An agent whose pane moved
reports the workspace it is in *now*, because the rail follows `primaryRuntimeKey`.

Building either level in a client from `project.cwd` alone is wrong: Herdr workspace labels are the
person's own words ("others", ".agents"), and a folder can hold a workspace the person renamed.

## What each client sends back

The same surface, whichever window the person used: `harness tell` / `agent_input` into the pane,
`agent_recent` for the conversation, `agent_update {opened: true}` so every client agrees on "last
used". Nothing is per-client state except the layout.

## Not built yet

- `HerdrBackend.openStream` — the terminal view can read (`capture`) but not stream bytes from a
  Herdr pane. Herdr offers `events.subscribe` (`pane_output_changed`) and `pane.read`, not a byte
  stream, so live terminal rendering has to be built from `pane.read` deltas. The chat page and the
  rail do not depend on it.
- The web client's tree column and the phone's workspace sections: the model is on the wire
  (`rail`), the screens are next.
