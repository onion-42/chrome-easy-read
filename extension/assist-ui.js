/* assist-ui.js: the assistant section of the notes panel. Questions about the paper go to Claude, translation
 * of the selected text goes to DeepSeek (the service worker makes both requests). */
(function () {
  "use strict";
  if (window.__easyReadAssist) return;
  var notes = window.__easyReadNotes, reader = window.__easyReadReader;
  if (!notes || !notes.mount || !reader) { console.error("easy-read assist: inject notes.js first"); return; }

  var doc = document;
  var st = { history: [], gen: 0, busy: false, last: "" };

  function el(tag, attrs, kids) {
    var e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { e.appendChild(k); });
    return e;
  }
  function button(text, label, onClick) {
    var b = el("button", { type: "button", title: label, "aria-label": label, text: text });
    b.addEventListener("click", onClick);
    return b;
  }

  var question = el("textarea", { "aria-label": "Вопрос по статье", placeholder: "Вопрос по статье…", rows: "2" });
  question.style.minHeight = "3.2em";
  var askBtn = button("Спросить Claude", "Задать вопрос по тексту статьи (Ctrl+Enter)", ask);
  var trBtn = button("Перевести выделенное", "Перевести выделенный текст (DeepSeek)", translate);
  var keepBtn = button("В заметку", "Положить последний ответ в поле заметки", function () { if (st.last) notes.fill(st.last); });
  var resetBtn = button("Новый разговор", "Забыть предыдущие вопросы", function () { st.gen++; reset(); }); // gen: an answer still on its way is dropped
  var statusEl = el("div", { class: "er-n-soft", role: "status" }); // not .er-n-msg: that one is the note form's message
  statusEl.style.minHeight = "1.2em";
  var logEl = el("div");

  /* "keep this document local": remembered per document, checked before every request */
  var LOCAL_ONLY = "assist-local-only"; // { [document id]: true } in chrome.storage.local
  var keepLocal = el("input", { type: "checkbox" });
  var keepLocalRow = el("label", { class: "er-n-row er-n-soft" }, [keepLocal, doc.createTextNode("Не отправлять этот документ в Claude и DeepSeek")]);
  function docId() {
    var d = typeof window.__erDoc === "function" ? window.__erDoc() : null;
    return (d && (d.hash || d.url)) || location.href;
  }
  function sync() { askBtn.disabled = trBtn.disabled = st.busy || keepLocal.checked; }
  async function localOnlyMap() { return (await chrome.storage.local.get(LOCAL_ONLY))[LOCAL_ONLY] || {}; }
  async function loadLocalOnly() {
    try {
      keepLocal.checked = !!(await localOnlyMap())[docId()];
    } catch (e) {
      console.warn("easy-read assist: could not read the keep-local setting", e);
    }
    sync();
  }
  keepLocal.addEventListener("change", async function () {
    sync(); // the buttons follow the checkbox at once, before the setting is stored
    try {
      var next = Object.assign({}, await localOnlyMap()), store = {};
      if (keepLocal.checked) next[docId()] = true; else delete next[docId()];
      store[LOCAL_ONLY] = next;
      await chrome.storage.local.set(store);
    } catch (e) {
      console.warn("easy-read assist: could not store the keep-local setting", e);
      say("Не удалось запомнить галочку для этого документа.");
    }
  });

  function costLine(u) {
    var n = function (x) { return x.toLocaleString("ru-RU"); };
    return (u.usd == null ? "" : "≈ $" + u.usd.toFixed(3) + " · ") + n(u.tokens) + " токенов (из кэша " + n(u.cached) + ")";
  }

  function say(text) { statusEl.textContent = text || ""; }
  function line(text, soft) {
    var p = el("p", { text: text, class: soft ? "er-n-soft" : "" });
    p.style.cssText = "margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere";
    logEl.appendChild(p);
    p.scrollIntoView({ block: "nearest" });
  }
  function reset() { st.history = []; st.last = ""; logEl.textContent = ""; keepBtn.hidden = true; say(""); }

  function paperText() {
    return reader.blocks().map(function (b) { return b.textContent; }).join("\n\n");
  }

  /* one request at a time; an answer for a document that is no longer open is dropped */
  async function call(msg, wait) {
    if (st.busy || keepLocal.checked) return null;
    st.busy = true; sync(); say(wait);
    var gen = st.gen;
    try {
      var res = await chrome.runtime.sendMessage(Object.assign({ type: "assist" }, msg));
      if (gen !== st.gen) return null;
      if (!res || !res.ok) throw new Error((res && res.message) || "Нет ответа от расширения.");
      say("");
      return res;
    } catch (e) {
      console.warn("easy-read assist: " + msg.op + " failed", e);
      if (gen === st.gen) say(e.message);
      return null;
    } finally {
      st.busy = false; sync();
    }
  }

  async function ask() {
    var q = question.value.trim();
    if (!q) { say("Напиши вопрос."); return; }
    var res = await call({ op: "ask", paper: paperText(), history: st.history, question: q }, "Claude читает статью…");
    if (!res) return;
    st.history = st.history.concat([{ role: "user", content: q }, res.turn]);
    line("Вопрос: " + q, true); line(res.text); line(costLine(res.usage), true);
    st.last = "Вопрос: " + q + "\n" + res.text; keepBtn.hidden = false;
    question.value = "";
  }

  async function translate() {
    var text = notes.quote();
    if (!text) { say("Выдели текст в статье."); return; }
    var res = await call({ op: "translate", text: text }, "DeepSeek переводит…");
    if (!res) return;
    line("Перевод:", true); line(res.text);
    st.last = res.text; keepBtn.hidden = false;
  }

  question.addEventListener("keydown", function (e) {
    // stop here: the panel's own Ctrl+Enter saves the note
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); ask(); }
  });
  window.addEventListener("er-doc", function () {
    st.gen++; reset();
    keepLocal.checked = true; sync(); // nothing is sent for the new document until its own setting is read
    loadLocalOnly();
  });

  keepBtn.hidden = true;
  loadLocalOnly();
  var body = el("div", {}, [
    keepLocalRow,
    question,
    el("div", { class: "er-n-row" }, [askBtn, trBtn]),
    statusEl, logEl,
    el("div", { class: "er-n-row" }, [keepBtn, resetBtn]),
  ]);
  body.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:8px";
  var summary = el("summary", { class: "er-n-soft", text: "Помощник: вопросы и перевод" });
  summary.style.cursor = "pointer";
  // <details> folds the section away, so the list of notes stays in view; closed until she opens it
  notes.mount(el("details", {}, [summary, body]));
  window.__easyReadAssist = { ask: ask, translate: translate };
})();
