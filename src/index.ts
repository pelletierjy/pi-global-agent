/**
 * PI agent worker — Pi Durable (@earendil-works/pi-durable) on a Cloudflare Durable Object.
 *
 * One deployment per PI coding agent (the global agent + one project each). The
 * Durable Object class is `PiAgent` (singleton instance, internal id "default").
 * Its SQLite storage backs BOTH:
 *
 *   - a Pi Durable Harness (durable conversations, checkpointed tasks, model
 *     turns, tool calls — resumes after crashes/redeploys), tables prefixed `pi_`
 *   - the mission-control tables (task queue, notes, conversation index)
 *
 * Endpoints (auth: AGENT_TOKEN bearer, WS via ?token=):
 *   GET  /health, /                      discovery (open)
 *   GET  /status                         agent status + queue counts
 *   GET  /usage                          session token/cost totals
 *   GET  /ping, GET|POST /tasks, POST /tasks/claim, GET|POST /tasks/:id
 *   GET  /notes, POST /state/set
 *   GET  /conversations                  list (root + created)
 *   POST /conversations                  {label?, agent?} → new durable conversation
 *   GET  /conversations/:id              resolved agent (id "root" = root conversation)
 *   GET  /conversations/:id/entries      transcript page
 *   POST /conversations/:id/messages     {content, requestId?, whenBusy?} → submit + wait + answer text
 *   POST /conversations/:id/abort | /reset | /configure
 *   WS   /ws?conversation=root           agent-event stream (snapshot + deltas + changed)
 *   GET  /federation, POST /federation/task|note   (worker-level; hub lists PEERS)
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  ROOT_CONVERSATION_ID,
  watchEvents,
  type AgentChange,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import {
  DurableObjectSqliteDatabase,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { DASHBOARD_HTML } from "./dashboard";

/* ------------------------------------------------------------------ types */

export type Env = {
  /** Durable Object binding; class name must match wrangler config. */
  PiAgent: DurableObjectNamespace;
  /** Display name: "global", "conversia-core", ... */
  AGENT_NAME: string;
  /** Bearer token guarding everything except /health and /. */
  AGENT_TOKEN?: string;
  /** JSON array of peer workers for /federation (hub only). */
  PEERS?: string;
};

type TaskStatus = "pending" | "in_progress" | "done" | "failed";

type TaskRow = {
  id: number;
  title: string;
  body: string | null;
  status: TaskStatus;
  result: string | null;
  created_at: number;
  updated_at: number;
};

type NoteRow = { id: number; body: string; created_at: number };

type AgentState = { status: string; currentTask: string; currentTaskId?: number };

const TASK_STATUSES: TaskStatus[] = ["pending", "in_progress", "done", "failed"];

/** Default model for new root conversations. Change per conversation via POST /conversations/:id/configure. */
const DEFAULT_MODEL = { provider: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" } as const;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const HOST_TABLES = [
  `CREATE TABLE IF NOT EXISTS exec_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    output TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    label TEXT,
    created_at INTEGER NOT NULL
  )`,
];

/* ---------------------------------------------------------------- helpers */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

async function tryJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clampLimit(value: unknown, fallback = 50): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : fallback;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as string[]).includes(value);
}

/** Conversation ids are branded numbers (`Id<"conversation">`); "root" maps to the reserved id. */
function parseConversationId(param: string): ConversationId | undefined {
  if (param === "root") return ROOT_CONVERSATION_ID;
  const n = Number(param);
  return Number.isSafeInteger(n) && n > 0 ? (n as unknown as ConversationId) : undefined;
}

/**
 * Provider keys come from Worker vars/secrets (the env bindings): process.env
 * is not populated inside workerd, so pi-ai's default auth context finds nothing.
 */
function buildModels(env: Env): MutableModels {
  const bindings = env as unknown as Record<string, unknown>;
  const models = createModels({
    authContext: {
      async env(name: string): Promise<string | undefined> {
        const binding = bindings[name];
        if (typeof binding === "string" && binding.trim()) return binding;
        const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
        return typeof proc === "string" && proc.trim() ? proc : undefined;
      },
      async fileExists(): Promise<boolean> {
        return false;
      },
    },
  });
  models.setProvider(deepseekProvider());
  models.setProvider(groqProvider());
  models.setProvider(openrouterProvider());
  models.setProvider(googleProvider());
  return models;
}

