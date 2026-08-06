// Markdown renderer for chat messages, ported from the Hermes dashboard
// (hermes-agent web/src/components/Markdown.tsx) so the sidebar formats replies
// the way the portal does. Same deliberate subset: fenced code blocks, inline
// code, bold, italic, headings, links, ordered/unordered lists, horizontal
// rules, and line breaks. Not a CommonMark parser — it targets the patterns
// assistant output actually uses.
//
// Everything is built with createElement/textContent, never innerHTML, so
// message content cannot inject markup no matter what the agent emits. Links
// are limited to http(s)/mailto for the same reason (a `javascript:` href would
// otherwise be one click from running in the extension's own page).
globalThis.HERMES_MD = (() => {

  // ── blocks ────────────────────────────────────────────────────────────────
  function parseBlocks(text) {
    const lines = String(text ?? "").split("\n");
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code. An unclosed fence (mid-stream) runs to the end, which is
      // what keeps a code block from flickering as plain text while it streams.
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
        i++;                                  // closing fence
        blocks.push({ type: "code", lang: fence[1] || "", content: code.join("\n") });
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.+)/);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, content: heading[2] });
        i++;
        continue;
      }

      if (/^[-*_]{3,}\s*$/.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

      if (/^[-*+]\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s/.test(lines[i])) items.push(lines[i++].replace(/^[-*+]\s/, ""));
        blocks.push({ type: "list", ordered: false, items });
        continue;
      }

      if (/^\d+[.)]\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) items.push(lines[i++].replace(/^\d+[.)]\s/, ""));
        blocks.push({ type: "list", ordered: true, items });
        continue;
      }

      if (line.trim() === "") { i++; continue; }

      // Paragraph: consecutive lines that start nothing else.
      const para = [];
      while (
        i < lines.length && lines[i].trim() !== "" &&
        !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) &&
        !/^[-*+]\s/.test(lines[i]) && !/^\d+[.)]\s/.test(lines[i]) &&
        !/^[-*_]{3,}\s*$/.test(lines[i])
      ) para.push(lines[i++]);
      if (para.length) blocks.push({ type: "paragraph", content: para.join("\n") });
    }

    return blocks;
  }

  // ── inline spans ──────────────────────────────────────────────────────────
  // Priority: code > link > bold > italic > bare URL > line break.
  const INLINE = /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\bhttps?:\/\/[^\s<>)\]]+)|(\n)/g;

  function inlineInto(parent, text) {
    const src = String(text ?? "");
    let last = 0, m;
    INLINE.lastIndex = 0;

    const add = (tag, content, className) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = content;
      parent.appendChild(node);
      return node;
    };

    while ((m = INLINE.exec(src)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(src.slice(last, m.index)));

      if (m[1]) add("code", m[1].slice(1, -1), "md-code");
      else if (m[2]) link(parent, m[3], m[4]);
      else if (m[5]) add("strong", m[6]);
      else if (m[7]) add("em", m[8]);
      else if (m[9]) link(parent, m[9], m[9]);
      else if (m[10]) parent.appendChild(document.createElement("br"));

      last = m.index + m[0].length;
    }
    if (last < src.length) parent.appendChild(document.createTextNode(src.slice(last)));
  }

  function link(parent, label, href) {
    const url = String(href).trim();
    // Anything that isn't a plain web/mail link renders as text, so a crafted
    // `javascript:`/`data:` href in a reply is inert.
    if (!/^(https?:|mailto:)/i.test(url)) {
      parent.appendChild(document.createTextNode(label));
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.textContent = label;
    parent.appendChild(a);
  }

  // ── block renderer ────────────────────────────────────────────────────────
  function renderBlock(block) {
    switch (block.type) {
      case "code": {
        const pre = document.createElement("pre");
        pre.className = "md-pre";
        const code = document.createElement("code");
        if (block.lang) code.dataset.lang = block.lang;
        code.textContent = block.content;
        pre.appendChild(code);
        return pre;
      }
      case "heading": {
        const h = document.createElement(`h${Math.min(block.level, 4)}`);
        inlineInto(h, block.content);
        return h;
      }
      case "hr":
        return document.createElement("hr");
      case "list": {
        const list = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = document.createElement("li");
          inlineInto(li, item);
          list.appendChild(li);
        }
        return list;
      }
      default: {
        const p = document.createElement("p");
        inlineInto(p, block.content);
        return p;
      }
    }
  }

  // Caret for a reply still streaming. It goes INSIDE the last block so it
  // hugs the final character instead of dropping to a line of its own.
  function caret() {
    const span = document.createElement("span");
    span.className = "md-caret";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  // Where the caret belongs for a given trailing block: at the end of the text
  // it's still writing — the last list item, inside the code, after the
  // paragraph — falling back to the fragment when there's nothing to hug.
  function caretHost(last, frag) {
    if (!last) return frag;
    if (last.tagName === "UL" || last.tagName === "OL") return last.lastElementChild || frag;
    if (last.tagName === "PRE") return last.firstElementChild || last;
    if (last.tagName === "HR") return frag;
    return last;
  }

  // Returns a fragment ready to drop into a message bubble.
  function render(text, { streaming = false } = {}) {
    const frag = document.createDocumentFragment();
    const blocks = parseBlocks(text);
    let last = null;

    for (const block of blocks) {
      last = renderBlock(block);
      frag.appendChild(last);
    }

    if (streaming) caretHost(last, frag).appendChild(caret());
    return frag;
  }

  return { render, parseBlocks };
})();
