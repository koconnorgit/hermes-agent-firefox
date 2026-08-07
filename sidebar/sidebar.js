// Sidebar controller: connection status, chat log, and the transport to Hermes.
// The extension holds host_permissions for the Hermes origin, so fetch/WebSocket
// from this document ride the user's existing dashboard session cookie
// (credentials: "include"). No token juggling needed while the user is signed in.

const { ENDPOINTS, DEFAULT_HOST } = globalThis.HERMES;
let HOST = DEFAULT_HOST;   // live Hermes host, loaded from settings during init
function hostOrigin() { return globalThis.HERMES.originPattern(HOST); }

const el = {
  status: document.getElementById("status"),
  log: document.getElementById("log"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  attach: document.getElementById("attach"),
  chip: document.getElementById("context-chip"),
  chipLabel: document.getElementById("context-label"),
  chipClear: document.getElementById("context-clear"),
  sessionSelect: document.getElementById("session-select"),
  sessionRefresh: document.getElementById("session-refresh"),
  openWeb: document.getElementById("open-web"),
  popout: document.getElementById("popout"),
  settings: document.getElementById("settings"),
  waiting: document.getElementById("waiting"),
};

let notifyCfg = globalThis.HERMES.notifyConfig(null);  // per-surface toggles, loaded from settings
let toolMode = globalThis.HERMES.toolDisplay(null);    // hidden | compact | detailed

// Show/hide the "response waiting" pill note and the dropdown ring when another
// session has an unread reply (each gated by its setting).
function updateUnreadIndicators() {
  const anyUnread = [...sessionMeta.values()].some((m) => m.unread);
  el.waiting.hidden = !(anyUnread && notifyCfg.pill);
  el.sessionSelect.classList.toggle("has-unread", anyUnread && notifyCfg.dropdown);
}

// This same document runs in two places: the sidebar (default_panel) and a
// floating popup window (opened with ?ctx=window). The button flips accordingly.
const isWindow = new URLSearchParams(location.search).get("ctx") === "window";

let attachedContext = null; // { title, url, excerpt/selection } sent with next msg

// ── UI helpers ─────────────────────────────────────────────────────────────
// Plain-text bubble. Used for our own status lines (and for anything a caller
// then appends elements to), matching the portal, which leaves system messages
// unformatted.
function addMsg(role, text = "") {
  const div = document.createElement("div");
  div.className = `msg msg--${role}`;
  div.textContent = text;
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
  return div;
}

// Chat bubble with the message rendered as markdown — headings, lists, code,
// emphasis, links — the way the dashboard renders the same text.
function addRich(role, text, streaming) {
  const div = document.createElement("div");
  div.className = `msg msg--${role} md`;
  paintRich(div, text, streaming);
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
  return div;
}
function paintRich(node, text, streaming) {
  node.textContent = "";
  node.appendChild(globalThis.HERMES_MD.render(text, { streaming }));
}
function setStatus(kind, label) {
  el.status.className = `status status--${kind}`;
  el.status.textContent = label;
}
// The pill for a session we're attached to. "waiting for input" comes from the
// gateway's own view of the session (session.active_list status) — a turn
// blocked on a clarify/sudo/secret answer is not the same as one still working,
// and calling it "working…" is what made a stalled session look alive.
function setTurnStatus(busy, awaiting) {
  setStatus("ok", awaiting ? "waiting for input" : busy ? "working…" : "connected");
}
function setContext(ctx, label) {
  attachedContext = ctx;
  if (ctx) {
    el.chipLabel.textContent = label || ctx.title || ctx.url || "page context";
    el.chip.hidden = false;
  } else {
    el.chip.hidden = true;
  }
}

// ── Host-permission gate (Firefox MV3) ────────────────────────────────────
// In Firefox MV3 the manifest's host_permissions are OPTIONAL and are not
// granted at install/load time. Without the grant, fetch() to the Hermes origin
// is refused and rejects — which looks like "unreachable". Detect that case and
// offer a one-click grant (permissions.request must run from a user gesture).
async function hasHostPermission() {
  try {
    return await browser.permissions.contains({ origins: [hostOrigin()] });
  } catch { return false; }
}

function promptForPermission() {
  setStatus("off", "needs access");
  const note = addMsg("system", "This add-on needs permission to talk to the Hermes host. ");
  const btn = document.createElement("button");
  btn.textContent = "Grant access to Hermes";
  btn.className = "send";
  btn.style.marginTop = "6px";
  btn.addEventListener("click", async () => {
    const granted = await browser.permissions
      .request({ origins: [hostOrigin()] })
      .catch(() => false);
    if (granted) { note.remove(); checkAuth(); }
    else addMsg("system", "Permission not granted. You can also enable it in about:addons → Hermes Agent → Permissions.");
  });
  note.appendChild(document.createElement("br"));
  note.appendChild(btn);
}

// ── Auth / connectivity check ──────────────────────────────────────────────
// The actual fetch runs in the background page (see background.js) to dodge the
// sidebar's cross-origin restrictions; here we just interpret the result.
async function checkAuth() {
  setStatus("unknown", "checking…");
  if (!(await hasHostPermission())) { promptForPermission(); return false; }

  const res = await browser.runtime
    .sendMessage({ type: "hermes:whoami" })
    .catch((e) => ({ ok: false, error: e.message }));

  if (res.ok) { setStatus("ok", "connected"); return true; }

  if (res.status === 401) {
    setStatus("off", "signed out");
    addMsg("system", "Not signed in. Open the Hermes dashboard, log in, then reload this sidebar.");
    const a = document.createElement("a");
    a.textContent = "Open dashboard login →";
    a.href = HOST + "/login";
    a.target = "_blank";
    a.style.color = "var(--midground)";
    el.log.lastChild.appendChild(document.createElement("br"));
    el.log.lastChild.appendChild(a);
    return false;
  }

  if (res.error) {
    setStatus("off", "blocked");
    const note = addMsg(
      "system",
      `Background request to ${HOST} threw: ${res.error}\n` +
      `Be sure to configure your Hermes host in `
    );
    const link = document.createElement("a");
    link.textContent = "Settings";
    link.href = "#";
    link.style.color = "var(--midground)";
    link.addEventListener("click", (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); });
    note.appendChild(link);
    note.appendChild(document.createTextNode("."));
    return false;
  }

  setStatus("off", `error ${res.status}`);
  return false;
}

