// Shared "copy the prompt, paste Claude's answer" component.
// Used for corrections, summary, study aids and translation.
import * as exp from "../export.js";
import { h, icon, pill, copyText, plural } from "./dom.js";

const MAX_SHOWN_ERRORS = 8;
const LONG_PROMPT_CHARS = 100000;

/**
 * createClaudeFlow({
 *   intro, getPrompts() -> string[], fileBase() -> string, checkLabel, placeholder,
 *   onCheck(text, partIndex) -> { errors?, info?, review?: Node, accepted?: boolean } (may be async)
 * }) -> { el, refresh(), reset() }
 */
export function createClaudeFlow({
  intro = "Paste the prompt into a new Claude chat (a strong model works best), wait for the answer, then copy the whole answer.",
  getPrompts,
  fileBase = () => "claude_prompt",
  checkLabel = "Check answer",
  placeholder = "Paste Claude's whole answer here",
  onCheck,
}) {
  let prompts = [];
  let part = 0;
  let copyTimer = null;

  // Step 1: copy the prompt
  const partLabel = h("span", { class: "part-label" });
  const prevPart = pill("Previous", { cls: "small", onclick: () => setPart(part - 1) });
  const nextPart = pill("Next", { cls: "small", onclick: () => setPart(part + 1) });
  const partRow = h("div", { class: "part-row", hidden: true }, partLabel, prevPart, nextPart);
  const promptInfo = h("p", { class: "hint" });
  const copyStatus = h("span", { class: "status", role: "status", "aria-live": "polite" });
  const manualBox = h("div", { class: "field", hidden: true });
  const copyBtn = pill("Copy prompt", { primary: true, iconName: "copy", onclick: () => copyPrompt() });
  const saveBtn = pill("Save as file", { iconName: "download", onclick: () => savePrompt() });
  const openClaude = h("a", { class: "pill", href: "https://claude.ai/new", target: "_blank", rel: "noopener noreferrer" },
    icon("sparkle", 18), h("span", { text: "Open Claude" }));

  // Step 2: paste the answer
  const answer = h("textarea", {
    rows: 7,
    spellcheck: false,
    autocapitalize: "none",
    placeholder,
    "aria-label": "Claude's answer",
  });
  const checkBtn = pill(checkLabel, { primary: true, onclick: () => check() });
  const messages = h("div", { class: "stack-sm", hidden: true });
  const reviewSlot = h("div", { class: "stack", hidden: true });

  const el = h("div", { class: "flow stack" },
    h("div", { class: "flow-step stack-sm" },
      h("h3", { text: "1. Copy the prompt" }),
      h("p", { class: "muted", text: intro }),
      partRow,
      promptInfo,
      h("div", { class: "btn-row" }, copyBtn, saveBtn, openClaude, copyStatus),
      manualBox),
    h("div", { class: "flow-step stack-sm" },
      h("h3", { text: "2. Paste Claude's answer" }),
      answer,
      h("div", { class: "btn-row" }, checkBtn),
      messages),
    reviewSlot);

  function currentPrompt() {
    return prompts[part] || "";
  }

  function updateInfo() {
    const text = currentPrompt();
    promptInfo.textContent = `Prompt size: ${text.length.toLocaleString()} characters.` +
      (text.length > LONG_PROMPT_CHARS ? " This is a long transcript. If pasting is slow or fails, save the prompt as a file and attach it in Claude." : "");
    const many = prompts.length > 1;
    partRow.hidden = !many;
    if (many) {
      partLabel.textContent = `Part ${part + 1} of ${prompts.length}`;
      prevPart.disabled = part === 0;
      nextPart.disabled = part >= prompts.length - 1;
      copyBtn.lastChild.textContent = `Copy part ${part + 1}`;
      checkBtn.lastChild.textContent = `${checkLabel} (part ${part + 1})`;
    } else {
      copyBtn.lastChild.textContent = "Copy prompt";
      checkBtn.lastChild.textContent = checkLabel;
    }
    manualBox.hidden = true;
  }

  function setPart(i) {
    part = Math.max(0, Math.min(prompts.length - 1, i));
    updateInfo();
  }

  function showManualCopy() {
    const ta = h("textarea", { class: "prompt-box", readOnly: true, rows: 8, "aria-label": "Prompt", value: currentPrompt() });
    manualBox.replaceChildren(
      h("p", { class: "hint", text: "Copying was blocked by the browser. Select all of the text below and copy it manually, or save it as a file." }),
      ta);
    manualBox.hidden = false;
    ta.focus();
    ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch { /* ignore */ }
  }

  async function copyPrompt() {
    const ok = await copyText(currentPrompt());
    if (!ok) { showManualCopy(); return; }
    manualBox.hidden = true;
    copyStatus.textContent = prompts.length > 1 ? `Part ${part + 1} copied` : "Prompt copied";
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyStatus.textContent = ""; }, 2500);
  }

  function savePrompt() {
    const suffix = prompts.length > 1 ? `_part${part + 1}` : "";
    exp.downloadFile(`${exp.safeFilename(fileBase())}${suffix}.txt`, currentPrompt(), "text/plain;charset=utf-8");
  }

  function showMessages({ errors = [], info = "" }) {
    const nodes = [];
    if (info) nodes.push(h("div", { class: "alert info", role: "status", text: info }));
    if (errors.length) {
      const shown = errors.slice(0, MAX_SHOWN_ERRORS);
      const more = errors.length - shown.length;
      nodes.push(h("div", { class: "alert warn" },
        h("p", { text: errors.length === 1 ? "Problem with the answer:" : `${plural(errors.length, "problem", "problems")} with the answer:` }),
        h("ul", {}, shown.map((e) => h("li", { text: e })), more > 0 ? h("li", { text: `and ${more} more` }) : null)));
    }
    messages.replaceChildren(...nodes);
    messages.hidden = !nodes.length;
  }

  async function check() {
    if (!answer.value.trim()) {
      showMessages({ errors: ["Paste Claude's answer first."] });
      return;
    }
    checkBtn.disabled = true;
    reviewSlot.replaceChildren();
    reviewSlot.hidden = true;
    let res = {};
    try {
      res = (await onCheck(answer.value, part)) || {};
    } catch (err) {
      res = { errors: [err && err.message ? err.message : "The answer could not be read."] };
    }
    checkBtn.disabled = false;
    showMessages(res);
    if (res.review) {
      reviewSlot.replaceChildren(res.review);
      reviewSlot.hidden = false;
    }
    if (res.accepted) {
      answer.value = "";
      if (part < prompts.length - 1) setPart(part + 1);
    }
  }

  function refresh() {
    prompts = getPrompts() || [];
    if (!prompts.length) prompts = [""];
    part = Math.max(0, Math.min(prompts.length - 1, part));
    updateInfo();
  }

  function reset() {
    answer.value = "";
    messages.replaceChildren();
    messages.hidden = true;
    reviewSlot.replaceChildren();
    reviewSlot.hidden = true;
    manualBox.hidden = true;
    part = 0;
    refresh();
  }

  refresh();
  return { el, refresh, reset };
}
