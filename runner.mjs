#!/usr/bin/env node
/**
 * runner.mjs — local execution bridge for the PI Durable fleet (scenario E).
 *
 * The cloud agents call tools (run_command / read_file / write_file); the
 * Durable Object enqueues an exec request and waits. This runner:
 *
 *   1. OUTBOUND-ONLY polls each worker's GET /exec/pending  (no open port,
 *      no tunnel — Cloudflare never needs to reach your machine)
 *   2. claims a request  (POST /exec/claim, atomic)
 *   3. executes it locally inside the mapped project root
 *   4. posts the result   (POST /exec/:id/result)
 *
 * SECURITY: this executes whatever the (token-authenticated) agents ask, on
 * THIS machine, as YOUR user. Only run it with your own token, and keep the
 * project map minimal. File tools are confined to their project root
 * (path-escape is rejected); shell commands are NOT sandboxed.
 *
 * Config precedence:
 *   1. env PI_RUNNER_CONFIG   (path to a JSON file)
 *   2. ./runner.config.json
 *   3. env PI_PROJECTS         (JSON map of agent-name -> folder)
 *   4. built-in defaults (D:\Repos\<...>)
 *
 * Keys: token  (falls back to env PI_AGENT_TOKEN)
 *       urls   (falls back to the five deployed workers)
 *       projects: { "<AGENT_NAME>": "C:\\\\path\\\\to\\\\repo" }
 *
 * Usage:  node runner.mjs            (polls forever, logs to stdout)
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_URLS = [
  "https://pi-global-agent.need-homework.workers.dev",
  "https://pi-conversia-core.need-homework.workers.dev",
  "https://pi-homeworktutora.need-homework.workers.dev",
  "https://pi-scalesviewer.need-homework.workers.dev",
  "https://pi-globalvsthost.need-homework.workers.dev",
];

const DEFAULT_PROJECTS = {
  "conversia-core": "D:\\Repos\\conversia-core",
  homeworktutora: "D:\\Repos\\HomeworkTutora",
  scalesviewer: "D:\\Repos\\ScalesViewer",
  globalvsthost: "D:\\Repos\\GlobalVstHost",
};

async function loadConfig() {
  const candidates = [];
  if (process.env.PI_RUNNER_CONFIG) candidates.push(process.env.PI_RUNNER_CONFIG);
  candidates.push(path.join(process.cwd(), "runner.config.json"));
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      log(`config loaded from ${file}`);
      return parsed;
    } catch {
      /* try next */
    }
  }
  return {};
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(token, json) {
  return { ...(json ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` };
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return null; // nothing pending
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: headers(token, true),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Reject anything that would escape the project root. */
function safeResolve(root, rel) {
  const abs = path.resolve(root, rel);
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return abs;
}

const MAX_OUTPUT = 100_000;

function truncate(text) {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n...[truncated]" : text;
}

function runCommand(command, root, timeoutSeconds) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    let settled = false;
    const child = spawn(command, { cwd: root, shell: true, windowsHide: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* best effort */
      }
      resolve({
        status: "failed",
        output: truncate(out + `\n[TIMEOUT after ${timeoutSeconds}s; command killed]`),
      });
    }, timeoutSeconds * 1000);

    const collect = (chunk) => {
      out += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "failed", output: `spawn error: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const tail = signal ? `\n[killed by ${signal}]` : `\n(exit code: ${code})  [${seconds}s]`;
      resolve({ status: "done", output: truncate(out + tail) });
    });
  });
}

async function handleJob(job, projects) {
  const root = projects[job.project];
  if (!root) {
    return {
      status: "failed",
      output: `no project root mapped for '${job.project}' — add it to runner.config.json projects`,
    };
  }
  let payload = {};
  try {
    payload = JSON.parse(job.payload || "{}");
  } catch {
    return { status: "failed", output: "invalid payload JSON" };
  }

  try {
    if (job.kind === "command") {
      if (typeof payload.command !== "string" || !payload.command.trim()) {
        return { status: "failed", output: "missing command" };
      }
      log(`[${job.project}] $ ${payload.command}`);
      return await runCommand(payload.command, root, 300);
    }

    if (job.kind === "read") {
      const abs = safeResolve(root, payload.path ?? "");
      const stat = await fs.stat(abs);
      if (stat.size > 1_000_000) {
        return { status: "failed", output: `file too large (${stat.size} bytes > 1 MB)` };
      }
      const content = await fs.readFile(abs, "utf8");
      log(`[${job.project}] read ${payload.path} (${content.length} chars)`);
      return { status: "done", output: content };
    }

    if (job.kind === "write") {
      const abs = safeResolve(root, payload.path ?? "");
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const content = String(payload.content ?? "");
      await fs.writeFile(abs, content, "utf8");
      log(`[${job.project}] wrote ${payload.path} (${content.length} chars)`);
      return { status: "done", output: `wrote ${Buffer.byteLength(content)} bytes to ${payload.path}` };
    }

    return { status: "failed", output: `unknown exec kind '${job.kind}'` };
  } catch (err) {
    log(`[${job.project}] ${job.kind} FAILED: ${err.message}`);
    return { status: "failed", output: String(err.message || err) };
  }
}

async function main() {
  const cfg = await loadConfig();
  const token = cfg.token || process.env.PI_AGENT_TOKEN;
  if (!token) {
    console.error("PI_AGENT_TOKEN (or token in runner.config.json) is required — the workers reject unauthenticated polls.");
    process.exit(1);
  }
  const urls = (cfg.urls || (process.env.PI_AGENT_URLS ? process.env.PI_AGENT_URLS.split(",") : null) || DEFAULT_URLS)
    .map((u) => String(u).trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const projects = { ...DEFAULT_PROJECTS, ...(cfg.projects || {}), ...jsonEnv("PI_PROJECTS") };

  log(`runner up: ${urls.length} worker(s), ${Object.keys(projects).length} project(s) mapped`);
  for (const [name, dir] of Object.entries(projects)) log(`  ${name} -> ${dir}`);

  let sinceLog = Date.now();
  for (;;) {
    let didWork = false;
    for (const base of urls) {
      try {
        // Claim is atomic server-side; one claim per worker per cycle keeps the
        // loop simple and gives ~1 job/sec/worker throughput.
        const claimed = await postJson(`${base}/exec/claim`, token, {}).catch((e) => {
          if (String(e).includes("404")) return null;
          throw e;
        });
        if (claimed && claimed.id) {
          didWork = true;
          const result = await handleJob(claimed, projects);
          await postJson(`${base}/exec/${claimed.id}/result`, token, result);
          log(`[${claimed.project}] ${claimed.kind}#${claimed.id} -> ${result.status}`);
        }
      } catch (err) {
        log(`poll error ${base}: ${err.message}`);
      }
    }
    if (!didWork && Date.now() - sinceLog > 30000) {
      log(`idle; polling ${urls.length} worker(s) every 800ms`);
      sinceLog = Date.now();
    }
    await sleep(800);
  }
}

function jsonEnv(name) {
  try {
    return JSON.parse(process.env[name] || "{}");
  } catch {
    return {};
  }
}

main().catch((err) => {
  console.error("runner crashed:", err);
  process.exit(1);
});