// ── Transport: the background is the session hub; we render the active one ───
// The background keeps every opened session live and buffers each transcript, so
// switching never loses an in-flight reply. Here we render whatever session the
// background marks active (full "log"), apply incremental stream ops, and show
// other sessions' activity (busy/unread) in the dropdown.
let gatewayPort = null;
let viewingStoredId = null;    // storedId the log currently shows
let streamBubble = null;       // current streaming assistant bubble
let streamText = "";           // its raw markdown source (the DOM is a render of this)
let lastToolBubble = null;     // most recent "running tool" note
const sessionMeta = new Map(); // storedId → { busy, unread } for dropdown markers

let reconnectTimer = null;
let reconnectTries = 0;

function connectGateway() {
  if (gatewayPort) return gatewayPort;
  const port = browser.runtime.connect({ name: "hermes:gateway" });
  gatewayPort = port;
  port.onMessage.addListener(onGatewayMessage);
  port.onDisconnect.addListener(() => {
    gatewayPort = null;
    // The background page can be torn down (idle suspend, extension reload)
    // while this view is still open. Without a reconnect the pane goes deaf and
    // freezes on whatever it last painted — typically "working…" with the
    // composer locked, while the reply lands fine on the server.
    clearTimeout(reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** reconnectTries++);
    setStatus("unknown", "reconnecting…");
    reconnectTimer = setTimeout(() => {
      try { connectGateway().postMessage({ type: "resumeActive" }); } catch {}
    }, delay);
  });
  return port;
}

