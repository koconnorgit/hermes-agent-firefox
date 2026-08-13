# hermes-agent-firefox — Agent Instructions

Firefox WebExtension sidebar that connects to a local Hermes Agent gateway
(chat, approvals, clarify/sudo/secret prompts, notifications).

## Release process (v0.1.x)

Releases ship via a **GitHub Release** — a bare tag push does NOT trigger
signing. `.github/workflows/release.yml` fires on `release: [published]`
(plus `workflow_dispatch`, which builds an **unsigned** .zip). The published-
release event is what runs the AMO signing job and attaches
`hermes-agent-firefox-<ver>.xpi` + `updates.json`.

1. **Bump the version** in BOTH `manifest.json` and `package.json` to the
   next `0.1.x`. They must match the tag exactly ("Version matches tag" step).
2. Validate before shipping: `node --check background.js` and
   `node --check sidebar/sidebar.js`, then `npm run lint` (web-ext must be
   0 errors / 0 warnings).
3. Commit the bump: `git add manifest.json package.json && git commit -m "chore(release): v0.1.x"`.
4. Push: `git push origin main`.
5. Tag: `git tag -a v0.1.x -m "v0.1.x" && git push origin v0.1.x`.
6. **Create the Release (this is the trigger):**
   `gh release create v0.1.x --title "v0.1.x" --notes "…" --target main`.
7. Verify: `gh run list --limit 3` shows the run; confirm assets
   `hermes-agent-firefox-0.1.x.xpi` and `updates.json` attach to the release.

### Pitfalls
- AMO rejects a version it has already accepted — a version is burned once
  published. Do not try to reuse it; bump to the next one.
- Always `git fetch` / check `git tag -l` (and remote) before tagging so you
  don't collide with an existing tag.
- `workflow_dispatch` builds an unsigned artifact — only use it for testing
  the build, never for shipping.
