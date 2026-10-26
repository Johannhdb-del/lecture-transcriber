// Small, safe Markdown renderer for Claude's study notes.
// Headings, paragraphs, nested bullet and numbered lists, **bold**, *italic*, `code`, line breaks.
// Raw HTML is never interpreted: everything is built with createElement and textContent.

const BULLET = /^(\s*)([-*+•])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```/;

/* ---------------------------- inline ---------------------------- */

function closingItalic(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "*" && s[j + 1] !== "*" && s[j - 1] !== "*" && !/\s/.test(s[j - 1])) return j;
  }
  return -1;
}

function inline(s, parent) {
  let buf = "";
  const flush = () => {
    if (buf) parent.appendChild(document.createTextNode(buf));
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|]/.test(s[i + 1])) {
      buf += s[++i];
    } else if (ch === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        flush();
        const el = document.createElement("code");
        el.textContent = s.slice(i + 1, j);
        parent.appendChild(el);
        i = j;
      } else buf += ch;
    } else if (ch === "*" && s[i + 1] === "*") {
      const j = s.indexOf("**", i + 2);
      if (j > i + 2 && !/\s/.test(s[i + 2])) {
        flush();
        const el = document.createElement("strong");
        inline(s.slice(i + 2, j), el);
        parent.appendChild(el);
        i = j + 1;
      } else { buf += "**"; i++; }
    } else if (ch === "*" && s[i + 1] && !/\s/.test(s[i + 1])) {
      const j = closingItalic(s, i + 2);
      if (j > i + 1) {
        flush();
        const el = document.createElement("em");
        inline(s.slice(i + 1, j), el);
        parent.appendChild(el);
        i = j;
      } else buf += ch;
    } else if (ch === "[") {
      const m = /^\[([^\]]+)\]\([^)]*\)/.exec(s.slice(i)); // link text only
      if (m) {
        flush();
        inline(m[1], parent);
        i += m[0].length - 1;
      } else buf += ch;
    } else buf += ch;
  }
  flush();
}

// Lines of one paragraph or list item, joined with <br>.
function inlineLines(lines, parent) {
  lines.forEach((line, i) => {
    if (i) parent.appendChild(document.createElement("br"));
    inline(line.trim(), parent);
  });
}

/* ----------------------------- blocks ---------------------------- */

function listMarker(line) {
  let m = BULLET.exec(line);
  if (m && !RULE.test(line)) return { indent: m[1].replace(/\t/g, "    ").length, ordered: false, text: m[3] };
  m = ORDERED.exec(line);
  if (m) return { indent: m[1].replace(/\t/g, "    ").length, ordered: true, text: m[3], start: Number(m[2]) };
  return null;
}

export function renderMarkdown(md, h) { // eslint-disable-line no-unused-vars
  const frag = document.createDocumentFragment();
  const lines = String(md == null ? "" : md).replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (FENCE.test(line)) { // fenced code block, shown as plain text
      const buf = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) buf.push(lines[i++]);
      i++;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    const hm = HEADING.exec(line);
    if (hm) {
      const el = document.createElement("h" + hm[1].length);
      inline(hm[2], el);
      frag.appendChild(el);
      i++;
      continue;
    }

    if (RULE.test(line)) { frag.appendChild(document.createElement("hr")); i++; continue; }

    if (listMarker(line)) {
      // stack of open lists, one per indentation level
      const stack = [];
      let item = null;
      while (i < lines.length) {
        const cur = lines[i];
        const mk = listMarker(cur);
        if (mk && !RULE.test(cur)) {
          while (stack.length > 1 && mk.indent < stack[stack.length - 1].indent) stack.pop();
          let top = stack[stack.length - 1];
          if (top) item = top.item;
          if (!top || (mk.indent > top.indent && item)) {
            const list = document.createElement(mk.ordered ? "ol" : "ul");
            if (mk.ordered && mk.start > 1 && !top) list.start = mk.start;
            (top && item ? item : frag).appendChild(list);
            top = { list, indent: mk.indent, ordered: mk.ordered, lines: null };
            stack.push(top);
          } else if (top.ordered !== mk.ordered && stack.length === 1 && mk.indent <= top.indent) {
            break; // a different kind of list at the top level starts a new block
          }
          item = document.createElement("li");
          top.list.appendChild(item);
          top.itemLines = [mk.text];
          top.item = item;
          i++;
          // continuation lines of this item
          while (i < lines.length && lines[i].trim() && !listMarker(lines[i]) && /^\s+\S/.test(lines[i]) && !HEADING.test(lines[i])) {
            top.itemLines.push(lines[i++]);
          }
          const holder = document.createElement("span");
          inlineLines(top.itemLines, holder);
          while (holder.firstChild) item.appendChild(holder.firstChild);
          continue;
        }
        if (!cur.trim()) { // a blank line ends the list unless another item follows
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && listMarker(lines[j]) && !RULE.test(lines[j])) { i = j; continue; }
          break;
        }
        break;
      }
      continue;
    }

    // paragraph: runs until a blank line or the start of another block
    const buf = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !RULE.test(lines[i]) && !(buf.length && listMarker(lines[i]))) {
      buf.push(lines[i++]);
    }
    if (!buf.length) { i++; continue; }
    const p = document.createElement("p");
    inlineLines(buf, p);
    frag.appendChild(p);
  }
  return frag;
}
