// Hidden extension page that plays Gemini audio: no page CSP, speed changes keep the pitch.
import { pcmToWav, base64ToBytes } from "./wav.js";

const audio = new Audio();
audio.preservesPitch = true;
let current = null; // { id, tabId, url, started }

function send(event, extra = {}) {
  if (!current) return;
  chrome.runtime.sendMessage({ type: "audio-event", id: current.id, tabId: current.tabId, event, ...extra })
    .catch((e) => console.warn("easy-read: audio event not delivered", e));
}

function stop() {
  audio.pause();
  if (current) URL.revokeObjectURL(current.url);
  current = null;
  audio.removeAttribute("src");
}

function play({ id, tabId, data, sampleRate, rate, startMs = 0 }) {
  stop();
  const wav = pcmToWav(base64ToBytes(data), sampleRate);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const mine = { id, tabId, url, started: false };
  current = mine;
  audio.src = url;
  audio.defaultPlaybackRate = rate; // a new src resets playbackRate to this
  audio.playbackRate = rate;
  // seek once the length is known: after a pause the sentence continues at the paused word
  audio.addEventListener("loadedmetadata", () => {
    if (current !== mine) return; // a newer sentence replaced this one
    audio.currentTime = Math.min(startMs / 1000, audio.duration);
    audio.play().catch((e) => send("error", { message: `Audio playback failed: ${e.message}` }));
  }, { once: true });
}

audio.addEventListener("playing", () => {
  if (!current || current.started) return; // "playing" also fires after a resume
  current.started = true;
  send("start", { durationMs: audio.duration * 1000 });
});
audio.addEventListener("ended", () => send("end"));
audio.addEventListener("error", () => send("error", { message: "The audio could not be played." }));

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target !== "offscreen") return false;
  if (msg.type === "play") play(msg);
  else if (msg.type === "stop") stop();
  respond({ ok: true }); // answer, so the sender's promise never rejects with "port closed"
  return false;
});
