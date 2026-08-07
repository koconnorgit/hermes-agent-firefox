// Background event page (Firefox MV3).
//   - builds the context menu / toolbar entry points, opens the sidebar
//   - owns ALL Hermes network I/O (a cross-origin request from the sidebar hits
//     Firefox's CORS / http→https auto-upgrade wall; from the background page,
//     with host_permissions + the manifest CSP, it's allowed)
//   - holds ONE live JSON-RPC WebSocket to the Hermes gateway and relays its
//     events to the sidebar over a Port
//
// Protocol (from NousResearch/hermes-agent: apps/shared/src/json-rpc-gateway.ts,
// tui_gateway/methods_*.py):
//   connect  POST /api/auth/ws-ticket → {ticket}; open ws /api/ws?ticket=…
//   frame    send {jsonrpc:"2.0", id:"w<n>", method, params}; match reply by id
//   create   session.create {source:"tool"} → {session_id, stored_session_id}
//   send     prompt.submit {session_id, text}
//   stream   {method:"event", params:{type, payload, session_id}} — types:
//            message.start|delta|complete, reasoning.delta,
//            tool.start|progress|complete, status.update, error,
//            approval.request, …

// config.js is loaded before this file (see manifest background.scripts).
const { ENDPOINTS, DEFAULT_HOST } = globalThis.HERMES;
let HOST = DEFAULT_HOST;  // live Hermes host; overridden from settings below

// Gateway text payloads are not always plain strings: the agent can send an
// array of content blocks ({text} / {output_text}) or a single block object.
// A `typeof x === "string"` test drops those on the floor, which shows up as a
// reply that streams in half — or never appears — while the server has it all.
// Mirrors coerceGatewayText() in the reference client (hermes-agent
// apps/desktop/src/lib/chat-runtime.ts).
function txt(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(txt).join("");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.output_text === "string") return v.output_text;
    return "";
  }
  return String(v);
}
// ── Tool-call detail ────────────────────────────────────────────────────────
// The gateway's tool events carry far more than a name (tui_gateway/server.py
// _on_tool_start / _on_tool_complete): an argument preview, the args, the
// result, a summary, a duration, and an inline diff for edits. That's what the
// native chat renders and what "detailed" tool display shows here. We buffer it
// for every session regardless of the user's setting — the sidebar decides how
// much of it to draw, so flipping the setting is a re-render, not a re-fetch.

// The verbose text fields are printed through Ink for the terminal UI, so they
// arrive carrying color codes. We render to HTML; strip them.
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
function plain(v) { return String(v ?? "").replace(ANSI_RE, ""); }

// A tool result can be an entire file. Keep a readable head in the buffer (the
// full text lives in the session transcript on the server, and in the
// dashboard) so a long session's buffer can't grow without bound.
const TOOL_TEXT_MAX_CHARS = 2000;
const TOOL_TEXT_MAX_LINES = 24;
function toolText(v) {
  if (v == null || v === "") return "";
  const s = plain(typeof v === "string" ? v : safeJson(v)).trim();
  if (!s || s === "{}" || s === "[]") return "";   // an argless call gets no block
  const lines = s.split("\n");
  let out = lines.length > TOOL_TEXT_MAX_LINES ? lines.slice(0, TOOL_TEXT_MAX_LINES).join("\n") : s;
  if (out.length > TOOL_TEXT_MAX_CHARS) out = out.slice(0, TOOL_TEXT_MAX_CHARS);
  const omitted = s.length - out.length;
  return omitted > 0 ? `${out}\n… ${omitted} more characters — open the chat in the dashboard for all of it` : out;
}
function safeJson(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
// A stored arguments/result blob is usually a JSON string; parse it so it
// pretty-prints instead of showing up as one escaped line.
function maybeJson(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t || !/^[[{]/.test(t)) return v;
  try { return JSON.parse(t); } catch { return v; }
}
// Stand-in for the gateway's build_tool_preview() — the parenthetical in
// `Terminal("ls -la")`. Live events carry `context` already; rows rebuilt from
// the stored transcript don't, so derive one from the arguments. Field order
// follows the desktop client's own preview picker.
const PREVIEW_KEYS = ["command", "query", "search_term", "path", "file_path", "question", "url", "pattern", "skill", "name", "code", "text"];
function argPreview(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const pick = (v) => (typeof v === "string" && v.trim() ? compact(v, 80) : "");
  for (const k of PREVIEW_KEYS) { const p = pick(args[k]); if (p) return p; }
  for (const v of Object.values(args)) { const p = pick(v); if (p) return p; }
  return "";
}
function compact(s, max) {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

// The trailing assistant text in a log, for comparing our buffer against the
// server's stored transcript.
function lastAssistantText(items) {
  for (let i = (items || []).length - 1; i >= 0; i--) {
    if (items[i].kind === "assistant") return items[i].text || "";
  }
  return "";
}

// How long after a turn settles we re-read the stored transcript to check our
// buffer against it. The first pass covers the normal case (the transcript is
// written just after the turn ends); the rest cover a turn that outlived our
// socket, where the reply can land minutes after the last event we saw.
const VERIFY_DELAYS_MS = [1500, 4000, 10000, 30000, 60000, 120000, 120000];

// How long a session may be busy with nothing arriving on its own stream before
// we stop believing the stream and go ask the gateway what it's doing. The
// socket-level watchdog can't catch this: any other session's traffic keeps the
// socket looking healthy while one session quietly stops reporting.
const SESSION_STALL_MS = 45000;

// ── Entry points: context menu, toolbar, sidebar plumbing ───────────────────
const MENU = { SELECTION: "hermes-ask-selection", PAGE: "hermes-ask-page" };
const HERMES_WINDOW_URL = browser.runtime.getURL("sidebar/sidebar.html?ctx=window");

browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({ id: MENU.SELECTION, title: 'Ask Hermes about "%s"', contexts: ["selection"] });
  browser.menus.create({ id: MENU.PAGE, title: "Ask Hermes about this page", contexts: ["page"] });
});

// Cached default-view setting so the click handlers stay synchronous — required
// because sidebarAction.open() must run inside the user gesture (no awaiting
// storage first).
let defaultView = "sidebar"; // "sidebar" | "window"
let notifyCfg = globalThis.HERMES.notifyConfig(null);  // badge / system toggles
let settingsLoaded = false;  // false until the cached value is read (matters on cold start)
browser.storage.local.get("settings").then(({ settings }) => {
  if (settings?.defaultView) defaultView = settings.defaultView;
  if (settings?.host) HOST = settings.host;
  notifyCfg = globalThis.HERMES.notifyConfig(settings);
  settingsLoaded = true;
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    const s = changes.settings.newValue || {};
    defaultView = s.defaultView || "sidebar";
    notifyCfg = globalThis.HERMES.notifyConfig(s);
    gateway.updateBadge();   // reflect a toggled badge setting right away
    gateway._ensureAlarm();  // start/stop background monitoring per the setting
    gateway.keepalive();     // reconnect immediately if it was just turned on
    const newHost = s.host || DEFAULT_HOST;
    if (newHost !== HOST) {
      HOST = newHost;
      gateway.reset();   // drop the socket/sessions bound to the old host
    }
    settingsLoaded = true;
  }
});

