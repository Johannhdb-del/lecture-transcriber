// Right side panel: loudness overview, then tabs Notes, Summary and Study aids.
import * as storage from "../storage.js";
import * as exp from "../export.js";
import * as tasks from "../claude-tasks.js";
import { renderMarkdown } from "../markdown.js";
import { h, icon, iconBtn, pill, selectWrap, LANGUAGES, noteStamp, copyText, toast } from "./dom.js";
import { createClaudeFlow } from "./claude-flow.js";
import { createOverview } from "./overview.js";
import { createMindMap } from "./mindmap.js";

const STAMP_RE = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g;
const TABS = [
  { id: "notes", label: "Notes" },
  { id: "summary", label: "Summary" },
  { id: "study", label: "Study aids" },
];

/**
 * getT() returns the current transcript, patch(obj) merges fields into it and saves.
 * onSeek(sec) jumps to a time, getTime() returns the playback position (0 without audio).
 */
export function createSidePanel({ getT, patch, player, onSeek, getTime, onClose }) {
  const overview = createOverview({ player });
  const closeBtn = iconBtn("x", "Close panel", onClose, "ghost sheet-close");
  const tabButtons = new Map();
  const bodies = new Map();
  const built = new Set();
  let active = "notes";

  const tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Panel sections" });
  for (const tab of TABS) {
    const btn = h("button", {
      type: "button",
      role: "tab",
      class: "tab",
      id: `tab-${tab.id}`,
      "aria-controls": `tabpanel-${tab.id}`,
      text: tab.label,
      onclick: () => select(tab.id),
      onkeydown(e) {
        const i = TABS.findIndex((x) => x.id === tab.id);
        if (e.key === "ArrowRight") select(TABS[(i + 1) % TABS.length].id, true);
        else if (e.key === "ArrowLeft") select(TABS[(i + TABS.length - 1) % TABS.length].id, true);
      },
    });
    tabButtons.set(tab.id, btn);
    tabBar.append(btn);
    bodies.set(tab.id, h("div", { class: "tab-body", id: `tabpanel-${tab.id}`, role: "tabpanel", "aria-labelledby": `tab-${tab.id}`, hidden: true }));
  }

  const el = h("aside", { class: "side-panel", "aria-label": "Notes, summary and study aids" },
    h("div", { class: "sheet-head" }, h("span", { class: "sheet-grip", "aria-hidden": "true" }), closeBtn),
    overview.el,
    h("div", { class: "handle", "aria-hidden": "true" }),
    tabBar,
    h("div", { class: "tab-scroll" }, ...bodies.values()));

  /* -------------------------------------------------------------- */
  /* Notes                                                           */
  /* -------------------------------------------------------------- */

  let notesTimer = null;
  let notesArea = null;

  function flushNotes() {
    if (notesTimer === null || !notesArea) return;
    clearTimeout(notesTimer);
    notesTimer = null;
    patch({ notes: notesArea.value });
  }

  function buildNotes() {
    const body = bodies.get("notes");
    const chips = h("div", { class: "chips", "aria-label": "Timestamps in your notes" });
    notesArea = h("textarea", {
      class: "notes-area",
      placeholder: "Add a note...",
      "aria-label": "Notes",
      value: getT().notes || "",
      spellcheck: true,
      oninput() {
        updateChips();
        clearTimeout(notesTimer);
        notesTimer = setTimeout(() => { notesTimer = null; patch({ notes: notesArea.value }); }, 500);
      },
    });

    function insertAtCursor(text) {
      const start = notesArea.selectionStart ?? notesArea.value.length;
      const end = notesArea.selectionEnd ?? start;
      notesArea.setRangeText(text, start, end, "end");
      notesArea.focus();
      notesArea.dispatchEvent(new Event("input"));
    }

    function insertChecklist() {
      const pos = notesArea.selectionStart ?? notesArea.value.length;
      const before = notesArea.value.slice(0, pos);
      const needsBreak = before.length > 0 && !before.endsWith("\n");
      insertAtCursor(`${needsBreak ? "\n" : ""}☐ `);
    }

    function updateChips() {
      const found = [];
      const seen = new Set();
      for (const m of notesArea.value.matchAll(STAMP_RE)) {
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        const sec = (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
        found.push({ label: m[0], sec });
      }
      chips.replaceChildren(...found.map((f) => h("button", {
        type: "button",
        class: "chip-ts",
        text: f.label,
        title: "Jump to this time",
        onclick: () => onSeek(f.sec),
      })));
      chips.hidden = !found.length;
    }

    body.append(
      h("div", { class: "notes-tools" },
        h("button", {
          type: "button", class: "icon-btn ghost", title: "Insert timestamp", "aria-label": "Insert timestamp",
          onclick: () => insertAtCursor(noteStamp(getTime())),
        }, icon("clock")),
        h("button", {
          type: "button", class: "icon-btn ghost", title: "Checklist item", "aria-label": "Checklist item",
          onclick: insertChecklist,
        }, icon("checkSquare"))),
      notesArea,
      chips);
    updateChips();
  }

  /* -------------------------------------------------------------- */
  /* Summary                                                         */
  /* -------------------------------------------------------------- */

  function languageSelect(initial, onchange) {
    const select = h("select", { "aria-label": "Language of the answer", onchange: () => onchange(select.value) },
      LANGUAGES.map((l) => h("option", { value: l.value, text: l.label })));
    select.value = initial;
    return select;
  }

  function titleBase(suffix) {
    return `${getT().title || "transcript"}_${suffix}`;
  }

  let summaryReplacing = false;
  let summaryLang = null;

  function renderSummary() {
    const body = bodies.get("summary");
    const t = getT();
    if (!summaryLang) summaryLang = t.summaryLanguage || t.language || "de";
    body.replaceChildren();

    if (t.summary && !summaryReplacing) {
      const text = h("div", { class: "md" }, renderMarkdown(t.summary));
      body.append(
        h("div", { class: "btn-row" },
          pill("Copy", { iconName: "copy", async onclick() { toast((await copyText(t.summary)) ? "Summary copied" : "Copying was blocked by the browser"); } }),
          pill("Download .md", { iconName: "download", onclick: () => exp.downloadFile(`${exp.safeFilename(titleBase("summary"))}.md`, t.summary, "text/markdown;charset=utf-8") }),
          pill("Replace", { onclick: () => { summaryReplacing = true; renderSummary(); } })),
        text);
      return;
    }

    const flow = createClaudeFlow({
      intro: "Claude writes study notes from this transcript. Copy the prompt, paste it into a new Claude chat, then paste the answer here.",
      getPrompts: () => [tasks.buildSummaryPrompt(getT(), { language: summaryLang })],
      fileBase: () => titleBase("summary_prompt"),
      checkLabel: "Save summary",
      placeholder: "Paste Claude's answer here",
      onCheck(text) {
        const md = tasks.parseSummaryAnswer(text);
        patch({ summary: md, summaryLanguage: summaryLang });
        summaryReplacing = false;
        renderSummary();
        return { accepted: true };
      },
    });
    const head = [
      h("div", { class: "field" },
        h("label", { text: "Language of the summary" }),
        selectWrap(languageSelect(summaryLang, (v) => { summaryLang = v; flow.refresh(); }))),
    ];
    if (t.summary) head.push(pill("Cancel", { cls: "small", onclick: () => { summaryReplacing = false; renderSummary(); } }));
    body.append(h("div", { class: "stack" }, ...head, flow.el));
  }

  /* -------------------------------------------------------------- */
  /* Study aids                                                      */
  /* -------------------------------------------------------------- */

  let studyReplacing = false;
  let studyLang = null;

  function flipCard(card) {
    const q = h("span", { class: "fc-q", text: card.q });
    const a = h("span", { class: "fc-a", text: card.a });
    const hint = h("span", { class: "fc-hint", text: "Tap to show the answer" });
    const btn = h("button", {
      type: "button",
      class: "flip-card",
      "aria-pressed": "false",
      onclick() {
        const on = btn.getAttribute("aria-pressed") !== "true";
        btn.setAttribute("aria-pressed", String(on));
        hint.textContent = on ? "Tap to show the question" : "Tap to show the answer";
      },
    }, q, a, hint);
    return btn;
  }

  // The tab holds flashcards and glossary first, then the mind map; each has its own Claude round trip.
  const studyBox = h("div");
  const mapBox = h("div", { class: "mm-section" });

  function buildStudy() {
    bodies.get("study").append(studyBox, mapBox);
    renderStudy();
    renderMindMap();
  }

  function renderStudy() {
    const body = studyBox;
    const t = getT();
    if (!studyLang) studyLang = t.studyLanguage || t.language || "de";
    body.replaceChildren();
    const aids = t.studyAids;
    const has = aids && ((aids.cards || []).length || (aids.glossary || []).length);

    if (has && !studyReplacing) {
      const nodes = [h("div", { class: "btn-row" }, pill("Replace", { onclick: () => { studyReplacing = true; renderStudy(); } }))];
      if ((aids.cards || []).length) {
        nodes.push(h("h3", { text: `Flashcards (${aids.cards.length})` }),
          h("div", { class: "cards" }, aids.cards.map(flipCard)));
      }
      if ((aids.glossary || []).length) {
        nodes.push(h("h3", { text: `Glossary (${aids.glossary.length})` }),
          h("dl", { class: "glossary" }, aids.glossary.flatMap((g) => [h("dt", { text: g.term }), h("dd", { text: g.explanation })])));
      }
      body.append(h("div", { class: "stack" }, ...nodes));
      return;
    }

    const flow = createClaudeFlow({
      intro: "Claude creates flashcards and a glossary from this transcript. Copy the prompt, paste it into a new Claude chat, then paste the answer here.",
      getPrompts: () => [tasks.buildStudyAidsPrompt(getT(), { language: studyLang })],
      fileBase: () => titleBase("study_aids_prompt"),
      checkLabel: "Save study aids",
      placeholder: "Paste Claude's answer here",
      onCheck(text) {
        const { cards, glossary, errors } = tasks.parseStudyAidsAnswer(text);
        if (!cards.length && !glossary.length) return { errors };
        patch({ studyAids: { cards, glossary }, studyLanguage: studyLang });
        studyReplacing = false;
        renderStudy();
        return { accepted: true };
      },
    });
    const head = [
      h("div", { class: "field" },
        h("label", { text: "Language of the study aids" }),
        selectWrap(languageSelect(studyLang, (v) => { studyLang = v; flow.refresh(); }))),
    ];
    if (has) head.push(pill("Cancel", { cls: "small", onclick: () => { studyReplacing = false; renderStudy(); } }));
    body.append(h("div", { class: "stack" }, ...head, flow.el));
  }

  /* -------------------------------------------------------------- */
  /* Mind map (part of Study aids)                                   */
  /* -------------------------------------------------------------- */

  let mapReplacing = false;
  let mapLang = null;
  let mindMap = null;

  function renderMindMap() {
    const t = getT();
    if (!mapLang) mapLang = t.mindMapLanguage || t.language || "de";
    if (mindMap) { mindMap.destroy(); mindMap = null; }
    mapBox.replaceChildren(h("h3", { text: "Mind map" }));

    if (t.mindMap && !mapReplacing) {
      mindMap = createMindMap({ root: t.mindMap, onSeek });
      mapBox.append(h("div", { class: "stack" },
        h("div", { class: "btn-row" },
          pill("Download .opml", {
            iconName: "download",
            onclick: () => exp.downloadFile(`${exp.safeFilename(titleBase("mindmap"))}.opml`, exp.mindMapToOpml(getT()), "text/x-opml;charset=utf-8"),
          }),
          pill("Replace", { onclick: () => { mapReplacing = true; renderMindMap(); } })),
        mindMap.el,
        h("p", { class: "hint", text: "Tap a topic to jump to that part of the lecture. The .opml file opens in mind map apps such as MindNode, XMind or iThoughts." })));
      return;
    }

    const flow = createClaudeFlow({
      intro: "Claude builds a mind map of this lecture, with the time where each topic comes up. Copy the prompt, paste it into a new Claude chat, then paste the answer here.",
      getPrompts: () => [tasks.buildMindMapPrompt(getT(), { language: mapLang })],
      fileBase: () => titleBase("mindmap_prompt"),
      checkLabel: "Save mind map",
      placeholder: "Paste Claude's answer here",
      onCheck(text) {
        const { root, errors } = tasks.parseMindMapAnswer(text, { durationSec: getT().durationSec });
        if (!root) return { errors };
        patch({ mindMap: root, mindMapLanguage: mapLang });
        mapReplacing = false;
        renderMindMap();
        return { accepted: true };
      },
    });
    const head = [
      h("div", { class: "field" },
        h("label", { text: "Language of the mind map" }),
        selectWrap(languageSelect(mapLang, (v) => { mapLang = v; flow.refresh(); }))),
    ];
    if (t.mindMap) head.push(pill("Cancel", { cls: "small", onclick: () => { mapReplacing = false; renderMindMap(); } }));
    mapBox.append(h("div", { class: "stack" }, ...head, flow.el));
  }

  /* -------------------------------------------------------------- */
  /* Tabs                                                            */
  /* -------------------------------------------------------------- */

  const builders = { notes: buildNotes, summary: renderSummary, study: buildStudy };

  function select(id, focus = false) {
    active = id;
    for (const [tid, btn] of tabButtons) {
      const on = tid === id;
      btn.setAttribute("aria-selected", String(on));
      btn.tabIndex = on ? 0 : -1;
      bodies.get(tid).hidden = !on;
    }
    if (!built.has(id)) { built.add(id); builders[id](); }
    if (focus) tabButtons.get(id).focus();
    try { storage.saveSettings({ panelTab: id }); } catch { /* ignore */ }
  }

  let first = "notes";
  try { first = storage.getSettings().panelTab || "notes"; } catch { /* ignore */ }
  select(TABS.some((x) => x.id === first) ? first : "notes");

  return {
    el,
    setBlob: (blob) => overview.setBlob(blob),
    redrawOverview: () => overview.redraw(),
    flush: flushNotes,
    destroy() {
      flushNotes();
      overview.destroy();
      if (mindMap) mindMap.destroy();
    },
    get active() { return active; },
  };
}
