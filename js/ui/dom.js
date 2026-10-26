// DOM helpers shared by all UI files: element builder, icons, popovers, dialogs, toasts.
// All dynamic text goes in through textContent or text nodes, never innerHTML.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an element. Text is always inserted as text, never as HTML. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "spellcheck") { el.setAttribute("spellcheck", v ? "true" : "false"); continue; }
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "for") el.htmlFor = v;
    else if (k.startsWith("aria-") || k.startsWith("data-")) el.setAttribute(k, v === true ? "true" : v);
    else if (k === "role" || k === "tabindex" || k === "contenteditable") el.setAttribute(k, v === true ? "true" : v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/* ------------------------------------------------------------------ */
/* Icons: simple line icons, 24 x 24, drawn from small shape specs     */
/* p = path, r = rect x,y,w,h,rx, c = circle cx,cy,r, l = line,        */
/* f = filled path with stroke, d = filled dot cx,cy,r                 */
/* ------------------------------------------------------------------ */

const ICONS = {
  sidebar: ["r:3,4,18,16,3", "l:9,4,9,20"],
  panelRight: ["r:3,4,18,16,3", "l:15,4,15,20"],
  plus: ["l:12,5,12,19", "l:5,12,19,12"],
  mic: ["r:9,3,6,11,3", "p:M5.5 11a6.5 6.5 0 0 0 13 0", "l:12,17.5,12,21"],
  gear: ["c:12,12,3.2", "p:M12 2.8v3 M12 18.2v3 M2.8 12h3 M18.2 12h3 M5.5 5.5l2.1 2.1 M16.4 16.4l2.1 2.1 M5.5 18.5l2.1-2.1 M16.4 7.6l2.1-2.1"],
  pencil: ["p:M4 20l1-4.2L16.3 4.5a2.1 2.1 0 0 1 3 3L8 18.8z", "p:M14.5 6.5l3 3"],
  users: ["c:9,8,3.2", "p:M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5", "c:17,9,2.4", "p:M16.5 14.6c2.6.2 4.5 2.2 4.5 5.4"],
  more: ["d:5,12,1.5", "d:12,12,1.5", "d:19,12,1.5"],
  download: ["p:M12 4v11", "p:M7.5 11l4.5 4.5 4.5-4.5", "p:M5 19.5h14"],
  upload: ["p:M12 15V4", "p:M7.5 8.5L12 4l4.5 4.5", "p:M5 19.5h14"],
  copy: ["r:9,9,11,11,2.5", "p:M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"],
  check: ["p:M5 12.5l4.5 4.5L19 7.5"],
  share: ["c:6,12,2.5", "c:17.5,6,2.5", "c:17.5,18,2.5", "l:8.2,10.8,15.3,7.2", "l:8.2,13.2,15.3,16.8"],
  info: ["c:12,12,9", "l:12,11,12,16.5", "d:12,7.7,1.2"],
  sparkle: ["p:M11 3.5l1.9 5.6 5.6 1.9-5.6 1.9L11 18.5l-1.9-5.6L3.5 11l5.6-1.9z", "p:M18.5 16v5", "p:M16 18.5h5"],
  globe: ["c:12,12,9", "p:M3 12h18", "p:M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"],
  trash: ["p:M4 7h16", "p:M10 11v6", "p:M14 11v6", "p:M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7", "p:M9 7V4.5h6V7"],
  undo: ["p:M9 14L4 9l5-5", "p:M4 9h10a6 6 0 0 1 0 12h-3"],
  redo: ["p:M15 14l5-5-5-5", "p:M20 9H10a6 6 0 0 0 0 12h3"],
  search: ["c:11,11,6.5", "l:16,16,20.5,20.5"],
  play: ["f:M8 5.5v13l11-6.5z"],
  pause: ["f:M7.5 5.5h3v13h-3z M13.5 5.5h3v13h-3z"],
  prev: ["f:M17 6v12L8.5 12z", "l:6.5,6,6.5,18"],
  next: ["f:M7 6v12l8.5-6z", "l:17.5,6,17.5,18"],
  arrowUp: ["l:12,19,12,5", "p:M6 11l6-6 6 6"],
  clock: ["c:12,12,9", "p:M12 7v5l3 2"],
  checkSquare: ["r:4,4,16,16,3.5", "p:M8.5 12.2l2.5 2.5 4.5-5"],
  x: ["l:6,6,18,18", "l:18,6,6,18"],
  chevronDown: ["p:M6 9.5l6 6 6-6"],
  stop: ["f:M8.5 6h7a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 15.5v-7A2.5 2.5 0 0 1 8.5 6z"],
  record: ["d:12,12,6.5"],
  file: ["p:M6 3h8l5 5v13H6z", "p:M14 3v5h5"],
  text: ["p:M4 7h16", "p:M4 12h16", "p:M4 17h10"],
};

function shape(spec) {
  const sep = spec.indexOf(":");
  const kind = spec.slice(0, sep);
  const data = spec.slice(sep + 1);
  const n = kind === "p" || kind === "f" ? [] : data.split(",").map(Number);
  let el;
  if (kind === "p" || kind === "f") {
    el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", data);
    if (kind === "f") el.setAttribute("fill", "currentColor");
  } else if (kind === "r") {
    el = document.createElementNS(SVG_NS, "rect");
    el.setAttribute("x", n[0]); el.setAttribute("y", n[1]);
    el.setAttribute("width", n[2]); el.setAttribute("height", n[3]); el.setAttribute("rx", n[4]);
  } else if (kind === "c" || kind === "d") {
    el = document.createElementNS(SVG_NS, "circle");
    el.setAttribute("cx", n[0]); el.setAttribute("cy", n[1]); el.setAttribute("r", n[2]);
    if (kind === "d") { el.setAttribute("fill", "currentColor"); el.setAttribute("stroke", "none"); }
  } else {
    el = document.createElementNS(SVG_NS, "line");
    el.setAttribute("x1", n[0]); el.setAttribute("y1", n[1]); el.setAttribute("x2", n[2]); el.setAttribute("y2", n[3]);
  }
  return el;
}

/** An inline SVG icon that takes the current text colour. */
export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");
  for (const spec of ICONS[name] || []) svg.append(shape(spec));
  return svg;
}