// One reused floating window (focus it instead of spawning duplicates).
let hermesWindowId = null;
browser.windows.onRemoved.addListener((id) => { if (id === hermesWindowId) hermesWindowId = null; });

// Track the last-focused NORMAL browser window so "+page" grabs the tab you're
// actually browsing, even when the (popup) chat window is the focused one.
let lastNormalWindowId = null;
browser.windows.getLastFocused().then((w) => { if (w?.type === "normal") lastNormalWindowId = w.id; }).catch(() => {});
browser.windows.onFocusChanged.addListener((winId) => {
  if (winId === browser.windows.WINDOW_ID_NONE) return;
  browser.windows.get(winId).then((w) => { if (w?.type === "normal") lastNormalWindowId = winId; }).catch(() => {});
});

// The active tab of the window the user is actually browsing.
async function foregroundTab() {
  const pick = async (q) => (await browser.tabs.query(q).catch(() => []))[0] || null;
  return (
    (lastNormalWindowId != null && await pick({ active: true, windowId: lastNormalWindowId })) ||
    await pick({ active: true, windowType: "normal" }) ||
    await pick({ active: true, currentWindow: true })
  );
}

async function openWindow() {
  if (hermesWindowId != null) {
    try { await browser.windows.update(hermesWindowId, { focused: true }); return; }
    catch { hermesWindowId = null; }
  }
  const win = await browser.windows.create({ url: HERMES_WINDOW_URL, type: "popup", width: 440, height: 680 });
  hermesWindowId = win.id;
}

// Open Hermes in the user's preferred view. Call synchronously from a gesture.
function openHermes() {
  if (settingsLoaded) {
    // Cache is fresh → decide synchronously (keeps the gesture for the sidebar).
    if (defaultView === "window") openWindow();
    else browser.sidebarAction.open().catch(() => openWindow());
    return;
  }
  // Cold background: the setting isn't cached yet. Read it (fast) so "window" is
  // honored; opening a window needs no gesture, and the sidebar branch relies on
  // transient activation surviving the short await.
  (async () => {
    try {
      const { settings } = await browser.storage.local.get("settings");
      if (settings?.defaultView) defaultView = settings.defaultView;
      settingsLoaded = true;
    } catch {}
    if (defaultView === "window") openWindow();
    else browser.sidebarAction.open().catch(() => openWindow());
  })();
}

browser.action.onClicked.addListener(() => openHermes());

browser.menus.onClicked.addListener((info, tab) => {
  // A chat view keeps a gateway port open only while it's alive, so this tells us
  // whether Hermes is already open. If open → reuse the session being viewed; if
  // not → open per the default view and start a fresh session.
  const chatOpen = gateway.ports.size > 0;
  if (!chatOpen) {
    // Nothing open → open per the default view. The view sees task.freshOpen and
    // asks the background for a NEW session (rather than resuming the active one).
    openHermes();                       // synchronous → preserves the gesture
  } else if (hermesWindowId != null) {
    browser.windows.update(hermesWindowId, { focused: true }).catch(() => {}); // reuse the open window
  }
  (async () => {
    let task;
    if (info.menuItemId === MENU.SELECTION) {
      task = { kind: "selection", text: info.selectionText || "", url: tab?.url, title: tab?.title };
    } else if (info.menuItemId === MENU.PAGE) {
      const ctx = await getPageContext(tab?.id).catch(() => null);
      task = { kind: "page", context: ctx, url: tab?.url, title: tab?.title };
    } else return;
    task.freshOpen = !chatOpen;         // hint the view to start from a clean log
    await browser.storage.session.set({ pendingTask: task });
    browser.runtime.sendMessage({ type: "hermes:pendingTask", task }).catch(() => {});
  })();
});

// The sidebar's "pop out" delegates window creation here, so it can close its
// own sidebar right after without racing the popup for focus.
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "hermes:openWindow") openWindow();
});

async function getPageContext(tabId) {
  if (tabId == null) return null;
  return browser.tabs.sendMessage(tabId, { type: "hermes:getPageContext" });
}

// ── One-shot request handlers (auth check + active-tab context) ─────────────
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "hermes:whoami") {
    (async () => {
      try {
        const r = await fetch(HOST + ENDPOINTS.whoami, { credentials: "include" });
        sendResponse({ ok: r.ok, status: r.status });
      } catch (e) { sendResponse({ ok: false, error: `${e.name}: ${e.message}` }); }
    })();
    return true;
  }
  if (msg?.type === "hermes:api") {
    // Generic authed REST passthrough (used for session list + transcripts).
    (async () => {
      try {
        const r = await fetch(HOST + msg.path, {
          method: msg.method || "GET",
          credentials: "include",
          headers: msg.body ? { "Content-Type": "application/json" } : undefined,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });
        const data = await r.json().catch(() => null);
        sendResponse({ ok: r.ok, status: r.status, data });
      } catch (e) { sendResponse({ ok: false, error: `${e.name}: ${e.message}` }); }
    })();
    return true;
  }
  if (msg?.type === "hermes:requestActiveContext") {
    (async () => {
      const tab = await foregroundTab();
      const ctx = tab ? await getPageContext(tab.id).catch(() => null) : null;
      sendResponse({ ok: true, tab: tab ? { url: tab.url, title: tab.title } : null, context: ctx });
    })();
    return true;
  }
});

