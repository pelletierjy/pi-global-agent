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
  var tfilter = {}; // per-worker task-list filter (default: open)
  var actModel = {}; // per-worker: active model of the root conversation

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