function onGatewayMessage(m) {
  reconnectTries = 0;          // the port is alive again
  switch (m.type) {
    case "log":        renderLog(m.storedId, m.items, m.busy, m.awaiting); break;
    case "render":     if (m.storedId === viewingStoredId) applyRenderOp(m); break;
    case "activity":   onActivity(m); break;
    case "notify":     break; // OS notification is fired by the background
    case "sessions-changed": scheduleSessionsReload(); break;
    case "closed":
      setStatus("off", "disconnected");
      el.send.disabled = false;   // never strand the composer on a dead socket
      if (streamBubble) {
        clearTimeout(paintTimer); paintTimer = null;
        paintRich(streamBubble, streamText, false);   // settle it: no caret on a dead socket
        streamBubble.classList.remove("streaming"); streamBubble = null; streamText = "";
      }
      if (m.code && m.code !== 1000) addMsg("system", `Gateway closed (code ${m.code}${m.reason ? ": " + m.reason : ""}).`);
      break;
    case "error":
      setStatus("off", "error");
      addMsg("system", `⚠ ${m.error}`);
      el.send.disabled = false;
      break;
  }
}

// Build a bubble for one buffered item.
function renderItem(item) {
  if (item.kind === "user") return addRich("user", item.text || "", false);
  if (item.kind === "assistant") {
    const b = addRich("agent", item.text || "", !!item.streaming);
    if (item.streaming) { b.classList.add("streaming"); streamBubble = b; streamText = item.text || ""; }
    return b;
  }
  if (item.kind === "tool") return renderTool(item);
  if (item.kind === "request") return renderRequest(item);
  return addMsg("system", item.text || "");
}

// ── Tool / skill / terminal rows ───────────────────────────────────────────
// Three modes, per Settings → Tool activity (see HERMES.toolDisplay):
//   hidden   — skip the row entirely, leaving only what Hermes says
//   compact  — "✓ terminal"
//   detailed — the native chat's line, `Terminal("ls -la") (0.4s) ✓`, with the
//              call's arguments and result folded underneath
// The background buffers the full detail regardless, so switching modes is a
// re-render of what's already in hand.

// snake_case tool name → the native chat's Title Case label (ui-tui
// lib/text.ts toolTrailLabel).
function toolLabel(name) {
  const n = String(name || "tool");
  return n.split("_").filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ") || n;
}
// Matches the gateway's _fmt_tool_duration so a call reads the same in both UIs.
function fmtDuration(sec) {
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
const compactLine = (item) => `${item.done ? (item.error ? "✗" : "✓") : "⚙"} ${item.name || "tool"}`;

function renderTool(item) {
  if (toolMode === "hidden") return null;
  const node = toolMode === "compact"
    ? addMsg("system", compactLine(item))
    : el.log.appendChild(document.createElement("div"));
  node.dataset.toolId = item.toolId || "";
  if (toolMode !== "compact") { node.className = "msg msg--tool"; paintTool(node, item); }
  el.log.scrollTop = el.log.scrollHeight;
  if (!item.done) lastToolBubble = node;
  return node;
}

function paintTool(node, item) {
  // Repainting drops the DOM, so carry the disclosure state across an update —
  // a running tool repaints on every progress event, and collapsing the block
  // out from under someone reading it is worse than the stale frame.
  const wasOpen = node.querySelector(".tool-more")?.open;
  node.textContent = "";
  node.classList.toggle("running", !item.done);
  node.classList.toggle("failed", !!item.error);

  const head = document.createElement("div");
  head.className = "tool-head";
  const mark = document.createElement("span");
  mark.className = "tool-mark";
  mark.textContent = item.done ? (item.error ? "✗" : "✓") : "⚙";
  const call = document.createElement("span");
  call.className = "tool-call";
  call.textContent = item.context ? `${toolLabel(item.name)}("${item.context}")` : toolLabel(item.name);
  head.appendChild(mark);
  head.appendChild(call);
  if (typeof item.durationS === "number") {
    const dur = document.createElement("span");
    dur.className = "tool-dur";
    dur.textContent = fmtDuration(item.durationS);
    head.appendChild(dur);
  }
  node.appendChild(head);

  const note = item.error || item.summary;
  if (note) {
    const n = document.createElement("div");
    n.className = "tool-note";
    n.textContent = note;
    node.appendChild(n);
  }

  const blocks = [["Args", item.argsText], ["Result", item.resultText], ["Diff", item.diff]].filter(([, v]) => v);
  if (!blocks.length) return;
  const more = document.createElement("details");
  more.className = "tool-more";
  more.open = !!wasOpen;
  const sum = document.createElement("summary");
  sum.textContent = blocks.map(([k]) => k.toLowerCase()).join(" · ");
  more.appendChild(sum);
  for (const [label, text] of blocks) {
    const h = document.createElement("div");
    h.className = "tool-block-h";
    h.textContent = label;
    const pre = document.createElement("pre");
    pre.className = "tool-block";
    pre.textContent = text;
    more.appendChild(h);
    more.appendChild(pre);
  }
  node.appendChild(more);
}

// Concurrent tool calls interleave, so prefer the id; fall back to the row we
// opened last for payloads that carry none.
function findToolBubble(item) {
  if (item.toolId) {
    const nodes = el.log.querySelectorAll("[data-tool-id]");
    for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].dataset.toolId === item.toolId) return nodes[i];
  }
  return lastToolBubble;
}

