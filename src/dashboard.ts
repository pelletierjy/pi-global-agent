// src/dashboard.ts
//
// Scenarios D + B: one-page realtime, INTERACTIVE dashboard served by any
// worker at /dashboard (normally the hub).
//
// Design rules (free-tier quotas, ~100k req/day per pool):
//  - periodic polling only every 2 min, and only while the tab is visible;
//  - every interactive action costs requests ONLY when the user clicks;
//  - WS "changed" events refresh only the data that is already open.
//
// Token via ?token=, the input box, or localStorage.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PI Durable Fleet</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0e1a; color: #e0e6f1;
         font: 13px/1.45 ui-monospace, "Cascadia Code", Consolas, monospace; }
  header { display: flex; gap: 10px; align-items: center; padding: 10px 16px;
           border-bottom: 1px solid #1e2a4a; background: #12182b; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0 12px 0 0; color: #00e5ff; letter-spacing: .04em; }
  input, button, select { background: #1a2340; color: #e0e6f1; border: 1px solid #1e2a4a;
                  border-radius: 6px; padding: 6px 10px; font: inherit; }
  input { min-width: 260px; }
  input.ask { min-width: 340px; flex: 1; }
  button { cursor: pointer; white-space: nowrap; } button:hover { background: #243560; }
  button.on { border-color: #00e5ff; color: #00e5ff; }
  button.mini { padding: 2px 8px; font-size: 11px; }
  button.go { border-color: #00e5ff; color: #00e5ff; }
  button.warnb { border-color: #ffd740; color: #ffd740; }
  .ws { font-size: 11px; color: #8a96b8; } .ws.ok { color: #00e676; } .ws.err { color: #ff1744; }
  #toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 16px;
             background: #0f1525; border-bottom: 1px solid #1e2a4a; flex-wrap: wrap; }
  #answer { display: none; margin: 0 16px; background: #12182b; border: 1px solid #00e5ff;
            border-radius: 10px; padding: 12px 14px; white-space: pre-wrap; font-size: 12.5px;
            max-height: 40vh; overflow-y: auto; }
  #answer .who { color: #00e5ff; }
  #grid { display: grid; gap: 12px; padding: 16px;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  .card { background: #12182b; border: 1px solid #1e2a4a; border-radius: 10px; padding: 12px 14px; }
  .card h2 { font-size: 13px; margin: 0 0 8px; display: flex; justify-content: space-between; }
  .state { color: #ffd740; } .task { color: #8a96b8; min-height: 18px; }
  .counts { display: flex; gap: 14px; margin: 8px 0 4px; align-items: center; }
  .counts b { color: #00e5ff; font-size: 18px; font-weight: 600; }
  .counts span { font-size: 11px; color: #8a96b8; display: block; }
  .meta { font-size: 11px; color: #8a96b8; margin-top: 6px; word-break: break-all; }
  .qadd { display: flex; gap: 6px; margin-top: 8px; }
  .qadd input { min-width: 0; flex: 1; font-size: 12px; padding: 4px 8px; }
  details.more { margin-top: 8px; border-top: 1px dotted #1e2a4a; padding-top: 6px; }
  details.more summary { cursor: pointer; color: #7ea8ff; font-size: 12px; }
  .trow { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 3px 0; }
  .trow .tid { color: #8a96b8; min-width: 26px; }
  .trow .ttitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trow.inprog .ttitle { color: #ffd740; }
  .note { font-size: 11.5px; color: #c9d4ee; background: #0f1525; border-radius: 6px;
          padding: 4px 8px; margin: 4px 0; }
  .note .ts { color: #8a96b8; }
  .empty { color: #8a96b8; font-size: 11.5px; font-style: italic; }
  .mflag { color: #ffd740; }
  .mdef { color: #8a96b8; }
  #quota { display: none; margin: 8px 16px 0; border: 1px solid #ff1744;
           background: rgba(255,23,68,.12); color: #ff8a80; border-radius: 8px;
           padding: 8px 12px; font-size: 12px; }
  #totals, #cron { font-size: 11px; color: #7ea8ff; }
  .tfilters { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0 4px; }
  .tfilters button { padding: 1px 7px; font-size: 10.5px; border-color: #1e2a4a; color: #8a96b8; }
  .tfilters button.on { border-color: #00e5ff; color: #00e5ff; }
  .trow .age { color: #8a96b8; font-size: 10.5px; min-width: 32px; text-align: right; }
  .trow.failed { background: rgba(255,23,68,.10); border-radius: 6px; padding: 3px 4px; }
  .trow.failed .ttitle { color: #ff8a80; }
  .trow.done .ttitle { color: #8a96b8; }
  nav#tabs { display: flex; gap: 6px; padding: 8px 16px 0; background: #0f1525; border-bottom: 1px solid #1e2a4a; flex-wrap: wrap; align-items: flex-end; }
  nav#tabs button { background: transparent; border: 1px solid transparent; color: #8a96b8; font-size: 12px; padding: 6px 12px; cursor: pointer; }
  nav#tabs button.on { color: #00e5ff; border-color: #1e2a4a; background: #12182b; border-radius: 8px 8px 0 0; }
  .view { display: none; }
  .view.on { display: block; }
  .panel { background: #12182b; border: 1px solid #1e2a4a; border-radius: 10px; margin: 14px 16px; padding: 12px 14px; }
  .panel h3 { margin: 0 0 8px; font-size: 13px; color: #00e5ff; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .panel table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .panel th { text-align: left; color: #7ea8ff; font-size: 11px; padding: 4px 6px; border-bottom: 1px solid #1e2a4a; }
  .panel td { padding: 4px 6px; border-bottom: 1px dotted #131c33; vertical-align: top; word-break: break-word; }
  .panel td.res { color: #c9d4ee; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; border: 1px solid #1e2a4a; color: #8a96b8; white-space: nowrap; }
  .chip.ok { color: #00e676; border-color: rgba(0,230,118,.5); }
  .chip.bad { color: #ff1744; border-color: rgba(255,23,68,.5); }
  .chip.pend { color: #ffd740; border-color: rgba(255,215,64,.5); }
  .chip.prog { color: #00e5ff; border-color: rgba(0,229,255,.5); }
  .viewhead { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 14px 16px 0; }
  .viewhead input, .viewhead select { font-size: 12px; padding: 4px 8px; }
  .viewhead input.search { min-width: 240px; }
  .vtitle { color: #00e5ff; font-size: 13px; }
  .trans { background: #080c14; border: 1px solid #1e2a4a; border-radius: 8px; padding: 10px; max-height: 55vh; overflow-y: auto; font-size: 12px; }
  .trans .msg { margin: 6px 0; word-break: break-word; }
  .trans .msg b { color: #7ea8ff; }
  .trans .msg.assistant b { color: #00e676; }
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 46px; margin-top: 10px; min-height: 46px; }
  .spark div { background: linear-gradient(#00e5ff, #2979ff); width: 14px; border-radius: 2px 2px 0 0; }
  .ctrl { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .ctrl input { min-width: 120px; flex: 1; font-size: 12px; padding: 4px 8px; }
  .notif.on { border-color: #00e676; color: #00e676; }
  #feed { margin: 0 16px 24px; border: 1px solid #1e2a4a; border-radius: 10px;
          background: #080c14; padding: 10px 14px; max-height: 220px; overflow-y: auto; }
  #feed h3 { margin: 0 0 6px; font-size: 12px; color: #00e5ff; }
  #feed div { padding: 2px 0; border-bottom: 1px dotted #131c33; }
  .t { color: #8a96b8; } .who { color: #2979ff; } .err { color: #ff1744; }
  .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #1e2a4a;
          border-top-color: #00e5ff; border-radius: 50%; animation: sp .8s linear infinite;
          vertical-align: -2px; margin-right: 6px; }
  @keyframes sp { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<header>
  <h1>PI DURABLE FLEET</h1>
  <input id="token" type="password" placeholder="AGENT_TOKEN" />
  <button id="btn">Connect</button>
  <span id="summary" class="ws">idle</span>
  <span id="totals" class="ws" title="Sum of all 5 queues"></span>
  <span id="cron" class="ws" title="Next hub sweep (cron: Monday 13:00 UTC)"></span>
  <button class="mini notif" id="notifBtn" title="Browser notifications: failed tasks / stuck agents">notify off</button>
  <span style="margin-left:auto" class="ws">quotas: 2-min poll, hidden tabs = 0 requests</span>
</header>
<div id="quota"></div>

<div id="toolbar">
  <select id="askWorker"></select>
  <input id="askInput" class="ask" placeholder="Ask an agent… (Enter to send)" />
  <button id="askBtn" class="go">Ask</button>
  <button id="briefBtn" class="warnb" title="Ask the hub for the prioritized morning brief (saved to memory via add_note)">Brief</button>
  <button id="sweepBtn" title="Digest all peer queues into a hub note + dispatch SWEEP_TASK (deduped)">Sweep</button>
</div>
<div id="answer"></div>

<nav id="tabs">
  <button class="on" data-view="cards">cards</button>
  <button data-view="fed">federation</button>
  <button data-view="results">results</button>
  <button data-view="conv">conversations</button>
  <button data-view="notes">notes</button>
  <button data-view="exec">runner</button>
  <button data-view="costs">costs</button>
</nav>

<div id="view-cards" class="view on"><div id="grid"></div></div>

<div id="view-fed" class="view">
  <div class="panel"><h3>Federation status <button class="mini" id="fedRefresh">refresh</button></h3>
    <div id="fedTable"><span class="empty">loads when this tab opens</span></div>
  </div>
  <div class="panel"><h3>Dispatch to peers</h3>
    <div class="ctrl"><select id="fedPeer"><option value="">all peers</option></select>
      <input id="fedTitle" placeholder="task title…" />
      <button class="mini" id="fedTaskBtn">send task</button></div>
    <div class="ctrl"><input id="fedNote" placeholder="note body…" />
      <button class="mini" id="fedNoteBtn">send note</button></div>
    <div class="empty" id="fedOut"></div>
  </div>
</div>

<div id="view-results" class="view">
  <div class="viewhead"><b class="vtitle">Results — every queue</b>
    <input class="search" id="resSearch" placeholder="search title or result…" />
    <select id="resStatus"><option value="">any status</option><option value="done">done</option><option value="failed">failed</option><option value="pending">pending</option><option value="in_progress">working</option></select>
    <button class="mini" id="resRefresh">refresh</button></div>
  <div class="panel"><div id="resTable"><span class="empty">loads when this tab opens</span></div></div>
</div>

<div id="view-conv" class="view">
  <div class="viewhead"><b class="vtitle">Conversations (read-only)</b>
    <select id="convWorker"></select>
    <button class="mini" id="convRefresh">load list</button>
    <select id="convSel"><option value="">pick a conversation…</option></select>
    <select id="convStart" title="Which end of the transcript to load first">
      <option value="ascending">oldest first</option>
      <option value="descending">newest first</option>
    </select>
    <span class="empty" id="convInfo"></span></div>
  <div class="panel"><div class="trans" id="convTrans"><span class="empty">choose an agent → load → pick a conversation</span></div>
    <div class="ctrl"><button class="mini" id="convMore" style="display:none">load 50 more</button></div></div>
</div>

<div id="view-notes" class="view">
  <div class="viewhead"><b class="vtitle">Fleet notes</b>
    <input class="search" id="notesSearch" placeholder="search notes…" />
    <button class="mini" id="notesRefresh">refresh</button></div>
  <div class="panel"><div id="notesAll"><span class="empty">loads when this tab opens</span></div></div>
</div>

<div id="view-exec" class="view">
  <div class="viewhead"><b class="vtitle">Runner / exec monitor</b>
    <span class="empty" id="execLast"></span>
    <button class="mini" id="execRefresh">refresh</button></div>
  <div class="panel"><div id="execTable"><span class="empty">loads when this tab opens</span></div></div>
</div>

<div id="view-costs" class="view">
  <div class="viewhead"><b class="vtitle">Costs</b>
    <span class="empty" id="costTotal"></span>
    <button class="mini" id="costsRefresh">refresh</button></div>
  <div class="panel"><div id="costsTable"></div>
    <div class="spark" id="costSpark"></div>
    <div class="empty" id="costHist"></div></div>
</div>

<div id="feed"><h3>LIVE EVENT FEED</h3><div id="lines"></div></div>

<script>
(function () {
  var WORKERS = [
    "pi-global-agent", "pi-conversia-core", "pi-homeworktutora",
    "pi-scalesviewer", "pi-globalvsthost"
  ];
  var HUB = "pi-global-agent";
  var SUFFIX = ".need-homework.workers.dev";
  var override = new URLSearchParams(location.search).get("workers");
  if (override) WORKERS = override.split(",").map(function (s) { return s.trim(); });

  var token = new URLSearchParams(location.search).get("token") ||
              localStorage.getItem("pi_token") || "";
  var connected = false;
  var sockets = [];
  var pollTimer = null;
  var fails = {};   // per-worker reconnect backoff (15s -> 60s)
  var live = 0;
  var loaded = {};  // per-worker: are the detail lists already fetched?
  var seen = {};    // per-worker: distinguishes first connect from reconnect in the feed
  var tfilter = {}; // per-worker task-list filter (default: open)
  var actModel = {}; // per-worker: active model of the root conversation
  var lastMsgAt = {};  // per-worker: timestamp of last WS message (activity)
  var prevFailed = {}; // per-worker: previous failed count (notifications)
  var lastTaskName = {}; var lastTaskAt = {}; var notifStuck = {};
  var RESULTS = []; var NOTES = [];
  var notifyOn = localStorage.getItem("pi_notify") === "1";

  var gridEl = document.getElementById("grid");
  var lines = document.getElementById("lines");
  var summary = document.getElementById("summary");
  var btn = document.getElementById("btn");
  var answer = document.getElementById("answer");
  var askWorker = document.getElementById("askWorker");
  var askInput = document.getElementById("askInput");
  document.getElementById("token").value = token;

  WORKERS.forEach(function (w) {
    var o = document.createElement("option");
    o.value = w; o.textContent = w;
    askWorker.appendChild(o);
  });

  function baseOf(w) { return "https://" + w + SUFFIX; }

  async function api(base, path, method, body) {
    var res = await fetch(base + path, {
      method: method || "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        Authorization: "Bearer " + token
      },
      body: body ? JSON.stringify(body) : undefined
    });
    var text = await res.text();
    var out; try { out = JSON.parse(text); } catch (e) { out = text; }
    if (res.status === 429 || (typeof out === "string" && out.indexOf("1027") >= 0)) showQuota();
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (typeof out === "string" ? out.slice(0, 120) : JSON.stringify(out).slice(0, 160)));
    return out;
  }

  function showQuota() {
    var q = document.getElementById("quota");
    if (!q) return;
    q.style.display = "block";
    q.textContent = "⚠ Cloudflare free quota exhausted (HTTP 429 / error 1027) — " +
                    "requests are failing; wait for the reset at 00:00 UTC.";
    clearTimeout(showQuota._t);
    showQuota._t = setTimeout(function () { q.style.display = "none"; }, 120000);
  }

  function updateCron() {
    var el = document.getElementById("cron");
    if (!el) return;
    var now = new Date();
    var next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 0, 0));
    var add = (8 - next.getUTCDay()) % 7;              // days until Monday
    if (add === 0 && now.getTime() > next.getTime()) add = 7;
    next.setUTCDate(next.getUTCDate() + add);
    var ms = next.getTime() - now.getTime();
    var h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
    el.textContent = "next sweep: " +
      (d > 0 ? d + "d " + (h % 24) + "h" : h + "h " + Math.floor((ms % 3600000) / 60000) + "m");
  }

  function feed(who, html) {
    var d = document.createElement("div");
    d.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() +
                  '</span> <span class="who">' + who + "</span> " + html;
    lines.insertBefore(d, lines.firstChild);
    while (lines.childNodes.length > 120) lines.removeChild(lines.lastChild);
  }

  function showAnswer(html) {
    answer.style.display = "block";
    answer.innerHTML = html;
  }

  /* ---------- cards ---------- */
  function wsUrl(w) {
    return "wss://" + w + SUFFIX + "/ws?conversation=root&token=" + encodeURIComponent(token);
  }

  var cards = {};
  WORKERS.forEach(function (w) {
    var el = document.createElement("div");
    el.className = "card";
    el.innerHTML =
      '<h2><span>' + w + '</span><span class="ws" id="ws-' + w + '">offline</span></h2>' +
      '<div class="state" id="state-' + w + '">-</div>' +
      '<div class="task" id="task-' + w + '"></div>' +
      '<div class="counts">' +
        '<div><b id="pend-' + w + '">-</b><span>pending</span></div>' +
        '<div><b id="prog-' + w + '">-</b><span>in progress</span></div>' +
        '<div><b id="done-' + w + '">-</b><span>done</span></div>' +
        '<div><button class="mini" data-notes="' + w + '">notes <span id="notes-' + w + '">-</span></button></div>' +
      '</div>' +
      '<div class="meta" id="model-' + w + '"></div>' +
      '<div class="qadd">' +
        '<input id="newtask-' + w + '" placeholder="+ task (Enter to add)" />' +
      '</div>' +
      '<details class="more" data-details="' + w + '">' +
        '<summary>tasks &amp; notes</summary>' +
        '<div class="tfilters" id="tf-' + w + '"></div>' +
        '<div class="tasklist" id="tl-' + w + '"><span class="empty">loading…</span></div>' +
        '<div class="noteslist" id="nl-' + w + '"><span class="empty">loading…</span></div>' +
        '<button class="mini" data-addnote="' + w + '">+ note</button> ' +
        '<button class="mini" data-refresh="' + w + '">refresh</button> ' +
        '<button class="mini" data-usage="' + w + '">usage</button>' +
        '<div class="meta" id="usage-' + w + '"></div>' +
        '<div class="qadd" style="margin-top:6px">' +
          '<input id="newmodel-' + w + '" placeholder="set model: provider/model" />' +
          '<button class="mini" data-setmodel="' + w + '">set</button>' +
        '</div>' +
        '<div class="ctrl">' +
          '<button class="mini" data-abort="' + w + '">abort</button>' +
          '<button class="mini danger" data-reset="' + w + '">reset</button>' +
          '<input id="newtl-' + w + '" placeholder="thinkingLevel value" />' +
          '<button class="mini" data-tl="' + w + '">set tl</button>' +
        '</div>' +
      '</details>';
    gridEl.appendChild(el);
    cards[w] = el;

    // quick add task (Enter)
    el.querySelector("#newtask-" + w).addEventListener("keydown", async function (e) {
      if (e.key !== "Enter") return;
      var title = this.value.trim();
      if (!title || !connected) return;
      try {
        await api(baseOf(w), "/tasks", "POST", { title: title });
        this.value = "";
        feed(w, "task added: <b>" + title.replace(/</g, "&lt;") + "</b>");
        refreshAll(w);
      } catch (err) { feed(w, '<span class="err">add failed: ' + err.message + "</span>"); }
    });

    // lazy load details on first open
    el.querySelector("details[data-details]").addEventListener("toggle", function () {
      if (this.open) refreshAll(w);
    });

    el.querySelector("[data-refresh]").addEventListener("click", function () { refreshAll(w); });

    el.querySelector("[data-usage]").addEventListener("click", async function () {
      var box = el.querySelector("#usage-" + w);
      try {
        var u = await api(baseOf(w), "/usage");
        var models = u.models || {};
        var total = 0, parts = [];
        Object.keys(models).forEach(function (k) {
          var c = (models[k].cost && models[k].cost.total) || 0;
          total += c;
          parts.push(k + " $" + c.toFixed(4) + " (" + models[k].totalTokens + " tok)");
        });
        box.textContent = parts.length
          ? "usage: " + parts.join(" · ") + " · TOTAL $" + total.toFixed(4)
          : "usage: no data yet";
      } catch (err) { box.textContent = "usage error: " + err.message; }
    });

    el.querySelector("[data-setmodel]").addEventListener("click", async function () {
      var v = el.querySelector("#newmodel-" + w).value.trim();
      var slash = v.indexOf("/");
      if (slash <= 0 || slash === v.length - 1) {
        feed(w, '<span class="err">model must be provider/model (e.g. google/gemini-3.8-flash)</span>');
        return;
      }
      try {
        await api(baseOf(w), "/conversations/root/configure", "POST",
          { agent: { model: { provider: v.slice(0, slash), modelId: v.slice(slash + 1) } } });
        feed(w, "model → <b>" + v.replace(/</g, "&lt;") + "</b>");
        el.querySelector("#newmodel-" + w).value = "";
        poll();
      } catch (err) { feed(w, '<span class="err">configure failed: ' + err.message + "</span>"); }
    });

    el.querySelector("[data-notes]").addEventListener("click", function () {
      var d = el.querySelector("details[data-details]");
      d.open = true; refreshAll(w);
    });

    el.querySelector("[data-abort]").addEventListener("click", async function () {
      try {
        await api(baseOf(w), "/conversations/root/abort", "POST", {});
        feed(w, "conversation aborted"); poll();
      } catch (err) { feed(w, '<span class="err">abort failed: ' + err.message + "</span>"); }
    });
    el.querySelector("[data-reset]").addEventListener("click", async function () {
      if (!confirm("Reset the ROOT conversation of " + w + "? (clears its conversation state — make sure this is what you want)")) return;
      try {
        await api(baseOf(w), "/conversations/root/reset", "POST", {});
        feed(w, '<span class="err">conversation reset</span>'); poll();
      } catch (err) { feed(w, '<span class="err">reset failed: ' + err.message + "</span>"); }
    });
    el.querySelector("[data-tl]").addEventListener("click", async function () {
      var v = el.querySelector("#newtl-" + w).value.trim();
      if (!v) return;
      try {
        await api(baseOf(w), "/conversations/root/configure", "POST", { agent: { thinkingLevel: v } });
        feed(w, "thinkingLevel → " + v);
        el.querySelector("#newtl-" + w).value = "";
      } catch (err) { feed(w, '<span class="err">configure failed: ' + err.message + "</span>"); }
    });

    el.querySelector("[data-addnote]").addEventListener("click", async function () {
      var body = prompt("Add note (" + w + "):");
      if (!body) return;
      try {
        await api(baseOf(w), "/notes", "POST", { body: body });
        feed(w, "note saved");
        refreshAll(w);
      } catch (err) { feed(w, '<span class="err">note failed: ' + err.message + "</span>"); }
    });
  });

  var F_TASKS = [
    ["open", "open"], ["pending", "pending"], ["in_progress", "working"],
    ["done", "done"], ["failed", "failed"], ["all", "all"]
  ];

  function age(ts) {
    if (!ts) return "";
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }

  async function refreshAll(w) {
    try {
      var tasks = await api(baseOf(w), "/tasks?limit=30");
      var f = tfilter[w] || "open";
      var shown = tasks.filter(function (t) {
        return f === "all" ? true
          : f === "open" ? (t.status === "pending" || t.status === "in_progress")
          : t.status === f;
      });
      var tf = document.getElementById("tf-" + w);
      tf.innerHTML = "";
      F_TASKS.forEach(function (pair) {
        var b = document.createElement("button");
        b.className = "mini" + (f === pair[0] ? " on" : "");
        b.textContent = pair[1];
        b.onclick = function () { tfilter[w] = pair[0]; refreshAll(w); };
        tf.appendChild(b);
      });
      var tl = document.getElementById("tl-" + w);
      if (!shown.length) tl.innerHTML = '<span class="empty">no ' + (f === "all" ? "" : f + " ") + 'tasks</span>';
      else {
        tl.innerHTML = "";
        shown.forEach(function (t) {
          var row = document.createElement("div");
          row.className = "trow" +
            (t.status === "in_progress" ? " inprog" : "") +
            (t.status === "failed" ? " failed" : "") +
            (t.status === "done" ? " done" : "");
          var actions =
            t.status === "pending"
              ? '<button class="mini" data-claim="' + t.id + '">claim</button>' +
                '<button class="mini" data-done="' + t.id + '">done</button>'
              : t.status === "in_progress"
              ? '<span class="ws">working…</span>' +
                '<button class="mini" data-done="' + t.id + '">done</button>' +
                '<button class="mini" data-failed="' + t.id + '">fail</button>'
              : t.status === "failed"
              ? '<button class="mini" data-reopen="' + t.id + '">reopen</button>'
              : "";
          row.innerHTML =
            '<span class="age">' + age(t.created_at) + '</span>' +
            '<span class="tid">#' + t.id + '</span>' +
            '<span class="ttitle" title="' + String(t.title).replace(/"/g, "&quot;") +
              (t.status === "failed" && t.result ? " — " + String(t.result).replace(/"/g, "&quot;") : "") +
              '">' + String(t.title).replace(/</g, "&lt;") + "</span>" +
            actions;
          tl.appendChild(row);
        });
        function post(id, payload, label) {
          api(baseOf(w), "/tasks/" + id, "POST", payload).then(function () {
            feed(w, "task #" + id + " → " + label);
            refreshAll(w); poll();
          }).catch(function (err) {
            feed(w, '<span class="err">' + label + ' failed: ' + err.message + "</span>");
          });
        }
        tl.querySelectorAll("[data-done]").forEach(function (b) {
          b.addEventListener("click", function () {
            var id = this.getAttribute("data-done");
            var result = prompt("Result for #" + id + ":", "done from dashboard");
            if (result === null) return;
            post(id, { status: "done", result: result }, "done");
          });
        });
        tl.querySelectorAll("[data-failed]").forEach(function (b) {
          b.addEventListener("click", function () {
            var id = this.getAttribute("data-failed");
            var result = prompt("Failure reason for #" + id + ":", "");
            if (result === null) return;
            post(id, { status: "failed", result: result || "failed from dashboard" }, "failed");
          });
        });
        tl.querySelectorAll("[data-claim]").forEach(function (b) {
          b.addEventListener("click", function () {
            post(this.getAttribute("data-claim"), { status: "in_progress" }, "claimed");
          });
        });
        tl.querySelectorAll("[data-reopen]").forEach(function (b) {
          b.addEventListener("click", function () {
            post(this.getAttribute("data-reopen"), { status: "pending" }, "reopened");
          });
        });
      }
      var notes = await api(baseOf(w), "/notes?limit=8");
      var nl = document.getElementById("nl-" + w);
      if (!notes.length) nl.innerHTML = '<span class="empty">no notes yet</span>';
      else {
        nl.innerHTML = "";
        notes.forEach(function (n) {
          var d = document.createElement("div");
          d.className = "note";
          d.innerHTML = '<span class="ts">' + new Date(n.created_at).toLocaleString() + "</span> " +
                        String(n.body).replace(/</g, "&lt;");
          nl.appendChild(d);
        });
      }
      var st = await api(baseOf(w), "/status");
      document.getElementById("pend-" + w).textContent = st.counts.pending;
      document.getElementById("prog-" + w).textContent = st.counts.in_progress;
      document.getElementById("done-" + w).textContent = st.counts.done;
      document.getElementById("notes-" + w).textContent = st.notes;
      loaded[w] = true;
    } catch (err) {
      document.getElementById("tl-" + w).innerHTML = '<span class="empty err">' + err.message + "</span>";
    }
  }

  /* ---------- periodic status (visible tabs only) ---------- */
  async function poll() {
    var tot = { pending: 0, in_progress: 0, done: 0, failed: 0 };
    for (var i = 0; i < WORKERS.length; i++) {
      var w = WORKERS[i];
      try {
        var s = await api(baseOf(w), "/status");
        document.getElementById("state-" + w).textContent =
          (s.state && s.state.status ? s.state.status : "-") +
          (s.state && s.state.currentTask ? "  |  " + s.state.currentTask : "");
        document.getElementById("pend-" + w).textContent = s.counts.pending;
        document.getElementById("prog-" + w).textContent = s.counts.in_progress;
        document.getElementById("done-" + w).textContent = s.counts.done;
        document.getElementById("notes-" + w).textContent = s.notes;
        tot.pending += s.counts.pending || 0;
        tot.in_progress += s.counts.in_progress || 0;
        tot.done += s.counts.done || 0;
        tot.failed += s.counts.failed || 0;
        // notifications: failed-count increase + agent stuck > 30 min on the same task
        if (typeof s.counts.failed === "number") {
          if (typeof prevFailed[w] === "number" && s.counts.failed > prevFailed[w]) {
            notify(w + ": task failed", s.counts.failed + " failed task(s) — open the card");
            feed(w, '<span class="err">failed count ' + prevFailed[w] + " → " + s.counts.failed + "</span>");
          }
          prevFailed[w] = s.counts.failed;
        }
        var stt = (s.state && s.state.status) || "";
        var ct = (s.state && s.state.currentTask) || "";
        if (stt === "working" && ct) {
          if (lastTaskName[w] !== ct) { lastTaskName[w] = ct; lastTaskAt[w] = Date.now(); notifStuck[w] = false; }
          else if (!notifStuck[w] && lastTaskAt[w] && Date.now() - lastTaskAt[w] > 30 * 60 * 1000) {
            notifStuck[w] = true;
            notify(w + " looks stuck", "working on the same task for over 30 min: " + ct);
          }
        } else { lastTaskName[w] = ct; lastTaskAt[w] = Date.now(); notifStuck[w] = false; }
        var def = s.defaultModel ? s.defaultModel.provider + "/" + s.defaultModel.modelId : "?";
        var active = def;
        try {
          var conv = await api(baseOf(w), "/conversations/root");
          if (conv.agent && conv.agent.model) {
            active = conv.agent.model.provider + "/" + conv.agent.model.modelId;
          }
        } catch (e2) { /* fall back to default */ }
        actModel[w] = active;
        var esc = function (x) { return String(x).replace(/</g, "&lt;"); };
        var meta = "model: " + esc(active);
        if (active !== def) meta += ' <span class="mflag">&#9873; custom (default: ' + esc(def) + ")</span>";
        else meta += ' <span class="mdef">(default)</span>';
        meta += "  |  conv:" + s.conversations;
        document.getElementById("model-" + w).innerHTML = meta;
        document.getElementById("ws-" + w).textContent = connected ? "live" : "status ok";
        document.getElementById("ws-" + w).className = "ws ok";
      } catch (e) {
        var el = document.getElementById("ws-" + w);
        el.textContent = "status error: " + e.message;
        el.className = "ws err";
      }
    }
    var totEl = document.getElementById("totals");
    if (totEl) totEl.textContent = "queues: " + tot.pending + " pending · " + tot.in_progress +
      " working · " + tot.done + " done · " + tot.failed + " failed";
    updateCron();
  }

  /* ---------- ask / brief / sweep ---------- */
  var reqSeq = 0;
  async function askAgent(w, content, label) {
    showAnswer('<span class="spin"></span><span class="who">' + label + "</span> thinking…");
    try {
      var out = await api(baseOf(w), "/conversations/root/messages", "POST", {
        content: content,
        requestId: "dash-" + Date.now() + "-" + (++reqSeq)
      });
      if (out.status === "done") {
        showAnswer('<span class="who">' + label + " @ " + w + "</span>\\n\\n" +
                   String(out.text).replace(/</g, "&lt;"));
        feed(w, label + " → " + String(out.text).slice(0, 60).replace(/</g, "&lt;"));
      } else {
        showAnswer('<span class="err">' + label + " failed: " + out.status + " " + (out.reason || "") + "</span>\\n" +
                   (out.detail ? String(out.detail).replace(/</g, "&lt;") : ""));
      }
    } catch (err) {
      showAnswer('<span class="err">' + label + " failed: " + err.message + "</span>");
    }
  }

  document.getElementById("askBtn").addEventListener("click", function () {
    var q = askInput.value.trim();
    if (!q || !connected) return;
    askAgent(askWorker.value, q, "ask");
    askInput.value = "";
  });
  askInput.addEventListener("keydown", function (e) { if (e.key === "Enter") document.getElementById("askBtn").click(); });

  document.getElementById("briefBtn").addEventListener("click", async function () {
    if (!connected) return;
    if (!confirm("Ask the hub agent for the morning brief? (it saves it to memory with add_note)")) return;
    await askAgent(HUB,
      "Write a SHORT morning brief in French: one line per project with its state, " +
      "the prioritized top 3 actions for today with reasons, and anything blocked. " +
      "Then call add_note once to save it (prefix: 'Morning brief').",
      "brief");
  });

  document.getElementById("sweepBtn").addEventListener("click", async function () {
    if (!connected) return;
    if (!confirm("Run the fleet sweep? (digests every peer queue into a hub note + dispatches SWEEP_TASK, deduped)")) return;
    showAnswer('<span class="spin"></span><span class="who">sweep</span> running…');
    try {
      var out = await api(baseOf(HUB), "/federation/sweep", "POST", {});
      showAnswer('<span class="who">sweep digest</span>\\n\\n' + String(out.digest).replace(/</g, "&lt;"));
      feed(HUB, "sweep executed");
      WORKERS.forEach(function (w) { if (loaded[w]) refreshAll(w); });
    } catch (err) {
      showAnswer('<span class="err">sweep failed: ' + err.message + "</span>");
    }
  });

  /* ---------- websocket streams ---------- */
  function openSocket(w) {
    var ws = new WebSocket(wsUrl(w));
    sockets.push(ws);
    ws.onopen = function () { summary.textContent = "live on " + WORKERS.length + " workers"; };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      lastMsgAt[w] = Date.now();
      if (m.type === "hello") {
        fails[w] = 0;
        live = Math.min(WORKERS.length, live + 1);
        document.getElementById("ws-" + w).textContent = "live";
        document.getElementById("ws-" + w).className = "ws ok";
        summary.textContent = "live (" + live + "/" + WORKERS.length + ")";
        var convLabel = String(m.conversation) === "1" ? "root" : "conversation " + m.conversation;
        feed(w, "<b>" + (seen[w] ? "reconnected" : "connected") + "</b> · streaming " + convLabel + " events");
        seen[w] = true;
      } else if (m.type === "changed") {
        feed(w, "changed: <b>" + m.scope + "</b>");
        if (m.scope === "tasks" || m.scope === "notes") { if (loaded[w]) refreshAll(w); }
        else poll();
      } else if (m.type === "events") {
        feed(w, "events: " + (m.events ? m.events.length : 0) + " update(s)");
      }
    };
    ws.onclose = function () {
      live = Math.max(0, live - 1);
      var el = document.getElementById("ws-" + w);
      el.textContent = "disconnected";
      el.className = "ws";
      if (!connected || document.hidden) return;   // no storms: intent off or background tab
      fails[w] = Math.min(4, (fails[w] || 0) + 1);
      var delay = Math.min(60000, 15000 * Math.pow(2, fails[w] - 1));  // 15s..60s
      feed(w, '<span class="err">ws closed - retry in ' + (delay / 1000) + "s</span>");
      setTimeout(function () { if (connected && !document.hidden) openSocket(w); }, delay);
    };
    ws.onerror = function () {};
  }

  function esc(x) { return String(x == null ? "" : x).replace(/</g, "&lt;"); }

  /* ---------- tabs & views ---------- */
  function chipFor(s) {
    return s === "done" ? '<span class="chip ok">done</span>'
      : s === "failed" ? '<span class="chip bad">failed</span>'
      : s === "in_progress" ? '<span class="chip prog">working</span>'
      : '<span class="chip pend">' + esc(s) + "</span>";
  }
  function num(x) { return typeof x === "number" ? x : "-"; }

  var VIEWS = ["cards", "fed", "results", "conv", "notes", "exec", "costs"];
  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("#tabs button").forEach(function (x) { x.className = ""; });
      b.className = "on";
      var v = b.getAttribute("data-view");
      VIEWS.forEach(function (name) {
        var el = document.getElementById("view-" + name);
        if (el) el.className = name === v ? "view on" : "view";
      });
      if (v === "fed") loadFed();
      else if (v === "results") loadResults();
      else if (v === "conv") loadConvList();
      else if (v === "notes") loadNotes();
      else if (v === "exec") loadExec();
      else if (v === "costs") loadCosts();
    });
  });

  /* --- federation view --- */
  async function loadFed() {
    var box = document.getElementById("fedTable");
    box.innerHTML = '<span class="empty">loading…</span>';
    try {
      var f = await api(baseOf(HUB), "/federation");
      var rows = [fedRow("hub · " + (f.agent || "global"), true, f.self)];
      (f.peers || []).forEach(function (p) { rows.push(fedRow(p.name, p.ok, p.status)); });
      box.innerHTML = "<table><tr><th>agent</th><th>link</th><th>state</th><th>pending</th><th>working</th><th>done</th><th>failed</th><th>notes</th><th>default model</th></tr>" +
        rows.join("") + "</table>";
      var sel = document.getElementById("fedPeer");
      var keep = sel.value;
      sel.innerHTML = '<option value="">all peers</option>';
      (f.peers || []).forEach(function (p) {
        var o = document.createElement("option"); o.value = p.name; o.textContent = p.name; sel.appendChild(o);
      });
      sel.value = keep;
    } catch (e) { box.innerHTML = '<span class="empty err">' + esc(e.message) + "</span>"; }
  }
  function fedRow(name, ok, st) {
    var c = (st && st.counts) || {};
    var m = st && st.defaultModel ? st.defaultModel.provider + "/" + st.defaultModel.modelId : "-";
    var state = st && st.state ? st.state.status + (st.state.currentTask ? " · " + esc(st.state.currentTask) : "") : "-";
    return "<tr><td><b>" + esc(name) + "</b></td>" +
      "<td>" + (ok ? '<span class="chip ok">ok</span>' : '<span class="chip bad">down</span>') + "</td>" +
      "<td>" + state + "</td><td>" + num(c.pending) + "</td><td>" + num(c.in_progress) +
      "</td><td>" + num(c.done) + "</td><td>" + num(c.failed) + "</td><td>" + num(st && st.notes) +
      "</td><td>" + esc(m) + "</td></tr>";
  }
  document.getElementById("fedRefresh").addEventListener("click", loadFed);
  document.getElementById("fedTaskBtn").addEventListener("click", async function () {
    var peer = document.getElementById("fedPeer").value;
    var title = document.getElementById("fedTitle").value.trim();
    var out = document.getElementById("fedOut");
    if (!title) { out.textContent = "task title required"; return; }
    try {
      var r = await api(baseOf(HUB), "/federation/task" + (peer ? "?peer=" + encodeURIComponent(peer) : ""),
        "POST", { title: title });
      out.textContent = "task dispatched to " + r.dispatched + " peer(s)";
      document.getElementById("fedTitle").value = "";
      feed(HUB, "dispatched task → " + (peer || "all peers"));
    } catch (e) { out.textContent = "error: " + e.message; }
  });
  document.getElementById("fedNoteBtn").addEventListener("click", async function () {
    var peer = document.getElementById("fedPeer").value;
    var body = document.getElementById("fedNote").value.trim();
    var out = document.getElementById("fedOut");
    if (!body) { out.textContent = "note body required"; return; }
    try {
      var r = await api(baseOf(HUB), "/federation/note" + (peer ? "?peer=" + encodeURIComponent(peer) : ""),
        "POST", { body: body });
      out.textContent = "note sent to " + r.dispatched + " peer(s)";
      document.getElementById("fedNote").value = "";
      feed(HUB, "dispatched note → " + (peer || "all peers"));
    } catch (e) { out.textContent = "error: " + e.message; }
  });

  /* --- results view --- */
  async function loadResults() {
    var box = document.getElementById("resTable");
    box.innerHTML = '<span class="empty">loading…</span>';
    try {
      var mine = await api(baseOf(HUB), "/tasks?limit=30");
      var fed = await api(baseOf(HUB), "/federation/tasks");
      RESULTS = [];
      (mine || []).forEach(function (t) { RESULTS.push({ w: HUB, t: t }); });
      (fed.peers || []).forEach(function (p) {
        (p.tasks || []).forEach(function (t) { RESULTS.push({ w: p.name, t: t }); });
      });
      renderResults();
    } catch (e) { box.innerHTML = '<span class="empty err">' + esc(e.message) + "</span>"; }
  }
  function renderResults() {
    var q = (document.getElementById("resSearch").value || "").toLowerCase();
    var stf = document.getElementById("resStatus").value;
    var rows = (RESULTS || []).filter(function (r) {
      if (stf && r.t.status !== stf) return false;
      if (!q) return true;
      return (String(r.t.title) + " " + String(r.t.result || "")).toLowerCase().indexOf(q) >= 0;
    });
    var html = rows.map(function (r) {
      var res = String(r.t.result || "");
      return "<tr><td>" + esc(r.w) + "</td><td>#" + r.t.id + "</td><td>" + chipFor(r.t.status) + "</td>" +
        '<td title="' + esc(String(r.t.title)).replace(/"/g, "&quot;") + '">' + esc(String(r.t.title)).slice(0, 90) + "</td>" +
        '<td class="res" title="' + esc(res).replace(/"/g, "&quot;") + '">' + esc(res.slice(0, 220)) + (res.length > 220 ? "…" : "") + "</td>" +
        "<td>" + age(r.t.updated_at || r.t.created_at) + "</td></tr>";
    }).join("");
    document.getElementById("resTable").innerHTML =
      html ? "<table><tr><th>agent</th><th>id</th><th>status</th><th>title</th><th>result</th><th>age</th></tr>" + html + "</table>"
           : '<span class="empty">no tasks match</span>';
  }
  document.getElementById("resRefresh").addEventListener("click", loadResults);
  document.getElementById("resSearch").addEventListener("input", renderResults);
  document.getElementById("resStatus").addEventListener("change", renderResults);

  /* --- conversations view (read-only) --- */
  var cwEl = document.getElementById("convWorker");
  WORKERS.forEach(function (w) { var o = document.createElement("option"); o.value = w; o.textContent = w; cwEl.appendChild(o); });
  async function loadConvList() {
    var w = cwEl.value || WORKERS[0];
    var sel = document.getElementById("convSel");
    sel.innerHTML = '<option value="">loading…</option>';
    try {
      var c = await api(baseOf(w), "/conversations");
      sel.innerHTML = '<option value="">pick a conversation…</option>';
      (c.conversations || []).forEach(function (x) {
        var o = document.createElement("option");
        o.value = x.id;
        o.textContent = "#" + x.id + " · " + (x.label || "") + (x.created_at ? " · " + new Date(x.created_at).toLocaleString() : "");
        sel.appendChild(o);
      });
      document.getElementById("convTrans").innerHTML = '<span class="empty">pick a conversation above</span>';
    } catch (e) { sel.innerHTML = '<option value="">error: ' + esc(e.message) + "</option>"; }
  }
  var convEntries = [], convCursor = null, convOrder = "ascending", convIdCur = null;

  async function loadConv(id) {
    if (!id) return;
    convIdCur = id; convEntries = []; convCursor = null;
    convOrder = document.getElementById("convStart").value || "ascending";
    await fetchConvPage();
  }
  async function fetchConvPage() {
    if (!convIdCur) return;
    var w = cwEl.value || WORKERS[0];
    var box = document.getElementById("convTrans");
    if (!convEntries.length) box.innerHTML = '<span class="empty">loading…</span>';
    var q = "limit=50&order=" + convOrder +
      (convCursor ? "&cursor=" + encodeURIComponent(JSON.stringify(convCursor)) : "");
    try {
      var r = await api(baseOf(w), "/conversations/" + convIdCur + "/entries?" + q);
      convEntries = convEntries.concat(r.entries || []);
      convCursor = (r.page && r.page.next) || null;
      renderConv();
    } catch (e) { box.innerHTML = '<span class="empty err">' + esc(e.message) + "</span>"; }
  }
  function renderConv() {
    var box = document.getElementById("convTrans");
    var list = convOrder === "descending" ? convEntries.slice().reverse() : convEntries;
    var html = "";
    list.forEach(function (en) {
      (en.model || []).forEach(function (m) {
        var content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        html += '<div class="msg ' + (m.role === "assistant" ? "assistant" : "") + '"><b>' +
          esc(m.role || "?") + ":</b> " + esc(content) + "</div>";
      });
    });
    box.innerHTML = html || '<span class="empty">empty transcript</span>';
    var more = document.getElementById("convMore");
    if (convCursor) {
      more.style.display = "";
      more.textContent = "load 50 more (" + convEntries.length + " loaded) " +
        (convOrder === "descending" ? "↑ older" : "→ next");
    } else {
      more.style.display = "none";
    }
    document.getElementById("convInfo").textContent =
      convEntries.length + " entries" + (convCursor ? "" : " · end of transcript");
  }
  document.getElementById("convMore").addEventListener("click", fetchConvPage);
  document.getElementById("convStart").addEventListener("change", function () {
    if (convIdCur) loadConv(convIdCur);
  });
  document.getElementById("convRefresh").addEventListener("click", loadConvList);
  cwEl.addEventListener("change", loadConvList);
  document.getElementById("convSel").addEventListener("change", function () { loadConv(this.value); });

  /* --- fleet notes view --- */
  async function loadNotes() {
    var box = document.getElementById("notesAll");
    box.innerHTML = '<span class="empty">loading…</span>';
    try {
      var lists = await Promise.all(WORKERS.map(function (w) {
        return api(baseOf(w), "/notes?limit=10").then(function (n) {
          return (n || []).map(function (x) { return { w: w, body: x.body, created_at: x.created_at }; });
        }).catch(function () { return []; });
      }));
      NOTES = [];
      lists.forEach(function (l) { NOTES = NOTES.concat(l); });
      NOTES.sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
      renderNotes();
    } catch (e) { box.innerHTML = '<span class="empty err">' + esc(e.message) + "</span>"; }
  }
  function renderNotes() {
    var q = (document.getElementById("notesSearch").value || "").toLowerCase();
    var rows = (NOTES || []).filter(function (n) {
      return !q || String(n.body).toLowerCase().indexOf(q) >= 0;
    });
    var html = rows.map(function (n) {
      return '<div class="note"><span class="ts">' + new Date(n.created_at).toLocaleString() +
        " · " + n.w + "</span> " + esc(n.body) + "</div>";
    }).join("");
    document.getElementById("notesAll").innerHTML = html || '<span class="empty">no notes match</span>';
  }
  document.getElementById("notesRefresh").addEventListener("click", loadNotes);
  document.getElementById("notesSearch").addEventListener("input", renderNotes);

  /* --- runner/exec view --- */
  async function loadExec() {
    var box = document.getElementById("execTable");
    box.innerHTML = '<span class="empty">loading…</span>';
    var rows = [];
    for (var i = 0; i < WORKERS.length; i++) {
      var w = WORKERS[i];
      var act = lastMsgAt[w] ? age(lastMsgAt[w]) + " ago" : "-";
      try {
        var t0 = Date.now();
        var r = await api(baseOf(w), "/exec/pending");
        var ping = (Date.now() - t0) + " ms";
        var pend = Array.isArray(r) ? r.length : "-";
        var next = Array.isArray(r) && r.length
          ? '<span class="empty">' + esc(JSON.stringify(r[0])).slice(0, 150) + "</span>" : "";
        rows.push("<tr><td><b>" + w + "</b></td><td>" + pend + "</td><td>" + act + "</td><td>" + ping + "</td><td>" + next + "</td></tr>");
      } catch (e) {
        rows.push("<tr><td><b>" + w + "</b></td><td colspan=4>" + '<span class="empty err">' + esc(e.message) + "</span></td></tr>");
      }
    }
    box.innerHTML = "<table><tr><th>agent</th><th>exec pending</th><th>last WS activity</th><th>ping (HTTP RTT)</th><th>next request</th></tr>" +
      rows.join("") + "</table>";
    document.getElementById("execLast").textContent = "refreshed " + new Date().toLocaleTimeString();
  }
  document.getElementById("execRefresh").addEventListener("click", loadExec);

  /* --- costs view --- */
  async function loadCosts() {
    var box = document.getElementById("costsTable");
    box.innerHTML = '<span class="empty">loading…</span>';
    var grand = 0, rows = [];
    for (var i = 0; i < WORKERS.length; i++) {
      var w = WORKERS[i];
      try {
        var u = await api(baseOf(w), "/usage");
        var models = u.models || {};
        var sub = 0, parts = [];
        Object.keys(models).forEach(function (k) {
          var c = (models[k].cost && models[k].cost.total) || 0;
          sub += c;
          parts.push(k + " · " + models[k].totalTokens + " tok · $" + c.toFixed(4));
        });
        grand += sub;
        rows.push("<tr><td><b>" + w + "</b></td><td>$" + sub.toFixed(4) + "</td><td>" + (esc(parts.join(" | ")) || "-") + "</td></tr>");
      } catch (e) {
        rows.push("<tr><td><b>" + w + "</b></td><td colspan=2>" + '<span class="empty err">' + esc(e.message) + "</span></td></tr>");
      }
    }
    box.innerHTML = "<table><tr><th>agent</th><th>total</th><th>models</th></tr>" + rows.join("") + "</table>";
    document.getElementById("costTotal").textContent = "fleet total: $" + grand.toFixed(4);
    var hist = [];
    try { hist = JSON.parse(localStorage.getItem("pi_cost_hist") || "[]"); } catch (e) { hist = []; }
    var last = hist[hist.length - 1];
    if (!last || Math.abs(last.v - grand) > 1e-9) {
      hist.push({ t: Date.now(), v: grand });
      if (hist.length > 40) hist = hist.slice(-40);
      try { localStorage.setItem("pi_cost_hist", JSON.stringify(hist)); } catch (e) {}
    }
    var max = 1e-9;
    hist.forEach(function (h) { if (h.v > max) max = h.v; });
    document.getElementById("costSpark").innerHTML = hist.map(function (h) {
      return '<div style="height:' + Math.max(3, Math.round(h.v / max * 44)) +
        'px" title="$' + h.v.toFixed(4) + " @ " + new Date(h.t).toLocaleString() + '"></div>';
    }).join("");
    document.getElementById("costHist").textContent =
      hist.length + " snapshot(s) — history lives in this browser (localStorage)";
  }
  document.getElementById("costsRefresh").addEventListener("click", loadCosts);

  /* --- notifications --- */
  var notifBtn = document.getElementById("notifBtn");
  function refreshNotifBtn() {
    notifBtn.textContent = notifyOn ? "notify on" : "notify off";
    notifBtn.className = "mini notif" + (notifyOn ? " on" : "");
  }
  function notify(title, body) {
    if (!notifyOn || !("Notification" in window) || Notification.permission !== "granted") return;
    try { new Notification(title, { body: body }); } catch (e) {}
  }
  notifBtn.addEventListener("click", async function () {
    if (!notifyOn) {
      if (!("Notification" in window)) { feed(HUB, '<span class="err">notifications unsupported here</span>'); return; }
      var p = await Notification.requestPermission();
      if (p !== "granted") { feed(HUB, '<span class="err">permission: ' + p + "</span>"); return; }
      notifyOn = true; localStorage.setItem("pi_notify", "1");
      feed(HUB, "notifications enabled");
    } else {
      notifyOn = false; localStorage.setItem("pi_notify", "0");
    }
    refreshNotifBtn();
  });
  refreshNotifBtn();

  function connect() {
    token = document.getElementById("token").value.trim();
    if (token) localStorage.setItem("pi_token", token);
    connected = true;
    seen = {};
    btn.textContent = "Disconnect";
    btn.className = "on";
    summary.textContent = "connecting...";
    live = 0;
    WORKERS.forEach(openSocket);
    poll();
    pollTimer = setInterval(poll, 120_000);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
        sockets = [];
      } else if (connected) {
        poll();
        if (!pollTimer) pollTimer = setInterval(poll, 120_000);
        WORKERS.forEach(openSocket);
      }
    });
  }

  function disconnect() {
    connected = false;
    btn.textContent = "Connect";
    btn.className = "";
    summary.textContent = "idle";
    if (pollTimer) clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", function () {});
    sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
    sockets = [];
    live = 0;
    answer.style.display = "none";
    WORKERS.forEach(function (w) {
      var el = document.getElementById("ws-" + w);
      el.textContent = "offline";
      el.className = "ws";
    });
  }

  btn.onclick = function () { connected ? disconnect() : connect(); };
  if (token) connect();
})();
</script>
</body>
</html>
`;