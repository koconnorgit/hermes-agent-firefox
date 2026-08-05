// Settings persisted in storage.local as { settings: { defaultView, host } }.
// The background page caches these and reacts via storage.onChanged.
const { DEFAULT_HOST, normHost, originPattern, notifyConfig } = globalThis.HERMES;

const radios = {
  sidebar: document.getElementById("view-sidebar"),
  window: document.getElementById("view-window"),
};
const saved = document.getElementById("saved");
const hostInput = document.getElementById("host");
const hostSaved = document.getElementById("host-saved");
const notifyBoxes = {
  badge: document.getElementById("n-badge"),
  dropdown: document.getElementById("n-dropdown"),
  pill: document.getElementById("n-pill"),
  system: document.getElementById("n-system"),
};
const notifySaved = document.getElementById("notify-saved");

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return settings || {};
}
async function patchSettings(patch) {
  const settings = await getSettings();
  await browser.storage.local.set({ settings: { ...settings, ...patch } });
}

async function load() {
  const s = await getSettings();
  radios[s.defaultView === "window" ? "window" : "sidebar"].checked = true;
  hostInput.value = s.host || DEFAULT_HOST;
  const n = notifyConfig(s);
  for (const [key, box] of Object.entries(notifyBoxes)) box.checked = !!n[key];
  document.getElementById("version").textContent = "v" + browser.runtime.getManifest().version;
}

async function saveNotify() {
  const notify = {};
  for (const [key, box] of Object.entries(notifyBoxes)) notify[key] = box.checked;
  await patchSettings({ notify });
  notifySaved.textContent = "Saved.";
  setTimeout(() => { notifySaved.textContent = ""; }, 1500);
}

async function saveView() {
  await patchSettings({ defaultView: radios.window.checked ? "window" : "sidebar" });
  saved.textContent = "Saved.";
  setTimeout(() => { saved.textContent = ""; }, 1500);
}

async function saveHost() {
  const host = normHost(hostInput.value);
  if (!/^https?:\/\/.+/i.test(host)) {
    hostSaved.textContent = "Enter a full URL, e.g. http://host:port";
    hostSaved.style.color = "#ff8f6b";
    return;
  }
  // Ask for host access (must run in this click's gesture). This can return false
  // when nothing NEW was granted — e.g. access was already granted earlier — so
  // it isn't a reliable success signal on its own.
  const origins = [originPattern(host)];
  try { await browser.permissions.request({ origins }); } catch {}

  // Source of truth: do we actually have access now?
  let granted = false;
  try { granted = await browser.permissions.contains({ origins }); } catch {}

  await patchSettings({ host });
  hostSaved.style.color = granted ? "" : "#ff8f6b";
  hostSaved.textContent = granted
    ? "Saved."
    : "Saved — grant host access when Firefox prompts, or the plugin can't reach it.";
  setTimeout(() => { hostSaved.textContent = ""; }, 2500);
}

radios.sidebar.addEventListener("change", saveView);
radios.window.addEventListener("change", saveView);
for (const box of Object.values(notifyBoxes)) box.addEventListener("change", saveNotify);
document.getElementById("host-save").addEventListener("click", saveHost);
hostInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveHost(); } });

document.getElementById("close").addEventListener("click", async () => {
  try {
    const tab = await browser.tabs.getCurrent();
    if (tab?.id != null) { await browser.tabs.remove(tab.id); return; }
  } catch {}
  window.close();
});

load();