/** Flatten an AssistantEntry's model messages to plain text. */
function textOf(entry: unknown): string {
  const model = (entry as { model?: unknown } | null | undefined)?.model;
  if (!Array.isArray(model)) return "";
  const parts: string[] = [];
  for (const msg of model) {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: unknown; text?: unknown };
        if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
  }
  return parts.join("");
}

/* --------------------------------------------------------- worker: routing */

const DEFAULT_INSTANCE = "default";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health") {
      return json({ ok: true, agent: env.AGENT_NAME, runtime: "pi-durable" });
    }
    if (url.pathname === "/dashboard") {
      const authError = requireAuth(request, env);
      if (authError) return authError;
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", ...CORS },
      });
    }
    if (url.pathname === "/") {
      return json({
        agent: env.AGENT_NAME,
        runtime: "pi-durable",
        endpoints: {
          status: "GET /status",
          usage: "GET /usage",
          tasks: "GET|POST /tasks, POST /tasks/claim, GET|POST /tasks/:id",
          notes: "GET|POST /notes",
          state: "POST /state/set",
          conversations: "GET|POST /conversations, GET /conversations/:id[/entries]",
          messages: "POST /conversations/:id/messages  (id: root or a conversation id)",
          control: "POST /conversations/:id/abort | /reset | /configure",
          websocket: "ws(s)://<host>/ws?conversation=root&token=<AGENT_TOKEN>",
          federation: "GET|POST /federation",
        },
      });
    }

    const authError = requireAuth(request, env);
    if (authError) return authError;

    if (url.pathname === "/federation" || url.pathname.startsWith("/federation/")) {
      return federation(request, env);
    }

    const stub = env.PiAgent.get(env.PiAgent.idFromName(DEFAULT_INSTANCE));
    return stub.fetch(request);
  },

  // Cron trigger (hub only — see triggers.crons in wrangler.jsonc). The sweep
  // digests every peer's queue into a hub note and dispatches the standing
  // audit task when SWEEP_TASK is configured. Same function as POST /federation/sweep.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSweep(env));
  },
} satisfies ExportedHandler<Env>;

function requireAuth(request: Request, env: Env): Response | null {
  if (!env.AGENT_TOKEN) return null;
  const url = new URL(request.url);
  const header = request.headers.get("authorization") ?? "";
  const query = url.searchParams.get("token");
  const ok = header === `Bearer ${env.AGENT_TOKEN}` || query === env.AGENT_TOKEN;
  return ok ? null : json({ error: "unauthorized" }, 401);
}

/* ---------------------------------------------------------- worker: peers */

type Peer = { name: string; url: string };

function parsePeers(env: Env): Peer[] {
  if (!env.PEERS?.trim()) return [];
  try {
    const value = JSON.parse(env.PEERS);
    if (!Array.isArray(value)) return [];
    return value
      .filter((p): p is Peer => !!p && typeof p === "object" && typeof (p as Peer).url === "string")
      .map((p) => ({ name: p.name ?? p.url, url: p.url.replace(/\/+$/, "") }));
  } catch {
    return [];
  }
}

function peerHeaders(env: Env): Record<string, string> {
  return env.AGENT_TOKEN ? { authorization: `Bearer ${env.AGENT_TOKEN}` } : {};
}

async function selfStatus(env: Env): Promise<unknown> {
  try {
    const stub = env.PiAgent.get(env.PiAgent.idFromName(DEFAULT_INSTANCE));
    const res = await stub.fetch(new Request("https://pi-agent/status"));
    return await res.json();
  } catch (e) {
    return { error: String(e) };
  }
}

async function federation(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/federation/, "") || "/";
  const peers = parsePeers(env);
  const headers = peerHeaders(env);

  if (request.method === "GET" && sub === "/tasks") return federationTasks(env);
  if (request.method === "POST" && sub === "/sweep") return runSweep(env);

  if (request.method === "GET" && (sub === "/" || sub === "/status")) {
    const self = await selfStatus(env);
    const results = await Promise.all(
      peers.map(async (peer) => {
        try {
          const res = await fetch(`${peer.url}/status`, { headers });
          return { name: peer.name, url: peer.url, ok: res.ok, status: await res.json() };
        } catch (e) {
          return { name: peer.name, url: peer.url, ok: false, error: String(e) };
        }
      }),
    );
    return json({ agent: env.AGENT_NAME, self, peers: results });
  }

  if (request.method === "POST" && (sub === "/task" || sub === "/note")) {
    const body = await tryJson(request);
    const only = url.searchParams.get("peer");
    const targets = only ? peers.filter((p) => p.name === only) : peers;
    const path = sub === "/task" ? "/tasks" : "/notes";
    const results = await Promise.all(
      targets.map(async (peer) => {
        try {
          const res = await fetch(`${peer.url}${path}`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          return { name: peer.name, ok: res.ok, body: await res.json() };
        } catch (e) {
          return { name: peer.name, ok: false, error: String(e) };
        }
      }),
    );
    return json({ dispatched: results.length, results });
  }

  return json({ error: "not_found", peers: peers.map((p) => p.name) }, 404);
}

