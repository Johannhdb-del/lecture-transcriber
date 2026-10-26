// App shell: sidebar and rail, hash routing, history list. The screens live in js/ui/.
import * as storage from "./storage.js";
import * as media from "./media-store.js";
import {
  h, icon, iconBtn, pill, errorMessage, toast,
  openPopover, closePopover, popoverOpenFor, menuItem,
} from "./ui/dom.js";
import { state, on, isBusy } from "./ui/state.js";
import { createNewView } from "./ui/new-view.js";
import { createTranscriptView } from "./ui/transcript-view.js";
import { createSettingsView, createKeySetupView } from "./ui/settings-view.js";

const NARROW_PX = 900; // below this the sidebar is an overlay drawer
const WIDE_START_PX = 1100;

const root = document.getElementById("app");
const narrowQuery = window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`);
const isNarrow = () => narrowQuery.matches;

/* ------------------------------------------------------------------ */
/* Navigation helpers                                                  */
/* ------------------------------------------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/");
  let arg = parts.slice(1).join("/");
  try { arg = decodeURIComponent(arg); } catch { /* keep raw */ }
  return { name: parts[0], arg };
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

const ctx = { navigate, route: () => route(), refreshHistory: () => refreshHistory() };

/* ------------------------------------------------------------------ */
/* Shell: rail, drawer, content                                        */
/* ------------------------------------------------------------------ */

const content = h("main", { id: "content", class: "content" });

const railToggle = iconBtn("sidebar", "Open sidebar", () => setSidebar(!root.classList.contains("sidebar-open")), "rail-btn");
const railNew = iconBtn("plus", "New transcription", () => go("#new"), "rail-btn rail-new");
const railRecord = iconBtn("mic", "Record", () => go("#record"), "rail-btn");
const railSettings = iconBtn("gear", "Settings", () => go("#settings"), "rail-btn rail-settings");
const rail = h("nav", { class: "rail", "aria-label": "Main" },
  h("div", { class: "rail-top" }, railToggle, railNew, railRecord),
  railSettings);

const drawerToggle = iconBtn("sidebar", "Close sidebar", () => setSidebar(false), "ghost");
const drawerNew = h("button", { type: "button", class: "drawer-new", onclick: () => go("#new") },
  icon("plus", 20), h("span", { text: "New transcription" }), h("span", { class: "busy-dot", "aria-hidden": "true" }));
const drawerRecord = h("button", { type: "button", class: "drawer-link", onclick: () => go("#record") },
  icon("mic", 20), h("span", { text: "Record" }));
const historyList = h("ul", { class: "history", "aria-label": "History" });
const drawerSettings = h("button", { type: "button", class: "pill block", onclick: () => go("#settings") },
  icon("gear", 18), h("span", { text: "Settings" }));
const drawer = h("aside", { class: "drawer", "aria-label": "Sidebar" },
  h("div", { class: "drawer-head" }, h("a", { class: "brand", href: "#new", text: "Lecture Transcriber" }), drawerToggle),
  h("div", { class: "drawer-actions" }, drawerNew, drawerRecord),
  h("h2", { class: "drawer-heading", text: "History" }),
  h("div", { class: "drawer-scroll" }, historyList),
  h("div", { class: "drawer-foot" }, drawerSettings));
const backdrop = h("div", { class: "drawer-backdrop", onclick: () => setSidebar(false) });

root.append(rail, drawer, backdrop, content);

function setSidebar(open, persist = true) {
  root.classList.toggle("sidebar-open", open);
  railToggle.setAttribute("aria-label", open ? "Close sidebar" : "Open sidebar");
  railToggle.setAttribute("aria-expanded", String(open));
  if (persist && !isNarrow()) {
    try { storage.saveSettings({ sidebarOpen: open }); } catch { /* ignore */ }
  }
}

function go(hash) {
  if (isNarrow()) setSidebar(false, false);
  navigate(hash);
}

function initSidebar() {
  if (isNarrow()) { setSidebar(false, false); return; }
  const saved = storage.getSettings().sidebarOpen;
  setSidebar(saved == null ? window.matchMedia(`(min-width: ${WIDE_START_PX}px)`).matches : !!saved, false);
}

function updateBusy() {
  const busy = isBusy();
  railNew.classList.toggle("busy", busy);
  drawerNew.classList.toggle("busy", busy);
}
on("busy", updateBusy);

/* ------------------------------------------------------------------ */
/* History list                                                        */
/* ------------------------------------------------------------------ */

let historyItems = [];
let currentId = null;
let current = null;       // the mounted view
let newViewApi = null;    // kept alive across routes (recording and progress must survive navigation)
let routeToken = 0;

async function refreshHistory() {
  try {
    historyItems = await storage.listTranscripts();
  } catch {
    historyItems = [];
  }
  renderHistory();
}

function renderHistory() {
  historyList.replaceChildren();
  if (!historyItems.length) {
    historyList.append(h("li", { class: "hist-empty", text: "No transcripts yet. Transcripts you create are saved on this device." }));
    return;
  }
  for (const it of historyItems) historyList.append(historyRow(it));
  markCurrent();
}

function markCurrent() {
  for (const li of historyList.querySelectorAll(".hist-item")) {
    const on = li.dataset.id === currentId;
    li.classList.toggle("current", on);
    const a = li.querySelector("a");
    if (a) { if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  }
}

function historyRow(it) {
  const link = h("a", {
    class: "hist-link",
    href: `#t/${encodeURIComponent(it.id)}`,
    title: it.title || "Untitled",
    onclick: () => { if (isNarrow()) setSidebar(false, false); },
  }, h("span", { class: "hist-dot", "aria-hidden": "true" }), h("span", { class: "hist-title", text: it.title || "Untitled" }));
  const more = iconBtn("more", `Options for ${it.title || "this transcript"}`, () => openHistoryMenu(more, it, link), "ghost hist-more");
  return h("li", { class: "hist-item", "data-id": it.id }, link, more);
}

