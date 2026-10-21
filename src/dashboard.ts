// src/dashboard.ts
//
// Scenario D: one-page realtime dashboard, served by any worker at /dashboard
// (normally the hub). Vanilla JS, no build step. It polls /status on all five
// workers and attaches to their /ws event streams; the token comes from
// ?token=, the input box, or localStorage.

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
  header { display: flex; gap: 10px; align-items: center; padding: 12px 16px;
           border-bottom: 1px solid #1e2a4a; background: #12182b; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0 12px 0 0; color: #00e5ff; letter-spacing: .04em; }
  input, button { background: #1a2340; color: #e0e6f1; border: 1px solid #1e2a4a;
                  border-radius: 6px; padding: 6px 10px; font: inherit; }
  input { min-width: 320px; }
  button { cursor: pointer; } button:hover { background: #243560; }
  button.on { border-color: #00e5ff; color: #00e5ff; }
  #grid { display: grid; gap: 12px; padding: 16px;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .card { background: #12182b; border: 1px solid #1e2a4a; border-radius: 10px; padding: 12px 14px; }
  .card h2 { font-size: 13px; margin: 0 0 8px; display: flex; justify-content: space-between; }
  .ws { font-size: 11px; color: #8a96b8; } .ws.ok { color: #00e676; }
  .state { color: #ffd740; } .task { color: #8a96b8; min-height: 18px; }
  .counts { display: flex; gap: 14px; margin: 8px 0 4px; }
  .counts b { color: #00e5ff; font-size: 18px; font-weight: 600; }
  .counts span { font-size: 11px; color: #8a96b8; display: block; }
  .meta { font-size: 11px; color: #8a96b8; margin-top: 6px; word-break: break-all; }
  #feed { margin: 0 16px 24px; border: 1px solid #1e2a4a; border-radius: 10px;
          background: #080c14; padding: 10px 14px; max-height: 300px; overflow-y: auto; }
  #feed h3 { margin: 0 0 6px; font-size: 12px; color: #00e5ff; }
  #feed div { padding: 2px 0; border-bottom: 1px dotted #131c33; }
  .t { color: #8a96b8; } .who { color: #2979ff; } .err { color: #ff1744; }
</style>
</head>
<body>
<header>
  <h1>PI DURABLE FLEET</h1>
  <input id="token" type="password" placeholder="AGENT_TOKEN" />
  <button id="btn">Connect</button>
  <span id="summary" class="ws">idle</span>
</header>
<div id="grid"></div>
<div id="feed"><h3>LIVE EVENT FEED</h3><div id="lines"></div></div>
<script>
(function () {
  var WORKERS = [
    "pi-global-agent", "pi-conversia-core", "pi-homeworktutora",
    "pi-scalesviewer", "pi-globalvsthost"
  ];
  var SUFFIX = ".need-homework.workers.dev";
  var override = new URLSearchParams(location.search).get("workers");
  if (override) WORKERS = override.split(",").map(function (s) { return s.trim(); });

  var token = new URLSearchParams(location.search).get("token") ||
              localStorage.getItem("pi_token") || "";
  var connected = false;
  var sockets = [];
  var pollTimer = null;

  var grid = document.getElementById("grid");
  var lines = document.getElementById("lines");
  var summary = document.getElementById("summary");
  var btn = document.getElementById("btn");
  document.getElementById("token").value = token;

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
      '<div><b id="notes-' + w + '">-</b><span>notes</span></div>' +
      "</div>" +
      '<div class="meta" id="model-' + w + '"></div>';
    grid.appendChild(el);
    cards[w] = el;
  });

  function feed(who, html) {
    var d = document.createElement("div");
    d.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() +
                  '</span> <span class="who">' + who + "</span> " + html;
    lines.insertBefore(d, lines.firstChild);
    while (lines.childNodes.length > 120) lines.removeChild(lines.lastChild);
  }

  function wsUrl(w) {
    return "wss://" + w + SUFFIX + "/ws?conversation=root&token=" + encodeURIComponent(token);
  }

  async function poll() {
    for (var i = 0; i < WORKERS.length; i++) {
      var w = WORKERS[i];
      try {
        var r = await fetch("https://" + w + SUFFIX + "/status",
                            { headers: { Authorization: "Bearer " + token } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        var s = await r.json();
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

  function connect() {
    token = document.getElementById("token").value.trim();
    if (token) localStorage.setItem("pi_token", token);
    connected = true;
    btn.textContent = "Disconnect";
    btn.className = "on";
    summary.textContent = "connecting...";
    var live = 0;

    WORKERS.forEach(function (w) {
      var ws = new WebSocket(wsUrl(w));
      sockets.push(ws);
      ws.onopen = function () { summary.textContent = "live on " + WORKERS.length + " workers"; };
      ws.onmessage = function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === "hello") {
          live++;
          document.getElementById("ws-" + w).textContent = "live";
          document.getElementById("ws-" + w).className = "ws ok";
          summary.textContent = "live (" + live + "/" + WORKERS.length + ")";
          feed(w, "<b>hello</b> conversation " + m.conversation);
        } else if (m.type === "changed") {
          feed(w, "changed: <b>" + m.scope + "</b>");
          poll();
        } else if (m.type === "events") {
          feed(w, "events: " + (m.events ? m.events.length : 0) + " update(s)");
        }
      };
      ws.onclose = function () {
        live = Math.max(0, live - 1);
        var el = document.getElementById("ws-" + w);
        el.textContent = "disconnected";
        el.className = "ws";
        if (connected) feed(w, '<span class="err">ws closed - retrying in 3s</span>');
        if (connected) setTimeout(function () { if (connected) reconnect(w); }, 3000);
      };
      ws.onerror = function () {};
    });

    poll();
    pollTimer = setInterval(poll, 30000);
  }

  function reconnect(w) {
    var ws = new WebSocket(wsUrl(w));
    sockets.push(ws);
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "hello") {
        document.getElementById("ws-" + w).textContent = "live";
        document.getElementById("ws-" + w).className = "ws ok";
        feed(w, "reconnected");
        poll();
      }
    };
    ws.onclose = function () { if (connected) setTimeout(function () { reconnect(w); }, 3000); };
  }

  function disconnect() {
    connected = false;
    btn.textContent = "Connect";
    btn.className = "";
    summary.textContent = "idle";
    if (pollTimer) clearInterval(pollTimer);
    sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
    sockets = [];
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
