// Loudness overview of the recording: a thin line chart with the playback position, click or drag to seek.
import { computePeaks } from "../player.js";
import { h } from "./dom.js";

const HEIGHT = 96;

export function createOverview({ player }) {
  const canvas = h("canvas", { class: "ov-canvas", "aria-hidden": "true" });
  const played = h("div", { class: "ov-played" });
  const marker = h("div", { class: "ov-marker" });
  const el = h("div", {
    class: "overview",
    hidden: true,
    role: "slider",
    tabindex: "0",
    "aria-label": "Recording overview, drag to seek",
  }, canvas, played, marker);

  let peaks = null;
  let token = 0;
  let dragging = false;

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function draw() {
    if (!peaks) return;
    const w = el.clientWidth;
    if (!w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);
    const base = HEIGHT - 6;
    const top = 10;
    const n = peaks.length;
    const yAt = (x) => {
      const i0 = Math.floor((x / w) * n);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
      let sum = 0;
      let count = 0;
      for (let i = i0; i < i1 && i < n; i++) { sum += peaks[i]; count++; }
      const a = count ? sum / count : 0;
      return base - Math.sqrt(a) * (base - top);
    };
    const line = cssVar("--muted", "#7a776f");
    ctx.beginPath();
    ctx.moveTo(0, base);
    for (let x = 0; x <= w; x += 2) ctx.lineTo(x, yAt(Math.min(x, w - 1)));
    ctx.lineTo(w, base);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = line;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = yAt(Math.min(x, w - 1));
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  function showTime(sec) {
    const d = player.duration;
    const f = d ? Math.max(0, Math.min(1, sec / d)) : 0;
    played.style.width = `${f * 100}%`;
    marker.style.left = `${f * 100}%`;
    el.setAttribute("aria-valuenow", String(Math.round(sec)));
  }

  function seekFromEvent(e) {
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
    const d = player.duration;
    if (d) player.seek(f * d);
    showTime(f * d);
  }

  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    seekFromEvent(e);
  });
  el.addEventListener("pointermove", (e) => { if (dragging) seekFromEvent(e); });
  el.addEventListener("pointerup", () => { dragging = false; });
  el.addEventListener("pointercancel", () => { dragging = false; });
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { player.seek(player.currentTime - 5); e.preventDefault(); }
    else if (e.key === "ArrowRight") { player.seek(player.currentTime + 5); e.preventDefault(); }
  });

  const off = [player.on("time", showTime)];
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => draw());
    ro.observe(el);
  }
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const onScheme = () => draw();
  if (mq && mq.addEventListener) mq.addEventListener("change", onScheme);

  return {
    el,
    /** Compute the overview for this audio. Hides itself when it cannot be computed. */
    async setBlob(blob) {
      const mine = ++token;
      peaks = null;
      if (!blob) { el.hidden = true; return; }
      try {
        const result = await computePeaks(blob, 600);
        if (mine !== token) return;
        peaks = result;
        el.hidden = false;
        draw();
        showTime(player.currentTime);
      } catch {
        if (mine === token) el.hidden = true;
      }
    },
    redraw: draw,
    destroy() {
      token++;
      for (const f of off) f();
      if (ro) ro.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener("change", onScheme);
    },
  };
}
