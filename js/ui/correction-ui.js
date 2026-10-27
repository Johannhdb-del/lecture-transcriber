// Review list for "Correct with Claude": shows each suggestion with checkboxes and applies the selected ones.
import * as corr from "../correction.js";
import { h, pill, plural } from "./dom.js";

const TYPE_LABELS = { fix: "Fix", guess: "Guess", format: "Format" };
const CONTEXT_CHARS = 60;

/** Build the review node. onApply(selectedCorrections) is called when the user confirms. */
export function buildCorrectionReview({ transcript, corrections, onApply, heading = "3. Review and apply" }) {
  const progressive = new Map(); // line id -> text after the earlier corrections of this list
  const items = [];              // { correction, checkbox }
  const list = h("ul", { class: "review-list" });

  for (const c of corrections) {
    const sentence = corr.findSentence(transcript, c.id);
    const text = sentence ? (progressive.get(c.id) ?? sentence.text) : "";
    const hit = sentence ? corr.locateText(text, c.find) : null;
    let note = "";
    let context = [];
    if (hit) {
      const from = Math.max(0, hit.index - CONTEXT_CHARS);
      const to = Math.min(text.length, hit.index + hit.length + CONTEXT_CHARS);
      context = [
        (from > 0 ? "…" : "") + text.slice(from, hit.index),
        h("del", { class: "c-del", text: text.slice(hit.index, hit.index + hit.length) }),
        c.replace ? h("ins", { class: "c-ins", text: c.replace }) : null,
        text.slice(hit.index + hit.length, to) + (to < text.length ? "…" : ""),
      ];
      progressive.set(c.id, (text.slice(0, hit.index) + c.replace + text.slice(hit.index + hit.length)).replace(/\s+/g, " ").trim());
    } else {
      note = sentence ? "Text not found in this line, it cannot be applied." : "Line not found, it cannot be applied.";
      context = [h("del", { class: "c-del", text: c.find }), c.replace ? h("ins", { class: "c-ins", text: c.replace }) : null];
    }

    const checkbox = h("input", {
      type: "checkbox",
      checked: !!hit && c.type !== "guess",
      disabled: !hit,
      "aria-label": `Apply correction ${c.id}`,
      onchange: updateApplyBtn,
    });
    items.push({ correction: c, checkbox });
    list.append(h("li", {},
      h("label", { class: "review-item" },
        checkbox,
        h("span", { class: "review-body" },
          h("span", { class: "review-head" },
            h("span", { class: `badge ${c.type}`, text: TYPE_LABELS[c.type] || c.type }),
            h("span", { class: "review-id", text: c.id })),
          h("span", { class: "review-ctx" }, context),
          c.reason ? h("span", { class: "review-reason", text: c.reason }) : null,
          note ? h("span", { class: "review-reason", text: note }) : null))));
  }

  const applyBtn = pill("", { primary: true, onclick: () => apply() });

  function selected() {
    return items.filter((i) => i.checkbox.checked).map((i) => i.correction);
  }

  function updateApplyBtn() {
    const n = selected().length;
    applyBtn.lastChild.textContent = `Apply selected (${n})`;
    applyBtn.disabled = n === 0;
  }

  function setAll(on) {
    for (const i of items) if (!i.checkbox.disabled) i.checkbox.checked = on;
    updateApplyBtn();
  }

  function apply() {
    const chosen = selected();
    if (chosen.length) onApply(chosen);
  }

  const node = h("div", { class: "flow-step stack-sm" },
    h("h3", { text: heading }),
    h("p", { text: `${plural(corrections.length, "suggestion", "suggestions")}. Fixes and format changes are selected, guesses are not.` }),
    h("div", { class: "btn-row" },
      pill("Select all", { onclick: () => setAll(true) }),
      pill("Select none", { onclick: () => setAll(false) }),
      applyBtn),
    list);
  updateApplyBtn();
  return node;
}

/** Confirmation after applying, with the corrections that could not be applied. */
export function correctionResultNode(res, onDismiss) {
  const failed = res.failed || [];
  return h("div", { class: failed.length ? "alert warn" : "alert info", role: "status" },
    h("p", { text: `${plural(res.applied, "correction", "corrections")} applied, ${failed.length} could not be applied.` }),
    failed.length
      ? h("ul", {}, failed.map((f) => h("li", { text: `${f.correction.id}: "${f.correction.find}" (${f.reason})` })))
      : null,
    pill("Dismiss", { cls: "small", onclick: onDismiss }));
}