function updateTool(item) {
  if (toolMode === "hidden") return;
  const node = findToolBubble(item);
  if (!node) { requestRerender(); return; }   // buffer and view have diverged
  if (toolMode === "compact") node.textContent = compactLine(item);
  else paintTool(node, item);
  if (item.done && lastToolBubble === node) lastToolBubble = null;
}

// Interactive approval / clarify / sudo / secret request card.
const REQ_HEAD = {
  approval: "⚠ Approve this command?",
  clarify: "❔ Hermes is asking:",
  sudo: "🔒 Password required",
  secret: "🔑 Secret required",
};
const CHOICE_LABEL = { once: "Approve once", session: "Approve for session", always: "Always approve", approve: "Approve", deny: "Deny" };
const prettyChoice = (c) => CHOICE_LABEL[c] || c;

function renderRequest(item) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg--request";
  el.log.appendChild(wrap);

  if (item.resolved) {
    wrap.classList.add("resolved");
    wrap.textContent = `▸ ${item.rtype} — ${item.answer || "resolved"}`;
    el.log.scrollTop = el.log.scrollHeight;
    return wrap;
  }

  const finish = (label) => { wrap.className = "msg msg--request resolved"; wrap.textContent = `▸ ${item.rtype} — ${label}`; };

  const head = document.createElement("div");
  head.className = "req-head";
  head.textContent = REQ_HEAD[item.rtype] || "Hermes needs input";
  wrap.appendChild(head);

  if (item.rtype === "approval" && item.command) {
    const pre = document.createElement("pre"); pre.className = "req-cmd"; pre.textContent = item.command; wrap.appendChild(pre);
  } else if (item.question) {
    const q = document.createElement("div"); q.className = "req-q"; q.textContent = item.question; wrap.appendChild(q);
  }

  const actions = document.createElement("div");
  actions.className = "req-actions";

  if (item.choices && item.choices.length && item.multi) {
    // Multi-select clarify: toggle each choice, then Send. Answer is a JSON array.
    const selected = new Set();
    for (const ch of item.choices) {
      const btn = document.createElement("button");
      btn.className = "req-btn req-btn--toggle"; btn.textContent = ch;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        const on = selected.has(ch);
        if (on) selected.delete(ch); else selected.add(ch);
        btn.classList.toggle("on", !on);
        btn.setAttribute("aria-pressed", String(!on));
      });
      actions.appendChild(btn);
    }
    const send = document.createElement("button");
    send.className = "req-btn"; send.textContent = "Send";
    send.addEventListener("click", () => {
      const arr = item.choices.filter((c) => selected.has(c));
      finish(arr.join(", ") || "(none)");
      respondRequest(item, arr.join(", "), { answer: JSON.stringify(arr) });
    });
    actions.appendChild(send);
  } else if (item.choices && item.choices.length) {
    for (const ch of item.choices) {
      const btn = document.createElement("button");
      btn.className = "req-btn" + (ch === "deny" ? " req-btn--danger" : "");
      btn.textContent = prettyChoice(ch);
      btn.addEventListener("click", () => {
        finish(prettyChoice(ch));
        respondRequest(item, prettyChoice(ch), item.rtype === "approval" ? { choice: ch } : { answer: ch });
      });
      actions.appendChild(btn);
    }
  } else {
    const secret = item.rtype === "sudo" || item.rtype === "secret";
    const input = document.createElement("input");
    input.className = "req-input";
    input.type = secret ? "password" : "text";
    input.placeholder = item.rtype === "sudo" ? "Password" : item.rtype === "secret" ? "Secret value" : "Your answer";
    const btn = document.createElement("button");
    btn.className = "req-btn"; btn.textContent = "Send";
    const go = () => {
      const val = input.value;
      if (!val && item.rtype !== "clarify") return;
      const key = item.rtype === "sudo" ? "password" : item.rtype === "secret" ? "value" : "answer";
      finish(secret ? "•••" : val || "(skipped)");
      respondRequest(item, secret ? "•••" : val, { [key]: val });
    };
    btn.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    actions.appendChild(input); actions.appendChild(btn);
  }

  wrap.appendChild(actions);
  el.log.scrollTop = el.log.scrollHeight;
  return wrap;
}

