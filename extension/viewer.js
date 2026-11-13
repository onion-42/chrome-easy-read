// easy-read PDF viewer: the PDF's text as calm HTML (easy-read + reading aloud), the real page on demand,
// and an optional clean-up (DeepSeek for the text, Gemini for scans). Opened as viewer.html?file=<url>, or with "Open a PDF…" / drag and drop.
import * as pdfjs from "./vendor/pdfjs/build/pdf.min.mjs";
import { pageToItems, reflow, drawScale } from "./pdf-text.js";
import { cleanPdf, cleanText, blocksToText, markdownToBlocks } from "./pdf-clean.js";
import { loadReaderOptions } from "./reader-options.js";
import { siteKey, matchesDomain, parseDomains } from "./site.js";
import { prepareHost } from "./host.js";
import { getVault, permission, keepPdf, openPdf as openVaultPdf } from "./vault-pdf.js";

const PROFILE_KEY = "settings";
const SAVE_DELAY_MS = 400;
const PAGE_SCRIPTS = ["easy-read.js", "text.js", "reader.js", "notes.js", "assist-ui.js"];
const ID_TEXT = 4000;      // characters of the first page searched for a DOI
const CACHE_KEY = "pdfClean";
const CACHE_SIZE = 10;     // cleaned PDFs kept, so reopening one costs nothing
const MIN_TEXT = 40;       // fewer characters than this in the whole PDF: it is a scan
const LANG_SAMPLE = 3000;  // characters used to guess the language

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/build/pdf.worker.min.mjs");
const DOC_OPTIONS = {
  cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"),
  cMapPacked: true,
  standardFontDataUrl: chrome.runtime.getURL("vendor/pdfjs/standard_fonts/"),
  wasmUrl: chrome.runtime.getURL("vendor/pdfjs/wasm/"),
  isEvalSupported: false,
};

const $ = (id) => document.getElementById(id);
const article = $("text");
const cleanBtn = $("clean");
// task: the pdf.js loading task (it owns the document); source: { url, name }; hash: SHA-256 of the bytes
const state = { task: null, doc: null, bytes: null, hash: null, source: null, local: [], showing: "local" };

// the tests swap these for fakes; everything else calls them through here
window.easyReadViewer = {
  clean: (text, opts) => cleanText(text, opts),          // DeepSeek: the text read from the PDF
  readScan: (bytes, apiKey) => cleanPdf(bytes, apiKey),  // Gemini: the PDF file itself
};

// for notes.js: what is open (so Zotero can recognise the paper), and "keep this file in the vault"
window.__erDoc = () => ({
  url: state.source?.url || "",
  title: state.source?.name || "",
  hash: state.hash,
  text: state.local.map((b) => b.text || "").join("\n").slice(0, ID_TEXT),
  meta: {},
  isPdf: true,
});
window.__erPdf = { save: (slug, interactive) => keepPdf(slug, state.bytes, { interactive }) };

function setState(s) { document.body.dataset.state = s; }
function status(text) { $("status").textContent = text; }
function el(tag, text) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  return e;
}

/* ---------- easy-read + the reader, with the same profile as on websites ---------- */

function addScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} did not load`));
    document.body.append(s);
  });
}

async function loadEasyRead() {
  const profile = (await chrome.storage.sync.get(PROFILE_KEY))[PROFILE_KEY] ?? {};
  prepareHost(profile, chrome.runtime.getURL("fonts/"), PROFILE_KEY, SAVE_DELAY_MS);
  window.__erTabId = (await chrome.tabs.getCurrent())?.id; // the reader only takes messages for this tab
  document.addEventListener("contextmenu", (e) => { window.__erContextTarget = e.target; }, true);
  for (const src of PAGE_SCRIPTS) await addScript(src);
}

/* new text: switching easy-read off and on stops reading aloud and re-applies bold starts and size to it */
function show(blocks) {
  window.__easyRead?.setEnabled(false);
  render(blocks);
  window.__easyRead?.setEnabled(true);
}

/* ---------- rendering (text only: every string goes in through textContent) ---------- */

function render(blocks) {
  article.textContent = "";
  let list = null;
  for (const b of blocks) {
    if (b.kind !== "li") list = null;
    if (b.kind === "page") article.append(pageMarker(b.page));
    else if (b.kind === "h") article.append(el(`h${Math.min(4, (b.level ?? 1) + 1)}`, b.text));
    else if (b.kind === "li") {
      if (!list) article.append((list = el("ul")));
      list.append(el("li", b.text));
    } else article.append(el("p", b.text));
  }
}

function pageMarker(n) {
  const marker = el("div");
  marker.className = "er-page";
  marker.dataset.page = String(n);
  const button = el("button", "Show page");
  button.type = "button";
  button.setAttribute("aria-label", `Show page ${n}`);
  button.setAttribute("aria-expanded", "false");
  const figure = el("figure");
  figure.hidden = true;
  button.addEventListener("click", () => togglePage(n, button, figure));
  marker.append(el("span", `Page ${n}`), button);
  if (state.source?.url) {
    const original = el("a", "Original ↗");
    original.href = `${state.source.url}#page=${n}`;
    original.target = "_blank";
    original.rel = "noreferrer";
    marker.append(original);
  }
  const frag = document.createDocumentFragment();
  frag.append(marker, figure);
  return frag;
}

