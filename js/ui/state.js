// Tiny shared state and event bus for the UI files.
import { createPlayer } from "../player.js";
import * as storage from "../storage.js";

export const state = {
  running: false,        // a transcription is in progress
  recording: false,      // a recording is in progress (or being finished)
  unsaved: null,         // transcript that could not be written to storage
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, data) {
  for (const fn of [...(listeners.get(event) || [])]) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}

export function isBusy() {
  return state.running || state.recording;
}

export function setBusy(partial) {
  Object.assign(state, partial);
  emit("busy", isBusy());
}

let player = null;

/** One shared player for the whole app. */
export function getPlayer() {
  if (!player) {
    player = createPlayer();
    try { player.setRate(Number(storage.getSettings().playbackRate) || 1); } catch { /* ignore */ }
  }
  return player;
}
