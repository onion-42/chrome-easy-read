// Service worker: per-site on/off for easy-read, injection, badge, PDFs, and the voice for immersive reading.
import { siteKey, storageKey, tabPatterns, LOCAL_FILES, matchesDomain, parseDomains, looksLikePdfUrl } from "./site.js";
import { loadReaderOptions, saveReaderOptions, RATES } from "./reader-options.js";
import { prepareHost } from "./host.js";
import { synthesize } from "./tts/gemini.js";
import { speakBuiltin, detectLang } from "./tts/builtin.js";
import { zotero } from "./zotero.js";

const PROFILE_KEY = "settings";
const SAVE_DELAY_MS = 400; // sliders fire many events; chrome.storage.sync allows ~120 writes/min
const BADGE = { on: "ON", unavailable: "–", pdf: "PDF" };
const TITLE = "easy-read: on / off for this site (Alt+Shift+E)";
const READ_MENU = "er-read-from-here";
const PDF_MENU = "er-open-pdf";
const NOTE_MENU = "er-add-note";
const SAVE_MENU = "er-save-paper";
const LIST_MENU = "er-reading-list";
const READING_LIST = chrome.runtime.getURL("reading.html");
const PDF_LINKS = ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "*://arxiv.org/pdf/*", "file:///*.pdf"];
const PAGE_SCRIPTS = ["easy-read.js", "text.js", "reader.js", "notes.js"];
const AUDIO_CACHE_SIZE = 24;
const TEST_PHRASE = "Hello! This is your reading voice.";
const VIEWER = chrome.runtime.getURL("viewer.html");

/* ---------- the PDF viewer ---------- */

const isViewer = (url) => typeof url === "string" && url.startsWith(VIEWER);
const viewerFor = (pdfUrl) => `${VIEWER}?file=${encodeURIComponent(pdfUrl)}`;
const sourceOf = (viewerUrl) => new URL(viewerUrl).searchParams.get("file");

async function contentTypeIsPdf(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return /application\/pdf/i.test(res.headers.get("content-type") ?? "");
  } catch (e) {
    console.debug("easy-read: could not check the content type", e);
    return false;
  }
}

/* a PDF shown by Chrome's viewer: by URL, by the document's type, or (page refuses scripts) by the server */
async function isPdfTab(tab) {
  if (looksLikePdfUrl(tab.url)) return true;
  if (!siteKey(tab.url)) return false;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.contentType });
    return result === "application/pdf";
  } catch {
    return contentTypeIsPdf(tab.url);
  }
}

/** Right-click "Open PDF in easy-read": the viewer in a new tab next to this one. */
async function openPdf(url, tab, paperKey = null) {
  const target = viewerFor(url) + (paperKey ? `&attach=${encodeURIComponent(paperKey)}` : "");
  await chrome.tabs.create({ url: target, index: tab ? tab.index + 1 : undefined, openerTabId: tab?.id });
}

/** One reading-list tab: focus it when it is already open. */
async function openReadingList() {
  const [open] = await chrome.tabs.query({ url: READING_LIST });
  if (open) await chrome.tabs.update(open.id, { active: true });
  else await chrome.tabs.create({ url: READING_LIST });
}

/* messages to the reader: content scripts get tabs.sendMessage; the viewer is an extension page, so it gets
 * a runtime message addressed to its tab */
function toTab(tab, msg) {
  return isViewer(tab.url) ? chrome.runtime.sendMessage({ ...msg, toTab: tab.id }) : chrome.tabs.sendMessage(tab.id, msg);
}

/* ---------- easy-read per site ---------- */

async function isSiteOn(host) {
  const key = storageKey(host);
  return (await chrome.storage.sync.get(key))[key] === true;
}

/** Make sure easy-read (+ the reader) runs and is on in a tab -> "ok", or "pdf" for Chrome's PDF viewer.
 * Throws on pages Chrome keeps from extensions. */
async function ensureEasyRead(tabId) {
  const profile = (await chrome.storage.sync.get(PROFILE_KEY))[PROFILE_KEY] ?? {};
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: prepareHost,
    args: [profile, chrome.runtime.getURL("fonts/"), PROFILE_KEY, SAVE_DELAY_MS],
  });
  if (result === "pdf") return "pdf";
  await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_SCRIPTS });
  return "ok";
}

async function switchOff(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__easyRead?.setEnabled(false),
  });
}

/* state: true (on) | false (off) | null (not available) | "pdf" (click opens the viewer) */
async function setBadge(tabId, state) {
  const text = state === true ? BADGE.on : state === null ? BADGE.unavailable : state === "pdf" ? BADGE.pdf : "";
  const title = state === null ? "easy-read: not available on this page"
    : state === "pdf" ? "easy-read: click to open this PDF as easy-read text" : TITLE;
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({ tabId, title });
}

