// Shared config, loaded as a classic script in the background page and the
// sidebar/options documents. Everything hangs off the global `HERMES`.
//
// The Hermes host is user-configurable (Settings → Host). This file holds only
// the DEFAULT host and host-independent endpoint paths; each context reads the
// live host from storage.local (`settings.host`) at runtime and builds URLs from
// the helpers below.
//
// The helpers below refer to `H` rather than `this` on purpose: callers are free
// to pull them off the object (`const { originPattern } = globalThis.HERMES`),
// and an unbound `this` would silently be `globalThis` in these classic scripts.
globalThis.HERMES = (() => {
const H = {
  // Placeholder default — set your actual Hermes host per-install in the
  // extension's Settings (⚙), or change this default for your own build.
  DEFAULT_HOST: "http://localhost:9119",

  // Host-independent paths. The API lives under /api (NOT /api/v1).
  ENDPOINTS: {
    whoami: "/api/auth/me",              // identity / "am I logged in?" probe
    sessions: "/api/sessions",           // session list
    messages: (sid) => `/api/sessions/${sid}/messages`, // a session's transcript
    wsTicket: "/api/auth/ws-ticket",     // short-lived ticket for the /api/ws socket
    login: "/auth/password-login",       // cookie login
  },

  // Per-surface notification toggles (settings.notify). All default on.
  // `background`: keep a connection alive while all views are closed so replies
  // still alert. The others gate individual on-screen/desktop signals.
  // `newSession`: alert when a brand-new session appears (e.g. a timer/cron run).
  NOTIFY_DEFAULTS: { badge: true, dropdown: true, pill: true, system: true, background: true, newSession: true },
  notifyConfig(settings) { return { ...H.NOTIFY_DEFAULTS, ...(settings?.notify || {}) }; },

  normHost(host) { return String(host || "").replace(/\/+$/, ""); },
  // ws://host/api/ws (or wss:// for an https host) — the JSON-RPC socket.
  wsUrl(host) { return H.normHost(host).replace(/^http/i, "ws") + "/api/ws"; },
  // Match pattern for host_permissions / permissions.request.
  // Firefox match patterns must NOT contain a port — "http://host:9119/*" is an
  // invalid pattern that permissions.request()/contains() silently reject, so the
  // grant prompt never shows and access is never obtained (see Firefox bug 1362809).
  // Drop the port; a portless pattern matches the host on every port.
  originPattern(host) {
    const h = H.normHost(host);
    try {
      const u = new URL(h);
      return `${u.protocol}//${u.hostname}/*`;
    } catch {
      return h.replace(/:\d+$/, "") + "/*";
    }
  },
};
return H;
})();
