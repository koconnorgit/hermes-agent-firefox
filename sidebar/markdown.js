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

  // ── tables ────────────────────────────────────────────────────────────────
  // GFM pipe tables: a row of cells, a divider row, then body rows. Detection
  // and splitting match the Hermes TUI (ui-tui/src/components/markdown.tsx).
  const DIVIDER_CELL = /^:?-{3,}:?$/;
  const splitRow = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  function isDivider(line) {
    if (line == null) return false;
    const cells = splitRow(line);
    return cells.length > 1 && cells.every((c) => DIVIDER_CELL.test(c));
  }
  const startsTable = (lines, i) => lines[i].includes("|") && isDivider(lines[i + 1]);

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

      if (startsTable(lines, i)) {
        const rows = [splitRow(line)];
        for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
        blocks.push({ type: "table", rows });
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
        blocks.push({ type: "quote", content: quoted.join("\n") });
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
        !/^[-*_]{3,}\s*$/.test(lines[i]) && !/^>\s?/.test(lines[i]) &&
        !startsTable(lines, i)
      ) para.push(lines[i++]);
      if (para.length) blocks.push({ type: "paragraph", content: para.join("\n") });
    }

    return blocks;
  }

  // ── inline spans ──────────────────────────────────────────────────────────
  // Priority: code > link > bold > italic > bare URL > line break.
  // The trailing `<br>` alternative is not markdown: it's how models write a
  // line break inside a table cell (a real newline would end the row). It's
  // matched as literal text and turned into a <br> element — the dashboard
  // leaves these showing as "<br>" in the middle of cells.
  const INLINE = /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\bhttps?:\/\/[^\s<>)\]]+)|(\n)|(<br\s*\/?>)/gi;

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
      else if (m[10] || m[11]) parent.appendChild(document.createElement("br"));

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

  // ── table renderer ────────────────────────────────────────────────────────
  // A table only stays a grid while it can plausibly fit the pane. Past that —
  // too many columns, or cells holding whole paragraphs (recipes, checklists,
  // comparison matrices) — it flips to the same stacked "Header: value" layout
  // the Hermes TUI falls back to, which stays readable at any width.
  const GRID_MAX_COLS = 4;
  const GRID_MAX_CELL = 60;      // characters in a single cell
  const GRID_MAX_ROW = 120;      // characters across a whole row

  const stripMarks = (s) => String(s)
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/`([^`]+)`/g, "$1");

  function renderTable(rows) {
    const headers = rows[0] || [];
    const cols = headers.length;
    const body = rows.slice(1).map((row) => {
      const cells = row.slice(0, cols);
      while (cells.length < cols) cells.push("");   // ragged rows padded out
      return cells;
    });

    // Header-only table: nothing to lay out, so just list the columns.
    if (!body.length) {
      const p = document.createElement("p");
      p.className = "md-heads";
      p.textContent = headers.map(stripMarks).join(" · ");
      return p;
    }

    const longestCell = Math.max(...rows.map((r) => Math.max(...r.map((c) => c.length), 0)), 0);
    const widestRow = Math.max(...rows.map((r) => r.join("  ").length), 0);
    const grid = cols <= GRID_MAX_COLS && longestCell <= GRID_MAX_CELL && widestRow <= GRID_MAX_ROW;

    if (grid) {
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      const table = document.createElement("table");
      table.className = "md-table";

      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const h of headers) {
        const th = document.createElement("th");
        inlineInto(th, h);
        headRow.appendChild(th);
      }
      head.appendChild(headRow);
      table.appendChild(head);

      const tbody = document.createElement("tbody");
      for (const row of body) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          inlineInto(td, cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }

    // Stacked: one block per row, each cell labelled with its column.
    const wrap = document.createElement("div");
    wrap.className = "md-rows";
    for (const row of body) {
      const card = document.createElement("div");
      card.className = "md-row";
      row.forEach((cell, ci) => {
        if (!cell) return;                       // an empty cell is just noise here
        const field = document.createElement("div");
        field.className = "md-field";
        const key = document.createElement("span");
        key.className = "md-key";
        key.textContent = `${stripMarks(headers[ci]) || `Col ${ci + 1}`}:`;
        field.appendChild(key);
        field.appendChild(document.createTextNode(" "));
        inlineInto(field, cell);
        card.appendChild(field);
      });
      if (card.childNodes.length) wrap.appendChild(card);
    }
    return wrap;
  }

  // ── block renderer ────────────────────────────────────────────────────────
  function renderBlock(block) {
    switch (block.type) {
      case "table":
        return renderTable(block.rows);
      case "quote": {
        const q = document.createElement("blockquote");
        inlineInto(q, block.content);
        return q;
      }
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
    // Tables own their internal structure — a stray span inside one gets
    // hoisted out by the parser, so the caret trails the block instead.
    if (last.tagName === "HR" || last.tagName === "DIV") return frag;
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