function openHistoryMenu(anchor, it, link) {
  if (popoverOpenFor(anchor)) { closePopover(); return; }
  const box = h("div", { class: "menu", role: "menu" },
    menuItem({ iconName: "pencil", label: "Rename", onclick() { closePopover(); renameInline(link, it); } }),
    menuItem({ iconName: "trash", label: "Delete", danger: true, onclick() { closePopover(); deleteItem(it); } }));
  openPopover(anchor, box, { align: "end" });
}

function renameInline(link, it) {
  const input = h("input", { type: "text", class: "hist-input", value: it.title || "", autocomplete: "off", "aria-label": "Rename transcript" });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (!save || !value || value === it.title) { renderHistory(); return; }
    try {
      if (current && current.id === it.id && current.setTitle) {
        await current.setTitle(value);
      } else {
        const t = await storage.getTranscript(it.id);
        if (t) { t.title = value; await storage.saveTranscript(t); }
      }
    } catch (err) {
      toast(`Could not rename. ${errorMessage(err)}`);
    }
    await refreshHistory();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  link.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteItem(it) {
  if (!window.confirm(`Delete "${it.title || "this transcript"}" from this device? This cannot be undone.`)) return;
  try {
    if (current && current.id === it.id && current.abandon) current.abandon();
    await storage.deleteTranscript(it.id);
    try { await media.deleteAudio(it.id); } catch { /* no audio stored */ }
    if (state.unsaved && state.unsaved.id === it.id) state.unsaved = null;
  } catch (err) {
    toast(`Could not delete. ${errorMessage(err)}`);
    return;
  }
  await refreshHistory();
  if (currentId === it.id) navigate("#new");
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

function teardown() {
  if (current && current !== newViewApi && current.destroy) {
    try { current.destroy(); } catch (e) { console.error(e); }
  }
  current = null;
}

function mount(view, id = null) {
  current = view;
  currentId = id;
  content.replaceChildren(view.el);
  markCurrent();
}

function setActiveNav(name) {
  const map = [[railNew, name === "new"], [railRecord, name === "record"], [railSettings, name === "settings"]];
  for (const [btn, on] of map) {
    if (on) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
  }
  drawerNew.classList.toggle("active", name === "new");
  drawerRecord.classList.toggle("active", name === "record");
  drawerSettings.classList.toggle("active", name === "settings");
}

async function route() {
  const token = ++routeToken;
  closePopover();
  teardown();
  document.title = "Lecture Transcriber";

  if (!storage.getApiKey()) {
    root.classList.add("no-key");
    currentId = null;
    mount(createKeySetupView({ onSaved: () => route() }));
    return;
  }
  root.classList.remove("no-key");

  const { name, arg } = parseHash();
  setActiveNav(name);
  switch (name) {
    case "new":
    case "record":
      if (!newViewApi) newViewApi = createNewView(ctx);
      newViewApi.show(name === "record" ? "record" : "new");
      mount(newViewApi);
      break;
    case "settings":
      mount(createSettingsView(ctx));
      break;
    case "history":
      setSidebar(true, false);
      history.replaceState(null, "", "#new");
      route();
      break;
    case "t": {
      currentId = arg;
      content.replaceChildren(h("div", { class: "page" }, h("div", { class: "page-inner" }, h("p", { class: "muted", text: "Loading" }))));
      const view = await createTranscriptView(ctx, arg, () => token !== routeToken);
      if (!view) return; // a newer route took over
      if (token !== routeToken) { view.destroy(); return; }
      view.id = arg;
      mount(view, arg);
      break;
    }
    default:
      history.replaceState(null, "", "#new");
      route();
  }
}

window.addEventListener("hashchange", route);

/* ------------------------------------------------------------------ */
/* Global behaviour                                                    */
/* ------------------------------------------------------------------ */

window.addEventListener("beforeunload", (e) => {
  if (isBusy()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Escape closes the overlay drawer on small screens.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isNarrow() && root.classList.contains("sidebar-open")) setSidebar(false, false);
});

// After a mouse or touch click, drop focus from buttons so Space toggles playback instead of re-clicking them.
document.addEventListener("click", (e) => {
  if (e.detail === 0) return; // keyboard activation
  const b = e.target.closest && e.target.closest("button");
  if (b && !b.closest("[role='tablist']")) setTimeout(() => { if (document.activeElement === b) b.blur(); }, 0);
});

initSidebar();
refreshHistory();
route();