// ── Gateway hub: one WebSocket, many buffered sessions ──────────────────────
// The socket carries every live session's events (each tagged with session_id).
// We keep each opened session live and accumulate its transcript here — so a
// session keeps streaming into its buffer even when you're viewing another, and
// switching back shows the full message. Non-active sessions surface as unread
// activity (toolbar badge + dropdown marker + a notification). The sidebar is a
// thin renderer of the ACTIVE session.
//
// Session item shape: {kind:"user"|"assistant"|"tool"|"system", text?,
// streaming?} — plus, for "tool": {toolId, name, context, argsText, resultText,
// summary, error, durationS, diff, done}.
class Gateway {
  constructor() {
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.state = "idle";
    this.connecting = null;
    this.ports = new Set();
    this.sessions = new Map();      // storedId → { storedId, liveId, log:[], busy, unread, seeded }
    this.liveToStored = new Map();  // liveId → storedId
    this.active = null;             // storedId currently viewed
    this.watched = new Set();       // storedIds to keep alive so closed-UI alerts fire
    this._newSessTimer = null;      // debounce for new-session detection
    this.lastFrameAt = 0;           // when the socket last delivered anything
    this._probing = null;           // in-flight liveness probe
    this._probeFails = 0;           // consecutive unanswered probes
    this._reconnectTimer = null;    // fast reconnect after a lost socket
  }

  // ── background monitoring (alerts while all views are closed) ──
  async _track(storedId) {
    if (!storedId || this.watched.has(storedId)) return;
    this.watched.add(storedId);
    while (this.watched.size > 10) this.watched.delete(this.watched.values().next().value); // keep newest, under server cap
    await browser.storage.session.set({ watchedSessions: [...this.watched] }).catch(() => {});
    this._ensureAlarm();
  }
  _ensureAlarm() {
    // A ~25s alarm both keeps the event page (and its socket) from idling out and
    // re-establishes the connection if Firefox suspended us anyway. It also
    // drives the liveness watchdog, so it runs whenever a view is open or a turn
    // is in flight — not only when background alerts are enabled.
    const needed = notifyCfg.background || this.ports.size > 0 ||
      [...this.sessions.values()].some((s) => s.busy || s.unfinished);
    if (needed) browser.alarms.create("hermes-keepalive", { periodInMinutes: 0.4 });
    else browser.alarms.clear("hermes-keepalive");
  }

  // Fired by the keepalive alarm. Liveness first (it can force a reconnect),
  // then the background-alert upkeep.
  async tick() {
    await this._checkLiveness();
    if (notifyCfg.background) await this.keepalive();
    // Background alerts are off, so keepalive() won't reconnect — but a view is
    // open and its socket is gone. Re-attach, or the pane sits there deaf.
    else if (this.ports.size > 0 && this.state !== "open") {
      try { await this.resumeActive(); } catch {}
    }
  }

  // A socket can die without ever firing onclose — a laptop sleep, a NAT or
  // proxy idle timeout, a wifi flip. readyState still reads OPEN, no events
  // arrive, and a turn sits at "working…" with its reply stranded on the
  // server. Probe a quiet socket, and re-read the transcript for any session
  // that's been busy with nothing coming in.
  async _checkLiveness() {
    const now = Date.now();
    const busy = [...this.sessions.values()].filter((s) => s.busy);
    const quiet = now - (this.lastFrameAt || 0);

    if (this.ws?.readyState === WebSocket.OPEN && quiet > (busy.length ? 30000 : 90000) && !this._probing) {
      const ws = this.ws;
      this._probing = this.request("session.active_list", {}, 20000)
        .then(() => { this._probeFails = 0; this.lastFrameAt = Date.now(); })
        .catch(() => {
          // One missed probe is not proof of a dead socket. The gateway runs
          // most RPCs on its dispatcher thread (only a few slow handlers get a
          // pool), so a loaded server can leave a perfectly healthy socket
          // quiet past the deadline — and closing costs us the live session
          // binding mid-turn. Two strikes before we give up on it.
          if (++this._probeFails < 2) return;
          this._probeFails = 0;
          // Unresponsive: drop it so ensureSocket() builds a fresh one. The
          // close may never arrive on a half-open socket, so settle by hand.
          try { ws.close(4000, "heartbeat failed"); } catch {}
          if (this.ws === ws) { this.ws = null; this.state = "closed"; this._onSocketLost(); }
        })
        .finally(() => { this._probing = null; });
      await this._probing;
    }

    // Still nothing after the probe → trust the transcript over the stream. If
    // it turns out the turn already produced its reply, settle the session:
    // leaving it "working…" strands the composer on a turn that's long done.
    if (busy.length && Date.now() - (this.lastFrameAt || 0) > 45000) {
      for (const s of busy) {
        const before = lastAssistantText(s.log);
        await this._resync(s).catch(() => {});
        if (lastAssistantText(s.log).length > before.length) { this._settle(s); this._setBusy(s, false); }
      }
      return;                                   // the whole socket was quiet; nothing left to single out
    }

    // The socket is fine, but a single session has gone silent mid-turn. That's
    // a hung pane — "working…", locked composer, and a reply that only shows up
    // when the user hits ⟳ — and the check above can't see it, because the
    // other sessions keep lastFrameAt fresh.
    const stalled = busy.filter((s) => s.liveId && Date.now() - (s.lastEventAt || 0) > SESSION_STALL_MS);
    if (stalled.length) await this._reconcileStalled(stalled).catch(() => {});
  }

  // Ask the gateway what these sessions are really doing and believe THAT over
  // our event stream. session.active_list reports a live status per session
  // (tui_gateway _session_live_status): working / starting / waiting (blocked
  // on a clarify, sudo or secret answer) / idle. Whatever it says, re-read the
  // transcript first — the server's copy is the one that's complete.
  async _reconcileStalled(sessions) {
    const res = await this.request("session.active_list", {}, 20000);
    this.lastFrameAt = Date.now();
    const status = new Map();
    for (const row of (res?.sessions || [])) if (row?.id) status.set(row.id, String(row.status || ""));

    for (const s of sessions) {
      const st = status.get(s.liveId);
      await this._resync(s).catch(() => {});
      s.lastEventAt = Date.now();               // re-check at most once per stall window
      const awaiting = st === "waiting";
      if (awaiting !== s.awaiting) { s.awaiting = awaiting; this._activity(s); }
      // Idle, or gone from the live list entirely: the turn is over and
      // whatever ended it never reached us. Settle it here rather than making
      // the user notice and refresh.
      if (st === "idle" || st === undefined) { if (this._settle(s)) this._completed(s); this._setBusy(s, false); }
    }
  }

  async keepalive() {
    if (!notifyCfg.background) { this._ensureAlarm(); return; }
    // Hold the socket open even with nothing watched — a bare authed socket still
    // receives global sessions.changed, which is how we spot timer/cron sessions.
    try { await this.ensureSocket(); } catch { return; }
    const { watchedSessions = [] } = await browser.storage.session.get("watchedSessions");
    for (const sid of watchedSessions) {
      const s = this._session(sid);
      if (!s.liveId) { try { await this.openSession(sid); } catch {} }
    }
  }

