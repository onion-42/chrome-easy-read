// notes-page.js: the notes of one paper in a tab of their own (notes.html?key=<Zotero key>&tab=<article tab>).
// The panel is notes.js itself, loaded the way the PDF viewer loads it; it reads window.__erNotesPage.
import { prepareHost, loadPageScripts } from "./host.js";

const PROFILE_KEY = "settings";
const SAVE_DELAY_MS = 400;
const PAGE_SCRIPTS = ["easy-read.js", "text.js", "reader.js", "notes.js"]; // no assistant: there is no article text here
const params = new URLSearchParams(location.search);
const key = params.get("key");
const sourceTab = Number(params.get("tab")) || null; // the tab with the article, when the page was opened from one
const status = (text) => { document.getElementById("status").textContent = text; };

window.__erDoc = () => ({ key, url: "", title: "", meta: {}, text: "" });
window.__erNotesPage = {
  /** A click on a note with a quote: show it in the article's tab. */
  show: async (noteKey, hasQuote) => {
    if (!hasQuote) {
      status("У этой заметки нет цитаты: показывать в тексте статьи нечего.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "notes-show", tab: sourceTab, key: noteKey });
    status(res?.ok ? "" : res?.message || "Вкладка статьи закрыта.");
  },
};

if (!key) status("Не указана статья. Открой заметки из reading list или из панели заметок.");
else {
  const profile = (await chrome.storage.sync.get(PROFILE_KEY))[PROFILE_KEY] ?? {};
  prepareHost(profile, chrome.runtime.getURL("fonts/"), PROFILE_KEY, SAVE_DELAY_MS);
  window.__erTabId = (await chrome.tabs.getCurrent())?.id;
  await loadPageScripts(PAGE_SCRIPTS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) window.__easyReadNotes.refresh(); // notes taken in the article meanwhile
  });
}
