// Mind map of a lecture: an inline SVG tree (root left, branches right) with fold toggles,
// jump to time on tap, pan and pinch zoom, and a full screen mode. No dependencies.
// Data: Node = { title: string, time?: number (seconds), children: Node[] }.
import { h, icon, clock } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout constants in SVG units. Font sizes must match the .mm-* rules in style.css.
const FONT_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const TITLE_SIZE = 13;
const TIME_SIZE = 10.5;
const LINE_H = 16;
const TIME_H = 14;
const PAD_X = 10;
const PAD_Y = 7;
const MAX_TEXT_W = 160; // plus padding gives the ~180 px node width
const MAX_LINES = 3;
const MIN_NODE_W = 44;
const GAP_X = 52; // space between columns, holds connector and fold toggle
const GAP_Y = 10; // vertical gap between siblings
const TOGGLE_R = 9;
const FIT_PAD = 16;
const TOOLBAR_SPACE = 44; // height of the zoom button row at the bottom of the viewport
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const TAP_SLOP = 6; // px of movement before a press counts as a drag
const AUTO_FOLD_AFTER = 40; // trees with more nodes start folded below level 2
const MAX_DEPTH = 12;
const MAX_NODES = 600;
const PALETTE_SIZE = 6;

function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, v === true ? "true" : v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** A small line icon that dom.js does not have, same look as icon(). */
function glyph(path, size = 20) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false",
  }, svgEl("path", { d: path }));
  svg.classList.add("icon");
  return svg;
}

const GLYPHS = {
  minus: "M5 12h14",
  fit: "M4 9V5h4 M20 9V5h-4 M4 15v4h4 M20 15v4h-4",
  enter: "M9 4H4v5 M15 4h5v5 M9 20H4v-5 M15 20h5v-5",
  exit: "M4 9h5V4 M20 9h-5V4 M4 15h5v5 M20 15h-5v5",
};

/** Copy the incoming data into plain nodes: drop untitled nodes (their children move up), cap depth and size. */
function buildTree(root) {
  let count = 0;
  function make(src, depth, parent) {
    const title = src && typeof src.title === "string" ? src.title.trim().slice(0, 200) : "";
    const kids = src && Array.isArray(src.children) ? src.children : [];
    if (!title) {
      // An untitled node is skipped, its children take its place.
      const out = [];
      for (const k of kids) out.push(...make(k, depth, parent));
      return out;
    }
    if (count >= MAX_NODES) return [];
    count++;
    const time = src && typeof src.time === "number" && Number.isFinite(src.time) && src.time >= 0 ? src.time : null;
    const node = { id: count, title, time, depth, parent, children: [], collapsed: false, color: 0 };
    if (depth < MAX_DEPTH) for (const k of kids) node.children.push(...make(k, depth + 1, node));
    return [node];
  }
  const made = make(root, 0, null);
  if (made.length) return { node: made[0], count };
  return { node: { id: 0, title: "Mind map", time: null, depth: 0, parent: null, children: [], collapsed: false, color: 0 }, count: 1 };
}

