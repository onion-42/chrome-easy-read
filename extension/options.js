// Options page: reading-aloud settings, saved as you type.
import { loadReaderOptions, saveReaderOptions, READER_DEFAULTS, RATES } from "./reader-options.js";

const SAVE_DELAY_MS = 300;
const form = document.getElementById("options");

const rateOut = document.getElementById("rate-value");
form.rate.max = String(RATES.length - 1);
function showRate() {
  const label = `${RATES[+form.rate.value]}×`;
  rateOut.textContent = label;
  form.rate.setAttribute("aria-valuetext", label);
}
form.rate.addEventListener("input", showRate);
const statusEl = document.getElementById("status");
let timer = 0;

function say(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = text ? (isError ? "bad" : "ok") : "";
}

function fill(o) {
  form.engine.value = o.engine;
  form.apiKey.value = o.apiKey;
  form.model.value = o.model;
  form.voice.value = o.voice;
  form.style.value = o.style;
  form.rate.value = String(RATES.includes(o.rate) ? RATES.indexOf(o.rate) : RATES.indexOf(1));
  showRate();
  form.readCitations.checked = o.readCitations;
  form.builtinOnly.value = o.builtinOnly;
}

function read() {
  return {
    engine: form.engine.value === "builtin" ? "builtin" : "gemini",
    apiKey: form.apiKey.value.trim(),
    model: form.model.value,
    voice: form.voice.value.trim() || READER_DEFAULTS.voice,
    style: form.style.value.trim(),
    rate: RATES[+form.rate.value],
    readCitations: form.readCitations.checked,
    builtinOnly: form.builtinOnly.value,
  };
}

async function save() {
  clearTimeout(timer);
  try {
    await saveReaderOptions(read());
    say("Saved");
  } catch (e) {
    say(`Not saved: ${e.message}`, true);
  }
}

form.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(save, SAVE_DELAY_MS);
});

document.getElementById("show-key").addEventListener("click", (e) => {
  const showing = form.apiKey.type === "text";
  form.apiKey.type = showing ? "password" : "text";
  e.currentTarget.textContent = showing ? "Show" : "Hide";
  e.currentTarget.setAttribute("aria-pressed", String(!showing));
});

document.getElementById("test").addEventListener("click", async () => {
  await save();
  say("Speaking…");
  try {
    const r = await chrome.runtime.sendMessage({ type: "test-voice" });
    say(r.ok ? "Did you hear it? Then the voice works." : r.message, !r.ok);
  } catch (e) {
    say(`Test failed: ${e.message}`, true);
  }
});

fill(await loadReaderOptions());