  addPort(port) {
    this.ports.add(port);
    this._ensureAlarm();
    // A view only hears `activity` as it happens, so one opening now would know
    // nothing about replies that landed while it was closed — and those are
    // exactly the chats its picker has to mark and float to the top. Hand it
    // the current state of every session we're tracking.
    try {
      port.postMessage({
        type: "sessions-state",
        sessions: [...this.sessions.values()].map((s) => ({
          storedId: s.storedId, busy: s.busy, unread: s.unread, awaiting: s.awaiting,
        })),
      });
    } catch {}
    port.onDisconnect.addListener(() => { this.ports.delete(port); this._ensureAlarm(); });
  }
  broadcast(msg) { for (const p of this.ports) { try { p.postMessage(msg); } catch {} } }

  // ── socket ──
  async ensureSocket() {
    if (this.state === "open" && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._openSocket().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async _openSocket() {
    this.state = "connecting";
    const tr = await fetch(HOST + ENDPOINTS.wsTicket, { method: "POST", credentials: "include" });
    if (!tr.ok) throw new Error(`ws-ticket ${tr.status}`);
    const { ticket } = await tr.json();
    await new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(`${globalThis.HERMES.wsUrl(HOST)}?ticket=${encodeURIComponent(ticket)}`); }
      catch (e) { return reject(e); }
      const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("ws connect timeout")); }, 10000);
      ws.onopen = () => { clearTimeout(to); this.ws = ws; this.state = "open"; this.lastFrameAt = Date.now(); resolve(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error("ws connect failed")); };
      ws.onclose = (ev) => {
        // A dead socket's close can land AFTER we've already replaced it (the
        // liveness probe force-closes and reconnects). Without this guard the
        // old socket's handler nulls the new one and the reconnect goes deaf.
        if (this.ws && this.ws !== ws) return;
        this.state = "closed"; this.ws = null;
        this._onSocketLost();
        this._failAll(new Error(`ws closed (${ev.code})`));
        this.broadcast({ type: "closed", code: ev.code, reason: ev.reason });
      };
      ws.onmessage = (e) => { if (this.ws === ws) this._onFrame(e.data); };
    });
  }
  request(method, params = {}, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error("gateway not connected"));
      const id = `w${++this.seq}`;
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`request timed out: ${method}`)); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  _failAll(err) { for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); try { reject(err); } catch {} } this.pending.clear(); }

  // The socket died. Every buffer may now be missing a turn, so mark them for a
  // re-pull and drop the busy flags — a session left "working…" on a dead socket
  // never clears (nothing is left to deliver the completion) and locks its
  // composer. If a turn really is still running, the next session.info heartbeat
  // after the reconnect re-arms busy.
  _onSocketLost() {
    this.liveToStored.clear();
    let hadBusy = false;
    for (const s of this.sessions.values()) {
      s.liveId = null;                        // must re-resume after reconnect
      s.gap = true;
      const closed = this._settle(s);
      // Through _setBusy so the end-of-turn reconciliation runs: whatever the
      // turn produced after the socket died is only in the stored transcript.
      if (s.busy) { hadBusy = true; this._setBusy(s, false); }
      else if (closed) { this._activity(s); this._scheduleVerify(s); }
    }
    this._scheduleReconnect(hadBusy);
  }

  // Get back on the wire without waiting for the next alarm tick (up to ~24s).
  // The server parks a disconnected session and reaps an idle one after a 20s
  // grace, and a turn that IS still running only reaches us again once we
  // re-resume it — so the sooner we reattach, the less of the reply we miss.
  _scheduleReconnect(hadBusy) {
    if (this._reconnectTimer) return;
    if (!hadBusy && this.ports.size === 0 && !notifyCfg.background) return;  // nobody's listening
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.ensureSocket();
        // Re-resume what we were following. session.resume reports `running`,
        // which re-arms busy for a turn that outlived the old socket, and the
        // gap flag makes openSession re-read the transcript.
        for (const storedId of new Set([this.active, ...this.watched].filter(Boolean))) {
          if (this.sessions.has(storedId)) { try { await this.openSession(storedId); } catch {} }
        }
        this.rerender();
      } catch { /* the keepalive alarm keeps retrying */ }
    }, 1000);
  }

  // Tear down the connection + buffered sessions (e.g. the host changed). The
  // next view/resumeActive reconnects to the new host with a fresh session.
  reset() {
    try { this.ws?.close(1000, "host changed"); } catch {}
    this.ws = null; this.state = "idle"; this.connecting = null;
    this._failAll(new Error("host changed"));
    this.sessions.clear();
    this.liveToStored.clear();
    this.active = null;
  }

  _onFrame(text) {
    this.lastFrameAt = Date.now();
    let frame; try { frame = JSON.parse(text); } catch { return; }
    if (frame.id != null && this.pending.has(frame.id)) {
      const { resolve, reject, timer } = this.pending.get(frame.id);
      this.pending.delete(frame.id); clearTimeout(timer);
      if (frame.error) reject(new Error(frame.error.message || JSON.stringify(frame.error)));
      else resolve(frame.result);
      return;
    }
    if (frame.method === "event" && frame.params?.type) this._onEvent(frame.params);
  }

  // ── sessions ──
  _session(storedId) {
    let s = this.sessions.get(storedId);
    if (!s) { s = { storedId, fetchId: storedId, liveId: null, log: [], busy: false, unread: false, seeded: false, gap: false, announced: true, unfinished: false, verifyTimer: null, lastEventAt: 0, awaiting: false }; this.sessions.set(storedId, s); }
    return s;
  }

  async newSession() {
    await this.ensureSocket();
    // Deliberately NOT close_on_disconnect. That flag is for a sidecar whose
    // life ends with its page (the dashboard's chat tab): the gateway reaps
    // those sessions the instant the socket drops — immediately, with no grace
    // window and no exemption for a turn in flight (server.py
    // _close_sessions_for_transport → _close_session_by_id, which terminates
    // the worker). Our socket blinks as a matter of course: the event page
    // suspends, wifi flips, the liveness watchdog force-closes a half-open
    // one. With the flag, every one of those blinks KILLED the running turn —
    // so the longer a reply took, the likelier it was to simply never arrive.
    // Without it the session is only detached: _ws_session_is_orphaned refuses
    // to reap anything still `running`, and an idle session gets a 20s grace
    // that our reconnect + session.resume cancels.
    const res = await this.request("session.create", { source: "tool" });
    const liveId = res?.session_id;
    const storedId = res?.stored_session_id || liveId;
    const s = this._session(storedId);
    s.liveId = liveId; s.seeded = true;                // brand new → empty transcript
    if (liveId) this.liveToStored.set(liveId, storedId);
    this._track(storedId);
    return s;
  }

  async openSession(storedId) {
    await this.ensureSocket();
    const s = this._session(storedId);
    if (!s.liveId) {
      const res = await this.request("session.resume", { session_id: storedId, omit_messages: true });
      s.liveId = res?.session_id || null;
      if (s.liveId) this.liveToStored.set(s.liveId, storedId);
      // Auto-compression ends a session and forks a continuation, so the server
      // can bind the resume to a DIFFERENT stored id than the one we asked for.
      // The transcript then lives under that id — read history from it, or the
      // post-compression replies are simply missing.
      if (res?.stored_session_id && res.stored_session_id !== s.fetchId) { s.fetchId = res.stored_session_id; s.gap = true; }
      // The resume payload states whether a turn is in flight, so a session the
      // terminal is mid-reply on shows as working the moment we attach.
      if (typeof res?.running === "boolean") this._setBusy(s, res.running);
    }
    if (!s.seeded) { await this._seed(s); s.seeded = true; }
    if (s.gap) await this._resync(s);
    this._track(storedId);
    return s;
  }

  // The persisted transcript, as log items. null if the fetch failed (so the
  // caller keeps whatever it already has rather than blanking the view).
  async _fetchHistory(s) {
    try {
      const r = await fetch(`${HOST}/api/sessions/${encodeURIComponent(s.fetchId)}/messages`, { credentials: "include" });
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      if (!data) return null;
      const items = [];
      const pending = new Map();   // tool_call_id → the row still awaiting its result
      for (const m of (data.messages || [])) {
        const content = txt(m.content);
        if (m.role === "tool") {
          // A stored tool result, filed under the call it answers. Dropping
          // these is what left rebuilt history with bare names and no detail.
          const it = pending.get(m.tool_call_id) ||
            [...pending.values()].find((x) => !x.resultText && x.name === (m.tool_name || m.name));
          if (it) { it.resultText = toolText(maybeJson(content)); pending.delete(it.toolId); }
          continue;
        }
        if (m.role === "user" && content) items.push({ kind: "user", text: content });
        else if (m.role === "assistant") {
          if (content) items.push({ kind: "assistant", text: content });
          for (const tc of (m.tool_calls || [])) {
            const fn = tc.function || {};
            const args = maybeJson(fn.arguments ?? tc.arguments ?? tc.args);
            const it = {
              kind: "tool",
              toolId: tc.id || tc.tool_call_id || "",
              name: fn.name || tc.name || "tool",
              context: argPreview(args),
              argsText: toolText(args),
              done: true,
            };
            items.push(it);
            if (it.toolId) pending.set(it.toolId, it);
          }
        }
      }
      return items;
    } catch { return null; }
  }

  async _seed(s) {
    const items = await this._fetchHistory(s);
    if (!items) return;
    s.log = items.concat(s.log);                       // history precedes anything already buffered
    s.gap = false;
  }

  // Rebuild the buffer from the stored transcript. Used whenever our event
  // stream has a hole — a dropped socket, a turn that ended with nothing
  // streamed into us — since the server's copy is the one that's complete.
  async _resync(s) {
    if (s.syncing) return s.syncing;
    s.syncing = (async () => {
      try { await this._doResync(s); } finally { s.syncing = null; }
    })();
    return s.syncing;
  }
  async _doResync(s) {
    const items = await this._fetchHistory(s);
    if (!items) return;
    const before = lastAssistantText(s.log);
    const fresh = lastAssistantText(items);
    // Keep what the stored transcript can't have yet: unanswered prompts, and a
    // reply still streaming into us (a resync mid-turn would otherwise wipe the
    // bubble the user is watching fill in).
    const keep = s.log.filter((it) =>
      (it.kind === "request" && !it.resolved) ||
      (it.kind === "assistant" && it.streaming && it.text && !fresh.includes(it.text)));
    const prevLen = s.log.length;
    s.log = items.concat(keep);
    s.gap = false;
    s.seeded = true;
    if (fresh.length > before.length) s.unfinished = false;   // the turn's reply is in hand
    // A re-render rebuilds the whole log: it resets the scroll position and
    // folds every tool row back up. The stall watchdog resyncs on a timer while
    // a long turn runs, so only repaint when the transcript actually moved.
    const changed = fresh !== before || s.log.length !== prevLen;
    if (changed && this._isActive(s)) this.broadcast({ type: "log", storedId: s.storedId, items: s.log, busy: s.busy, awaiting: s.awaiting });
    // We only learned about this reply by re-reading the transcript, so nothing
    // announced it — raise the badge/notification now rather than leaving the
    // turn silently finished.
    if (fresh && fresh.length > before.length && !s.announced) this._completed(s);
  }
  async resync(storedId) {
    const s = this.sessions.get(storedId);
    if (!s) return this.view(storedId);
    if (!s.liveId) { try { await this.openSession(storedId); } catch {} }
    return this._resync(s);
  }

  // ── incoming events → per-session log ──
  // Which buffered session an event belongs to. Events are tagged with the LIVE
  // id, but a reconnect (or a session we only ever saw over REST) can leave that
  // id unmapped — fall back to the stored id the payload carries and learn the
  // mapping, rather than dropping the event on the floor.
  _route(ev) {
    const p = ev.payload || {};
    const live = ev.session_id;
    let storedId = live ? this.liveToStored.get(live) : null;
    if (!storedId && live && this.sessions.has(live)) storedId = live;
    if (!storedId && p.stored_session_id &&
        (this.sessions.has(p.stored_session_id) || this.watched.has(p.stored_session_id))) {
      storedId = p.stored_session_id;   // ours, just not mapped yet (post-reconnect)
    }
    if (storedId && live) this.liveToStored.set(live, storedId);
    return storedId;
  }

  _onEvent(ev) {
    if (ev.type === "sessions.changed") { this.broadcast({ type: "sessions-changed" }); this._scheduleNewSessionCheck(); return; }
    const storedId = this._route(ev);
    if (!storedId) return;
    const s = this._session(storedId);
    s.lastEventAt = Date.now();   // this session's own stream is alive
    const p = ev.payload || {};
    switch (ev.type) {
      // The agent loop's own heartbeat. `running` is authoritative — and it's
      // the ONLY end-of-turn signal we get when message.complete never arrives
      // (turn crash, or a reconnect that straddled the completion). Without it a
      // session sits at "working…" forever with the reply stranded server-side.
      case "session.info":
        if (typeof p.running === "boolean") {
          if (!p.running) { if (this._settle(s)) this._completed(s); }
          this._setBusy(s, p.running);
          if (!p.running && s.gap) this._resync(s);
        }
        break;
      case "message.start": s.announced = false; this._push(s, { kind: "assistant", text: "", streaming: true }); this._setBusy(s, true); break;
      case "message.delta": { const d = txt(p.text); if (d) this._appendAssistant(s, d); break; }
      // Interim assistant commentary (text emitted alongside tool calls). Seal
      // it as its own bubble so the final completion adds a new one instead of
      // overwriting prose the user already read.
      case "message.interim": this._sealInterim(s, txt(p.text), p.already_streamed); break;
      // payload.text is the whole final reply; `rendered` is the same text
      // pre-wrapped for terminals and is all we get on some frames.
      // _completed before _setBusy: it marks the turn announced, which is what
      // tells the busy flip this turn ended properly (and not with a silence
      // worth chasing).
      case "message.complete":
        this._endAssistant(s, txt(p.text) || txt(p.rendered));
        this._completed(s); this._setBusy(s, false); this._scheduleVerify(s);
        break;
      // tool.start's args are the server's redacted display copy
      // (_redact_tool_args_for_display); tool.complete carries the raw call, so
      // take Args from the start event and never let the completion overwrite it.
      case "tool.start":
        this._push(s, {
          kind: "tool",
          toolId: p.tool_id || "",
          name: p.name || p.tool || "tool",
          context: compact(plain(p.context || p.preview || ""), 80),
          argsText: toolText(p.args_text || p.args),
          done: false,
        });
        break;
      case "tool.progress": this._toolProgress(s, p.name || p.tool, plain(p.preview || "")); break;
      case "tool.complete": this._toolDone(s, p); break;
      case "error": this._push(s, { kind: "system", text: `⚠ ${txt(p.message) || txt(p.text) || "agent error"}` }); this._setBusy(s, false); break;
      case "approval.request":
        this._push(s, { kind: "request", rtype: "approval", liveId: ev.session_id, command: p.command || "", choices: (p.choices && p.choices.length) ? p.choices : ["once", "deny"], resolved: false });
        this._needsInput(s); break;
      case "clarify.request":
        this._push(s, { kind: "request", rtype: "clarify", liveId: ev.session_id, requestId: p.request_id, question: p.question || "", choices: (p.choices && p.choices.length) ? p.choices : null, multi: !!p.multi_select, resolved: false });
        this._needsInput(s); break;
      case "sudo.request":
        this._push(s, { kind: "request", rtype: "sudo", liveId: ev.session_id, question: p.prompt || p.message || "Password required", choices: null, resolved: false });
        this._needsInput(s); break;
      case "secret.request":
        this._push(s, { kind: "request", rtype: "secret", liveId: ev.session_id, question: p.prompt || p.message || p.name || "Secret required", choices: null, resolved: false });
        this._needsInput(s); break;
    }
  }

  // Send the user's answer to a pending request, and mark it resolved in the log.
  async respond(m) {
    const storedId = m.liveId ? this.liveToStored.get(m.liveId) : this.active;
    const s = storedId ? this.sessions.get(storedId) : null;
    if (s) this._resolveRequest(s, m);
    if (m.rtype === "approval") return this.request("approval.respond", { choice: m.choice, session_id: m.liveId });
    if (m.rtype === "clarify") return this.request("clarify.respond", { request_id: m.requestId, answer: m.answer ?? "" });
    if (m.rtype === "sudo") return this.request("sudo.respond", { session_id: m.liveId, password: m.password ?? "" });
    if (m.rtype === "secret") return this.request("secret.respond", { session_id: m.liveId, value: m.value ?? "" });
  }
  _resolveRequest(s, m) {
    for (let i = s.log.length - 1; i >= 0; i--) {
      const it = s.log[i];
      if (it.kind === "request" && !it.resolved && it.rtype === m.rtype && (m.rtype !== "clarify" || it.requestId === m.requestId)) {
        it.resolved = true; it.answer = m.label ?? "resolved"; break;
      }
    }
  }

  _isActive(s) { return s.storedId === this.active; }
  _emit(s, op) { if (this._isActive(s)) this.broadcast({ type: "render", storedId: s.storedId, ...op }); }

  _push(s, item) { s.log.push(item); this._emit(s, { op: "push", item }); }
  _appendAssistant(s, text) {
    const last = s.log[s.log.length - 1];
    if (last && last.kind === "assistant" && last.streaming) { last.text += text; this._emit(s, { op: "delta", text }); }
    else this._push(s, { kind: "assistant", text, streaming: true });
  }
  // Close out the turn's bubble. Scans back for the streaming item rather than
  // trusting the tail — a tool.start between the deltas and the completion puts
  // a tool item last, which used to swallow the whole reply.
  _endAssistant(s, finalText) {
    for (let i = s.log.length - 1; i >= 0; i--) {
      const it = s.log[i];
      if (it.kind === "assistant" && it.streaming) {
        // Prefer the completion's text: if we missed deltas, ours is truncated.
        if (typeof finalText === "string" && finalText.length > it.text.length) it.text = finalText;
        it.streaming = false;
        this._emit(s, { op: "end", text: it.text });
        return;
      }
    }
    // No open bubble — we joined mid-turn, missed message.start entirely, or an
    // interim already sealed this turn's prose. Add the reply unless the tail
    // already carries it (a completion that just restates a sealed interim).
    if (finalText) {
      if (lastAssistantText(s.log).includes(finalText)) return;
      this._push(s, { kind: "assistant", text: finalText });
    } else s.gap = true;
  }
  // An interim message means "this prose is final, more may follow" — the agent
  // emitted commentary alongside a tool call, or an answer that a verify-on-stop
  // nudge then sent it back to improve. Close the open bubble on it so later
  // deltas start a fresh one.
  //
  // `already_streamed: false` means the text is content the UI has NOT seen —
  // the answer was composed off-stream, so there are no deltas for it. Dropping
  // it (which is what happens if you only ever seal an existing bubble) leaves
  // the reply invisible while the turn runs on, which is why a turn ending in
  // "would you like me to continue?" showed nothing until you hit ⟳: that
  // question is exactly the kind of premature stop the verify-on-stop hook
  // catches. Mirrors finalizeInterimAssistantMessage() in the reference client
  // (apps/desktop/.../use-message-stream/index.ts), which seals in place when a
  // streaming bubble exists and appends a standalone message when it doesn't.
  _sealInterim(s, text, alreadyStreamed) {
    if (!text) return;
    for (let i = s.log.length - 1; i >= 0; i--) {
      const it = s.log[i];
      if (it.kind !== "assistant" || !it.streaming) continue;
      // Same prose, streamed to us already → seal it, keeping the fuller copy.
      if (alreadyStreamed !== false || !it.text || text.includes(it.text)) {
        if (text.length > it.text.length) it.text = text;
        it.streaming = false;
        this._emit(s, { op: "end", text: it.text });
        return;
      }
      // Unrelated prose was streaming (mid-turn narration) and the interim is
      // separate content: seal that bubble on its own text, then add this below.
      it.streaming = false;
      this._emit(s, { op: "end", text: it.text });
      break;
    }
    if (lastAssistantText(s.log) === text) return;   // already on screen
    this._push(s, { kind: "assistant", text });
  }
  // Un-stream a bubble nothing ever closed. True if it actually closed one.
  _settle(s) {
    for (let i = s.log.length - 1; i >= 0; i--) {
      const it = s.log[i];
      if (it.kind === "assistant" && it.streaming) {
        it.streaming = false;
        if (!it.text) s.gap = true;          // turn produced text we never saw → REST has it
        this._emit(s, { op: "end", text: it.text });
        return true;
      }
    }
    return false;
  }
  // Fold a tool.complete into the row its tool.start opened. Matched by
  // tool_id when the payload has one (concurrent tool calls interleave, so the
  // newest unfinished row is not always the right one) and by "last one still
  // running" otherwise.
  _toolDone(s, p = {}) {
    const id = p.tool_id || "";
    const name = p.name || p.tool || "";
    for (let i = s.log.length - 1; i >= 0; i--) {
      const it = s.log[i];
      if (it.kind !== "tool") continue;
      if (id ? it.toolId !== id : it.done) continue;
      this._fillToolResult(it, p);
      if (name) it.name = name;
      this._emit(s, { op: "toolUpdate", item: it });
      return;
    }
    // No open row — we attached mid-turn and missed the start. Show the call
    // anyway rather than dropping it.
    const item = { kind: "tool", toolId: id, name: name || "tool", context: argPreview(p.args), argsText: toolText(p.args), done: true };
    this._fillToolResult(item, p);
    this._push(s, item);
  }
  _fillToolResult(it, p) {
    it.done = true;
    // The gateway only sets `error` on some paths; a tool that reports failure
    // in its own JSON result is still a failure worth marking.
    const resultErr = p.result && typeof p.result === "object" && typeof p.result.error === "string" ? p.result.error : "";
    it.error = compact(plain(p.error || resultErr), 200);
    if (typeof p.duration_s === "number") it.durationS = p.duration_s;
    if (p.summary) it.summary = compact(plain(p.summary), 200);
    // result_text is the server-redacted copy (verbose sessions only); the raw
    // result is always present and is what the desktop client renders.
    it.resultText = toolText(p.result_text != null ? p.result_text : p.result);
    if (p.inline_diff) it.diff = toolText(p.inline_diff);
    if (!it.argsText) it.argsText = toolText(p.args);
    if (!it.context) it.context = argPreview(p.args);
  }
  // Long-running tools stream a fresher preview (a terminal's latest output
  // line, a search's current target) — the native chat swaps it into the row.
  _toolProgress(s, name, preview) {
    if (!preview) return;
    for (let i = s.log.length - 1; i >= 0; i--) {
      const it = s.log[i];
      if (it.kind !== "tool" || it.done) continue;
      if (name && it.name !== name) continue;
      it.context = compact(preview, 80);
      this._emit(s, { op: "toolUpdate", item: it });
      return;
    }
  }
  _setBusy(s, busy) {
    if (s.busy === busy) return;
    s.busy = busy;
    s.awaiting = false;              // a turn that starts or ends isn't blocked on an answer
    if (busy) { s.announced = false; s.unfinished = false; s.lastEventAt = Date.now(); }
    // A turn that goes quiet without ever producing a reply we could announce
    // didn't finish as far as we can tell — the socket died under it, or the
    // completion frame never reached us. Keep re-checking the transcript
    // instead of accepting the silence (see _verifyTurn).
    else s.unfinished = !s.announced;
    this._activity(s);
    this._ensureAlarm();          // watchdog runs for the duration of a turn
    if (!busy) this._scheduleVerify(s);
  }

  // ── end-of-turn reconciliation ──────────────────────────────────────────
  // The event stream is best-effort: a suspended background page, a dropped or
  // half-open socket, or a frame shape we didn't understand all end the same
  // way — a reply that's complete on the server and truncated (or missing)
  // here, with no notification. So after every turn settles, check our buffer
  // against the stored transcript, which is the authoritative copy.
  _scheduleVerify(s, attempt = 0) {
    clearTimeout(s.verifyTimer);
    if (attempt >= VERIFY_DELAYS_MS.length) {
      // Out of patience. Drop the flag so it stops holding the keepalive alarm
      // open; ⟳ and the next reconnect still re-read the transcript.
      s.unfinished = false; this._ensureAlarm(); return;
    }
    s.verifyTimer = setTimeout(() => this._verifyTurn(s, attempt).catch(() => {}), VERIFY_DELAYS_MS[attempt]);
  }
  async _verifyTurn(s, attempt = 0) {
    if (s.busy) return;                       // a new turn is running; its own end verifies
    const items = await this._fetchHistory(s);
    if (!items) { if (s.unfinished) this._scheduleVerify(s, attempt + 1); return; }
    // Only ever adopt MORE text — a transcript that lags behind must never
    // shorten what we already showed.
    if (lastAssistantText(items).length > lastAssistantText(s.log).length) {
      await this._resync(s);                  // clears `unfinished` and announces
      this._ensureAlarm();
      return;
    }
    // Nothing new yet. For a turn we watched finish cleanly that's the end of
    // it; for one that went quiet on us the reply may still be minutes out, so
    // keep looking on a widening interval rather than giving up at 1.5s (which
    // is how a long reply used to sit invisible until the user hit ⟳).
    if (s.unfinished) this._scheduleVerify(s, attempt + 1);
  }
  _activity(s) { this.broadcast({ type: "activity", storedId: s.storedId, busy: s.busy, unread: s.unread, awaiting: s.awaiting }); }
  // Alert when the reply isn't the session you're actively looking at — which
  // includes the case where NO view is open (ports empty), so a reply to the
  // last-viewed session still notifies.
  _shouldAlert(s) { return this.ports.size === 0 || !this._isActive(s); }
  _completed(s) {
    s.announced = true;
    if (this._shouldAlert(s)) { s.unread = true; this._activity(s); this._notify(s); }
    this.updateBadge();
  }
  _needsInput(s) {   // the agent is blocked waiting for an answer
    if (this._shouldAlert(s)) { s.unread = true; this._activity(s); this._notify(s, "Hermes needs your input."); }
    this.updateBadge();
  }
  _notify(s, message = "New reply in another session.") {
    this.broadcast({ type: "notify", storedId: s.storedId });
    if (!notifyCfg.system) return;
    try {
      browser.notifications.create(`hermes:${s.storedId}`, { type: "basic", title: "Hermes Agent", message });
    } catch {}
  }
  updateBadge() {
    const n = notifyCfg.badge ? [...this.sessions.values()].filter((x) => x.unread).length : 0;
    try {
      browser.action.setBadgeText({ text: n ? String(n) : "" });
      browser.action.setBadgeBackgroundColor({ color: "#e5484d" });   // red = attention
    } catch {}
  }

  // ── new-session detection (e.g. a timer/cron spawns a fresh session) ──
  // sessions.changed only signals "the list changed", so diff /api/sessions
  // against a baseline persisted in storage.session.
  _scheduleNewSessionCheck() {
    clearTimeout(this._newSessTimer);
    this._newSessTimer = setTimeout(() => this._checkNewSessions(), 1000);
  }
  async _checkNewSessions() {
    if (!notifyCfg.newSession) return;
    let list;
    try {
      const r = await fetch(HOST + ENDPOINTS.sessions, { credentials: "include" });
      if (!r.ok) return;
      list = (await r.json())?.sessions || [];
    } catch { return; }

    const stored = await browser.storage.session.get("knownSessions");
    if (stored.knownSessions === undefined) {
      // First sighting → baseline the existing sessions, don't alert on them.
      const seed = list.filter((s) => (s.message_count || 0) > 0).map((s) => s.id);
      await browser.storage.session.set({ knownSessions: seed });
      return;
    }

    const known = new Set(stored.knownSessions);
    const DENY = new Set(["tool", "kanban"]); // noisy internal sources (sub-agents, workers)
    let changed = false;
    for (const s of list) {
      if ((s.message_count || 0) <= 0 || known.has(s.id)) continue; // only real, unseen sessions
      known.add(s.id); changed = true;
      if (this.sessions.has(s.id)) continue;                        // one we already track
      if (DENY.has((s.source || "").toLowerCase())) continue;
      this._newSessionAlert(s);
    }
    if (changed) await browser.storage.session.set({ knownSessions: [...known] });
  }
  _newSessionAlert(sess) {
    const s = this._session(sess.id);   // minimal entry so it shows unread in badge/dropdown
    s.unread = true;
    this._activity(s);
    this.updateBadge();
    this._notify(s, `New session: ${sess.title || sess.id}`);
  }

  // ── viewer actions ──
  // Re-send the active session's buffer. No network — used when a view finds
  // itself out of sync with the stream (see the sidebar's render ops).
  rerender() {
    const s = this.active ? this.sessions.get(this.active) : null;
    if (s) this.broadcast({ type: "log", storedId: s.storedId, items: s.log, busy: s.busy, awaiting: s.awaiting });
  }

  _setActive(storedId) {
    this.active = storedId;
    // Persisted so a suspended/restarted background page comes back to the
    // chat the user was in, instead of stranding it behind a brand-new session.
    browser.storage.session.set({ activeSession: storedId }).catch(() => {});
  }

  async view(storedId) {
    const s = await this.openSession(storedId);
    this._setActive(storedId);
    s.unread = false; this.updateBadge();
    this.broadcast({ type: "log", storedId: s.storedId, items: s.log, busy: s.busy, awaiting: s.awaiting });
    return s;
  }
  async viewNew() {
    const s = await this.newSession();
    this._setActive(s.storedId);
    this.broadcast({ type: "log", storedId: s.storedId, items: s.log, busy: s.busy, awaiting: s.awaiting });
    return s;
  }
  async resumeActive() {
    // Sidebar (re)opened: re-attach to the active session, or make a fresh one.
    await this.ensureSocket();
    if (this.active && this.sessions.has(this.active)) return this.view(this.active);
    // Nothing in memory — we may have been suspended mid-conversation. Restore
    // the session that was open rather than silently starting over.
    const { activeSession } = await browser.storage.session.get("activeSession").catch(() => ({}));
    if (activeSession) {
      try { return await this.view(activeSession); } catch {}
    }
    return this.viewNew();
  }

  async submit(text, display) {
    if (!this.active) await this.viewNew();
    const s = this._session(this.active);
    if (!s.liveId) await this.openSession(s.storedId);
    this._push(s, { kind: "user", text: display ?? text });
    s.announced = false;
    const res = await this.request("prompt.submit", { session_id: s.liveId, text });
    // The gateway acks as soon as the turn is spawned. Mark the session busy on
    // that ack rather than waiting for message.start, so the watchdog is armed
    // even if the very first event of the turn is the one we lose.
    this._setBusy(s, true);
    return res;
  }
}