function respondRequest(item, label, extra) {
  connectGateway().postMessage({
    type: "respond", rtype: item.rtype, liveId: item.liveId, requestId: item.requestId, label, ...extra,
  });
}

function renderLog(storedId, items, busy, awaiting) {
  viewingStoredId = storedId;
  clearTimeout(paintTimer); paintTimer = null;
  streamBubble = null; streamText = ""; lastToolBubble = null;
  el.log.textContent = "";
  for (const item of items || []) renderItem(item);
  el.log.scrollTop = el.log.scrollHeight;
  const meta = sessionMeta.get(storedId); if (meta) { meta.unread = false; decorateOption(storedId); }
  updateUnreadIndicators();
  syncDropdownTo(storedId);
  setTurnStatus(busy, awaiting);
  el.send.disabled = !!busy;
}

// A stream op arrived with no bubble to put it in — the pane's view of the
// stream and the background's buffer have diverged (a dropped socket nulls the
// bubble, a re-render can land mid-turn). Guessing here is how a finished reply
// ends up on screen truncated or missing until you refresh; ask the background
// to re-send the buffer instead, since it holds the authoritative copy.
let rerenderPending = false;
function requestRerender() {
  if (rerenderPending) return;
  rerenderPending = true;
  setTimeout(() => {
    rerenderPending = false;
    try { connectGateway().postMessage({ type: "rerender" }); } catch {}
  }, 250);
}

// Markdown has to be re-parsed from the whole message on every change, so
// repaint on a short timer instead of per token — a long reply would otherwise
// re-render thousands of times as it streams.
let paintTimer = null;
function schedulePaint() {
  if (paintTimer) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    if (!streamBubble) return;
    paintRich(streamBubble, streamText, true);
    el.log.scrollTop = el.log.scrollHeight;
  }, 80);
}

function applyRenderOp(m) {
  switch (m.op) {
    case "push":
      renderItem(m.item);
      el.log.scrollTop = el.log.scrollHeight;
      break;
    case "delta":
      if (streamBubble) { streamText += m.text; schedulePaint(); }
      else requestRerender();
      break;
    case "end":
      if (streamBubble) {
        // m.text is the background's full buffered text — authoritative, since
        // any delta we missed leaves what's on screen truncated.
        if (typeof m.text === "string" && m.text.length > streamText.length) streamText = m.text;
        clearTimeout(paintTimer); paintTimer = null;
        paintRich(streamBubble, streamText, false);   // final paint, caret dropped
        streamBubble.classList.remove("streaming"); streamBubble = null; streamText = "";
        el.log.scrollTop = el.log.scrollHeight;
      } else requestRerender();   // the completed reply would otherwise be dropped
      break;
    case "toolUpdate":
      updateTool(m.item);
      break;
  }
}

