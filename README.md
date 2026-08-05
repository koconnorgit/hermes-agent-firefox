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

## Build from source / self-host

Everything below is optional — only needed to hack on it or ship your own build.

```sh
npm install        # or rely on npx
npm run lint       # web-ext lint
npm start          # run in a scratch Firefox profile (auto-reload)
npm run build      # unsigned .zip in web-ext-artifacts/  (temporary loads only)
npm run sign       # AMO-signed .xpi (needs WEB_EXT_API_KEY / WEB_EXT_API_SECRET)
```

Load an unsigned build via `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on…** (it unloads on restart — release Firefox only keeps *signed*
add-ons permanently).

**Signing** uses a free [addons.mozilla.org](https://addons.mozilla.org) API key
([create one](https://addons.mozilla.org/developers/addon/api/key/)) on the
*unlisted* channel — no public listing or review wait.

**Releases** are cut from git tags and signed by CI:

1. Bump `version` in both `manifest.json` and `package.json` to the same value.
2. Commit, then create a GitHub Release with tag `vX.Y.Z` (must match the version
   — CI enforces it).
3. The [`release`](./.github/workflows/release.yml) workflow lints, signs (when
   the repo has `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` secrets), regenerates the
   `updates.json` auto-update manifest, and attaches the `.xpi` + `updates.json`
   to the release.

> **Forking?** The signed build and auto-update feed are tied to this repo's
> extension id and `browser_specific_settings.gecko.update_url`. For your own
> distribution, change the `gecko.id` and `update_url` in `manifest.json` to your
> fork, and sign under your own AMO account.

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
