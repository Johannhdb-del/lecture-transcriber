// Settings screen and the first run key setup screen.
import * as storage from "../storage.js";
import * as deepgram from "../engines/deepgram.js";
import * as fmt from "../format.js";
import * as media from "../media-store.js";
import { readDocument, extractTerms, mergeTerms } from "../doc-terms.js";
import { DEEPGRAM_TERM_LIMIT, CHECK_TERM_LIMIT } from "../course-terms.js";
import {
  h, pill, selectWrap, alertBox, errorMessage, baseName, plural, languageLabel, formatDate, LANGUAGES,
} from "./dom.js";

/* API key form (shared by setup and settings) --------------------------- */

function keyForm({ submitLabel = "Test and save", onSaved }) {
  const alert = alertBox();
  const input = h("input", {
    type: "password",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: false,
    placeholder: "Paste your Deepgram API key",
    "aria-label": "Deepgram API key",
  });
  const toggle = h("button", {
    type: "button",
    class: "pill",
    text: "Show",
    "aria-pressed": "false",
    onclick() {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
      toggle.setAttribute("aria-pressed", String(show));
    },
  });
  const submit = h("button", { type: "submit", class: "pill primary", text: submitLabel });

  return h("form", {
    class: "stack",
    async onsubmit(e) {
      e.preventDefault();
      alert.clear();
      const key = input.value.trim();
      if (!key) { alert.show("Paste your API key first."); return; }
      submit.disabled = true;
      toggle.disabled = true;
      submit.textContent = "Testing the key";
      try {
        const res = await deepgram.testKey(key);
        if (res && res.ok) {
          storage.setApiKey(key);
          input.value = "";
          onSaved();
          return;
        }
        alert.show((res && res.message) || "Key not accepted.");
      } catch (err) {
        alert.show(errorMessage(err));
      }
      submit.disabled = false;
      toggle.disabled = false;
      submit.textContent = submitLabel;
    },
  },
  alert.el,
  h("div", { class: "input-row" }, input, toggle),
  h("div", { class: "btn-row" }, submit));
}

/** The screen shown while no key is stored. */
export function createKeySetupView({ onSaved }) {
  return {
    el: h("div", { class: "page" }, h("div", { class: "page-inner stack" },
      h("h1", { text: "Welcome" }),
      h("p", { class: "lead", text: "This app turns lecture recordings into readable transcripts with speaker labels. It uses Deepgram for the speech recognition, so you need a Deepgram API key." }),
      h("div", { class: "card stack" },
        h("h2", { text: "Add your Deepgram key" }),
        h("p", {}, "Create a key in the Deepgram console under API Keys at ",
          h("a", { href: "https://console.deepgram.com", target: "_blank", rel: "noopener noreferrer", text: "console.deepgram.com" }),
          ". The key is stored only on this device and is sent only to Deepgram."),
        keyForm({ onSaved })))),
    destroy() {},
  };
}

/* Settings ----------------------------------------------------------------- */