/** GET /federation/tasks — pull every peer's recent tasks (how the hub "reads results"). */
async function federationTasks(env: Env): Promise<Response> {
  const peers = parsePeers(env);
  const headers = peerHeaders(env);
  const results = await Promise.all(
    peers.map(async (peer) => {
      try {
        const res = await fetch(`${peer.url}/tasks?limit=10`, { headers });
        return { name: peer.name, ok: res.ok, tasks: res.ok ? await res.json() : [] };
      } catch (e) {
        return { name: peer.name, ok: false, error: String(e), tasks: [] };
      }
    }),
  );
  return json({ generatedAt: Date.now(), peers: results });
}

/**
 * Scenario C: the weekly sweep. Digest every peer's queue into a hub note and,
 * when SWEEP_TASK is set, dispatch that audit task to each peer that does not
 * already have it pending (dedupe so reruns/cron overlaps are idempotent).
 * Called by the cron trigger and by POST /federation/sweep for manual runs.
 */
async function runSweep(env: Env): Promise<Response> {
  const peers = parsePeers(env);
  const headers = peerHeaders(env);
  const sweepTask = (env as unknown as { SWEEP_TASK?: string }).SWEEP_TASK?.trim();
  const parts: string[] = [];
  const dispatched: Record<string, unknown>[] = [];

  for (const peer of peers) {
    try {
      const statusRes = await fetch(`${peer.url}/status`, { headers });
      const status = (statusRes.ok ? await statusRes.json() : null) as {
        counts?: Record<string, unknown>;
        notes?: number;
      } | null;
      const counts = status?.counts ?? {};
      parts.push(
        `${peer.name}: pending=${counts.pending ?? '?'} in_progress=${counts.in_progress ?? '?'} done=${counts.done ?? '?'} notes=${status?.notes ?? '?'}`,
      );

      if (sweepTask) {
        // Dedupe: skip when a pending task with the same title already exists.
        const pendingRes = await fetch(`${peer.url}/tasks?status=pending&limit=50`, { headers });
        const pending = pendingRes.ok ? await pendingRes.json() : [];
        const duplicate = Array.isArray(pending) && pending.some((t: { title?: string }) => t.title === sweepTask);
        if (duplicate) {
          dispatched.push({ peer: peer.name, skipped: "already pending" });
        } else {
          const post = await fetch(`${peer.url}/tasks`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ title: sweepTask, body: "auto: scheduled sweep (pi-global-agent)" }),
          });
          dispatched.push({ peer: peer.name, ok: post.ok });
        }
      }
    } catch (e) {
      parts.push(`${peer.name}: ERROR ${String(e)}`);
    }
  }

  const self = await selfStatus(env);
  const selfCounts: Record<string, unknown> =
    (self as { counts?: Record<string, unknown> })?.counts ?? {};
  const digest =
    `Sweep ${new Date().toISOString()} | self: pending=${selfCounts.pending ?? '?'} done=${selfCounts.done ?? '?'} | ` +
    parts.join(" | ") +
    (sweepTask ? ` | dispatched: ${JSON.stringify(dispatched)}` : "");

  // Store the digest as a hub note (internal DO call — auth already handled at the worker edge).
  try {
    const stub = env.PiAgent.get(env.PiAgent.idFromName(DEFAULT_INSTANCE));
    await stub.fetch(
      new Request("https://pi-agent/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: digest }),
      }),
    );
  } catch (e) {
    return json({ error: "digest_store_failed", message: String(e), digest }, 500);
  }
  return json({ ok: true, digest, dispatched });
}

/* --------------------------------------------------------------- the DO -- */

