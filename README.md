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

## How it authenticates

Hermes uses a **session cookie**. The extension declares host access for your
configured Hermes host and makes its requests with `credentials: "include"`, so
it reuses your existing dashboard session — just sign in once at the dashboard.
No token or API key is stored by the extension.

## Configure the host

Set your Hermes base URL in the extension's **Settings** (⚙ in the sidebar
header, or `about:addons` → this add-on → Preferences). The default is baked into
[`config.js`](./config.js) (`DEFAULT_HOST`); Settings overrides it and requests
access to whatever host you enter. Both HTTP and HTTPS hosts work.

> Firefox auto-upgrades `http://` requests from extension pages to `https://`.
> This extension ships a `content_security_policy` that suppresses that upgrade
> and routes all network I/O through the background page, so a **plain-HTTP**
> Hermes host is reachable. Serving Hermes over HTTPS is still recommended.

## Install

### Permanent install (signed)

Firefox release/beta only run **signed** extensions. Sign your own copy for free
via [addons.mozilla.org](https://addons.mozilla.org) on the *unlisted* channel
(no public listing, no review wait):

1. Create AMO API credentials: https://addons.mozilla.org/developers/addon/api/key/
2. Export them and sign:
   ```sh
   export WEB_EXT_API_KEY=user:xxxxx:123
   export WEB_EXT_API_SECRET=xxxxxxxxxxxxxxxx
   npm run sign
   ```
3. Install the resulting `.xpi` from `web-ext-artifacts/` (drag it onto Firefox,
   or `about:addons` → gear → *Install Add-on From File…*).

Releases here also attach a signed `.xpi` automatically when repo AMO secrets are
set (see below) — grab it from the [Releases](../../releases) page.

**Auto-updates:** the manifest's `update_url` points at
`releases/latest/download/updates.json`. Each signed release publishes that file
(pointing to the release's `.xpi` with its hash), so once you install a signed
build, Firefox auto-updates it from future releases — no reinstalling.

### Temporary (development)

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick
`manifest.json`. Unloads on restart. Or `npm start` to launch a scratch Firefox
with the extension loaded and auto-reloading.

## Develop

```sh
npm install        # optional; scripts also work via npx
npm run lint       # web-ext lint
npm start          # run in a scratch Firefox profile
npm run build      # unsigned .zip in web-ext-artifacts/
npm run sign       # signed .xpi (needs WEB_EXT_API_KEY / _SECRET)
```

## Releases

Releases are cut from git tags:

1. Bump `version` in both `manifest.json` and `package.json` (keep them equal).
2. Commit, then create a GitHub Release with tag `vX.Y.Z` (matching the version).
3. The [`release`](./.github/workflows/release.yml) workflow lints, builds, and —
   if the repo has `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` secrets — signs, then
   uploads the artifact to the release. Without secrets it attaches an unsigned
   `.zip`.

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