async function drawPage(n, cssWidth) {
  const page = await state.doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: drawScale(base.width, base.height, cssWidth, window.devicePixelRatio || 1) });
  const canvas = el("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Page ${n} of the PDF`);
  await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

async function togglePage(n, button, figure) {
  const opening = figure.hidden;
  figure.hidden = !opening;
  button.textContent = opening ? "Hide page" : "Show page";
  button.setAttribute("aria-label", `${opening ? "Hide" : "Show"} page ${n}`);
  button.setAttribute("aria-expanded", String(opening));
  if (!opening || figure.firstChild || !state.doc || n > state.doc.numPages) return;
  try {
    figure.append(await drawPage(n, figure.clientWidth));
  } catch (e) {
    console.error(`easy-read viewer: page ${n} could not be drawn`, e);
    figure.append(el("span", `Page ${n} could not be drawn: ${e.message}`));
  }
}

/* ---------- loading ---------- */

const textLength = (blocks) => blocks.reduce((n, b) => n + (b.text?.length ?? 0), 0);

async function setLanguage() {
  const sample = article.textContent.slice(0, LANG_SAMPLE);
  const { isReliable, languages } = await chrome.i18n.detectLanguage(sample);
  if (isReliable && languages.length) article.lang = languages[0].language;
  else article.removeAttribute("lang");
}

function showSource() {
  const { url, name } = state.source;
  $("title").textContent = name;
  document.title = `${name} · easy-read`;
  const original = $("original");
  original.hidden = !url;
  if (url) original.href = url;
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* the new PDF is read completely first; only then it replaces the open one (a broken file changes nothing) */
async function openPdf(bytes, source) {
  setState("loading");
  let task = null;
  try {
    task = pdfjs.getDocument({ ...DOC_OPTIONS, data: bytes.slice() }); // pdf.js takes over its copy of the bytes
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      status(`Reading page ${n} of ${doc.numPages}…`);
      pages.push(await pageToItems(await doc.getPage(n)));
    }
    const title = (await doc.getMetadata().catch(() => null))?.info?.Title?.trim();
    const previous = state.task;
    const hash = await sha256(bytes);
    cleanBtn.disabled = true; // until updateCleanButton() below has checked the new document
    Object.assign(state, { task, doc, bytes, hash, local: reflow(pages), showing: "local",
      source: { ...source, name: title || source.name } });
    previous?.destroy().catch((e) => console.warn("easy-read viewer: closing the previous PDF failed", e));
    showSource();
    show(state.local);
    await setLanguage();
    await announceDoc();
    status(isScan(state.local) ? "This PDF has no text layer (it is a scan). “Read this scan with Gemini” can read it." : "");
    setState("ready");
  } catch (e) {
    console.error("easy-read viewer: PDF could not be opened", e);
    task?.destroy().catch(() => {}); // the failed load; its own error is already reported above
    status(`This PDF could not be opened: ${e.message}`);
    setState(state.doc ? "ready" : "error"); // the PDF that was open stays usable
  }
  await updateCleanButton();
}

async function openUrl(url) {
  setState("loading");
  status("Downloading the PDF…");
  let res;
  try {
    res = await fetch(url, { credentials: "include" }); // PDFs behind a login need the site's cookies
  } catch (e) {
    console.error("easy-read viewer: download failed", e);
    status(url.startsWith("file:")
      ? "Chrome blocked this local file. Turn on “Allow access to file URLs” for easy-read in chrome://extensions, or use “Open a PDF…”."
      : `The PDF could not be downloaded: ${e.message}`);
    setState("error");
    return;
  }
  if (!res.ok) {
    status(`The PDF could not be downloaded (HTTP ${res.status}).`);
    setState("error");
    return;
  }
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "PDF");
  await openPdf(new Uint8Array(await res.arrayBuffer()), { url, name });
}

/* a PDF kept in the vault (0_media/papers/…), opened from the reading list */
async function openFromVault(path) {
  setState("loading");
  const dir = await getVault();
  if (!dir) {
    status("Папка vault не выбрана. Выбери её в настройках easy-read.");
    setState("error");
    return;
  }
  if ((await permission(dir)) !== "granted") {
    status("Нужен доступ к папке vault: нажми в любом месте страницы.");
    setState("error");
    document.addEventListener("click", async () => {
      if ((await permission(dir, true)) === "granted") await openFromVault(path);
    }, { once: true });
    return;
  }
  const file = await openVaultPdf(dir, path);
  if (!file) {
    status(`В vault нет файла ${path}.`);
    setState("error");
    return;
  }
  await openFile(file);
}

/* notes.js reloads its state for the new document; a PDF opened for a known paper is tied to it first */
async function announceDoc() {
  const key = new URLSearchParams(location.search).get("attach");
  if (key) {
    const res = await chrome.runtime.sendMessage({ type: "zotero", op: "attach", key, doc: window.__erDoc() });
    if (!res?.ok) console.warn("easy-read viewer: could not tie the PDF to its paper", res?.message);
  }
  window.dispatchEvent(new Event("er-doc"));
}