function onActivity(m) {
  sessionMeta.set(m.storedId, { busy: m.busy, unread: m.unread });
  if (m.storedId === viewingStoredId) {
    setTurnStatus(m.busy, m.awaiting);
    el.send.disabled = !!m.busy;
  }
  decorateOption(m.storedId);
  updateUnreadIndicators();
}

// Fold any attached page context into the prompt text (prompt.submit takes text).
function composePrompt(text) {
  if (!attachedContext) return text;
  const c = attachedContext;
  const parts = [`[Page context — ${c.title || c.url || "current tab"}]`];
  if (c.url) parts.push(`URL: ${c.url}`);
  if (c.selection) parts.push(`Selected text:\n${c.selection}`);
  else if (c.excerpt) parts.push(`Page text (excerpt):\n${c.excerpt}`);
  parts.push(`\n---\n${text}`);
  return parts.join("\n");
}

function send(text) {
  if (!text.trim()) return;
  el.send.disabled = true;
  const composed = composePrompt(text);
  setContext(null);                 // context consumed once sent
  // The user + assistant bubbles arrive back as render ops from the background.
  connectGateway().postMessage({ type: "prompt", text: composed, display: text });
}

// ── Sessions dropdown ───────────────────────────────────────────────────────
async function apiGet(path) {
  const res = await browser.runtime
    .sendMessage({ type: "hermes:api", path })
    .catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) throw new Error(res?.error || `GET ${path} → ${res?.status}`);
  return res.data;
}

let sessionsReloadTimer = null;
function scheduleSessionsReload() {          // debounce: sessions.changed fires in bursts
  clearTimeout(sessionsReloadTimer);
  sessionsReloadTimer = setTimeout(loadSessions, 400);
}

function optionFor(storedId) {
  return [...el.sessionSelect.options].find((o) => o.value === storedId);
}
function decorateOption(storedId) {          // prefix a marker for unread/busy sessions
  const opt = optionFor(storedId);
  if (!opt || !opt.dataset.base) return;
  const meta = sessionMeta.get(storedId);
  const mark = meta?.unread ? "● " : meta?.busy ? "… " : "";
  opt.textContent = mark + opt.dataset.base;
}
function syncDropdownTo(storedId) {
  el.sessionSelect.value = optionFor(storedId) ? storedId : "";
}

async function loadSessions() {
  try {
    const data = await apiGet(ENDPOINTS.sessions);
    const sessions = (data?.sessions || [])
      .filter((s) => (s.message_count || 0) > 0)   // hide empty throwaway sockets, keep real chats
      .sort((a, b) => (b.last_activity_at || b.started_at || 0) - (a.last_activity_at || a.started_at || 0));
    const current = el.sessionSelect.value;
    el.sessionSelect.innerHTML = '<option value="">＋ New chat</option>';
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.id;
      const label = (s.title || s.id).slice(0, 42);
      opt.dataset.base = s.message_count ? `${label} (${s.message_count})` : label;
      opt.textContent = opt.dataset.base;
      el.sessionSelect.appendChild(opt);
      decorateOption(s.id);
    }
    // Prefer the session actually being viewed (survives the reopen race where
    // the log restores before the options exist); otherwise keep prior selection.
    const target = viewingStoredId && optionFor(viewingStoredId) ? viewingStoredId : current;
    el.sessionSelect.value = target || "";
  } catch (e) {
    console.warn("[hermes] loadSessions failed:", e);
  }
}

function selectSession(storedId) {
  el.send.disabled = true;
  connectGateway().postMessage({ type: "view", storedId });   // background resumes + sends the log
}

function newChat() {
  connectGateway().postMessage({ type: "new" });              // background creates + sends an empty log
}

