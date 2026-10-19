#!/usr/bin/env node
/**
 * pi agent CLI — HTTP/WebSocket client for a Pi Durable PI agent worker.
 *
 * Usage:  node scripts/pi.mjs <command> [args...]
 * Env:    PI_AGENT_URL    base URL (default http://localhost:8787)
 *         PI_AGENT_TOKEN  bearer token (required when AGENT_TOKEN is set)
 *
 * Commands:
 *   health | status | ping | usage
 *   tasks [status] | get <id> | add <title> [body...] | claim
 *   done <id> [result...] | fail <id> [error...]
 *   note <text...> | notes [limit] | state <status> [task...]
 *   conversations                    list durable conversations
 *   conv <id>                        show a conversation's resolved agent   (id: root)
 *   entries <id> [limit]             transcript entries (ascending)
 *   ask <text> [convId]              send a message, wait, print the answer
 *   abort <id> | reset <id> [handoff...]
 *   configure <id> <agentJson>       e.g. configure root '{"model":{"provider":"groq","modelId":"llama-3.3-70b-versatile"}}'
 *   listen [convId]                  stream agent events over WebSocket (Ctrl+C to stop)
 *   federation                       hub only (pi-global-agent)
 *
 * Examples:
 *   node scripts/pi.mjs ask "What is 2+2?"
 *   node scripts/pi.mjs ask "Also check the build" root
 *   PI_AGENT_URL=https://pi-global-agent.<sub>.workers.dev node scripts/pi.mjs federation
 */

const base = (process.env.PI_AGENT_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const token = process.env.PI_AGENT_TOKEN;

function headers(jsonBody) {
  return {
    ...(jsonBody ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: headers(!!body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    out = text;
  }
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  if (!res.ok) process.exit(1);
  return out;
}

function listen(convId) {
  const wsUrl =
    base.replace(/^http/, "ws") +
    `/ws?conversation=${encodeURIComponent(convId)}` +
    (token ? `&token=${encodeURIComponent(token)}` : "");
  const ws = new WebSocket(wsUrl);
  const heartbeat = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      /* closing */
    }
  }, 25_000);
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      console.log(ev.data);
      return;
    }
    if (msg.type === "pong") return;
    console.log(JSON.stringify(msg, null, 2));
  });
  ws.addEventListener("close", (ev) => {
    clearInterval(heartbeat);
    console.error(`stream closed (${ev.code})`);
    process.exit(ev.code === 1000 ? 0 : 1);
  });
  ws.addEventListener("error", () => {
    clearInterval(heartbeat);
    console.error("websocket error");
    process.exit(1);
  });
  console.error(`listening on ${wsUrl} — Ctrl+C to stop`);
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "health":
      return call("GET", "/health");
    case "status":
      return call("GET", "/status");
    case "ping":
      return call("GET", "/ping");
    case "usage":
      return call("GET", "/usage");

    case "tasks":
      return call("GET", `/tasks${args[0] ? `?status=${encodeURIComponent(args[0])}` : ""}`);
    case "get":
      return call("GET", `/tasks/${encodeURIComponent(args[0])}`);
    case "add": {
      const [title, ...rest] = args;
      if (!title) throw new Error("usage: add <title> [body...]");
      return call("POST", "/tasks", { title, body: rest.join(" ") || undefined });
    }
    case "claim":
      return call("POST", "/tasks/claim");
    case "done": {
      const [id, ...rest] = args;
      if (!id) throw new Error("usage: done <id> [result...]");
      return call("POST", `/tasks/${id}`, { status: "done", result: rest.join(" ") || undefined });
    }
    case "fail": {
      const [id, ...rest] = args;
      if (!id) throw new Error("usage: fail <id> [error...]");
      return call("POST", `/tasks/${id}`, { status: "failed", result: rest.join(" ") || undefined });
    }

    case "note": {
      if (!args.length) throw new Error("usage: note <text...>");
      return call("POST", "/notes", { body: args.join(" ") });
    }
    case "notes":
      return call("GET", `/notes${args[0] ? `?limit=${encodeURIComponent(args[0])}` : ""}`);
    case "state": {
      const [status, ...rest] = args;
      if (!status) throw new Error("usage: state <status> [currentTask...]");
      return call("POST", "/state/set", { status, currentTask: rest.join(" ") || undefined });
    }

    case "conversations":
      return call("GET", "/conversations");
    case "conv":
      return call("GET", `/conversations/${encodeURIComponent(args[0] ?? "root")}`);
    case "entries":
      return call("GET", `/conversations/${encodeURIComponent(args[0] ?? "root")}/entries${args[1] ? `?limit=${encodeURIComponent(args[1])}` : ""}`);
    case "ask": {
      const [text, conv = "root"] = args;
      if (!text) throw new Error("usage: ask <text> [convId]");
      const out = await call("POST", `/conversations/${encodeURIComponent(conv)}/messages`, {
        content: text,
        requestId: `cli:${Date.now()}`,
      });
      if (out && typeof out === "object" && out.status !== "done") process.exit(1);
      return;
    }
    case "abort":
      return call("POST", `/conversations/${encodeURIComponent(args[0] ?? "root")}/abort`);
    case "reset":
      return call("POST", `/conversations/${encodeURIComponent(args[0] ?? "root")}/reset`, {
        handoff: args.slice(1).join(" ") || undefined,
      });
    case "configure": {
      const [id, agentJson] = args;
      if (!id || !agentJson) throw new Error(`usage: configure <id> <agentJson>`);
      return call("POST", `/conversations/${encodeURIComponent(id)}/configure`, { agent: JSON.parse(agentJson) });
    }

    case "listen":
      return listen(args[0] ?? "root");
    case "federation":
      return call("GET", "/federation");

    default:
      console.error(`unknown command: ${cmd ?? "(none)"}\nRun: node scripts/pi.mjs help`);
      console.error(
        [
          "health | status | ping | usage",
          "tasks [status] | get <id> | add <title> [body] | claim | done <id> [result] | fail <id> [error]",
          "note <text> | notes [limit] | state <status> [task]",
          "conversations | conv <id> | entries <id> [limit]",
          "ask <text> [convId] | abort <id> | reset <id> [handoff] | configure <id> <agentJson>",
          "listen [convId] | federation",
        ].join("\n"),
      );
      process.exit(cmd && cmd !== "help" ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
