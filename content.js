// Content script: extracts lightweight, structured context from the current
// page when the sidebar / background asks for it. Nothing runs until a message
// arrives, so the footprint on normal browsing is essentially zero.

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "hermes:getPageContext") return;

  const selection = String(window.getSelection?.() || "").trim();

  // Prefer the main article body if the page marks one up; fall back to <body>.
  const main =
    document.querySelector("main, article, [role='main']") || document.body;
  const bodyText = (main?.innerText || "").replace(/\s+\n/g, "\n").trim();

  sendResponse({
    url: location.href,
    title: document.title,
    selection,
    // Cap the dump so we don't ship a megabyte of text to the agent.
    excerpt: bodyText.slice(0, 8000),
    truncated: bodyText.length > 8000,
  });
  return true;
});
