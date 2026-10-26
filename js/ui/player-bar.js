// Bottom audio player: time, previous or next segment, play and pause, speed.
import * as storage from "../storage.js";
import { h, icon, iconBtn, clock } from "./dom.js";
import { segmentAt } from "./segments.js";

const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];

/** getStarts() returns the sorted start times of all segments. */
export function createPlayerBar({ player, getStarts, getTotal }) {
  const cur = h("span", { class: "pb-cur", text: "0:00" });
  const total = h("span", { class: "pb-total", text: "0:00" });
  const seek = h("input", {
    type: "range",
    class: "pb-seek",
    min: "0",
    max: "1",
    step: "0.1",
    value: "0",
    "aria-label": "Seek",
  });
  const playIcon = h("span", { class: "pb-play-icon" }, icon("play", 22));
  const playBtn = h("button", { type: "button", class: "pb-play", "aria-label": "Play", onclick: () => player.toggle() }, playIcon);
  const prevBtn = iconBtn("prev", "Previous segment", () => step(-1), "ghost");
  const nextBtn = iconBtn("next", "Next segment", () => step(1), "ghost");
  const rateBtn = h("button", { type: "button", class: "pb-rate", "aria-label": "Playback speed", onclick: () => cycleRate() });

  const el = h("div", { class: "player-bar", role: "region", "aria-label": "Audio player" },
    seek,
    h("div", { class: "pb-row" },
      h("div", { class: "pb-time" }, cur, h("span", { class: "pb-sep", text: "/" }), total),
      h("div", { class: "pb-controls" }, prevBtn, playBtn, nextBtn),
      h("div", { class: "pb-right" }, rateBtn)));

  let dragging = false;

  function duration() {
    return player.duration || (getTotal ? getTotal() : 0) || 0;
  }

  function showRate() {
    rateBtn.textContent = `${player.rate}x`;
  }

  function showTotal() {
    const d = duration();
    total.textContent = clock(d);
    seek.max = String(d || 1);
  }

  function showTime(sec) {
    cur.textContent = clock(sec);
    if (!dragging) seek.value = String(sec);
  }

  function showState(playing) {
    playIcon.replaceChildren(icon(playing ? "pause" : "play", 22));
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function step(dir) {
    const starts = getStarts();
    if (!starts.length) return;
    const now = player.currentTime;
    const i = segmentAt(starts, now);
    let target;
    if (dir > 0) target = starts[Math.min(starts.length - 1, i + 1)];
    else if (i >= 0 && now - starts[i] > 2) target = starts[i];
    else target = starts[Math.max(0, i - 1)];
    player.seek(target, { play: player.playing });
  }

  function cycleRate() {
    const i = RATES.indexOf(player.rate);
    const next = RATES[(i + 1) % RATES.length];
    player.setRate(next);
    try { storage.saveSettings({ playbackRate: next }); } catch { /* ignore */ }
    showRate();
  }

  seek.addEventListener("pointerdown", () => { dragging = true; });
  seek.addEventListener("pointerup", () => { dragging = false; });
  seek.addEventListener("pointercancel", () => { dragging = false; });
  seek.addEventListener("input", () => {
    const v = Number(seek.value) || 0;
    cur.textContent = clock(v);
    player.seek(v);
  });

  const off = [
    player.on("time", showTime),
    player.on("state", showState),
    player.on("loaded", showTotal),
  ];

  showTotal();
  showTime(player.currentTime);
  showState(player.playing);
  showRate();

  return {
    el,
    destroy() { for (const f of off) f(); },
  };
}