export class PiAgent {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly database: DurableObjectSqliteDatabase;
  private hostReady?: Promise<void>;
  private harnessPromise?: Promise<Harness>;
  private readonly subs = new Map<WebSocket, { convId: string; stream?: AgentEventStream }>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    // Same SQLite database as Pi (prefix "pi_"); this adapter shares Pi's
    // operation queue, so host writes never race a Pi transaction.
    this.database = new DurableObjectSqliteDatabase(ctx.storage);
  }

  /* ---------------------------------------------------------- harness --- */

  private ensureHost(): Promise<void> {
    this.hostReady ??= (async () => {
      for (const sql of HOST_TABLES) await this.database.exec(sql);
    })();
    return this.hostReady;
  }

  private getHarness(): Promise<Harness> {
    this.harnessPromise ??= this.openHarness().catch((error) => {
      this.harnessPromise = undefined;
      throw error;
    });
    return this.harnessPromise;
  }

  private async openHarness(): Promise<Harness> {
    await this.ensureHost();
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" });
    const harness = await Harness.open(
      storage,
      {
        models: buildModels(this.env),
        registry: this.buildRegistry(),
        onReport: (error) => console.error("[pi-durable] reported:", error),
      },
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    // Creates the root conversation with the default agent on first use.
    await harness.root(BACKGROUND_CONTEXT, { agent: this.defaultAgent() });
    harness.closed.then((end) => {
      this.harnessPromise = undefined;
      if (end.reason === "failed") {
        console.error("[pi-durable] session failed:", end.error);
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1011, "session_failed");
          } catch {
            /* already gone */
          }
        }
      }
    });
    void this.reattachAll();
    return harness;
  }

  private defaultAgent(): AgentChange {
    return {
      model: { ...DEFAULT_MODEL },
      instructions:
        `You are the ${this.env.AGENT_NAME} PI agent. ` +
        "You have a durable mission-control queue (list_tasks) and session memory (add_note): " +
        "record decisions with add_note so future sessions of this agent keep the context.",
    };
  }

  private buildRegistry() {
    const registry = createRegistry();
    registry.install(this.missionControlExtension());
    registry.install(this.remoteExecExtension());
    return registry;
  }

  private missionControlExtension() {
    const db = this.database;
    return defineExtension({
      name: "mission-control",
      tools: [
        defineTool({
          name: "list_tasks",
          description:
            "List this agent's durable task queue (optionally filtered by status: pending, in_progress, done, failed).",
          parameters: Type.Object({ status: Type.Optional(Type.String()) }),
          replay: "safe",
          execute: async (args: { status?: string }) => {
            const rows = isTaskStatus(args.status)
              ? await db.all(`SELECT * FROM tasks WHERE status = ? ORDER BY id DESC LIMIT 100`, args.status)
              : await db.all(`SELECT * FROM tasks ORDER BY id DESC LIMIT 100`);
            return { output: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
          },
        }),
        defineTool({
          name: "add_note",
          description:
            "Append a durable session note to this agent's memory. Every future session of this agent can read it.",
          parameters: Type.Object({ body: Type.String() }),
          execute: async (args: { body: string }) => {
            await db.run(`INSERT INTO notes (body, created_at) VALUES (?, ?)`, args.body, Date.now());
            return { output: [{ type: "text" as const, text: "note saved" }] };
          },
        }),
      ],
    });
  }

  /* ------------------------------------------------------- WebSocket ----- */

  private upgrade(url: URL): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const convParam = url.searchParams.get("conversation") ?? "root";
    void this.attach(server, convParam).catch((e) => {
      try {
        server.send(JSON.stringify({ type: "error", error: String(e) }));
        server.close(1011, "attach_failed");
      } catch {
        /* gone */
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }


  private async attach(ws: WebSocket, convParam: string): Promise<void> {
    if (this.subs.get(ws)?.stream) return;
    this.subs.set(ws, { convId: convParam }); // sync marker: prevents double-attach
    try {
      // Per-socket identity that survives hibernation (DO WebSockets have no .id).
      ws.serializeAttachment(convParam);
    } catch {
      /* best effort */
    }
    try {
      const harness = await this.getHarness();
      const convId = parseConversationId(convParam);
      if (!convId) throw new Error(`invalid conversation: ${convParam}`);
      const stream = await watchEvents(harness, convId, BACKGROUND_CONTEXT);
      stream.start(async (events) => {
        try {
          ws.send(JSON.stringify({ type: "events", conversation: convId, events }));
        } catch {
          /* closed */
        }
      });
      this.subs.set(ws, { convId: convParam, stream });
      try {
        ws.send(
          JSON.stringify({
            type: "hello",
            agent: this.env.AGENT_NAME,
            conversation: convId,
            snapshot: stream.snapshot,
          }),
        );
      } catch {
        /* closed */
      }
    } catch (e) {
      this.subs.delete(ws);
      throw e;
    }
  }

  /** After a hibernation wake, restore event streams for sockets we still hold. */
  private async reattachAll(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.subs.has(ws)) continue;
      try {
        const attachment = ws.deserializeAttachment();
        const stored = typeof attachment === "string" && attachment ? attachment : "root";
        await this.attach(ws, stored);
      } catch (e) {
        console.error("[pi-durable] reattach failed:", e);
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    try {
      void message;
      if (!this.subs.get(ws)?.stream) {
        const attachment = ws.deserializeAttachment();
        const stored = typeof attachment === "string" && attachment ? attachment : "root";
        await this.attach(ws, stored);
      }
      try {
        ws.send(JSON.stringify({ type: "pong", serverTime: Date.now() }));
      } catch {
        /* closed */
      }
    } catch (e) {
      console.error("[pi-durable] ws message failed:", e);
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const sub = this.subs.get(ws);
    this.subs.delete(ws);
    if (sub?.stream) {
      try {
        await sub.stream.stop();
      } catch {
        /* session already closed */
      }
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1011, "error", false);
  }

  /* ------------------------------------------------ remote exec (scenario E) */

  /** Wait for the local runner to finish an exec request (polls the host table). */
  private async waitForExec(
    id: number,
    timeoutMs: number,
  ): Promise<{ status: string; output: string | null }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await this.database.get<{ status: string; output: string | null }>(
        `SELECT status, output FROM exec_requests WHERE id = ?`,
        id,
      );
      if (!row) throw new Error("exec request vanished from the queue");
      if (row.status === "done" || row.status === "failed") return row;
      if (Date.now() > deadline) {
        throw new Error(
          `remote executor timed out after ${Math.round(timeoutMs / 1000)}s — is runner.mjs running on the project machine?`,
        );
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private remoteExecExtension() {
    const db = this.database;
    const project = this.env.AGENT_NAME;
    const enqueue = async (kind: string, payload: Record<string, unknown>): Promise<number> => {
      const now = Date.now();
      const row = await db.get<{ id: number }>(
        `INSERT INTO exec_requests (project, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *`,
        project,
        kind,
        JSON.stringify(payload),
        now,
        now,
      );
      if (!row) throw new Error("failed to enqueue exec request");
      this.broadcastChanged("tasks");
      return row.id;
    };

    return defineExtension({
      name: "remote-exec",
      tools: [
        defineTool({
          name: "run_command",
          description:
            `Run a shell command on the ${project} project machine through the local runner ` +
            "(runner.mjs). Returns stdout/stderr with the exit code. Honors timeoutSeconds (default 120, max 300).",
          parameters: Type.Object({
            command: Type.String(),
            timeoutSeconds: Type.Optional(Type.Number()),
          }),
          execute: async (args: { command: string; timeoutSeconds?: number }) => {
            const id = await enqueue("command", { command: args.command });
            const timeout = Math.min(Math.max(args.timeoutSeconds ?? 120, 5), 300) * 1000;
            const row = await this.waitForExec(id, timeout);
            if (row.status === "failed") throw new Error(row.output ?? "command failed");
            return { output: [{ type: "text" as const, text: (row.output ?? "(no output)").slice(0, 40000) }] };
          },
        }),
        defineTool({
          name: "read_file",
          description: `Read a UTF-8 file inside the ${project} project (path relative to the project root).`,
          parameters: Type.Object({ path: Type.String() }),
          replay: "safe",
          execute: async (args: { path: string }) => {
            const id = await enqueue("read", { path: args.path });
            const row = await this.waitForExec(id, 60000);
            if (row.status === "failed") throw new Error(row.output ?? "read failed");
            return { output: [{ type: "text" as const, text: (row.output ?? "").slice(0, 80000) }] };
          },
        }),
        defineTool({
          name: "write_file",
          description: `Write a UTF-8 file inside the ${project} project (creates parent directories). Path is relative to the project root.`,
          parameters: Type.Object({ path: Type.String(), content: Type.String() }),
          execute: async (args: { path: string; content: string }) => {
            const id = await enqueue("write", { path: args.path, content: args.content });
            const row = await this.waitForExec(id, 60000);
            if (row.status === "failed") throw new Error(row.output ?? "write failed");
            return { output: [{ type: "text" as const, text: row.output ?? "written" }] };
          },
        }),
      ],
    });
  }

  /* ------------------------------------------------------- mission control */

  private broadcastChanged(scope: "tasks" | "notes" | "state"): void {
    const payload = JSON.stringify({ type: "changed", scope, at: Date.now() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* closed */
      }
    }
  }

  private async getState(): Promise<AgentState> {
    return (await this.ctx.storage.get<AgentState>("mc:state")) ?? { status: "idle", currentTask: "" };
  }

  private async setState(state: AgentState): Promise<AgentState> {
    await this.ctx.storage.put("mc:state", state);
    return state;
  }

  /* ------------------------------------------------------------ HTTP API - */

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.upgrade(url);
      await this.ensureHost();

      const seg = url.pathname.split("/").filter(Boolean);
      const method = request.method.toUpperCase();
      const body = method === "POST" ? await tryJson(request) : {};
      const db = this.database;

      /* ---------------- status / ping / usage ---------------- */
      if (seg.length === 0 || seg[0] === "status") {
        if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const counts: Record<TaskStatus, number> = { pending: 0, in_progress: 0, done: 0, failed: 0 };
        for (const row of await db.all<{ status: TaskStatus; n: number }>(
          `SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`,
        )) {
          if (row.status in counts) counts[row.status] = Number(row.n);
        }
        const notes = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notes`);
        const convs = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations`);
        return json({
          agent: this.env.AGENT_NAME,
          runtime: "pi-durable",
          serverTime: Date.now(),
          state: await this.getState(),
          root: ROOT_CONVERSATION_ID,
          defaultModel: DEFAULT_MODEL,
          counts,
          notes: Number(notes?.n ?? 0),
          conversations: 1 + Number(convs?.n ?? 0),
        });
      }
      if (seg[0] === "ping") return json({ pong: true, serverTime: Date.now() });
      if (seg[0] === "debug" && method === "GET") {
        const bindings = this.env as unknown as Record<string, unknown>;
        const models = buildModels(this.env);
        let auth: unknown;
        try {
          const res = await models.getAuth("deepseek");
          auth = res ? { found: true, source: res.source } : { found: false };
        } catch (e) {
          auth = { error: String(e) };
        }
        const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
        return json({
          envKeys: Object.keys(bindings).filter((k) => k.includes("API_KEY") || k.startsWith("AGENT_")),
          bindingPresent: typeof bindings.DEEPSEEK_API_KEY === "string",
          processEnvPresent: typeof proc?.DEEPSEEK_API_KEY === "string",
          auth,
        });
      }
      if (seg[0] === "usage") {
        const harness = await this.getHarness();
        return json(await harness.usage(BACKGROUND_CONTEXT));
      }

      /* ---------------- task queue ---------------- */
      if (seg[0] === "tasks") {
        if (seg.length === 1 && method === "GET") {
          const status = url.searchParams.get("status");
          if (status && !isTaskStatus(status)) return json({ error: "invalid_status" }, 400);
          const limit = clampLimit(url.searchParams.get("limit"));
          const rows = status
            ? await db.all(`SELECT * FROM tasks WHERE status = ? ORDER BY id DESC LIMIT ?`, status, limit)
            : await db.all(`SELECT * FROM tasks ORDER BY id DESC LIMIT ?`, limit);
          return json(rows);
        }
        if (seg.length === 1 && method === "POST") {
          const title = typeof body.title === "string" ? body.title.trim() : "";
          if (!title) return json({ error: "title_required" }, 400);
          const note = typeof body.body === "string" && body.body.trim() ? body.body : null;
          const now = Date.now();
          const row = await db.get<TaskRow>(
            `INSERT INTO tasks (title, body, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?) RETURNING *`,
            title,
            note,
            now,
            now,
          );
          this.broadcastChanged("tasks");
          return json(row, 201);
        }
        if (seg.length === 2 && seg[1] === "claim" && method === "POST") {
          // Atomic claim: one statement, no read-modify-write window.
          const row = await db.get<TaskRow>(
            `UPDATE tasks SET status = 'in_progress', updated_at = ?
             WHERE id = (SELECT id FROM tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1)
             RETURNING *`,
            Date.now(),
          );
          if (!row) return json({ error: "no_pending_tasks" }, 404);
          await this.setState({ status: "working", currentTask: row.title, currentTaskId: row.id });
          this.broadcastChanged("tasks");
          return json(row);
        }
        if (seg.length === 2) {
          const id = Number(seg[1]);
          if (!Number.isInteger(id) || id <= 0) return json({ error: "invalid_id" }, 400);
          if (method === "GET") {
            const row = await db.get(`SELECT * FROM tasks WHERE id = ?`, id);
            return row ? json(row) : json({ error: "task_not_found" }, 404);
          }
          if (method === "POST") {
            const set: string[] = [];
            const params: (string | number | null)[] = [];
            if (body.status !== undefined && body.status !== null) {
              if (!isTaskStatus(body.status)) return json({ error: "invalid_status" }, 400);
              set.push("status = ?");
              params.push(body.status);
            }
            if (body.result !== undefined) {
              set.push("result = ?");
              params.push(body.result === null ? null : String(body.result));
            }
            if (body.body !== undefined) {
              set.push("body = ?");
              params.push(body.body === null ? null : String(body.body));
            }
            if (!set.length) return json({ error: "nothing_to_update" }, 400);
            set.push("updated_at = ?");
            params.push(Date.now(), id);
            const row = await db.get<TaskRow>(`UPDATE tasks SET ${set.join(", ")} WHERE id = ? RETURNING *`, ...params);
            if (!row) return json({ error: "task_not_found" }, 404);
            const state = await this.getState();
            const isCurrent =
              state.currentTaskId !== undefined
                ? state.currentTaskId === row.id
                : state.currentTask === row.title; // legacy state persisted before currentTaskId existed
            if ((row.status === "done" || row.status === "failed") && isCurrent) {
              await this.setState({ status: "idle", currentTask: "" });
            }
            this.broadcastChanged("tasks");
            return json(row);
          }
        }
      }

      /* ---------------- session memory ---------------- */
      if (seg[0] === "notes" && seg.length === 1) {
        if (method === "GET") {
          const limit = clampLimit(url.searchParams.get("limit"));
          return json(await db.all(`SELECT * FROM notes ORDER BY id DESC LIMIT ?`, limit));
        }
        if (method === "POST") {
          const noteBody = typeof body.body === "string" ? body.body.trim() : "";
          if (!noteBody) return json({ error: "note_required" }, 400);
          const row = await db.get<NoteRow>(
            `INSERT INTO notes (body, created_at) VALUES (?, ?) RETURNING *`,
            noteBody,
            Date.now(),
          );
          this.broadcastChanged("notes");
          return json(row, 201);
        }
      }

      /* ---------------- agent state ---------------- */
      if (seg[0] === "state" && seg.length === 2 && seg[1] === "set" && method === "POST") {
        const status = typeof body.status === "string" && body.status.trim() ? body.status.trim() : "";
        if (!status) return json({ error: "status_required" }, 400);
        const currentTask = typeof body.currentTask === "string" ? body.currentTask : "";
        const next = await this.setState({ status, currentTask });
        this.broadcastChanged("state");
        return json(next);
      }

      /* ---------------- remote execution bridge (scenario E) ---------------- */
      if (seg[0] === "exec") {
        if (seg.length === 2 && seg[1] === "pending" && method === "GET") {
          const rows = await db.all(`SELECT * FROM exec_requests WHERE status = 'pending' ORDER BY id ASC LIMIT 10`);
          return json(rows);
        }
        if (seg.length === 2 && seg[1] === "claim" && method === "POST") {
          // Atomic claim: one statement, no read-modify-write window.
          const row = await db.get(
            `UPDATE exec_requests SET status = 'running', updated_at = ?
             WHERE id = (SELECT id FROM exec_requests WHERE status = 'pending' ORDER BY id ASC LIMIT 1)
             RETURNING *`,
            Date.now(),
          );
          return row ? json(row) : json({ error: "no_pending_exec" }, 404);
        }
        if (seg.length === 3 && seg[2] === "result" && method === "POST") {
          const status = body.status === "failed" ? "failed" : "done";
          const output = typeof body.output === "string" ? body.output.slice(0, 400000) : null;
          const row = await db.get(
            `UPDATE exec_requests SET status = ?, output = ?, updated_at = ? WHERE id = ? RETURNING *`,
            status,
            output,
            Date.now(),
            Number(seg[1]),
          );
          if (!row) return json({ error: "exec_not_found" }, 400);
          this.broadcastChanged("tasks");
          return json(row);
        }
      }

      /* ---------------- conversations ---------------- */
      if (seg[0] === "conversations") {
        const harness = await this.getHarness();

        if (seg.length === 1 && method === "GET") {
          const rows = await db.all<{ id: number; label: string; created_at: number }>(
            `SELECT id, label, created_at FROM conversations ORDER BY created_at DESC LIMIT 100`,
          );
          return json({
            conversations: [
              { id: ROOT_CONVERSATION_ID, label: "root", created_at: null },
              ...rows.map((r) => ({ id: r.id, label: r.label, created_at: r.created_at })),
            ],
          });
        }
        if (seg.length === 1 && method === "POST") {
          const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 120) : null;
          const agent =
            body.agent && typeof body.agent === "object" ? (body.agent as AgentChange) : this.defaultAgent();
          const conv = await harness.createConversation(
            { ownership: { kind: "ownerless" }, agent },
            BACKGROUND_CONTEXT,
          );
          await db.run(
            `INSERT OR REPLACE INTO conversations (id, label, created_at) VALUES (?, ?, ?)`,
            conv.id,
            label,
            Date.now(),
          );
          this.broadcastChanged("state");
          return json({ id: conv.id, label }, 201);
        }
        if (seg.length >= 2) {
          const conv = await this.resolve(harness, seg[1]);
          if (!conv) return json({ error: "conversation_not_found", id: seg[1] }, 404);

          if (seg.length === 2 && method === "GET") {
            const agent = await conv.agent(BACKGROUND_CONTEXT);
            return json({ id: conv.id, agent });
          }
          if (seg.length === 3 && seg[2] === "entries" && method === "GET") {
            const limit = clampLimit(url.searchParams.get("limit"));
            const page = await conv.entries({ order: "ascending" }, limit, undefined, BACKGROUND_CONTEXT);
            const { items, ...rest } = page as { items: unknown[] } & Record<string, unknown>;
            return json({ entries: items, page: rest });
          }
          if (seg.length === 3 && seg[2] === "messages" && method === "POST") {
            const content = typeof body.content === "string" && body.content.trim() ? body.content : null;
            if (!content) return json({ error: "content_required" }, 400);
            const whenBusy: "steer" | "reject" | "followUp" =
              body.whenBusy === "steer" || body.whenBusy === "reject" ? body.whenBusy : "followUp";
            const draft = {
              type: "input" as const,
              content,
              ...(typeof body.requestId === "string" && body.requestId ? { requestId: body.requestId } : {}),
              whenBusy,
            };
            const submission = await conv.submit(draft, BACKGROUND_CONTEXT);
            const settled = await submission.wait(BACKGROUND_CONTEXT);
            if (settled.status === "done" && settled.type === "input") {
              const entry = await conv.commit(
                (tx) => tx.entry(AssistantEntry, settled.answer),
                BACKGROUND_CONTEXT,
              );
              return json({
                status: "done",
                submissionId: submission.id,
                answerEntryId: settled.answer,
                text: textOf(entry),
              });
            }
            return json({
              status: settled.status,
              submissionId: submission.id,
              ...(settled.status === "unanswered" ? { reason: settled.reason, detail: settled.detail } : {}),
            });
          }
          if (seg.length === 3 && seg[2] === "abort" && method === "POST") {
            await conv.abort(BACKGROUND_CONTEXT);
            return json({ ok: true });
          }
          if (seg.length === 3 && seg[2] === "reset" && method === "POST") {
            const handoff = typeof body.handoff === "string" && body.handoff.trim() ? body.handoff : undefined;
            await conv.reset(handoff, BACKGROUND_CONTEXT);
            return json({ ok: true });
          }
          if (seg.length === 3 && seg[2] === "configure" && method === "POST") {
            if (!body.agent || typeof body.agent !== "object") return json({ error: "agent_required" }, 400);
            await conv.configure(body.agent as AgentChange, BACKGROUND_CONTEXT);
            return json({ ok: true, agent: await conv.agent(BACKGROUND_CONTEXT) });
          }
        }
      }

      return json({ error: "not_found", path: url.pathname }, 404);
    } catch (e) {
      return json({ error: "internal", message: String(e) }, 500);
    }
  }

  private async resolve(harness: Harness, idParam: string): Promise<Conversation | undefined> {
    const id = parseConversationId(idParam);
    return id === undefined ? undefined : harness.conversation(id, BACKGROUND_CONTEXT);
  }
}