// ── Pop out / dock ──────────────────────────────────────────────────────────
// The session hub (transcripts, active session) lives in the background page, so
// it survives the move — the reopened view just asks for the active session's log
// via "resumeActive". The handoff only carries the window we popped out from.
let dockTargetWindowId = null;   // the normal window we popped out from (window ctx)
let myWindowId = null;           // this document's own window (cached at init)

async function saveHandoff(extra = {}) {
  await browser.storage.session.set({ handoff: { ...extra } });
}
async function consumeHandoff() {
  const { handoff } = await browser.storage.session.get("handoff");
  if (handoff) await browser.storage.session.remove("handoff");
  return handoff || null;
}

function popOut() {
  // Save state (fire — the popup reads it once it loads), have the BACKGROUND
  // open the window, then close our own sidebar synchronously. Creating the
  // window in the background is what lets us close the sidebar immediately
  // without the popup stealing focus first (which used to leave both open).
  saveHandoff({ originWindowId: myWindowId });
  browser.runtime.sendMessage({ type: "hermes:openWindow" });
  browser.sidebarAction.close().catch((e) => console.warn("[hermes] sidebar close failed:", e));
}

async function dock() {
  // Firefox won't let a popup auto-open a normal window's sidebar (no gesture it
  // can satisfy), so docking: persist state, focus the origin window, close the
  // popup. The user reopens the pane via the toolbar icon or Ctrl+Shift+Y — the
  // sidebar restores this state from the handoff on open. The open() below is a
  // harmless best-effort in case a Firefox build ever allows it.
  await saveHandoff();
  try {
    if (dockTargetWindowId != null) {
      await browser.windows.update(dockTargetWindowId, { focused: true });
    }
    await browser.sidebarAction.open();
  } catch (e) {
    console.warn("[hermes] dock open (best-effort) failed:", e);
  }
  window.close();
}

function setupPopButton() {
  if (isWindow) {
    el.popout.textContent = "⤓";
    el.popout.title = "Dock (reopen the pane via the toolbar icon or Ctrl+Shift+Y)";
    el.popout.addEventListener("click", dock);
  } else {
    el.popout.title = "Pop out to a floating window";
    el.popout.addEventListener("click", popOut);
  }
}

// ── Open the current chat in the dashboard ─────────────────────────────────
// The web UI resumes a transcript at /chat?resume=<session id> — the same link
// its own Sessions page uses. With no session open yet, land on a blank /chat.
function dashboardChatUrl() {
  return HOST + "/chat" + (viewingStoredId ? `?resume=${encodeURIComponent(viewingStoredId)}` : "");
}

async function openInDashboard() {
  const url = dashboardChatUrl();
  // In the pop-out, "the current window" is a popup with no tab strip, so a bare
  // tabs.create would bury the tab in it. Aim at a real browser window instead.
  if (isWindow) {
    const wins = await browser.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
    const target = wins.find((w) => w.id === dockTargetWindowId) || wins.find((w) => w.focused) || wins[0];
    if (!target) { await browser.windows.create({ url }); return; }
    await browser.tabs.create({ url, windowId: target.id, active: true });
    await browser.windows.update(target.id, { focused: true }).catch(() => {});
    return;
  }
  await browser.tabs.create({ url, active: true });
}

// ── Page-context attach ────────────────────────────────────────────────────
async function attachActivePage() {
  const resp = await browser.runtime
    .sendMessage({ type: "hermes:requestActiveContext" })
    .catch(() => null);
  if (resp?.context) {
    const c = resp.context;
    setContext(
      { url: c.url, title: c.title, selection: c.selection, excerpt: c.excerpt },
      c.selection ? `selection · ${c.title || c.url}` : c.title || c.url
    );
  } else {
    addMsg("system", "Couldn't read the active tab (some pages block content scripts).");
  }
}

