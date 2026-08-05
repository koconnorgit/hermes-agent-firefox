// Settings persisted in storage.local as { settings: { defaultView, host } }.
// The background page caches these and reacts via storage.onChanged.
const { DEFAULT_HOST, normHost, originPattern } = globalThis.HERMES;

const radios = {
  sidebar: document.getElementById("view-sidebar"),
  window: document.getElementById("view-window"),
};
const saved = document.getElementById("saved");
const hostInput = document.getElementById("host");
const hostSaved = document.getElementById("host-saved");

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
  // Request access to the host so the extension may talk to it (needs a gesture,
  // which this click provides). Grant is optional but the plugin can't reach the
  // host without it.
  let granted = true;
  try { granted = await browser.permissions.request({ origins: [originPattern(host)] }); }
  catch { granted = false; }

  await patchSettings({ host });
  hostSaved.style.color = "";
  hostSaved.textContent = granted ? "Saved." : "Saved — but host access was not granted.";
  setTimeout(() => { hostSaved.textContent = ""; }, 2500);
}

radios.sidebar.addEventListener("change", saveView);
radios.window.addEventListener("change", saveView);
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