const gateway = new Gateway();

// Keepalive: the alarm fires even with no view open, keeping the socket connected
// (and reconnecting after a suspend) so replies still raise alerts.
browser.alarms.onAlarm.addListener((a) => { if (a.name === "hermes-keepalive") gateway.tick(); });
(async () => {
  const { settings } = await browser.storage.local.get("settings");
  if (globalThis.HERMES.notifyConfig(settings).background) { gateway._ensureAlarm(); gateway.keepalive(); }
})();

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "hermes:gateway") return;
  gateway.addPort(port);
  port.onMessage.addListener(async (m) => {
    try {
      if (m?.type === "resumeActive") await gateway.resumeActive();
      else if (m?.type === "view") await gateway.view(m.storedId);
      else if (m?.type === "new") await gateway.viewNew();
      else if (m?.type === "prompt") await gateway.submit(m.text, m.display);
      else if (m?.type === "resync" && m.storedId) await gateway.resync(m.storedId);
      else if (m?.type === "rerender") gateway.rerender();
      else if (m?.type === "respond") await gateway.respond(m);
      else if (m?.type === "markRead" && m.storedId) {
        const s = gateway.sessions.get(m.storedId);
        if (s) { s.unread = false; gateway.updateBadge(); }
      }
    } catch (e) {
      port.postMessage({ type: "error", error: `${e.name || "Error"}: ${e.message}` });
    }
  });
});