// ── Tasks pushed from the context menu / toolbar ───────────────────────────
async function drainPendingTask() {
  const { pendingTask } = await browser.storage.session.get("pendingTask");
  if (pendingTask) {
    await browser.storage.session.remove("pendingTask");
    applyTask(pendingTask);
  }
}
function applyTask(task) {
  if (task.kind === "selection") {
    setContext({ url: task.url, title: task.title, selection: task.text }, `selection · ${task.title || task.url}`);
    el.input.value = "Explain this selection.";
  } else if (task.kind === "page" && task.context) {
    const c = task.context;
    setContext({ url: c.url, title: c.title, excerpt: c.excerpt }, c.title || c.url);
    el.input.value = "Summarize this page.";
  }
  el.input.focus();
}
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "hermes:pendingTask" && msg.task) {
    applyTask(msg.task);
    browser.storage.session.remove("pendingTask");  // consumed here; don't let init replay it
  }
});

// ── Wiring ─────────────────────────────────────────────────────────────────
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.input.value;
  el.input.value = "";
  el.input.style.height = "auto";
  send(text);
});
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.form.requestSubmit(); }
});
el.input.addEventListener("input", () => {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 140) + "px";
});
el.attach.addEventListener("click", attachActivePage);
el.chipClear.addEventListener("click", () => setContext(null));
el.sessionSelect.addEventListener("change", () => {
  const v = el.sessionSelect.value;
  if (v) selectSession(v); else newChat();
});
el.sessionRefresh.addEventListener("click", () => {
  loadSessions();
  // Manual escape hatch: re-pull the open session's transcript from the server,
  // so a reply that arrived while we were disconnected shows up on demand.
  if (viewingStoredId) connectGateway().postMessage({ type: "resync", storedId: viewingStoredId });
});
el.openWeb.addEventListener("click", () => {
  openInDashboard().catch((e) => addMsg("system", `Couldn't open the dashboard: ${e.message}`));
});
el.settings.addEventListener("click", () => browser.runtime.openOptionsPage());
setupPopButton();
browser.windows.getCurrent().then((w) => { myWindowId = w.id; }).catch(() => {});

// When the host changes in Settings, re-point and reconnect automatically so the
// user doesn't have to close and reopen the sidebar. (The background resets its
// socket on the same event — see background.js.)
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  notifyCfg = globalThis.HERMES.notifyConfig(changes.settings.newValue);
  updateUnreadIndicators();   // reflect toggled indicators immediately
  // Tool rows are drawn from the background's buffer, so a mode change only
  // needs a repaint of the open transcript — no refetch, nothing lost.
  const newToolMode = globalThis.HERMES.toolDisplay(changes.settings.newValue);
  if (newToolMode !== toolMode) {
    toolMode = newToolMode;
    try { connectGateway().postMessage({ type: "rerender" }); } catch {}
  }
  const newHost = changes.settings.newValue?.host || DEFAULT_HOST;
  if (newHost !== HOST) { HOST = newHost; reconnect(); }
});

async function reconnect() {
  clearTimeout(paintTimer); paintTimer = null;
  streamBubble = null; streamText = "";
  el.log.textContent = "";
  setStatus("unknown", "reconnecting…");
  const ok = await checkAuth();
  if (ok) {
    connectGateway().postMessage({ type: "resumeActive" });
    loadSessions();
  }
}

(async () => {
  // Context-menu "fresh open" → ask for a NEW session. Otherwise re-attach to the
  // active session (the background sends its full buffered log either way).
  const { settings } = await browser.storage.local.get("settings");
  if (settings?.host) HOST = settings.host;   // point at the configured Hermes host
  notifyCfg = globalThis.HERMES.notifyConfig(settings);
  toolMode = globalThis.HERMES.toolDisplay(settings);

  const { pendingTask } = await browser.storage.session.get("pendingTask");
  const handoff = await consumeHandoff();
  const freshOpen = !!pendingTask?.freshOpen;
  if (handoff?.originWindowId != null) dockTargetWindowId = handoff.originWindowId;

  const ok = await checkAuth();
  if (ok) {
    const port = connectGateway();
    port.postMessage(freshOpen ? { type: "new" } : { type: "resumeActive" });
    await loadSessions();
  }
  drainPendingTask();                              // apply the selection/page context, if any
})();
