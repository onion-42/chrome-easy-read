/* notes.js: notes on the article being read. A note = quote + comment, stored in Zotero as a child note of
 * the paper (the service worker talks to Zotero). Quotes are highlighted with the CSS Custom Highlight API,
 * so the page's DOM is never changed. Injected after reader.js, in the same isolated world; the PDF viewer
 * loads it too and offers window.__erDoc (what is open) and window.__erPdf (save the file into the vault). */
(function () {
  "use strict";
  if (window.__easyReadNotes && window.__easyReadNotes.open) return; // (a page element with this id is not us)
  var er = window.__easyRead, reader = window.__easyReadReader;
  if (!er || !reader) { console.error("easy-read notes: inject easy-read.js and reader.js first"); return; }

  var doc = document;
  var MAX_QUOTE = 2000;
  var ARTICLE_META = "meta[name=citation_doi], meta[name=citation_pmid], meta[name=citation_title]";
  var st = { paper: null, notes: [], pdfUrl: null, pending: { quote: "", page: null, full: "" }, editing: null, summary: false, ranges: [], busy: false, P: null, vault: "", gen: 0 };
  // st.gen counts documents: the viewer can open another PDF while a request is out, and a late answer
  // for the previous document must never be applied to (or saved as) the new one
  var viewerDoc = typeof window.__erDoc === "function" ? window.__erDoc : null;
  var viewerPdf = window.__erPdf && typeof window.__erPdf.save === "function" ? window.__erPdf : null;

  var css = doc.createElement("style");
  css.textContent = [
    "#er-note{position:fixed;left:124px;bottom:16px;z-index:2147483000;box-shadow:0 4px 14px rgba(0,0,0,.18)}",
    "#er-note[hidden],#er-notes[hidden],#er-notes [hidden]{display:none}",
    "#er-notes{position:fixed;top:12px;right:12px;bottom:12px;width:360px;max-width:calc(100vw - 24px);z-index:2147483001;" +
      "background:var(--er-p);color:var(--er-i);border:1px solid var(--er-b);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.22);" +
      "padding:14px;display:flex;flex-direction:column;gap:10px;overflow:auto;font-size:15px;line-height:1.5}",
    "#er-notes .er-n-head{display:flex;gap:8px;align-items:center;justify-content:space-between;font-weight:700}",
    "#er-notes .er-n-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
    "#er-notes .er-n-soft{color:var(--er-s);font-size:13px}",
    "#er-notes .er-n-quote{border-left:3px solid var(--er-a);padding:2px 0 2px 10px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}",
    "#er-notes textarea{font:inherit;color:inherit;background:var(--er-p);border:1px solid var(--er-b);border-radius:8px;padding:8px;min-height:6.5em;resize:vertical;width:100%;box-sizing:border-box}",
    "#er-notes a{color:var(--er-a)}",
    "#er-notes .er-n-item{border-top:1px solid var(--er-b);padding:8px 0 2px;display:grid;grid-template-columns:1fr auto;gap:4px 8px;cursor:pointer}",
    "#er-notes .er-n-item p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}",
    "#er-notes .er-n-item .er-n-quote{grid-column:1}",
    "#er-notes .er-n-item button{grid-column:2;grid-row:1;align-self:start;min-height:28px;padding:2px 8px}",
    "#er-notes .er-n-msg{min-height:1.2em}",
    "::highlight(er-note){background-color:color-mix(in srgb,#f2c14e 45%,transparent)}"
  ].join("\n");
  doc.head.appendChild(css);

  /* ---------- small helpers ---------- */

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
  function link(text, href) { return el("a", { href: href, target: "_blank", rel: "noreferrer", text: text }); }

  async function shared() {
    if (!st.P) st.P = await import(chrome.runtime.getURL("papers.js"));
    return st.P;
  }

  /* what is open: the viewer says it itself; a web page is described by its meta tags */
  function docInfo() {
    if (viewerDoc) return viewerDoc();
    var meta = {};
    doc.querySelectorAll("meta[name]").forEach(function (m) { meta[m.name.toLowerCase()] = m.content; });
    return { url: location.href, title: doc.title, meta: meta, text: "" };
  }

  function selectionQuote() {
    var sel = getSelection();
    var full = sel && !sel.isCollapsed ? sel.toString().trim() : ""; // the assistant translates all of it
    var quote = full.slice(0, MAX_QUOTE);
    var node = sel && sel.anchorNode;
    var block = node && (node.nodeType === 1 ? node : node.parentElement);
    if (block && block.closest(".er-ui")) return { quote: "", page: null, full: "" }; // our own panel is not the article
    block = block && block.closest("p, li, h2, h3, h4");
    var page = null, e = block;                              // nearest page marker above the block (PDF viewer)
    while (e && page == null) {
      e = e.previousElementSibling || (e.parentElement && e.parentElement.closest("article") ? e.parentElement : null);
      if (e && e.matches && e.matches(".er-page")) page = e.dataset.page;
    }
    return { quote: quote, page: page, full: full };
  }

  async function send(op, extra) {
    var res = await chrome.runtime.sendMessage(Object.assign({ type: "zotero", op: op, doc: docInfo() }, extra || {}));
    if (!res || !res.ok) throw new Error((res && res.message) || "Нет ответа от расширения.");
    return res;
  }

  /* ---------- the panel ---------- */

  var noteBtn = el("button", { id: "er-note", type: "button", class: "er-ui", text: "📝",
    "aria-label": "Заметки к статье (Alt+Shift+N)", title: "Заметки к статье (Alt+Shift+N)" });
  var titleEl = el("span", { text: "Заметки" });
  var statusEl = el("div", { class: "er-n-soft", role: "status" });
  var linksEl = el("div", { class: "er-n-row" });
  var pdfEl = el("div", { class: "er-n-row er-n-soft" });
  var quoteEl = el("blockquote", { class: "er-n-quote", hidden: "" });
  var input = el("textarea", { "aria-label": "Текст заметки", placeholder: "Комментарий к выделенному тексту…" });
  var saveBtn = button("Сохранить (Ctrl+Enter)", "Сохранить заметку в Zotero", save);
  var cancelBtn = button("Отмена", "Не менять заметку", function () { resetForm(); render(); });
  var msgEl = el("div", { class: "er-n-soft er-n-msg", role: "status" });
  var extraEl = el("div"); // assist-ui.js mounts the assistant section here
  var listHead = el("div", { class: "er-n-soft" });
  var listEl = el("div");
  var panel = el("div", { id: "er-notes", class: "er-ui", role: "complementary", "aria-label": "Заметки к статье", hidden: "" }, [
    el("div", { class: "er-n-head" }, [titleEl, button("✕", "Закрыть заметки", close)]),
    statusEl, linksEl, pdfEl, quoteEl, input,
    el("div", { class: "er-n-row" }, [saveBtn, cancelBtn]),
    msgEl, extraEl, listHead, listEl
  ]);

  function say(text) { msgEl.textContent = text || ""; }

  function resetForm() {
    st.editing = null; st.summary = false; st.pending = { quote: "", page: null, full: "" };
    input.value = "";
  }

  function render() {
    var p = st.paper;
    titleEl.textContent = p ? "Заметки · " + p.label : "Заметки";
    statusEl.textContent = p ? "✓ В Zotero" : "Статьи ещё нет в Zotero. Она сохранится вместе с первой заметкой.";
    linksEl.textContent = "";
    if (p) {
      linksEl.appendChild(link("Zotero", "zotero://select/library/items/" + p.key));
      if (p.slug) linksEl.appendChild(link("Obsidian", "obsidian://open?" + (st.vault ? "vault=" + encodeURIComponent(st.vault) + "&" : "") + "file=" + encodeURIComponent(p.slug)));
      linksEl.appendChild(button("Вывод по статье", "Одна общая заметка ко всей статье", startSummary));
    } else {
      linksEl.appendChild(button("Сохранить статью в Zotero", "Сохранить статью в Zotero без заметки", function () { run("save"); }));
      if (viewerPdf && !docInfo().url) linksEl.appendChild(button("Привязать к статье…", "Этот файл — статья из списка чтения", choosePaper));
    }
    quoteEl.hidden = !st.pending.quote || !!st.editing || st.summary;
    quoteEl.textContent = st.pending.quote + (st.pending.page ? "\nстр. " + st.pending.page : "");
    input.placeholder = st.editing ? "Текст заметки (markdown; цитата — строки с «> »)" : st.summary ? "Вывод по всей статье…" : "Комментарий к выделенному тексту…";
    cancelBtn.hidden = !st.editing && !st.summary;
    listHead.textContent = st.notes.length ? "Заметки к статье (" + st.notes.length + ")" : "";
    listEl.textContent = "";
    st.notes.forEach(function (n) { listEl.appendChild(noteItem(n)); });
    renderPdf();
  }

  function noteItem(n) {
    var found = !n.quote || st.ranges.some(function (r) { return r.noteKey === n.key; });
    var body = n.md.split("\n").filter(function (l) { return l.indexOf(">") !== 0; }).join("\n").trim();
    var item = el("div", { class: "er-n-item", "data-key": n.key }, []);
    if (n.quote) item.appendChild(el("p", { class: "er-n-quote", text: n.quote.length > 160 ? n.quote.slice(0, 157) + "…" : n.quote }));
    if (!n.readOnly) item.appendChild(button("✎", "Править заметку", function (e) { e.stopPropagation(); startEdit(n); }));
    item.appendChild(el("p", { text: (n.summary ? "★ Вывод: " : "") + body }));
    if (!found) item.appendChild(el("p", { class: "er-n-soft", text: "цитата не найдена в этом тексте" }));
    item.addEventListener("click", function () { scrollToNote(n.key); });
    return item;
  }

  function startEdit(n) {
    st.editing = { key: n.key, version: n.version }; st.summary = false;
    input.value = n.md;
    say(""); render(); input.focus();
  }

  function startSummary() {
    var old = st.notes.find(function (n) { return n.summary; });
    if (old) { startEdit(old); return; }
    st.summary = true; st.editing = null; input.value = "";
    say(""); render(); input.focus();
  }

  /* one request at a time; the answer of every paper operation carries the fresh state */
  async function run(op, extra) {
    if (st.busy) return false;
    st.busy = true; saveBtn.disabled = true; say("Zotero…");
    var gen = st.gen;
    try {
      var res = await send(op, extra);
      if (gen !== st.gen) return false; // another document was opened meanwhile
      st.vault = res.vault || "";
      if (res.paper !== undefined) { st.paper = res.paper; st.notes = res.notes; st.pdfUrl = res.pdfUrl; }
      say("");
      await paint();
      render();
      keepPdf(false);
      return res;
    } catch (e) {
      console.warn("easy-read notes: " + op + " failed", e);
      say(e.message);
      return false;
    } finally {
      st.busy = false; saveBtn.disabled = false;
    }
  }

  async function save() {
    var text = input.value.trim();
    if (st.editing) {
      if (!text) { say("Пустая заметка. Удалить заметку можно в Zotero."); return; }
      var res = await run("edit", { noteKey: st.editing.key, md: text, version: st.editing.version });
      if (!res) return;
      if (res.conflict) {
        // her text stays in the field; the next save goes on top of the remote version
        st.editing.version = res.remote.version;
        say("Заметка изменилась в Zotero. Версия оттуда:\n" + res.remote.md + "\n\nТвой текст остался в поле. «Сохранить» ещё раз запишет его.");
        msgEl.style.whiteSpace = "pre-wrap";
        return;
      }
      resetForm();
      await run("status");
      return;
    }
    if (!text && !st.pending.quote) { say("Выдели текст в статье или напиши комментарий."); return; }
    var ok = await run("note", { quote: st.pending.quote, page: st.pending.page, comment: text, summary: st.summary });
    if (ok) { resetForm(); render(); }
  }

  /* a local file in the viewer that could not be recognised: tie it to a paper of the reading list */
  async function choosePaper() {
    try {
      var res = await send("list");
      var select = el("select", { "aria-label": "Статья из списка чтения" });
      res.groups.forEach(function (g) {
        var group = el("optgroup", { label: g.name });
        g.items.forEach(function (p) { group.appendChild(el("option", { value: p.key, text: p.label + " — " + p.title.slice(0, 70) })); });
        select.appendChild(group);
      });
      linksEl.textContent = "";
      linksEl.appendChild(select);
      linksEl.appendChild(button("Привязать", "Привязать этот файл к выбранной статье", function () { run("attach", { key: select.value }); }));
    } catch (e) { say(e.message); }
  }

  /* ---------- the PDF in the vault ---------- */

  var PDF_WHY = {
    "no-vault": "PDF не сохранён: выбери папку vault в настройках easy-read.",
    permission: "PDF не сохранён: подтвердить доступ к папке vault.",
    "too-big": "PDF не сохранён: файл больше 95 МБ, GitHub не примет его в vault."
  };

  function renderPdf(why) {
    pdfEl.textContent = "";
    var p = st.paper;
    if (!p) return;
    if (p.pdf) { pdfEl.textContent = "PDF ✓ " + p.pdf; return; }
    if (viewerPdf) {
      if (!why) return;
      pdfEl.appendChild(doc.createTextNode(PDF_WHY[why] || "PDF не сохранён: " + why));
      if (why === "permission") pdfEl.appendChild(button("Подтвердить", "Разрешить запись в папку vault", function () { keepPdf(true); }));
      if (why === "no-vault") pdfEl.appendChild(button("Настройки", "Открыть настройки easy-read", function () { chrome.runtime.sendMessage({ type: "open-options" }); }));
    } else if (st.pdfUrl) {
      pdfEl.appendChild(doc.createTextNode("PDF не сохранён."));
      pdfEl.appendChild(button("Сохранить PDF", "Открыть PDF в easy-read и сохранить его в vault", function () {
        chrome.runtime.sendMessage({ type: "open-pdf", url: st.pdfUrl, key: p.key });
      }));
    }
  }

  /* in the viewer: once the paper is known, the open file goes to 0_media/papers/<slug>.pdf */
  async function keepPdf(interactive) {
    var p = st.paper;
    if (!viewerPdf || !p || p.pdf || !p.slug) return;
    var gen = st.gen, hash = docInfo().hash; // the file that is open now; its bytes are taken in this same tick
    try {
      var res = await viewerPdf.save(p.slug, interactive);
      if (gen !== st.gen) return;
      if (res.reason) { renderPdf(res.reason); return; }
      await send("pdfSaved", { key: p.key, path: res.path, hash: hash });
      if (gen !== st.gen) return;
      st.paper = Object.assign({}, p, { pdf: res.path });
      renderPdf();
    } catch (e) {
      console.warn("easy-read notes: saving the PDF failed", e);
      if (gen === st.gen) renderPdf(e.message);
    }
  }

  /* ---------- highlights ---------- */

  function rangeIn(block, start, length, P) {
    var map = P.normIndexMap(block.textContent);
    var from = map[start], to = map[start + length - 1] + 1;
    var walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var range = doc.createRange(), seen = 0, node, begun = false;
    while ((node = walker.nextNode())) {
      var end = seen + node.data.length;
      if (!begun && from < end) { range.setStart(node, from - seen); begun = true; }
      if (begun && to <= end) { range.setEnd(node, to - seen); return range; }
      seen = end;
    }
    return null;
  }

  async function paint() {
    if (!window.CSS || !CSS.highlights) return;
    var P = await shared();
    var blocks = reader.blocks();
    var texts = blocks.map(function (b) { return b.textContent; });
    var ranges = [];
    st.notes.forEach(function (n) {
      var hit = n.quote && P.locateQuote(texts, n.quote);
      var range = hit && rangeIn(blocks[hit.block], hit.start, hit.length, P);
      if (range) { range.noteKey = n.key; ranges.push(range); }
    });
    st.ranges = ranges;
    if (ranges.length) CSS.highlights.set("er-note", new Highlight(...ranges));
    else CSS.highlights.delete("er-note");
  }

  function scrollToNote(key) {
    var range = st.ranges.find(function (r) { return r.noteKey === key; });
    var target = range && range.startContainer.parentElement;
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function noteAt(x, y) {
    var pos = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(x, y) : null;
    var node = pos ? pos.offsetNode : null, offset = pos ? pos.offset : 0;
    if (!pos && doc.caretRangeFromPoint) {
      var r = doc.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node) return null;
    var hit = st.ranges.find(function (range) { return range.isPointInRange(node, offset); });
    return hit ? hit.noteKey : null;
  }

  doc.addEventListener("click", function (e) {
    if (!st.ranges.length || e.target.closest(".er-ui") || !getSelection().isCollapsed) return;
    var key = noteAt(e.clientX, e.clientY);
    if (!key) return;
    panel.hidden = false;
    var item = listEl.querySelector('[data-key="' + key + '"]');
    if (item) item.scrollIntoView({ block: "nearest" });
  });

  /* ---------- open / close ---------- */

  async function open() {
    var picked = selectionQuote();
    if (picked.quote) { st.pending = picked; st.editing = null; st.summary = false; }
    panel.hidden = false;
    render();
    input.focus();
    await run("status");
  }
  function close() { panel.hidden = true; }

  /* quietly on load: highlights of earlier notes, and (viewer) the PDF into the vault */
  async function refresh() {
    var gen = st.gen;
    try {
      var res = await send("status");
      if (gen !== st.gen) return;
      st.vault = res.vault || "";
      st.paper = res.paper; st.notes = res.notes; st.pdfUrl = res.pdfUrl;
      await paint();
      if (!panel.hidden) render();
      keepPdf(false);
    } catch (e) {
      console.debug("easy-read notes: no Zotero state for this page", e);
    }
  }

  noteBtn.addEventListener("click", function () { if (panel.hidden) open(); else close(); });
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    else if (e.key === "Escape") close();
    e.stopPropagation(); // typing a note never triggers the reader's Space / the page's shortcuts
  });

  chrome.runtime.onMessage.addListener(function (m, sender, respond) {
    if (m.toTab != null && m.toTab !== window.__erTabId) return;
    if (m.type === "notes-open") open();
    else if (m.type === "notes-save") open().then(function () { if (!st.paper) run("save"); });
    else return;
    respond({ ok: true });
  });

  /* the text is rebuilt by easy-read (bold word starts) and by the viewer: ranges must be rebuilt too */
  er.onChange(function (s) {
    noteBtn.hidden = !s.enabled;
    if (!s.enabled) { if (!viewerDoc) close(); if (window.CSS && CSS.highlights) CSS.highlights.delete("er-note"); return; }
    if (st.notes.length) paint().then(function () { if (!panel.hidden) render(); });
  });
  window.addEventListener("er-doc", function () { st.gen++; st.paper = null; st.notes = []; resetForm(); refresh(); });

  doc.body.appendChild(noteBtn);
  doc.body.appendChild(panel);
  noteBtn.hidden = !er.getState().enabled;
  window.__easyReadNotes = {
    at: noteAt, // reader.js: a click on a note opens it and is not a jump
    open: open, refresh: refresh,
    mount: function (node) { extraEl.appendChild(node); },
    quote: function () { return selectionQuote().full || st.pending.full || ""; }, // the whole selection, never shortened
    fill: function (text) { input.value = (input.value ? input.value + "\n\n" : "") + text; input.focus(); },
  };
  if (viewerDoc ? !!viewerDoc().hash : !!doc.querySelector(ARTICLE_META)) refresh();
})();