/* local files need Chrome's per-extension "Allow access to file URLs" switch; open the page that has it */
async function askForFileAccess(tabId) {
  await chrome.action.setBadgeText({ tabId, text: BADGE.unavailable });
  await chrome.action.setTitle({ tabId, title: "easy-read: turn on \"Allow access to file URLs\" for local pages" });
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

async function applyToTab(tabId, on) {
  try {
    if (!on) {
      await switchOff(tabId);
      await setBadge(tabId, false);
      return;
    }
    await setBadge(tabId, (await ensureEasyRead(tabId)) === "pdf" ? "pdf" : true);
  } catch (e) {
    console.warn(`easy-read: cannot change tab ${tabId}`, e);
    await setBadge(tabId, null);
  }
}

/** Toolbar click / Alt+Shift+E: a PDF opens in the viewer (and the viewer goes back to the PDF);
 * any other page flips its site and every open tab of that site. */
async function toggleSite(tab) {
  if (isViewer(tab.url)) {
    const source = sourceOf(tab.url);
    if (source) await chrome.tabs.update(tab.id, { url: source });
    return;
  }
  if (await isPdfTab(tab)) {
    await chrome.tabs.update(tab.id, { url: viewerFor(tab.url) });
    return;
  }
  const host = siteKey(tab.url);
  if (!host) {
    await setBadge(tab.id, null);
    return;
  }
  const on = !(await isSiteOn(host));
  const key = storageKey(host);
  await (on ? chrome.storage.sync.set({ [key]: true }) : chrome.storage.sync.remove(key));
  if (host === LOCAL_FILES && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    await askForFileAccess(tab.id);
    return;
  }
  const tabs = await chrome.tabs.query({ url: tabPatterns(host) });
  await Promise.all(tabs.map((t) => applyToTab(t.id, on)));
}

async function onPageLoaded(tabId, url) {
  const host = siteKey(url);
  if (!host) return;
  if (await isSiteOn(host)) await applyToTab(tabId, true);
  else await setBadge(tabId, false);
}

/* ---------- immersive reading ---------- */

/** Start / toggle reading in a tab. easy-read is switched on for this tab (not remembered for the site). */
async function readerCommand(tab, type, fromContext = false) {
  try {
    if (isViewer(tab.url)) {
      await toTab(tab, { type, fromContext });
      return;
    }
    if (!siteKey(tab.url) || (await ensureEasyRead(tab.id)) === "pdf") {
      await setBadge(tab.id, siteKey(tab.url) ? "pdf" : null);
      return;
    }
    await toTab(tab, { type, fromContext });
  } catch (e) {
    console.warn(`easy-read: cannot read aloud in tab ${tab.id}`, e);
    await setBadge(tab.id, null);
  }
}

/* "built-in voice only" is checked against the page's site; for the viewer, the PDF's own site */
function engineFor(opts, tab) {
  const host = siteKey(isViewer(tab.url) ? sourceOf(tab.url) : tab.url);
  const workSite = host && matchesDomain(host, parseDomains(opts.builtinOnly));
  return opts.engine === "gemini" && !workSite ? "gemini" : "builtin";
}

let latestSpeech = null; // id of the newest speak request; late Gemini replies for older ones are dropped
const audioCache = new Map();

function cachedSynth(text, opts) {
  const key = [opts.model, opts.voice, opts.style, text].join("\u0000");
  if (!audioCache.has(key)) {
    const audio = synthesize(text, opts);
    audio.catch(() => audioCache.delete(key)); // failures are reported by the caller, never cached
    audioCache.set(key, audio);
    if (audioCache.size > AUDIO_CACHE_SIZE) audioCache.delete(audioCache.keys().next().value);
  }
  return audioCache.get(key);
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play the reading voice.",
    });
  } catch (e) {
    if (!String(e.message).includes("single offscreen")) throw e; // a parallel call created it
  }
}

async function toOffscreen(type) {
  if (!(await chrome.offscreen.hasDocument())) return;
  await chrome.runtime.sendMessage({ target: "offscreen", type });
}

async function playInOffscreen(id, tabId, { data, sampleRate }, rate, startMs = 0) {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: "offscreen", type: "play", id, tabId, data, sampleRate, rate, startMs });
}

/* each engine: (msg, tab, send) -> speaks msg.text and reports start / word / end / error through send */
const engines = {
  async builtin(msg, tab, send) {
    await toOffscreen("stop");
    const lang = msg.lang || (await detectLang(msg.text));
    if (latestSpeech === msg.id) speakBuiltin(msg.text, { lang, rate: msg.rate }, send);
  },
  async gemini(msg, tab) {
    chrome.tts.stop();
    const audio = cachedSynth(msg.text, msg.opts);
    (msg.next ?? []).forEach((text) => cachedSynth(text, msg.opts)); // prefetch while this one plays
    const result = await audio;
    if (latestSpeech === msg.id) await playInOffscreen(msg.id, tab.id, result, msg.rate, msg.startMs);
  },
};

