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
  <span style="margin-left:auto" class="ws">quotas: 2-min poll, hidden tabs = 0 requests</span>
</header>

<div id="toolbar">
  <select id="askWorker"></select>
  <input id="askInput" class="ask" placeholder="Ask an agent… (Enter to send)" />
  <button id="askBtn" class="go">Ask</button>
  <button id="briefBtn" class="warnb" title="Ask the hub for the prioritized morning brief (saved to memory via add_note)">Brief</button>
  <button id="sweepBtn" title="Digest all peer queues into a hub note + dispatch SWEEP_TASK (deduped)">Sweep</button>
</div>
<div id="answer"></div>

<div id="grid"></div>

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
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (typeof out === "string" ? out.slice(0, 120) : JSON.stringify(out).slice(0, 160)));
    return out;
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
        '<div class="tasklist" id="tl-' + w + '"><span class="empty">loading…</span></div>' +
        '<div class="noteslist" id="nl-' + w + '"><span class="empty">loading…</span></div>' +
        '<button class="mini" data-addnote="' + w + '">+ note</button> ' +
        '<button class="mini" data-refresh="' + w + '">refresh</button>' +
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

    el.querySelector("[data-notes]").addEventListener("click", function () {
      var d = el.querySelector("details[data-details]");
      d.open = true; refreshAll(w);
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

  async function refreshAll(w) {
    try {
      var tasks = await api(baseOf(w), "/tasks?limit=10");
      var pending = tasks.filter(function (t) { return t.status === "pending" || t.status === "in_progress"; });
      var tl = document.getElementById("tl-" + w);
      if (!pending.length) tl.innerHTML = '<span class="empty">no open tasks</span>';
      else {
        tl.innerHTML = "";
        pending.forEach(function (t) {
          var row = document.createElement("div");
          row.className = "trow" + (t.status === "in_progress" ? " inprog" : "");
          row.innerHTML =
            '<span class="tid">#' + t.id + '</span>' +
            '<span class="ttitle" title="' + String(t.title).replace(/"/g, "&quot;") + '">' + String(t.title).replace(/</g, "&lt;") + "</span>" +
            (t.status === "pending"
              ? '<button class="mini" data-done="' + t.id + '">done</button>'
              : '<span class="ws">working…</span>');
          tl.appendChild(row);
        });
        tl.querySelectorAll("[data-done]").forEach(function (b) {
          b.addEventListener("click", async function () {
            var id = this.getAttribute("data-done");
            var result = prompt("Result for #" + id + ":", "done from dashboard");
            if (result === null) return;
            try {
              await api(baseOf(w), "/tasks/" + id, "POST", { status: "done", result: result });
              feed(w, "task #" + id + " → done");
              refreshAll(w);
            } catch (err) { feed(w, '<span class="err">done failed: ' + err.message + "</span>"); }
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
        document.getElementById("model-" + w).textContent =
          (s.defaultModel ? s.defaultModel.provider + "/" + s.defaultModel.modelId : "") +
          "  |  conv:" + s.conversations;
        document.getElementById("ws-" + w).textContent = connected ? "live" : "status ok";
        document.getElementById("ws-" + w).className = "ws ok";
      } catch (e) {
        var el = document.getElementById("ws-" + w);
        el.textContent = "status error: " + e.message;
        el.className = "ws err";
      }
    }
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