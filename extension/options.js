// Options page: reading-aloud settings, saved as you type.
import { loadReaderOptions, saveReaderOptions, READER_DEFAULTS, RATES } from "./reader-options.js";

const SAVE_DELAY_MS = 300;
const ENGINES = ["local", "builtin"];
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
  form.engine.value = ENGINES.includes(o.engine) ? o.engine : READER_DEFAULTS.engine; // a stored "gemini" voice is gone
  form.localUrl.value = o.localUrl;
  form.localVoiceEn.value = o.localVoiceEn;
  form.localVoiceRu.value = o.localVoiceRu;
  form.apiKey.value = o.apiKey;
  form.rate.value = String(RATES.includes(o.rate) ? RATES.indexOf(o.rate) : RATES.indexOf(1));
  showRate();
  form.claudeKey.value = o.claudeKey;
  form.claudeModel.value = o.claudeModel;
  form.deepseekKey.value = o.deepseekKey;
  form.deepseekUrl.value = o.deepseekUrl;
  form.deepseekModel.value = o.deepseekModel;
  form.translateTo.value = o.translateTo;
  form.readCitations.checked = o.readCitations;
  form.builtinOnly.value = o.builtinOnly;
}

function read() {
  return {
    engine: ENGINES.includes(form.engine.value) ? form.engine.value : READER_DEFAULTS.engine,
    localUrl: form.localUrl.value.trim() || READER_DEFAULTS.localUrl,
    localVoiceEn: form.localVoiceEn.value.trim() || READER_DEFAULTS.localVoiceEn,
    localVoiceRu: form.localVoiceRu.value.trim() || READER_DEFAULTS.localVoiceRu,
    apiKey: form.apiKey.value.trim(),
    rate: RATES[+form.rate.value],
    claudeKey: form.claudeKey.value.trim(),
    claudeModel: form.claudeModel.value,
    deepseekKey: form.deepseekKey.value.trim(),
    deepseekUrl: form.deepseekUrl.value.trim() || READER_DEFAULTS.deepseekUrl,
    deepseekModel: form.deepseekModel.value.trim() || READER_DEFAULTS.deepseekModel,
    translateTo: form.translateTo.value.trim() || READER_DEFAULTS.translateTo,
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