export function createMindMap({ root, onSeek } = {}) {
  const { node: tree, count: total } = buildTree(root);

  // Colour per main branch, inherited by its whole subtree.
  tree.children.forEach((c, i) => paint(c, i % PALETTE_SIZE));
  function paint(n, ci) { n.color = ci; for (const k of n.children) paint(k, ci); }

  // Initial fold state: small trees open, big trees show root plus two levels.
  (function initFold(n) {
    n.collapsed = total > AUTO_FOLD_AFTER && n.depth >= 2;
    for (const k of n.children) initFold(k);
  })(tree);

  /* ---------------- text measuring (canvas, works while detached) ---------------- */

  const rootStyle = getComputedStyle(document.documentElement);
  const fontStack = rootStyle.getPropertyValue("--font").trim() || FONT_FALLBACK;
  const monoStack = rootStyle.getPropertyValue("--mono").trim() || MONO_FALLBACK;
  const ctx = document.createElement("canvas").getContext("2d");

  function measure(text, font) {
    if (!ctx) return text.length * TITLE_SIZE * 0.55;
    ctx.font = font;
    return ctx.measureText(text).width;
  }
  function titleFont(n) {
    const weight = n.depth <= 1 ? 600 : 400;
    return `${weight} ${TITLE_SIZE}px ${fontStack}`;
  }

  /** Greedy word wrap to MAX_TEXT_W, at most MAX_LINES lines, ending in an ellipsis when cut. */
  function wrap(text, font) {
    const pieces = [];
    for (const word of text.split(/\s+/)) {
      if (!word) continue;
      let rest = word;
      // Split words that are wider than a line by themselves.
      while (measure(rest, font) > MAX_TEXT_W && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut), font) > MAX_TEXT_W) cut--;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      pieces.push(rest);
    }
    const lines = [];
    let cur = "";
    for (const p of pieces) {
      const test = cur ? `${cur} ${p}` : p;
      if (!cur || measure(test, font) <= MAX_TEXT_W) cur = test;
      else { lines.push(cur); cur = p; }
    }
    if (cur) lines.push(cur);
    if (lines.length > MAX_LINES) {
      lines.length = MAX_LINES;
      let last = lines[MAX_LINES - 1];
      while (last.length > 1 && measure(`${last}…`, font) > MAX_TEXT_W) last = last.slice(0, -1);
      lines[MAX_LINES - 1] = `${last.trimEnd()}…`;
    }
    return lines;
  }

  // Measure every node once; sizes do not change when folding.
  (function size(n) {
    const font = titleFont(n);
    n.lines = wrap(n.title, font);
    n.timeText = n.time != null ? clock(n.time) : "";
    let w = 0;
    for (const l of n.lines) w = Math.max(w, measure(l, font));
    if (n.timeText) w = Math.max(w, measure(n.timeText, `${TIME_SIZE}px ${monoStack}`));
    n.w = Math.max(MIN_NODE_W, Math.ceil(w) + PAD_X * 2);
    n.h = PAD_Y * 2 + n.lines.length * LINE_H + (n.timeText ? TIME_H : 0);
    for (const k of n.children) size(k);
  })(tree);

  /* ---------------- DOM ---------------- */

  const g = svgEl("g", { class: "mm-world" });
  const svg = svgEl("svg", { class: "mm-svg", role: "group", "aria-label": "Mind map" }, g);
  const viewport = h("div", { class: "mm-viewport" }, svg);

  const btnFull = h("button", { type: "button", class: "icon-btn mm-btn", "aria-label": "Full screen", title: "Full screen", "aria-pressed": "false" });
  btnFull.append(glyph(GLYPHS.enter));
  const toolbar = h("div", { class: "mm-toolbar" },
    mkBtn(icon("plus"), "Zoom in", () => zoomBy(1.3)),
    mkBtn(glyph(GLYPHS.minus), "Zoom out", () => zoomBy(1 / 1.3)),
    mkBtn(glyph(GLYPHS.fit), "Fit to view", () => fit()),
    btnFull);
  const el = h("div", { class: "mindmap" }, viewport, toolbar);

  function mkBtn(ic, label, fn) {
    return h("button", {
      type: "button", class: "icon-btn mm-btn", "aria-label": label, title: label,
      onclick() { try { fn(); } catch { /* never throw from handlers */ } },
    }, ic);
  }

  /* ---------------- layout and render ---------------- */

  let tx = 0;
  let ty = 0;
  let scale = 1;
  let userMoved = false; // true once the user panned or zoomed; stops automatic refitting
  let bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
  let focusKey = null;

  const visibleKids = (n) => (n.collapsed ? [] : n.children);

  /** Tidy tree: subtree heights first, then place each node at the middle of its children. */
  function layout() {
    const colW = [];
    (function widths(n) {
      colW[n.depth] = Math.max(colW[n.depth] || 0, n.w);
      for (const k of visibleKids(n)) widths(k);
    })(tree);
    const colX = [0];
    for (let d = 1; d < colW.length; d++) colX[d] = colX[d - 1] + colW[d - 1] + GAP_X;

    (function heights(n) {
      const kids = visibleKids(n);
      let sum = 0;
      for (const k of kids) { heights(k); sum += k.sh; }
      if (kids.length) sum += GAP_Y * (kids.length - 1);
      n.kidsH = sum;
      n.sh = Math.max(n.h, sum);
    })(tree);

    (function place(n, top) {
      n.x = colX[n.depth];
      const kids = visibleKids(n);
      if (!kids.length) { n.cy = top + n.sh / 2; return; }
      let y = top + (n.sh - n.kidsH) / 2;
      for (const k of kids) { place(k, y); y += k.sh + GAP_Y; }
      n.cy = (kids[0].cy + kids[kids.length - 1].cy) / 2;
    })(tree, 0);

    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    (function walk(n) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.cy - n.h / 2);
      y1 = Math.max(y1, n.cy + n.h / 2);
      x1 = Math.max(x1, n.x + n.w + (n.children.length ? TOGGLE_R * 2 + 4 : 0));
      for (const k of visibleKids(n)) walk(k);
    })(tree);
    bounds = { x0, y0, x1, y1 };
  }

  function colorVar(n) {
    return `var(--mm-${(n.color % PALETTE_SIZE) + 1})`;
  }

  function render() {
    layout();
    const links = svgEl("g", { class: "mm-links" });
    const nodes = svgEl("g", { class: "mm-nodes" });

    (function draw(n) {
      const kids = visibleKids(n);
      for (const k of kids) {
        const x1 = n.x + n.w + (n.children.length ? TOGGLE_R * 2 + 4 : 0);
        const x2 = k.x;
        const mx = (x1 + x2) / 2;
        const path = svgEl("path", { class: "mm-link", d: `M${x1} ${n.cy} C${mx} ${n.cy} ${mx} ${k.cy} ${x2} ${k.cy}` });
        path.style.setProperty("--c", colorVar(k));
        links.append(path);
        draw(k);
      }
      nodes.append(drawNode(n));
    })(tree);

    g.textContent = "";
    g.append(links, nodes);
    if (focusKey) {
      const target = g.querySelector(`[data-key="${focusKey}"]`);
      if (target && target.focus) { try { target.focus({ preventScroll: true }); } catch { /* ignore */ } }
      focusKey = null;
    }
  }

  function drawNode(n) {
    const seekable = n.time != null && typeof onSeek === "function";
    const cls = ["mm-node", `mm-l${Math.min(n.depth, 2)}`];
    if (n.depth === 0) cls.push("mm-root");
    if (seekable) cls.push("mm-seek");
    const grp = svgEl("g", { class: cls.join(" "), "data-node": n.id });
    if (n.depth > 0) grp.style.setProperty("--c", colorVar(n));

    const top = n.cy - n.h / 2;
    grp.append(svgEl("rect", { class: "mm-box", x: n.x, y: top, width: n.w, height: n.h, rx: 9 }));
    n.lines.forEach((line, i) => {
      const t = svgEl("text", { class: "mm-title", x: n.x + PAD_X, y: top + PAD_Y + LINE_H * i + LINE_H - 4 });
      t.textContent = line;
      grp.append(t);
    });
    if (n.timeText) {
      const t = svgEl("text", { class: "mm-time", x: n.x + PAD_X, y: top + PAD_Y + LINE_H * n.lines.length + TIME_H - 4 });
      t.textContent = n.timeText;
      grp.append(t);
    }
    if (seekable) {
      grp.setAttribute("role", "button");
      grp.setAttribute("tabindex", "0");
      grp.setAttribute("data-key", `n${n.id}`);
      grp.setAttribute("aria-label", `${n.title}, jump to ${n.timeText}`);
    }

    if (n.children.length) {
      const cx = n.x + n.w + TOGGLE_R + 2;
      const tg = svgEl("g", {
        class: "mm-toggle", "data-toggle": n.id, "data-key": `t${n.id}`, role: "button", tabindex: "0",
        "aria-expanded": String(!n.collapsed),
        "aria-label": `${n.collapsed ? "Expand" : "Collapse"} ${n.title}`,
      });
      if (n.depth > 0) tg.style.setProperty("--c", colorVar(n));
      tg.append(svgEl("circle", { class: "mm-hit", cx, cy: n.cy, r: TOGGLE_R + 6 }));
      tg.append(svgEl("circle", { class: "mm-dot", cx, cy: n.cy, r: TOGGLE_R }));
      const label = svgEl("text", { class: "mm-count", x: cx, y: n.cy });
      label.textContent = n.collapsed ? String(n.children.length) : "−";
      tg.append(label);
      // The toggle sits beside the node, so it is a sibling in the same group.
      grp.append(tg);
    }
    return grp;
  }

  /* ---------------- pan, zoom, fit ---------------- */

  function applyTransform() {
    g.setAttribute("transform", `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})`);
  }

  const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

  /** Zoom by factor around a viewport point (px relative to the viewport's top left). */
  function zoomAt(px, py, factor) {
    const next = clampZoom(scale * factor);
    const k = next / scale;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    scale = next;
    userMoved = true;
    applyTransform();
  }

  function zoomBy(factor) {
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
  }

  /** Scale and centre the whole visible tree. Returns false while the viewport has no size. */
  function fit() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!vw || !vh) return false;
    const cw = Math.max(1, bounds.x1 - bounds.x0);
    const ch = Math.max(1, bounds.y1 - bounds.y0);
    const vhFree = vh - TOOLBAR_SPACE; // keep the bottom row clear of the zoom buttons
    scale = clampZoom(Math.min((vw - FIT_PAD * 2) / cw, (vhFree - FIT_PAD * 2) / ch, 1.5));
    tx = (vw - cw * scale) / 2 - bounds.x0 * scale;
    ty = (vhFree - ch * scale) / 2 - bounds.y0 * scale;
    userMoved = false;
    applyTransform();
    return true;
  }

  /* ---------------- folding and seeking ---------------- */

  function findNode(id) {
    let hit = null;
    (function walk(n) {
      if (hit) return;
      if (n.id === id) { hit = n; return; }
      for (const k of n.children) walk(k);
    })(tree);
    return hit;
  }

  /** Re-lay out after a fold change. Keeps the anchor node where it was on screen once the user has moved the view. */
  function relayout(anchor) {
    const before = anchor ? anchor.cy * scale + ty : 0;
    render();
    if (!userMoved) fit();
    else if (anchor) { ty = before - anchor.cy * scale; applyTransform(); }
  }

  function toggleNode(n, viaKey) {
    n.collapsed = !n.collapsed;
    if (viaKey) focusKey = `t${n.id}`;
    relayout(n);
  }

  function setAll(collapsed) {
    (function walk(n) {
      n.collapsed = n.children.length ? (n.depth === 0 ? false : collapsed) : false;
      for (const k of n.children) walk(k);
    })(tree);
    relayout(null);
    if (userMoved) fit();
  }

  function activate(target, viaKey) {
    if (!target || !target.closest) return;
    const tg = target.closest("[data-toggle]");
    if (tg) {
      const n = findNode(Number(tg.getAttribute("data-toggle")));
      if (n) toggleNode(n, viaKey);
      return;
    }
    const ng = target.closest("[data-node]");
    if (!ng) return;
    const n = findNode(Number(ng.getAttribute("data-node")));
    if (n && n.time != null && typeof onSeek === "function") {
      if (full) setFull(false); // otherwise the transcript spot would stay hidden behind the map
      onSeek(n.time);
    }
  }

  /* ---------------- pointer handling ---------------- */

  const pointers = new Map(); // id -> { x, y } relative to the viewport
  let gesture = { moved: false, multi: false, target: null };
  let pan = null; // { px, py, tx, ty }
  let pinch = null; // { dist, scale, wx, wy }

  const safe = (fn) => (e) => { try { fn(e); } catch { /* never throw from handlers */ } };

  function rel(e) {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function startPan(p) { pan = { px: p.x, py: p.y, tx, ty }; }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      scale,
      wx: (mid.x - tx) / scale,
      wy: (mid.y - ty) / scale,
    };
  }

  const onDown = safe((e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = rel(e);
    if (pointers.size === 0) gesture = { moved: false, multi: false, target: e.target };
    pointers.set(e.pointerId, p);
    try { viewport.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pointers.size === 1) { startPan(p); pinch = null; }
    else if (pointers.size === 2) { gesture.multi = true; gesture.moved = true; pan = null; startPinch(); }
  });

  const onMove = safe((e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = rel(e);
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      scale = clampZoom(pinch.scale * (dist / pinch.dist));
      tx = mid.x - pinch.wx * scale;
      ty = mid.y - pinch.wy * scale;
      userMoved = true;
      applyTransform();
      return;
    }
    if (pointers.size === 1 && pan) {
      const dx = p.x - pan.px;
      const dy = p.y - pan.py;
      if (!gesture.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      gesture.moved = true;
      tx = pan.tx + dx;
      ty = pan.ty + dy;
      userMoved = true;
      applyTransform();
    }
  });

  function endPointer(e, canTap) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try { viewport.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    pinch = null;
    if (pointers.size === 1) { startPan([...pointers.values()][0]); gesture.moved = true; }
    else if (pointers.size === 0) {
      pan = null;
      const tap = canTap && !gesture.moved && !gesture.multi;
      const target = gesture.target;
      gesture = { moved: false, multi: false, target: null };
      if (tap) activate(target, false); // a drag or pinch never reaches here
    }
  }

  const onUp = safe((e) => endPointer(e, true));
  const onCancel = safe((e) => endPointer(e, false));

  const onWheel = safe((e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-200, Math.min(200, e.deltaY * unit));
    const p = rel(e);
    zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
  });

  const onKeyDown = safe((e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target;
    if (!t || !t.closest || !t.closest("[data-toggle], [data-node][role='button']")) return;
    e.preventDefault();
    activate(t, true);
  });

  viewport.addEventListener("pointerdown", onDown);
  viewport.addEventListener("pointermove", onMove);
  viewport.addEventListener("pointerup", onUp);
  viewport.addEventListener("pointercancel", onCancel);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("keydown", onKeyDown);

  /* ---------------- full screen ---------------- */

  let full = false;

  const onEscape = safe((e) => {
    if (e.key === "Escape" && full) { e.stopPropagation(); setFull(false); }
  });

  function setFull(on) {
    full = on;
    el.classList.toggle("mm-full", on);
    btnFull.setAttribute("aria-pressed", String(on));
    const label = on ? "Exit full screen" : "Full screen";
    btnFull.setAttribute("aria-label", label);
    btnFull.title = label;
    btnFull.textContent = "";
    btnFull.append(glyph(on ? GLYPHS.exit : GLYPHS.enter));
    if (on) document.addEventListener("keydown", onEscape, true);
    else document.removeEventListener("keydown", onEscape, true);
    // The viewport resizes with the class; wait a frame so clientWidth is current.
    requestAnimationFrame(() => { try { fit(); } catch { /* ignore */ } });
  }
  btnFull.addEventListener("click", safe(() => setFull(!full)));

  /* ---------------- resize, first render ---------------- */

  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      try {
        if (!viewport.clientWidth || !viewport.clientHeight) return;
        if (!userMoved) fit();
      } catch { /* ignore */ }
    });
    ro.observe(viewport);
  }

  render();
  fit(); // does nothing while detached; the ResizeObserver fits once there is a size

  return {
    el,
    fit,
    expandAll() { setAll(false); },
    collapseAll() { setAll(true); },
    destroy() {
      if (ro) ro.disconnect();
      viewport.removeEventListener("pointerdown", onDown);
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerup", onUp);
      viewport.removeEventListener("pointercancel", onCancel);
      viewport.removeEventListener("wheel", onWheel);
      svg.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onEscape, true);
      pointers.clear();
    },
  };
}
