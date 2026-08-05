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
//   create   session.create {close_on_disconnect:true, source:"tool"} → {session_id}
//   send     prompt.submit {session_id, text}
//   stream   {method:"event", params:{type, payload, session_id}} — types:
//            message.start|delta|complete, reasoning.delta, tool.start|complete,
//            status.update, error, approval.request, …

// config.js is loaded before this file (see manifest background.scripts).
const { ENDPOINTS, DEFAULT_HOST } = globalThis.HERMES;
let HOST = DEFAULT_HOST;  // live Hermes host; overridden from settings below

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
// Session item shape: {kind:"user"|"assistant"|"tool"|"system", text?, name?,
// streaming?, done?}.
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
  }

  addPort(port) { this.ports.add(port); port.onDisconnect.addListener(() => this.ports.delete(port)); }
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
      ws.onopen = () => { clearTimeout(to); this.ws = ws; this.state = "open"; resolve(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error("ws connect failed")); };
      ws.onclose = (ev) => {
        this.state = "closed"; this.ws = null;
        this.liveToStored.clear();
        for (const s of this.sessions.values()) s.liveId = null;  // must re-resume after reconnect
        this._failAll(new Error(`ws closed (${ev.code})`));
        this.broadcast({ type: "closed", code: ev.code, reason: ev.reason });
      };
      ws.onmessage = (e) => this._onFrame(e.data);
    });
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error("gateway not connected"));
      const id = `w${++this.seq}`;
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`request timed out: ${method}`)); } }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  _failAll(err) { for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); try { reject(err); } catch {} } this.pending.clear(); }

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
    if (!s) { s = { storedId, liveId: null, log: [], busy: false, unread: false, seeded: false }; this.sessions.set(storedId, s); }
    return s;
  }

  async newSession() {
    await this.ensureSocket();
    const res = await this.request("session.create", { close_on_disconnect: true, source: "tool" });
    const liveId = res?.session_id;
    const storedId = res?.stored_session_id || liveId;
    const s = this._session(storedId);
    s.liveId = liveId; s.seeded = true;                // brand new → empty transcript
    if (liveId) this.liveToStored.set(liveId, storedId);
    return s;
  }

  async openSession(storedId) {
    await this.ensureSocket();
    const s = this._session(storedId);
    if (!s.liveId) {
      const res = await this.request("session.resume", { session_id: storedId, omit_messages: true });
      s.liveId = res?.session_id || null;
      if (s.liveId) this.liveToStored.set(s.liveId, storedId);
    }
    if (!s.seeded) { await this._seed(s); s.seeded = true; }
    return s;
  }

  async _seed(s) {
    try {
      const r = await fetch(`${HOST}/api/sessions/${encodeURIComponent(s.storedId)}/messages`, { credentials: "include" });
      const data = await r.json().catch(() => null);
      const items = [];
      for (const m of (data?.messages || [])) {
        if (m.role === "user" && m.content) items.push({ kind: "user", text: m.content });
        else if (m.role === "assistant") {
          if (m.content) items.push({ kind: "assistant", text: m.content });
          for (const tc of (m.tool_calls || [])) items.push({ kind: "tool", name: tc.function?.name || tc.name || "tool", done: true });
        }
      }
      s.log = items.concat(s.log);                     // history precedes anything already buffered
    } catch {}
  }

  // ── incoming events → per-session log ──
  _onEvent(ev) {
    if (ev.type === "sessions.changed") { this.broadcast({ type: "sessions-changed" }); return; }
    const storedId = ev.session_id ? this.liveToStored.get(ev.session_id) : null;
    if (!storedId) return;
    const s = this._session(storedId);
    const p = ev.payload || {};
    switch (ev.type) {
      case "message.start": this._push(s, { kind: "assistant", text: "", streaming: true }); this._setBusy(s, true); break;
      case "message.delta": if (typeof p.text === "string") this._appendAssistant(s, p.text); break;
      case "message.complete": this._endAssistant(s, p.text); this._setBusy(s, false); this._completed(s); break;
      case "tool.start": this._push(s, { kind: "tool", name: p.name || p.tool || "tool", done: false }); break;
      case "tool.complete": this._toolDone(s, p.name || p.tool); break;
      case "error": this._push(s, { kind: "system", text: `⚠ ${p.message || p.text || "agent error"}` }); this._setBusy(s, false); break;
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
  _endAssistant(s, finalText) {
    const last = s.log[s.log.length - 1];
    if (last && last.kind === "assistant" && last.streaming) {
      if (!last.text && typeof finalText === "string") last.text = finalText;
      last.streaming = false;
      this._emit(s, { op: "end", text: last.text });
    }
  }
  _toolDone(s, name) {
    for (let i = s.log.length - 1; i >= 0; i--) {
      const it = s.log[i];
      if (it.kind === "tool" && !it.done) { it.done = true; if (name) it.name = name; this._emit(s, { op: "toolDone", name: it.name }); break; }
    }
  }
  _setBusy(s, busy) { if (s.busy !== busy) { s.busy = busy; this._activity(s); } }
  _activity(s) { this.broadcast({ type: "activity", storedId: s.storedId, busy: s.busy, unread: s.unread }); }
  _completed(s) {
    if (!this._isActive(s)) { s.unread = true; this._activity(s); this._notify(s); }
    this.updateBadge();
  }
  _needsInput(s) {   // the agent is blocked waiting for an answer
    if (!this._isActive(s)) { s.unread = true; this._activity(s); this._notify(s, "Hermes needs your input."); }
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

  // ── viewer actions ──
  async view(storedId) {
    const s = await this.openSession(storedId);
    this.active = storedId;
    s.unread = false; this.updateBadge();
    this.broadcast({ type: "log", storedId: s.storedId, items: s.log, busy: s.busy });
    return s;
  }
  async viewNew() {
    const s = await this.newSession();
    this.active = s.storedId;
    this.broadcast({ type: "log", storedId: s.storedId, items: s.log, busy: s.busy });
    return s;
  }
  async resumeActive() {
    // Sidebar (re)opened: re-attach to the active session, or make a fresh one.
    await this.ensureSocket();
    if (this.active && this.sessions.has(this.active)) return this.view(this.active);
    return this.viewNew();
  }

  async submit(text, display) {
    if (!this.active) await this.viewNew();
    const s = this._session(this.active);
    if (!s.liveId) await this.openSession(s.storedId);
    this._push(s, { kind: "user", text: display ?? text });
    return this.request("prompt.submit", { session_id: s.liveId, text });
  }
}

const gateway = new Gateway();

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "hermes:gateway") return;
  gateway.addPort(port);
  port.onMessage.addListener(async (m) => {
    try {
      if (m?.type === "resumeActive") await gateway.resumeActive();
      else if (m?.type === "view") await gateway.view(m.storedId);
      else if (m?.type === "new") await gateway.viewNew();
      else if (m?.type === "prompt") await gateway.submit(m.text, m.display);
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
