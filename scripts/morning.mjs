#!/usr/bin/env node
/**
 * morning.mjs — Scenario B: the morning brief.
 *
 * One command that answers "where does the fleet stand, and what should I do
 * today?":
 *
 *   1. GET  /federation          every peer's live status (state, queues, notes)
 *   2. GET  /federation/tasks    recent tasks across all peers (results view)
 *   3. POST /conversations/root/messages   asks the hub agent to turn it all
 *      into a short prioritized brief AND to save it with its add_note tool
 *      (so the brief becomes part of the hub's durable memory)
 *
 * Usage:
 *   node scripts/morning.mjs                # against PI_AGENT_URL (or hub default)
 *   node scripts/morning.mjs --no-ask       # print raw fleet data only, no model call
 *
 * Env: PI_AGENT_URL (default https://pi-global-agent.need-homework.workers.dev)
 *      PI_AGENT_TOKEN (required — workers enforce it)
 */

const HUB_DEFAULT = "https://pi-global-agent.need-homework.workers.dev";
const base = (process.env.PI_AGENT_URL ?? HUB_DEFAULT).replace(/\/+$/, "");
const token = process.env.PI_AGENT_TOKEN;
const ask = !process.argv.includes("--no-ask");

function headers(jsonBody) {
  return {
    ...(jsonBody ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function get(path) {
  const res = await fetch(base + path, { headers: headers(false) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  if (!token) {
    console.error("PI_AGENT_TOKEN is required (the workers enforce bearer auth).");
    process.exit(1);
  }

  console.log(`Fleet status via ${base}\n`);

  const fed = await get("/federation");
  console.log(`${pad("PEER", 18)}${pad("STATE", 12)}${pad("PEND", 6)}${pad("PROG", 6)}${pad("DONE", 6)}${pad("NOTES", 7)}CURRENT TASK`);
  const reportPeer = (name, status, ok) => {
    if (!ok || !status) return console.log(`${pad(name, 18)}(unreachable)`);
    const c = status.counts ?? {};
    const st = status.state?.status ?? "-";
    const cur = status.state?.currentTask ?? "";
    console.log(
      `${pad(name, 18)}${pad(st, 12)}${pad(c.pending ?? "?", 6)}${pad(c.in_progress ?? "?", 6)}${pad(c.done ?? "?", 6)}${pad(status.notes ?? "?", 7)}${cur}`,
    );
  };
  reportPeer(fed.agent + " (hub)", fed.self, true);
  for (const p of fed.peers) reportPeer(p.name, p.status, p.ok);

  const ft = await get("/federation/tasks");
  const open = [];
  for (const p of ft.peers) {
    for (const t of p.tasks ?? []) {
      if (t.status === "pending" || t.status === "in_progress") {
        open.push(`${p.name}: [${t.status}] ${t.title}`);
      }
    }
  }
  console.log(`\nOpen tasks across the fleet: ${open.length}`);
  open.slice(0, 12).forEach((t) => console.log(`  - ${t}`));

  if (!ask) return;

  const context = JSON.stringify(
    {
      fleetStatus: {
        self: { agent: fed.agent, ...(fed.self ?? {}) },
        peers: fed.peers.map((p) => ({ name: p.name, ok: p.ok, status: p.status })),
      },
      openTasks: open.slice(0, 30),
    },
    null,
    1,
  );

  console.log("\nAsking the hub agent for the brief...");
  // Provider flakiness is real (503 demand spikes, transient upstream 404s):
  // retry the brief up to 3 times before giving up.
  let out = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    out = await post("/conversations/root/messages", {
      content:
        "Good morning. Here is the live fleet data (JSON):\n" +
        context +
        "\n\nWrite a SHORT morning brief in French: 1) one line per project with its state, " +
        "2) the prioritized top 3 actions for today with reasons, 3) anything blocked or unhealthy. " +
        "Then call add_note once to save the exact same brief to memory (prefix: 'Morning brief').",
      requestId: `morning-${new Date().toISOString().slice(0, 10)}-${attempt}`,
    });
    if (out.status === "done") break;
    if (attempt < 3) {
      console.error(`  attempt ${attempt} failed (${out.status} ${out.reason ?? ""}) — retrying in 6s...`);
      await new Promise((r) => setTimeout(r, 6000));
    }
  }

  if (out.status === "done") {
    console.log("\n" + "=".repeat(72));
    console.log(out.text);
    console.log("=".repeat(72));
  } else {
    console.error(`brief failed: ${out.status} ${out.reason ?? ""} ${out.detail ?? ""}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