export function createSettingsView(ctx) {
  const inner = h("div", { class: "page-inner stack" });
  const el = h("div", { class: "page" }, inner);
  let alive = true;

  function render(openId = "") {
    const alert = alertBox();
    const settings = storage.getSettings();

    // Defaults
    const langSelect = h("select", {
      id: "default-language",
      onchange() { storage.saveSettings({ language: langSelect.value }); flashDefaults(); },
    }, LANGUAGES.map((l) => h("option", { value: l.value, text: l.label })));
    langSelect.value = settings.language || "de";

    const diarSelect = h("select", {
      id: "speaker-model",
      onchange() { storage.saveSettings({ diarizer: diarSelect.value }); flashDefaults(); },
    },
    h("option", { value: "v1", text: "v1 (recommended)" }),
    h("option", { value: "latest", text: "latest" }));
    diarSelect.value = settings.diarizer === "latest" ? "latest" : "v1";

    const smoothBox = h("input", {
      type: "checkbox",
      id: "smooth-speakers",
      checked: settings.smoothSpeakers !== false,
      onchange() { storage.saveSettings({ smoothSpeakers: smoothBox.checked }); flashDefaults(); },
    });

    const defaultsStatus = h("span", { class: "status", role: "status" });
    let defTimer = null;
    function flashDefaults() {
      defaultsStatus.textContent = "Saved";
      clearTimeout(defTimer);
      defTimer = setTimeout(() => { defaultsStatus.textContent = ""; }, 2000);
    }

    const defaultsCard = h("section", { class: "card stack" },
      h("h2", { text: "Defaults" }),
      h("div", { class: "grid-2" },
        h("div", { class: "field" }, h("label", { for: "default-language", text: "Default language" }), selectWrap(langSelect)),
        h("div", { class: "field" },
          h("label", { for: "speaker-model", text: "Speaker model" }), selectWrap(diarSelect),
          h("p", { class: "hint", text: "v1 is recommended. Try latest only if speaker labels look wrong." }))),
      h("div", { class: "field" },
        h("label", { class: "check", for: "smooth-speakers" }, smoothBox, h("span", { text: "Merge short speaker fragments (recommended)" })),
        h("p", { class: "hint", text: "Fixes false speaker switches in the middle of a sentence. Applies to new transcriptions." })),
      defaultsStatus);

    // Recording
    const liveBox = h("input", {
      type: "checkbox",
      id: "live-transcript",
      checked: settings.liveTranscript !== false,
      onchange() { storage.saveSettings({ liveTranscript: liveBox.checked }); flashRecording(); },
    });
    const recordingStatus = h("span", { class: "status", role: "status" });
    let recTimer = null;
    function flashRecording() {
      recordingStatus.textContent = "Saved";
      clearTimeout(recTimer);
      recTimer = setTimeout(() => { recordingStatus.textContent = ""; }, 2000);
    }
    const recordingCard = h("section", { class: "card stack" },
      h("h2", { text: "Recording" }),
      h("div", { class: "field" },
        h("label", { class: "check", for: "live-transcript" }, liveBox, h("span", { text: "Show live transcript while recording" })),
        h("p", { class: "hint", text: "The text appears on screen as it is spoken. It adds about $0.45 per 90 minutes. The full transcription after recording stays available." })),
      recordingStatus);

    // Keyterm lists
    const listsBox = h("div", { class: "stack-sm" });
    for (const list of storage.listKeytermLists()) listsBox.append(keytermItem(list, list.id === openId, alert));
    if (!listsBox.children.length) {
      listsBox.append(h("p", { class: "muted", text: "No lists yet. A list holds names and technical words that help Deepgram spell them correctly." }));
    }

    const importInput = h("input", {
      type: "file",
      id: "import-terms",
      class: "visually-hidden",
      accept: ".txt,text/plain",
      async onchange() {
        const file = importInput.files && importInput.files[0];
        importInput.value = "";
        if (!file) return;
        alert.clear();
        try {
          const text = await file.text();
          const terms = fmt.parseKeyterms(text);
          if (!terms.length) { alert.show("No terms found in that file. Use one term per line."); return; }
          const saved = storage.saveKeytermList({ name: baseName(file.name), terms });
          render(saved.id);
        } catch (err) {
          alert.show(`Could not import the file. ${errorMessage(err)}`);
        }
      },
    });

    const listsCard = h("section", { class: "card stack" },
      h("h2", { text: "Keyterm lists" }),
      h("p", { class: "muted", text: "Save vocabulary for a course once and pick it for each transcription. One term per line. Lines starting with # are ignored. Add the course literature (PDF, .txt, .md) to a list, and its key terms are used as well." }),
      listsBox,
      h("div", { class: "btn-row" },
        pill("Add list", {
          onclick() {
            try {
              const saved = storage.saveKeytermList({ name: "New list", terms: [] });
              render(saved.id);
            } catch (err) {
              alert.show(`Could not create the list. ${errorMessage(err)}`);
            }
          },
        }),
        pill("Import .txt file", { onclick: () => importInput.click() }),
        importInput));

    // Audio storage
    const audioHost = h("div", { class: "stack-sm" }, h("p", { class: "muted", text: "Loading" }));
    const audioCard = h("section", { class: "card stack" },
      h("h2", { text: "Audio storage" }),
      h("p", { class: "muted", text: "The audio of each transcription is kept on this device so you can play it back. Deleting it frees space but keeps the transcript." }),
      audioHost);
    renderAudio(audioHost, alert);

    // API key
    const key = storage.getApiKey();
    const last4 = key.length >= 4 ? key.slice(-4) : key;
    const keyHolder = h("div", {});
    const keyCard = h("section", { class: "card stack" },
      h("h2", { text: "Deepgram API key" }),
      h("p", {}, "Stored on this device only. Current key: ", h("span", { class: "key-mask", text: `•••• ${last4}` })),
      keyHolder,
      h("div", { class: "btn-row" },
        pill("Change key", {
          onclick() {
            if (keyHolder.children.length) { keyHolder.replaceChildren(); return; }
            keyHolder.append(keyForm({ submitLabel: "Test and save", onSaved: () => render() }));
          },
        }),
        pill("Remove key", {
          danger: true,
          onclick() {
            if (!window.confirm("Remove the API key from this device? You will need to enter it again to transcribe.")) return;
            storage.clearApiKey();
            ctx.route();
          },
        })));

    const tipCard = h("section", { class: "card stack" },
      h("h2", { text: "Keep your data" }),
      h("p", { text: "Add this app to your Home Screen (Share button in Safari, then Add to Home Screen). Safari may clear stored data of websites you do not use for a while, but apps on the Home Screen are kept." }),
      h("h2", { text: "Privacy" }),
      h("p", { text: "Audio goes directly from this device to Deepgram, with the setting that opts out of Deepgram using it to improve their models. Transcripts, audio and your key stay on this device. There is no server of ours in between." }));

    inner.replaceChildren(h("h1", { text: "Settings" }), alert.el, defaultsCard, recordingCard, listsCard, audioCard, keyCard, tipCard);
  }

  function keytermItem(list, open, alert) {
    const summaryName = h("span", { text: list.name });
    const summaryCount = h("span", { class: "muted small", text: plural((list.terms || []).length, "term", "terms") });
    const nameInput = h("input", { type: "text", value: list.name, id: `kt-name-${list.id}`, autocomplete: "off" });
    const termsArea = h("textarea", {
      id: `kt-terms-${list.id}`,
      rows: 8,
      spellcheck: false,
      autocapitalize: "none",
      value: (list.terms || []).join("\n"),
    });
    const status = h("span", { class: "status", role: "status" });
    return h("details", { class: "kt", open },
      h("summary", {}, summaryName, summaryCount),
      h("div", { class: "kt-body stack" },
        h("div", { class: "field" }, h("label", { for: `kt-name-${list.id}`, text: "Name" }), nameInput),
        h("div", { class: "field" }, h("label", { for: `kt-terms-${list.id}`, text: "Terms, one per line" }), termsArea),
        courseDocs(list, alert),
        h("div", { class: "btn-row" },
          pill("Save list", {
            primary: true,
            onclick() {
              try {
                const terms = fmt.parseKeyterms(termsArea.value);
                const name = nameInput.value.trim() || "Untitled list";
                const saved = storage.saveKeytermList({ id: list.id, name, terms });
                summaryName.textContent = saved.name;
                summaryCount.textContent = plural(saved.terms.length, "term", "terms");
                nameInput.value = saved.name;
                termsArea.value = saved.terms.join("\n");
                status.textContent = "Saved";
                setTimeout(() => { status.textContent = ""; }, 2000);
              } catch (err) {
                alert.show(`Could not save the list. ${errorMessage(err)}`);
              }
            },
          }),
          pill("Delete list", {
            danger: true,
            onclick() {
              if (!window.confirm(`Delete the list "${list.name}" and its documents?`)) return;
              storage.deleteKeytermList(list.id);
              if (storage.getSettings().keytermListId === list.id) storage.saveSettings({ keytermListId: "" });
              storage.deleteCourseDocuments(list.id).catch(() => { /* ignore */ });
              render();
            },
          }),
          status)));
  }

  /* Course documents of a keyterm list --------------------------------- */

  function courseDocs(list, alert) {
    const docsBox = h("div", { class: "stack-sm" });
    const termsBox = h("div", { class: "stack-sm" });
    const progress = h("span", { class: "status", role: "status" });
    const fileInput = h("input", {
      type: "file",
      class: "visually-hidden",
      accept: ".pdf,application/pdf,.txt,text/plain,.md,text/markdown",
      multiple: true,
      async onchange() {
        const files = [...(fileInput.files || [])];
        fileInput.value = "";
        alert.clear();
        for (const file of files) {
          try {
            progress.textContent = `Reading ${file.name}`;
            const doc = await readDocument(file, {
              onProgress: (f) => { progress.textContent = `Reading ${file.name}, ${Math.round(f * 100)}%`; },
            });
            const terms = extractTerms(doc, { language: storage.getSettings().language });
            await storage.saveDocument({
              courseId: list.id, name: doc.name, kind: doc.kind, pages: doc.pages, text: doc.text, emphasis: doc.emphasis, terms,
            });
          } catch (err) {
            alert.show(`${file.name}: ${errorMessage(err)}`);
          }
        }
        progress.textContent = "";
        refresh();
      },
    });

    // Switching a term off marks it in every document of the course, so it stays off when documents change.
    async function setTermOff(term, off) {
      const key = term.toLowerCase();
      for (const d of await storage.listDocuments(list.id)) {
        let touched = false;
        for (const t of d.terms || []) {
          if (String(t.term).toLowerCase() === key && !!t.off !== off) { t.off = off; touched = true; }
        }
        if (touched) await storage.saveDocument(d);
      }
      refresh();
    }

    async function refresh() {
      let docs = [];
      try { docs = await storage.listDocuments(list.id); } catch (err) { alert.show(`Could not read the documents. ${errorMessage(err)}`); }
      docsBox.replaceChildren(...(docs.length
        ? docs.map((d) => h("div", { class: "doc-row" },
          h("span", { class: "doc-name", text: d.name }),
          h("span", { class: "muted small", text: `${d.kind === "pdf" ? `${plural(d.pages, "page", "pages")}, ` : ""}${plural((d.terms || []).filter((t) => !t.off).length, "term", "terms")}` }),
          pill("Remove", {
            cls: "small",
            async onclick() {
              if (!window.confirm(`Remove "${d.name}" from this course?`)) return;
              try { await storage.deleteDocument(d.id); } catch (err) { alert.show(errorMessage(err)); }
              refresh();
            },
          })))
        : [h("p", { class: "muted small", text: "No documents yet. Add literature summaries or slides as PDF so their key terms help the transcription." })]));

      termsBox.replaceChildren();
      if (!docs.length) return;
      const merged = mergeTerms(docs, { limit: CHECK_TERM_LIMIT });
      const listTerms = new Set((list.terms || []).map((t) => String(t).toLowerCase()));
      const free = Math.max(0, DEEPGRAM_TERM_LIMIT - listTerms.size);
      let sent = 0;
      const chips = merged.map((t) => {
        const toDeepgram = !listTerms.has(t.term.toLowerCase()) && sent < free;
        if (toDeepgram) sent++;
        return h("button", {
          type: "button",
          class: `term-chip${toDeepgram ? " sent" : ""}`,
          title: "Remove this term",
          "aria-label": `Remove term ${t.term}`,
          onclick: () => setTermOff(t.term, true),
        }, h("span", { text: t.term }), h("span", { class: "term-x", "aria-hidden": "true", text: "×" }));
      });
      const offCount = new Set(docs.flatMap((d) => (d.terms || []).filter((t) => t.off).map((t) => String(t.term).toLowerCase()))).size;
      termsBox.append(
        h("p", { class: "small", text: `Terms from the documents, best first. The ${sent} highlighted ones also go to Deepgram, after your own ${plural(listTerms.size, "term", "terms")} (about ${DEEPGRAM_TERM_LIMIT} in total). All of them are used by "Check course terms" and "Correct with Claude". Tap a term to remove it.` }),
        h("div", { class: "term-chips" }, chips));
      if (offCount) {
        termsBox.append(pill(`Restore ${plural(offCount, "removed term", "removed terms")}`, {
          cls: "small",
          async onclick() {
            for (const d of await storage.listDocuments(list.id)) {
              if ((d.terms || []).some((t) => t.off)) {
                for (const t of d.terms) delete t.off;
                await storage.saveDocument(d);
              }
            }
            refresh();
          },
        }));
      }
    }

    refresh();
    return h("div", { class: "field doc-section" },
      h("label", { text: "Course documents" }),
      docsBox,
      h("div", { class: "btn-row" }, pill("Add document", { iconName: "upload", onclick: () => fileInput.click() }), progress, fileInput),
      termsBox);
  }

  /* Audio storage card ------------------------------------------------- */

  async function forgetAudio(id) {
    await media.deleteAudio(id);
    try {
      const t = await storage.getTranscript(id);
      if (t && t.audioId) {
        delete t.audioId;
        await storage.saveTranscript(t);
      }
    } catch { /* transcript may not exist any more */ }
  }

  async function renderAudio(host, alert) {
    let audio = [];
    let transcripts = [];
    let estimate = null;
    try {
      [audio, transcripts, estimate] = await Promise.all([
        media.listAudio(), storage.listTranscripts(), media.storageEstimate(),
      ]);
    } catch (err) {
      if (alive) host.replaceChildren(h("p", { class: "muted", text: `Could not read the audio storage. ${errorMessage(err)}` }));
      return;
    }
    if (!alive) return;
    const titles = new Map(transcripts.map((t) => [t.id, t]));
    const total = audio.reduce((n, a) => n + (a.size || 0), 0);
    const lines = [h("p", {}, h("strong", { text: fmt.formatBytes(total) }), ` of audio in ${plural(audio.length, "recording", "recordings")}.`)];
    if (estimate && estimate.quota) {
      lines.push(h("p", { class: "hint", text: `Browser storage used: ${fmt.formatBytes(estimate.usage)} of about ${fmt.formatBytes(estimate.quota)} available.` }));
    }
    if (!audio.length) {
      host.replaceChildren(...lines, h("p", { class: "muted", text: "No audio is stored." }));
      return;
    }

    const list = h("ul", { class: "audio-list" });
    for (const a of audio.sort((x, y) => (x.savedAt < y.savedAt ? 1 : -1))) {
      const tr = titles.get(a.id);
      list.append(h("li", { class: "audio-row" },
        h("div", { class: "audio-meta" },
          h("span", { class: "audio-title", text: tr ? tr.title || "Untitled" : a.name || "Audio without transcript" }),
          h("span", { class: "muted small", text: `${fmt.formatBytes(a.size)} · ${formatDate(a.savedAt)}${tr ? ` · ${languageLabel(tr.language)}` : ""}` })),
        pill("Delete audio", {
          cls: "small",
          async onclick() {
            if (!window.confirm("Delete the audio of this transcript? The transcript text stays.")) return;
            try { await forgetAudio(a.id); } catch (err) { alert.show(errorMessage(err)); }
            host.replaceChildren(h("p", { class: "muted", text: "Loading" }));
            renderAudio(host, alert);
          },
        })));
    }
    host.replaceChildren(...lines, list,
      h("div", { class: "btn-row" },
        pill("Delete all audio", {
          danger: true,
          async onclick() {
            if (!window.confirm(`Delete all stored audio (${fmt.formatBytes(total)})? The transcripts stay.`)) return;
            try {
              for (const a of audio) await forgetAudio(a.id);
            } catch (err) {
              alert.show(errorMessage(err));
            }
            host.replaceChildren(h("p", { class: "muted", text: "Loading" }));
            renderAudio(host, alert);
          },
        })));
  }

  render();
  return { el, destroy() { alive = false; } };
}