async function openFile(file) {
  if (!file) return;
  await openPdf(new Uint8Array(await file.arrayBuffer()), { url: null, name: file.name });
}

/* ---------- clean-up: DeepSeek for a PDF with text, Gemini for a scan ---------- */

const LOCAL_ONLY = "assist-local-only"; // the notes panel's "do not send this document to Claude and DeepSeek"
const isScan = (local) => textLength(local) < MIN_TEXT;

/** Why this document must not be sent for clean-up, or "" when it may. doc: { hash, local, source }. */
async function whyNotSent(doc) {
  const host = doc.source?.url ? siteKey(doc.source.url) : null;
  if (host && matchesDomain(host, parseDomains((await loadReaderOptions()).builtinOnly))) {
    return "Off for this site: it is on the private sites list in options.";
  }
  const keptLocal = !isScan(doc.local) && Boolean(((await chrome.storage.local.get(LOCAL_ONLY))[LOCAL_ONLY] ?? {})[doc.hash]);
  return keptLocal ? "Off for this document: “do not send to Claude and DeepSeek” is ticked in the notes panel." : "";
}

async function readCache(key) {
  const list = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? [];
  return list.find((c) => c.key === key)?.md ?? null;
}

async function writeCache(key, md) {
  const list = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? [];
  const next = [{ key, md }, ...list.filter((c) => c.key !== key)].slice(0, CACHE_SIZE);
  await chrome.storage.local.set({ [CACHE_KEY]: next });
}

async function updateCleanButton() {
  if (state.showing === "cleaned") {
    cleanBtn.textContent = "Show local text";
    cleanBtn.disabled = false;
    cleanBtn.title = "Back to the text read from the PDF on this computer.";
    return;
  }
  const doc = state.doc;
  const scan = isScan(state.local);
  const why = state.bytes ? await whyNotSent(state) : "";
  if (state.doc !== doc || state.showing === "cleaned") return; // changed while the settings were read: a newer call sets the button
  cleanBtn.textContent = scan ? "Read this scan with Gemini" : "Clean up with DeepSeek";
  cleanBtn.disabled = !state.bytes || Boolean(why);
  cleanBtn.title = why
    || (scan ? "Sends this PDF to Google’s Gemini, which reads the scanned pages (costs a few cents; kept for next time)."
      : "Sends the text of this PDF to DeepSeek and shows its cleaned-up version (costs a few cents; kept for next time).");
}

async function cleanUp() {
  if (state.showing === "cleaned") {
    state.showing = "local";
    show(state.local);
    await updateCleanButton();
    return;
  }
  // one document from the click to the answer: another PDF may be opened at any await below, and neither its
  // text nor its cache entry may get mixed up with this one. The cache key is the hash of the file's content.
  const { doc, hash, local, bytes, source } = state;
  if (!bytes) return;
  let md = await readCache(hash);
  if (!md) {
    cleanBtn.disabled = true;
    const scan = isScan(local);
    try {
      const opts = await loadReaderOptions();
      const why = await whyNotSent({ hash, local, source }); // checked again here: the button may be out of date
      if (state.doc !== doc) return;
      if (why) {
        status(why);
        await updateCleanButton();
        return;
      }
      status(scan ? "Gemini is reading the scan. This can take a minute…" : "DeepSeek is cleaning the text. This can take a minute…");
      md = scan ? await window.easyReadViewer.readScan(bytes, opts.apiKey)
        : await window.easyReadViewer.clean(blocksToText(local), opts);
      await writeCache(hash, md);
    } catch (e) {
      console.warn("easy-read viewer: clean-up failed", e);
      if (state.doc !== doc) return;
      status(e.message);
      await updateCleanButton();
      return;
    }
  }
  if (state.doc !== doc) return; // the answer belongs to a PDF that is no longer open: keep it in the cache only
  state.showing = "cleaned";
  show(markdownToBlocks(md));
  await setLanguage();
  status("");
  await updateCleanButton();
}

/* ---------- wiring ---------- */

cleanBtn.addEventListener("click", () => cleanUp());
chrome.storage.onChanged.addListener((changes, area) => { // the "do not send" box was ticked or cleared in the notes panel
  if (area === "local" && changes[LOCAL_ONLY]) updateCleanButton().catch((e) => console.warn("easy-read viewer: clean button not updated", e));
});
$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => openFile(e.target.files[0]));
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("drag"); });
document.addEventListener("dragleave", () => document.body.classList.remove("drag"));
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drag");
  openFile([...e.dataTransfer.files].find((f) => f.type === "application/pdf"));
});

await loadEasyRead();
const params = new URLSearchParams(location.search);
if (params.get("file")) await openUrl(params.get("file"));
else if (params.get("vault")) await openFromVault(params.get("vault"));
else {
  $("title").textContent = "Open a PDF";
  article.append(el("p", "Choose a PDF with “Open a PDF…” above, or drag one onto this page."));
  article.firstChild.className = "empty";
  setState("empty");
}
