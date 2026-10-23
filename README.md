# pi-global-agent

> **Guide complet (architecture, fonctionnement, exemples)** : [GUIDE.md](GUIDE.md) — en français.
> **Référence API** : ce document.
> **Présentation (slides)** : `https://pelletierjy.github.io/pi-global-agent`

<img width="1997" height="824" alt="image" src="https://github.com/user-attachments/assets/b345eca8-2208-4e48-af93-4ffcb5431fd5" />

Cloudflare Worker + Durable Object running **[Pi Durable](https://earendil.com/posts/pi-durable/)** (`@earendil-works/pi-durable`) — the **main/global PI agent**. The four project workers (`pi-conversia-core`, `pi-homeworktutora`, `pi-scalesviewer`, `pi-globalvsthost`) run identical code with a different `name`/`AGENT_NAME`.

One singleton SQLite-backed Durable Object per worker hosts:

- **A Pi Durable Harness** — durable conversations (transcripts, model turns, checkpointed tasks) that survive crashes/redeploys, with background compaction and exactly-once submissions (`requestId`)
- **Mission-control tables** — the task queue, session-memory notes, conversation index (shared database via the DO's SQLite adapter, Pi tables prefixed `pi_`)
- **Agent tools** — `list_tasks` + `add_note` so the agent itself reads/extends its own queue and memory
- **Federation** (hub only) — `PEERS` lists the four project workers

## Endpoints

Base: `https://pi-global-agent.<sub>.workers.dev` (custom domain `pi-global-agent.jyp.solutions` once the zone is delegated) — locally `http://localhost:8787`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health`, `/` | liveness + discovery (no auth) |
| GET | `/status` | state, queue counts, conversation count |
| GET | `/usage` | session token/cost totals |
| GET/POST | `/tasks`, POST `/tasks/claim`, GET/POST `/tasks/:id` | mission-control queue (`pending → in_progress → done/failed`) |
| GET/POST | `/notes` | session memory |
| POST | `/state/set` | `{status, currentTask}` |
| GET/POST | `/conversations` | list / create durable conversations |
| GET | `/conversations/:id[/entries]` | resolved agent / transcript (`id` = `root` or a UUID) |
| POST | `/conversations/:id/messages` | `{content, requestId?, whenBusy?}` → waits, returns `{status, text}` |
| POST | `/conversations/:id/abort\|reset\|configure` | conversation control |
| WS | `/ws?conversation=root` | agent-event stream: `hello` (+snapshot), `events` deltas, `changed` broadcasts |
| GET/POST | `/federation`, `/federation/task\|note` | aggregate / dispatch to peers |

## Quick start

```sh
npm install
npm run dev        # http://localhost:8787
npm run typecheck
npm run deploy
```

Auth: shared `AGENT_TOKEN` worker secret (`Authorization: Bearer …`, WebSocket `?token=`). Local: `.dev.vars` (gitignored). Provider keys are read from worker secrets: `DEEPSEEK_API_KEY` (default model `deepseek/deepseek-flash`), plus `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` for other models.

Change the default model on a conversation:

```sh
node scripts/pi.mjs configure root '{"model":{"provider":"groq","modelId":"llama-3.3-70b-versatile"}}'
```

## CLI

```sh
export PI_AGENT_URL=https://pi-global-agent.<sub>.workers.dev
export PI_AGENT_TOKEN=<token>

node scripts/pi.mjs status
node scripts/pi.mjs ask "Summarize the current task queue"      # durable chat → answer text
node scripts/pi.mjs add "Refactor guardrails" "src/services/…"
node scripts/pi.mjs claim && node scripts/pi.mjs done 1 "done"
node scripts/pi.mjs note "kept limits in models/constants.ts"
node scripts/pi.mjs listen root                                  # live agent events (WebSocket)
node scripts/pi.mjs federation                                   # every agent at once
```

## WebSocket

Connect to `/ws?conversation=root&token=<AGENT_TOKEN>`:

```js
const ws = new WebSocket(`wss://${host}/ws?conversation=root&token=${token}`);
ws.onmessage = (ev) => console.log(JSON.parse(ev.data));  // hello → events → changed
setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 25_000);  // heartbeat (also re-attaches after hibernation)
```

Send a message over HTTP (`ask`/`POST …/messages`); the answer streams to the socket as agent events (message deltas, tool calls) and lands in the transcript.

## Durability model

- Everything is committed to the DO's SQLite before it is shown: transcripts, queued submissions, tool intent, checkpoints.
- A crash/redeploy mid-run is picked up by `harness.resume()` — interrupted work continues from its last checkpoint; `requestId` makes retries exactly-once.
- Mission-control and Pi share one database through the DO's queue (`DurableObjectSqliteDatabase` + `pi_` prefix), so queue writes never race a Pi transaction.

## Notes

- `global_fetch_strictly_public` is required for `/federation` (same-zone worker→worker `fetch()` is blocked with 1042 otherwise).
- Custom domains (`pi-*.jyp.solutions`): requires the `jyp.solutions` zone on this Cloudflare account — delegate NS to the assigned Cloudflare nameservers, then re-deploy; update `PEERS` to the new URLs.
- Workers are unchanged in name (`pi-global-agent`, …); the Durable Object class/migration is the same (`PiAgent`, SQLite) — existing storage and secrets carry over.

## Fleet scenarios (C/D/E/B)

- **Weekly sweep (C)** — the hub cron (`0 13 * * 1`) digests every peer's queue into a hub note and dispatches `SWEEP_TASK` (deduplicated). Manual: `POST /federation/sweep`; results view: `GET /federation/tasks`.
- **Realtime dashboard (D)** — `GET /dashboard`: five cards (state, queues, notes, model) plus a live WebSocket event feed — and it is **interactive**: quick-add tasks per agent, mark pending tasks done with a result, read/add notes, ask any agent from the toolbar (dropdown + question), plus hub **Brief** (morning brief) and **Sweep** buttons. Token via `?token=`, the input box, or localStorage. Every control costs a request only on click (quota-friendly); details panels load lazily and refresh on WS `changed` events.
- **Local execution (E)** — the model tools `run_command` / `read_file` / `write_file` reach this machine through `runner.mjs`, an outbound-only poller with root-confined file access: `PI_AGENT_TOKEN=... node runner.mjs`.
- **Morning brief (B)** — `node scripts/morning.mjs` prints every peer's state and open tasks, then asks the hub agent for a prioritized brief (saved to memory with `add_note`). `--no-ask` prints raw data only.

### Operational notes
- **Stop the runner before `wrangler deploy`, restart it after**: its polling keeps the Durable Objects alive, and DOs only load new code on restart.
- **Free Workers quota (~100k req/day, resets 00:00 UTC)**: the runner idles at 1 claim per worker every 30 s (`PI_POLL_MS` to tune; drains fast when work exists), the dashboard polls every 2 min and pauses on hidden tabs. HTTP 429 / error 1027 = quota spent — wait for the reset instead of retrying.
- Dashboard/WS URLs use `*.need-homework.workers.dev` until the `jyp.solutions` custom domains are enabled (the `routes` entry is commented in `wrangler.jsonc`).
