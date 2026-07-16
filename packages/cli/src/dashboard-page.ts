export function dashboardPage(appId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(appId)} · Durlo Dispatch</title>
  <style>
    :root {
      --paper: #f4f0e6;
      --paper-deep: #e8e1d2;
      --ink: #17211d;
      --muted: #66706a;
      --line: #c9c1b1;
      --signal: #d9f23c;
      --signal-ink: #263000;
      --rust: #c84b31;
      --blue: #2978a0;
      --shadow: 0 16px 44px rgba(30, 37, 31, .10);
      --display: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      --mono: "Azeret Mono", "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html { background: var(--paper-deep); }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        linear-gradient(rgba(23, 33, 29, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(23, 33, 29, .035) 1px, transparent 1px),
        var(--paper);
      background-size: 22px 22px;
      font-family: var(--mono);
      font-size: 13px;
    }
    button, input, select { font: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, tr:focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 2px;
    }
    .masthead {
      min-height: 124px;
      padding: 24px clamp(20px, 4vw, 64px);
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      color: #f8f4ea;
      background: var(--ink);
      border-bottom: 7px solid var(--signal);
    }
    .wordmark { display: flex; align-items: baseline; gap: 16px; }
    .wordmark strong {
      font-family: var(--display);
      font-size: clamp(38px, 6vw, 72px);
      font-weight: 600;
      letter-spacing: -.055em;
      line-height: .8;
    }
    .wordmark span { color: #b7c0ba; text-transform: uppercase; letter-spacing: .16em; }
    .app-id { text-align: right; }
    .app-id small { display: block; color: #aab4ad; text-transform: uppercase; letter-spacing: .14em; }
    .app-id b { font-family: var(--display); font-size: 20px; font-weight: 500; }
    .shell { max-width: 1720px; margin: 0 auto; padding: 28px clamp(16px, 3vw, 48px) 64px; }
    .health-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      border: 1px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--shadow);
      animation: rise .45s ease-out both;
    }
    .health-card { min-height: 93px; padding: 15px 16px; border-right: 1px solid var(--ink); }
    .health-card:last-child { border-right: 0; }
    .health-card label { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .13em; }
    .health-card strong { display: block; margin-top: 9px; font-family: var(--display); font-size: 31px; font-weight: 500; }
    .health-card .sub { color: var(--muted); font-size: 10px; }
    .health-card.attention { background: color-mix(in srgb, var(--rust) 12%, var(--paper)); }
    .workspace { display: grid; grid-template-columns: minmax(540px, 1.08fr) minmax(390px, .92fr); gap: 24px; margin-top: 24px; }
    .panel { border: 1px solid var(--ink); background: rgba(244, 240, 230, .94); box-shadow: var(--shadow); animation: rise .45s .08s ease-out both; }
    .panel-head { min-height: 58px; padding: 13px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--ink); }
    .panel-title { font-family: var(--display); font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
    .live { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
    .live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #69a83f; box-shadow: 0 0 0 4px rgba(105, 168, 63, .14); }
    .filters { padding: 12px 16px; display: grid; grid-template-columns: 1.1fr .8fr 1.6fr auto; gap: 8px; border-bottom: 1px solid var(--line); }
    input, select { min-width: 0; height: 36px; padding: 0 10px; color: var(--ink); background: #fffdf6; border: 1px solid var(--line); border-radius: 0; }
    .button { height: 36px; padding: 0 14px; border: 1px solid var(--ink); background: var(--ink); color: white; cursor: pointer; transition: transform .14s, background .14s; }
    .button:hover { transform: translateY(-1px); background: #2b3832; }
    .button.secondary { color: var(--ink); background: transparent; }
    .button.danger { background: var(--rust); border-color: var(--rust); }
    .button.signal { color: var(--signal-ink); background: var(--signal); border-color: var(--ink); font-weight: 700; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 9px 12px; color: var(--muted); font-size: 9px; text-align: left; text-transform: uppercase; letter-spacing: .12em; border-bottom: 1px solid var(--line); }
    td { padding: 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    tbody tr { cursor: pointer; transition: background .13s; }
    tbody tr:hover, tbody tr.selected { background: rgba(217, 242, 60, .18); }
    .resource { font-weight: 700; }
    .run-id { display: block; max-width: 155px; overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; }
    .status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; text-transform: uppercase; font-size: 9px; letter-spacing: .08em; font-weight: 700; }
    .status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .status.completed::before { background: #5d963a; }
    .status.running::before { background: var(--blue); animation: pulse 1.4s infinite; }
    .status.pending::before, .status.sleeping::before { background: #cf9d23; }
    .status.failed::before, .status.dead_letter::before, .status.cancelled::before { background: var(--rust); }
    .table-foot { padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; color: var(--muted); }
    .detail { min-height: 610px; }
    .detail-body { padding: 18px; }
    .empty { min-height: 420px; display: grid; place-items: center; padding: 40px; color: var(--muted); text-align: center; }
    .empty strong { display: block; margin-bottom: 8px; color: var(--ink); font-family: var(--display); font-size: 28px; }
    .detail-hero { padding-bottom: 18px; border-bottom: 1px solid var(--line); }
    .detail-hero h2 { margin: 8px 0 4px; font-family: var(--display); font-size: clamp(26px, 3vw, 40px); line-height: 1; letter-spacing: -.035em; overflow-wrap: anywhere; }
    .eyebrow { color: var(--muted); text-transform: uppercase; letter-spacing: .13em; font-size: 9px; }
    .detail-meta { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--muted); font-size: 10px; }
    .actions { margin-top: 16px; display: flex; gap: 8px; }
    .diagnostics { display: grid; grid-template-columns: repeat(4, 1fr); margin: 18px 0; border: 1px solid var(--line); }
    .diagnostics div { padding: 10px; border-right: 1px solid var(--line); }
    .diagnostics div:last-child { border-right: 0; }
    .diagnostics label { display: block; color: var(--muted); font-size: 8px; text-transform: uppercase; letter-spacing: .08em; }
    .diagnostics b { display: block; margin-top: 4px; font-family: var(--display); font-size: 20px; font-weight: 500; }
    .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--ink); }
    .tab { padding: 10px 13px; color: var(--muted); border: 0; border-right: 1px solid var(--line); background: transparent; cursor: pointer; }
    .tab.active { color: var(--ink); background: var(--signal); }
    .tab-panel { padding-top: 16px; }
    .timeline { position: relative; margin-left: 7px; padding-left: 23px; }
    .timeline::before { content: ""; position: absolute; left: 3px; top: 7px; bottom: 9px; width: 1px; background: var(--line); }
    .event { position: relative; padding: 0 0 19px; }
    .event::before { content: ""; position: absolute; left: -24px; top: 4px; width: 7px; height: 7px; border: 2px solid var(--paper); outline: 1px solid var(--ink); background: var(--ink); transform: rotate(45deg); }
    .event h4 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .event time { display: block; margin-top: 3px; color: var(--muted); font-size: 9px; }
    .event p { margin: 7px 0 0; color: var(--rust); font-size: 10px; overflow-wrap: anywhere; }
    pre { max-height: 320px; overflow: auto; margin: 0 0 14px; padding: 13px; color: #ebf1ed; background: #202b26; border-left: 5px solid var(--signal); font: 11px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
    .section-label { margin: 18px 0 7px; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .12em; }
    dialog { max-width: 430px; padding: 0; color: var(--ink); background: var(--paper); border: 1px solid var(--ink); box-shadow: 0 26px 80px rgba(0, 0, 0, .35); }
    dialog::backdrop { background: rgba(17, 25, 21, .64); backdrop-filter: blur(2px); }
    .dialog-body { padding: 24px; }
    .dialog-body h3 { margin: 0 0 8px; font-family: var(--display); font-size: 28px; }
    .dialog-body p { color: var(--muted); line-height: 1.6; }
    .dialog-actions { padding: 13px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--line); }
    .toast { position: fixed; right: 22px; bottom: 22px; z-index: 5; max-width: 420px; padding: 13px 16px; color: white; background: var(--ink); border-left: 5px solid var(--signal); box-shadow: var(--shadow); transform: translateY(130%); transition: transform .2s ease-out; }
    .toast.show { transform: translateY(0); }
    .toast.error { border-color: var(--rust); }
    @keyframes rise { from { opacity: 0; transform: translateY(12px); } }
    @keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(41, 120, 160, .18); } }
    @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
    @media (max-width: 1120px) {
      .health-grid { grid-template-columns: repeat(3, 1fr); }
      .health-card:nth-child(3) { border-right: 0; }
      .health-card:nth-child(-n+3) { border-bottom: 1px solid var(--ink); }
      .workspace { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      .masthead { min-height: 112px; align-items: flex-start; flex-direction: column; }
      .wordmark { flex-direction: column; gap: 7px; }
      .app-id { text-align: left; }
      .health-grid { grid-template-columns: repeat(2, 1fr); }
      .health-card { border-bottom: 1px solid var(--ink); }
      .health-card:nth-child(2n) { border-right: 0; }
      .health-card:nth-last-child(-n+2) { border-bottom: 0; }
      .filters { grid-template-columns: 1fr 1fr; }
      .filters input { grid-column: 1 / -1; }
      .diagnostics { grid-template-columns: repeat(2, 1fr); }
      th:nth-child(4), td:nth-child(4) { display: none; }
    }
  </style>
</head>
<body>
  <header class="masthead">
    <div class="wordmark"><strong>Durlo</strong><span>dispatch ledger / local</span></div>
    <div class="app-id"><small>Application scope</small><b>${escapeHtml(appId)}</b></div>
  </header>
  <main class="shell">
    <section class="health-grid" id="health" aria-label="Backlog health"></section>
    <div class="workspace">
      <section class="panel" aria-label="Runs">
        <div class="panel-head"><span class="panel-title">Run register</span><span class="live">refreshing</span></div>
        <form class="filters" id="filters">
          <select name="status" aria-label="Filter by status"><option value="">All states</option><option>pending</option><option>running</option><option>sleeping</option><option>completed</option><option>failed</option><option>dead_letter</option><option>cancelled</option></select>
          <select name="kind" aria-label="Filter by kind"><option value="">All kinds</option><option>task</option><option>workflow</option></select>
          <input name="resource" type="search" placeholder="Resource id" aria-label="Filter by resource id">
          <button class="button" type="submit">Apply</button>
        </form>
        <div class="table-wrap">
          <table><thead><tr><th>Status</th><th>Resource / run</th><th>Attempts</th><th>Created</th></tr></thead><tbody id="runs"></tbody></table>
        </div>
        <div class="table-foot"><span id="run-count">Loading…</span><button class="button secondary" id="more" type="button" hidden>Load older</button></div>
      </section>
      <aside class="panel detail" aria-live="polite">
        <div class="panel-head"><span class="panel-title">Durable evidence</span><span class="eyebrow" id="checked-at"></span></div>
        <div id="detail" class="empty"><div><strong>Select a run</strong>Inspect checkpoints, attempts, timers, payloads, and the derived timeline.</div></div>
      </aside>
    </div>
  </main>
  <dialog id="confirm"><div class="dialog-body"><h3 id="confirm-title"></h3><p id="confirm-copy"></p></div><div class="dialog-actions"><button class="button secondary" value="cancel">Keep run</button><button class="button danger" id="confirm-action" value="default">Confirm</button></div></dialog>
  <div class="toast" id="toast" role="status"></div>
  <script>
    const state = { runs: [], selectedId: null, nextCursor: null, loading: false, tab: "timeline" };
    const runsNode = document.querySelector("#runs");
    const detailNode = document.querySelector("#detail");
    const moreButton = document.querySelector("#more");
    const filters = document.querySelector("#filters");
    const dialog = document.querySelector("#confirm");
    const actionButton = document.querySelector("#confirm-action");

    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
    const relative = (value) => {
      if (!value) return "—";
      const delta = Date.now() - new Date(value).getTime();
      const future = delta < 0;
      const absolute = Math.abs(delta);
      const [amount, unit] = absolute < 60000 ? [Math.max(1, Math.round(absolute / 1000)), "s"] : absolute < 3600000 ? [Math.round(absolute / 60000), "m"] : absolute < 86400000 ? [Math.round(absolute / 3600000), "h"] : [Math.round(absolute / 86400000), "d"];
      return future ? "in " + amount + unit : amount + unit + " ago";
    };
    const duration = (milliseconds) => milliseconds < 1000 ? milliseconds + " ms" : milliseconds < 60000 ? (milliseconds / 1000).toFixed(1) + " s" : Math.round(milliseconds / 60000) + " min";
    const api = async (path, options) => {
      const response = await fetch(path, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Request failed with " + response.status);
      return body;
    };
    const status = (value) => '<span class="status ' + escapeHtml(value) + '">' + escapeHtml(value.replaceAll("_", " ")) + '</span>';
    const pretty = (value) => '<pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';

    function query(cursor) {
      const data = new FormData(filters);
      const params = new URLSearchParams({ limit: "50" });
      if (data.get("status")) params.set("status", data.get("status"));
      if (data.get("kind")) params.set("kind", data.get("kind"));
      if (data.get("resource")) params.set("resourceId", data.get("resource"));
      if (cursor) params.set("cursor", cursor);
      return params;
    }

    async function loadRuns(append = false) {
      if (state.loading) return;
      state.loading = true;
      try {
        const page = await api("/api/runs?" + query(append ? state.nextCursor : null));
        state.runs = append ? state.runs.concat(page.runs) : page.runs;
        state.nextCursor = page.nextCursor;
        renderRuns();
      } catch (error) { toast(error.message, true); }
      finally { state.loading = false; }
    }

    function renderRuns() {
      runsNode.innerHTML = state.runs.map((run) => '<tr tabindex="0" data-id="' + escapeHtml(run.id) + '" class="' + (run.id === state.selectedId ? "selected" : "") + '"><td>' + status(run.status) + '</td><td><span class="resource">' + escapeHtml(run.resourceId) + '</span><span class="run-id" title="' + escapeHtml(run.id) + '">' + escapeHtml(run.kind + " · v" + run.resourceVersion + " · " + run.id) + '</span></td><td>' + run.attemptCount + ' / ' + run.maxAttempts + '</td><td title="' + escapeHtml(new Date(run.createdAt).toLocaleString()) + '">' + relative(run.createdAt) + '</td></tr>').join("");
      document.querySelector("#run-count").textContent = state.runs.length + (state.runs.length === 1 ? " run" : " runs") + (state.nextCursor ? " loaded" : " total");
      moreButton.hidden = !state.nextCursor;
      runsNode.querySelectorAll("tr").forEach((row) => {
        const select = () => selectRun(row.dataset.id);
        row.addEventListener("click", select);
        row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") select(); });
      });
    }

    async function selectRun(id, quiet = false) {
      state.selectedId = id;
      renderRuns();
      if (!quiet) detailNode.innerHTML = '<div class="empty"><div><strong>Reading ledger…</strong>Taking one consistent snapshot.</div></div>';
      try {
        const details = await api("/api/runs/" + encodeURIComponent(id));
        renderDetail(details);
      } catch (error) { if (!quiet) detailNode.innerHTML = '<div class="empty"><div><strong>Could not read run</strong>' + escapeHtml(error.message) + '</div></div>'; }
    }

    function renderDetail(details) {
      const run = details.run;
      document.querySelector("#checked-at").textContent = "read " + relative(details.checkedAt);
      const cancellable = ["pending", "running", "sleeping"].includes(run.status);
      const retryable = (run.kind === "task" && run.status === "dead_letter") || (run.kind === "workflow" && run.status === "failed");
      detailNode.className = "detail-body";
      detailNode.innerHTML = '<div class="detail-hero"><span class="eyebrow">' + escapeHtml(run.kind) + ' / version ' + escapeHtml(run.resourceVersion) + '</span><h2>' + escapeHtml(run.resourceId) + '</h2>' + status(run.status) + '<div class="detail-meta"><span title="' + escapeHtml(run.id) + '">ID ' + escapeHtml(run.id) + '</span><span>Created ' + escapeHtml(new Date(run.createdAt).toLocaleString()) + '</span><span>Priority ' + run.priority + '</span></div><div class="actions">' + (cancellable ? '<button class="button danger" data-action="cancel">Cancel run</button>' : '') + (retryable ? '<button class="button signal" data-action="retry">Manual retry</button>' : '') + '</div></div>' +
        '<div class="diagnostics"><div><label>Failures</label><b>' + details.diagnostics.failureCount + '</b></div><div><label>Retries</label><b>' + details.diagnostics.retryCount + '</b></div><div><label>Lease loss</label><b>' + details.diagnostics.leaseLossCount + '</b></div><div><label>Timer lag</label><b>' + duration(details.diagnostics.timerLagMs) + '</b></div></div>' +
        '<div class="tabs"><button class="tab ' + (state.tab === "timeline" ? "active" : "") + '" data-tab="timeline">Timeline · ' + details.timeline.length + '</button><button class="tab ' + (state.tab === "data" ? "active" : "") + '" data-tab="data">Data</button><button class="tab ' + (state.tab === "records" ? "active" : "") + '" data-tab="records">Records</button></div><div class="tab-panel">' + renderTab(details) + '</div>';
      detailNode.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => confirmAction(button.dataset.action, run)));
      detailNode.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { state.tab = button.dataset.tab; renderDetail(details); }));
    }

    function renderTab(details) {
      if (state.tab === "timeline") return '<div class="timeline">' + details.timeline.map((event) => '<article class="event"><h4>' + escapeHtml(event.type.replaceAll("_", " ")) + (event.stepId ? ' · ' + escapeHtml(event.stepId) : '') + '</h4><time>' + escapeHtml(new Date(event.at).toLocaleString()) + (event.workerId ? ' · worker ' + escapeHtml(event.workerId) : '') + '</time>' + (event.error ? '<p>' + escapeHtml(event.error.name + ': ' + event.error.message) + '</p>' : '') + '</article>').join("") + '</div>';
      if (state.tab === "data") return '<div class="section-label">Input</div>' + pretty(details.run.input) + '<div class="section-label">Output</div>' + pretty(details.run.output) + '<div class="section-label">Run error</div>' + pretty(details.run.error) + '<div class="section-label">Persisted options</div>' + pretty(details.run.options);
      return '<div class="section-label">Steps · ' + details.steps.length + '</div>' + pretty(details.steps) + '<div class="section-label">Attempts · ' + details.attempts.length + '</div>' + pretty(details.attempts) + '<div class="section-label">Timers · ' + details.timers.length + '</div>' + pretty(details.timers);
    }

    function confirmAction(action, run) {
      document.querySelector("#confirm-title").textContent = action === "cancel" ? "Cancel this run?" : "Grant one manual attempt?";
      document.querySelector("#confirm-copy").textContent = action === "cancel" ? "Cancellation prevents future Durlo transitions, but JavaScript already running may only stop cooperatively." : "Attempt history and the idempotency key remain intact. A failed manual attempt returns to its terminal state.";
      actionButton.textContent = action === "cancel" ? "Cancel run" : "Retry run";
      actionButton.className = action === "cancel" ? "button danger" : "button signal";
      actionButton.onclick = async () => {
        dialog.close();
        try {
          await api("/api/runs/" + encodeURIComponent(run.id) + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          toast(action === "cancel" ? "Run cancelled" : "Run queued for one manual attempt");
          await Promise.all([loadRuns(), selectRun(run.id, true), loadHealth()]);
        } catch (error) { toast(error.message, true); }
      };
      dialog.showModal();
    }

    async function loadHealth() {
      try {
        const health = await api("/api/health");
        const run = health.backlog.runs;
        const timers = health.backlog.timers;
        const worker = health.worker;
        const unavailable = health.compatibility?.unavailableRuns?.length ?? 0;
        const cards = [
          ["Ready now", run.ready, run.readyLagMs ? "lag " + duration(run.readyLagMs) : "claimable"],
          ["In flight", run.running, run.expiredLeases ? run.expiredLeases + " expired lease" : "leases current"],
          ["Sleeping", run.sleeping, timers.pending + " pending timer"],
          ["Due timers", timers.due, timers.lagMs ? "lag " + duration(timers.lagMs) : "on time"],
          ["Unavailable", unavailable, health.compatibility?.truncated ? "partial result" : "for this worker"],
          ["Worker slots", worker ? worker.activeRuns + " / " + worker.concurrency : "—", worker ? worker.status : "dashboard only"]
        ];
        document.querySelector("#health").innerHTML = cards.map(([label, value, sub], index) => '<div class="health-card ' + ((index === 1 && run.expiredLeases) || (index === 3 && timers.due) || (index === 4 && unavailable) ? "attention" : "") + '"><label>' + escapeHtml(label) + '</label><strong>' + escapeHtml(value) + '</strong><span class="sub">' + escapeHtml(sub) + '</span></div>').join("");
      } catch (error) { toast(error.message, true); }
    }

    let toastTimer;
    function toast(message, error = false) {
      const node = document.querySelector("#toast");
      node.textContent = message;
      node.className = "toast show" + (error ? " error" : "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => node.className = "toast", 3600);
    }

    filters.addEventListener("submit", (event) => { event.preventDefault(); state.nextCursor = null; loadRuns(); });
    moreButton.addEventListener("click", () => loadRuns(true));
    dialog.querySelector('[value="cancel"]').addEventListener("click", () => dialog.close());
    loadHealth(); loadRuns();
    setInterval(() => { loadHealth(); loadRuns(); if (state.selectedId) selectRun(state.selectedId, true); }, 3000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[character]!;
  });
}