/** Round 44 px icon button. */
export function iconBtn(name, label, onclick, cls = "") {
  return h("button", {
    type: "button",
    class: cls ? `icon-btn ${cls}` : "icon-btn",
    "aria-label": label,
    title: label,
    onclick,
  }, icon(name));
}

/** Text pill with an optional leading icon. */
export function pill(label, { iconName, primary = false, danger = false, onclick, cls = "", type = "button" } = {}) {
  const classes = ["pill", primary ? "primary" : "", danger ? "danger" : "", cls].filter(Boolean).join(" ");
  return h("button", { type, class: classes, onclick },
    iconName ? icon(iconName, 18) : null,
    h("span", { text: label }));
}

/** A select with a drawn chevron. */
export function selectWrap(select) {
  return h("div", { class: "select" }, select, icon("chevronDown", 16));
}

/* ------------------------------------------------------------------ */
/* Small formatters                                                     */
/* ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, "0");

/** Transcript timestamp: MM:SS.cc below one hour, H:MM:SS.cc above. */
export function stamp(sec) {
  const cs = Math.max(0, Math.round((Number(sec) || 0) * 100));
  const c = cs % 100;
  const s = Math.floor(cs / 100);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}.${pad2(c)}` : `${pad2(mm)}:${pad2(ss)}.${pad2(c)}`;
}

/** Player clock: 0:13 or 1:02:03. */
export function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}

/** Note timestamp such as [03:25] or [1:03:25]. */
export function noteStamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `[${hh}:${pad2(mm)}:${pad2(ss)}]` : `[${pad2(mm)}:${pad2(ss)}]`;
}

export const LANGUAGES = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
];

export function languageLabel(code) {
  return (LANGUAGES.find((l) => l.value === code) || { label: String(code || "").toUpperCase() }).label;
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function baseName(filename) {
  return String(filename || "").replace(/\.[^./\\]+$/, "") || "Untitled";
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function errorMessage(err) {
  return err && err.message ? err.message : "Something went wrong. Please try again.";
}

export function dedupeTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const raw of terms) {
    const t = String(raw).trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { class: "offscreen", readOnly: true, value: text });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Inline alert area with show and clear. */
export function alertBox() {
  const el = h("div", { class: "alert", role: "alert", hidden: true });
  return {
    el,
    show(message, kind = "error") {
      el.className = kind === "error" ? "alert" : `alert ${kind}`;
      el.textContent = message;
      el.hidden = false;
    },
    clear() {
      el.hidden = true;
      el.textContent = "";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Toast                                                                */
/* ------------------------------------------------------------------ */

let toastHost = null;

export function toast(message, ms = 2600) {
  if (!toastHost) {
    toastHost = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const el = h("div", { class: "toast", text: message });
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
}

/* ------------------------------------------------------------------ */
/* Popover (menus anchored to a button), one at a time                  */
/* ------------------------------------------------------------------ */

let pop = null;

export function isPopoverOpen() {
  return !!pop;
}

export function popoverOpenFor(anchor) {
  return !!pop && pop.anchor === anchor;
}

export function closePopover(restoreFocus = false) {
  if (!pop) return;
  const p = pop;
  pop = null;
  document.removeEventListener("pointerdown", p.onDown, true);
  document.removeEventListener("keydown", p.onKey, true);
  window.removeEventListener("resize", p.onResize);
  p.el.remove();
  if (p.onClose) p.onClose();
  if (restoreFocus && p.anchor.isConnected && p.anchor.focus) p.anchor.focus();
}

export function openPopover(anchor, content, { align = "start", onClose } = {}) {
  closePopover();
  const el = h("div", { class: "popover" }, content);
  const onDown = (e) => {
    if (el.contains(e.target) || anchor.contains(e.target)) return;
    closePopover();
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    closePopover(true);
  };
  const onResize = () => closePopover();
  pop = { el, anchor, onDown, onKey, onResize, onClose };
  document.body.append(el);

  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = align === "end" ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = r.bottom + 6;
  if (top + hgt > vh - 8) top = Math.max(8, r.top - hgt - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  return { close: () => closePopover() };
}

/** A menu row. */
export function menuItem({ iconName, label, onclick, danger = false, checked = null }) {
  return h("button", {
    type: "button",
    role: "menuitem",
    class: danger ? "menu-item danger" : "menu-item",
    onclick,
  },
  iconName ? icon(iconName, 18) : h("span", { class: "menu-icon-gap" }),
  h("span", { class: "menu-label-text", text: label }),
  checked ? icon("check", 18) : null);
}

export function menuSeparator() {
  return h("div", { class: "menu-sep", role: "separator" });
}

export function menuHeading(text) {
  return h("div", { class: "menu-heading", text });
}

/** A menu row with a switch on the right. onchange(on) is called after toggling. */
export function switchRow({ iconName, label, checked, onchange }) {
  const sw = h("span", { class: "switch", "aria-hidden": "true" }, h("span", { class: "switch-knob" }));
  const row = h("button", {
    type: "button",
    role: "switch",
    class: "menu-item",
    "aria-checked": String(!!checked),
    onclick() {
      const on = row.getAttribute("aria-checked") !== "true";
      row.setAttribute("aria-checked", String(on));
      onchange(on);
    },
  },
  iconName ? icon(iconName, 18) : h("span", { class: "menu-icon-gap" }),
  h("span", { class: "menu-label-text", text: label }),
  sw);
  return row;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                               */
/* ------------------------------------------------------------------ */

export function isDialogOpen() {
  return !!document.querySelector(".modal-backdrop");
}

export function openDialog({ title, content, actions = [] }) {
  const prevFocus = document.activeElement;
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus();
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  const buttons = actions.map((a) => pill(a.label, {
    primary: !!a.primary,
    danger: !!a.danger,
    onclick() { if (a.onclick) a.onclick(); close(); },
  }));
  const closeBtn = iconBtn("x", "Close", close, "ghost");
  const modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "modal-head" }, h("h2", { text: title }), closeBtn),
    h("div", { class: "modal-body" }, content),
    buttons.length ? h("div", { class: "modal-actions" }, buttons) : null);
  const backdrop = h("div", {
    class: "modal-backdrop",
    onpointerdown(e) { if (e.target === backdrop) close(); },
  }, modal);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  (buttons[buttons.length - 1] || closeBtn).focus();
  return { close };
}

/** True while the user is typing into a field, so single key shortcuts must stay out of the way. */
export function isTyping(target) {
  if (!target || !target.closest) return false;
  if (target.isContentEditable) return true;
  return !!target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
}