async function speak(msg, tab) {
  latestSpeech = msg.id;
  const opts = await loadReaderOptions();
  const engine = engineFor(opts, tab);
  // a built-in voice continues from a word by getting the rest of the text; its word positions are
  // shifted back onto the whole sentence. Gemini replays the same audio from msg.startMs instead.
  const from = engine === "builtin" ? msg.startChar || 0 : 0;
  const send = (ev) => {
    const shifted = ev.event === "word" ? { ...ev, charIndex: ev.charIndex + from } : ev;
    return toTab(tab, { type: "tts-event", id: msg.id, ...shifted })
      .catch((e) => console.debug("easy-read: tab gone, speech event dropped", e)); // tab closed or navigated
  };
  try {
    await engines[engine]({ ...msg, text: msg.text.slice(from), opts }, tab, send);
  } catch (e) {
    console.warn("easy-read: speech failed", e);
    send({ event: "error", message: e.message });
  }
}

/* pause = silence now; the reader keeps its place and resumes by speaking from the marked word */
async function control(cmd, value) {
  if (cmd === "pause" || cmd === "stop") {
    latestSpeech = null; // a Gemini reply still on its way will not start playing
    chrome.tts.stop();
    await toOffscreen("stop");
  } else if (cmd === "rate") {
    await saveReaderOptions({ rate: value });
  }
}

/** Options page "Test voice": speak a short phrase with the current settings. */
async function testVoice() {
  const opts = await loadReaderOptions();
  latestSpeech = "test";
  if (opts.engine === "builtin") {
    speakBuiltin(TEST_PHRASE, { lang: "en", rate: opts.rate }, () => {});
    return;
  }
  await playInOffscreen("test", null, await synthesize(TEST_PHRASE, opts), opts.rate);
}

async function relayAudioEvent(msg) {
  const tab = await chrome.tabs.get(msg.tabId);
  await toTab(tab, { ...msg, type: "tts-event" });
}

/* ---------- wiring ---------- */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === "speak") speak(msg, sender.tab);
  else if (msg.type === "control") control(msg.cmd, msg.value).catch((e) => console.warn("easy-read: control failed", e));
  else if (msg.type === "audio-event") {
    if (msg.tabId != null) relayAudioEvent(msg).catch((e) => console.debug("easy-read: tab gone, audio event dropped", e));
  } else if (msg.type === "reader-options") {
    loadReaderOptions().then((o) => respond({ rate: o.rate, readCitations: o.readCitations, rates: RATES }));
    return true;
  } else if (msg.type === "zotero") {
    zotero(msg).then((r) => respond({ ok: true, ...r }), (e) => respond({ ok: false, message: e.message }));
    return true;
  } else if (msg.type === "open-pdf") {
    openPdf(msg.url, sender.tab, msg.key).catch((e) => console.error("easy-read: open PDF failed", e));
  } else if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
  } else if (msg.type === "test-voice") {
    testVoice().then(() => respond({ ok: true }), (e) => respond({ ok: false, message: e.message }));
    return true;
  } else return false;
  respond({ ok: true });
  return false;
});

chrome.action.onClicked.addListener((tab) => {
  toggleSite(tab).catch((e) => console.error("easy-read: toggle failed", e));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "read-aloud") readerCommand(tab, "reader-toggle");
  else if (command === "add-note") readerCommand(tab, "notes-open");
  else if (command === "reading-list") openReadingList().catch((e) => console.error("easy-read: reading list failed", e));
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: READ_MENU, title: "Read aloud from here", contexts: ["page", "selection", "link"] });
  chrome.contextMenus.create({ id: PDF_MENU, title: "Open PDF in easy-read", contexts: ["link"], targetUrlPatterns: PDF_LINKS });
  chrome.contextMenus.create({ id: NOTE_MENU, title: "Заметка к выделению (Zotero)", contexts: ["selection"] });
  chrome.contextMenus.create({ id: SAVE_MENU, title: "Сохранить статью в Zotero", contexts: ["page"] });
  chrome.contextMenus.create({ id: LIST_MENU, title: "Reading list", contexts: ["action"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === READ_MENU) readerCommand(tab, "reader-start", true);
  else if (info.menuItemId === PDF_MENU) openPdf(info.linkUrl, tab).catch((e) => console.error("easy-read: open PDF failed", e));
  else if (info.menuItemId === NOTE_MENU) readerCommand(tab, "notes-open");
  else if (info.menuItemId === SAVE_MENU) readerCommand(tab, "notes-save");
  else if (info.menuItemId === LIST_MENU) openReadingList().catch((e) => console.error("easy-read: reading list failed", e));
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  onPageLoaded(tabId, tab.url).catch((e) => console.error("easy-read: page load handling failed", e));
});

// handy from the service worker console; the E2E tests also swap `engines` for a fake voice
self.easyRead = {
  toggleSite,
  openPdf,
  startReading: (tab, fromContext) => readerCommand(tab, "reader-start", fromContext),
  openNotes: (tab) => readerCommand(tab, "notes-open"),
  engines,
};
