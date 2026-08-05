# Hermes Agent — Firefox extension

A Firefox sidebar (and pop-out window) for chatting with a self-hosted
[Nous Research **Hermes Agent**](https://github.com/NousResearch/hermes-agent)
dashboard — multi-session chat with live streaming, page context, and interactive
approvals, all riding your existing dashboard login.

## Features

- **Chat** with the agent over its JSON-RPC WebSocket (`/api/ws`), streaming
  replies token-by-token.
- **Multiple sessions** — a dropdown lists your sessions; switch freely. Each
  session is buffered in the background, so a reply that lands while you're
  looking elsewhere is complete when you switch back, with an unread badge +
  desktop notification.
- **Page context** — a `＋page` button and right-click "Ask Hermes about this
  page / selection" fold the current tab's content into your prompt (works in the
  sidebar and the pop-out window).
- **Pop out / dock** — move the chat into a floating window and back; choose the
  default in Settings. Reopen the pane with the toolbar icon or `Ctrl+Shift+Y`.
- **Interactive requests** — answer the agent's approval, clarify (single &
  multi-select), sudo, and secret prompts inline instead of in the dashboard.

## Requirements

- **Firefox 128 or newer.**
- Access to a running **Hermes Agent** dashboard, and an account you can log into
  there.

## Install

1. Go to the [**Releases**](../../releases) page and download the latest
   `hermes-agent-firefox-<version>.xpi`.
2. Open that `.xpi` in Firefox (or `about:addons` → gear → *Install Add-on From
   File…*) and confirm the prompt.
3. The build is signed, so it stays installed across restarts **and updates
   itself** whenever a new release ships — no reinstalling.

Then set it up:

1. Click the toolbar icon (or **View → Sidebar → Hermes Agent**) to open the
   chat, and open **Settings** (⚙ in the header).
2. Enter your **Hermes host** (e.g. `http://hermes.example:9119`), click **Save
   host**, and allow the access prompt.
3. Sign in at your Hermes dashboard once — the extension reuses that session.

### Authentication & host notes

Hermes uses a **session cookie**; the extension sends requests with your existing
dashboard session and stores no token or API key of its own. Both HTTP and HTTPS
hosts work — Firefox normally auto-upgrades `http://` from extensions to
`https://`, but this extension suppresses that so a plain-HTTP host is reachable
(HTTPS is still recommended).

## Troubleshooting

**"blocked" / `NetworkError`, or nothing loads.** The extension can't reach your
Hermes host. Open **Settings (⚙)**, confirm the **host** URL, click **Save host**,
and **allow** Firefox's access prompt. Make sure Hermes is running and reachable
from this machine (try opening the host URL in a normal tab). The status pill
shows **blocked** in this state, with a link straight to Settings.

**"signed out."** You're reaching the host but aren't logged in. Open your Hermes
dashboard in the same Firefox, sign in, and the sidebar reconnects (or reopen it).

**A "Grant access to Hermes" button appears.** Firefox hasn't granted the
extension access to your host yet — click it (or set the host in Settings, which
asks for access). The status message may say access "was not granted" only if you
dismiss that prompt.

**Changed the host but it didn't switch.** Saving a new host reconnects
automatically; if a stale view lingers, pick a session from the dropdown or reopen
the sidebar.

**Docked from the pop-out window and the pane didn't reappear.** Firefox doesn't
let a popup reopen a sidebar — reopen it with the toolbar icon or **Ctrl+Shift+Y**
(your chat is preserved).

**Switched away mid-reply and the message looks cut off.** It's still buffering in
the background; the full text is there when the turn finishes. Reselecting the
session reloads it complete.

**No badge / notification for other sessions.** Check **Settings → Notifications**
(toolbar badge, dropdown highlight, "response waiting" note, desktop notification,
and new-session alerts are each toggleable), and that Firefox/your OS allows
notifications. **New sessions** alerts you when a brand-new session appears (e.g. a
timer/cron run), not just replies in existing ones.
To get alerts when the sidebar/window is **closed**, keep **"Alert while closed"**
on — it holds a light background connection so replies still notify (turn it off
to avoid any background network use).

**Not updating.** Force a check at `about:addons` → gear → **Check for Updates**.
The installed build must be a signed release for auto-updates to apply.

## Project layout

| Path | Role |
|------|------|
| `manifest.json` | MV3 manifest (event-page background, `sidebar_action`, options page). |
| `config.js` | Default host + host-independent endpoint paths and URL helpers. |
| `background.js` | Session hub: one WebSocket, buffers every session, routes events; owns all network I/O, context menu, window/sidebar plumbing, notifications. |
| `sidebar/` | The chat UI (renders the active session; also runs as the pop-out window). |
| `options/` | Settings page (host + default view). |
| `content.js` | Extracts page title / selection / text on request. |
| `icons/` | Toolbar / sidebar icon. |

## License

[MIT](./LICENSE)
