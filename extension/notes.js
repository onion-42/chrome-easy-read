/* notes.js: notes on the article being read. A note = quote + comment, stored in Zotero as a child note of
 * the paper (the service worker talks to Zotero). Quotes are highlighted with the CSS Custom Highlight API,
 * so the page's DOM is never changed. Injected after reader.js, in the same isolated world; the PDF viewer
 * loads it too and offers window.__erDoc (what is open), window.__erPdf (save the file into the vault) and
 * window.__erView (text view or PDF view; in PDF view quotes live in the text layers of the pages).
 * notes.html (the notes of one paper in a tab of their own) loads it too and sets window.__erNotesPage:
 * there the panel is the page, it names its paper by key, and there is no article text. */
(function () {
  "use strict";
  if (window.__easyReadNotes && window.__easyReadNotes.open) return; // (a page element with this id is not us)
  var er = window.__easyRead, reader = window.__easyReadReader;
  if (!er || !reader) { console.error("easy-read notes: inject easy-read.js and reader.js first"); return; }

  var doc = document;
  var MAX_QUOTE = 2000;
  var ARTICLE_META = "meta[name=citation_doi], meta[name=citation_pmid], meta[name=citation_title]";
  var st = { paper: null, notes: [], pdfUrl: null, pending: { quote: "", page: null, full: "" }, editing: null, summary: false, ranges: [], busy: false, P: null, vault: "", gen: 0, materials: [] };
  // st.gen counts documents: the viewer can open another PDF while a request is out, and a late answer
  // for the previous document must never be applied to (or saved as) the new one
  var viewerDoc = typeof window.__erDoc === "function" ? window.__erDoc : null;
  var viewerPdf = window.__erPdf && typeof window.__erPdf.save === "function" ? window.__erPdf : null;
  var viewerView = window.__erView && typeof window.__erView.mode === "function" ? window.__erView : null;
  var notesPage = window.__erNotesPage || null;

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
    "#er-notes .er-n-mats{gap:2px 12px}",
    "#er-notes .er-n-tools button{min-height:28px;min-width:30px;padding:2px 8px}",
    "#er-notes .er-n-preview{border:1px dashed var(--er-b);border-radius:8px;padding:6px 8px;overflow-wrap:anywhere}",
    "#er-notes .er-n-body{grid-column:1;overflow-wrap:anywhere}",
    "#er-notes :is(.er-n-body,.er-n-preview) :is(p,ul,ol,blockquote){margin:0 0 4px}",
    "#er-notes :is(.er-n-body,.er-n-preview) :is(ul,ol){padding-left:1.3em}",
    "#er-notes :is(.er-n-body,.er-n-preview) blockquote{border-left:3px solid var(--er-a);padding-left:10px}",
    "#er-notes :is(.er-n-body,.er-n-preview) mark{background-color:#ffd40080;color:inherit}",
    "#er-notes :is(.er-n-body,.er-n-preview) code{font-family:ui-monospace,monospace;font-size:.92em}",
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
    var pdfPage = block && block.closest(".er-pdf-page");    // PDF view: the page is the box around the text layer,
    if (pdfPage) {                                            // and the line ends of the page are not paragraphs
      return { quote: full.replace(/\s*\n\s*/g, " ").slice(0, MAX_QUOTE), page: pdfPage.dataset.page, full: full };
    }
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
  var matsEl = el("div", { class: "er-n-row er-n-soft er-n-mats", hidden: "" }); // links only; they are managed in the reading list
  var quoteEl = el("blockquote", { class: "er-n-quote", hidden: "" });
  var input = el("textarea", { "aria-label": "Текст заметки", placeholder: "Комментарий к выделенному тексту…" });

  /* text tools: wrap the selection of the note field in markdown; a second press takes the marks off */
  function wrap(before, after) {
    var v = input.value, s = input.selectionStart, e = input.selectionEnd;
    var inside = v.slice(s, e);
    var has = s >= before.length && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after;
    if (has) {
      input.value = v.slice(0, s - before.length) + inside + v.slice(e + after.length);
      input.setSelectionRange(s - before.length, e - before.length);
    } else {
      input.value = v.slice(0, s) + before + inside + after + v.slice(e);
      input.setSelectionRange(s + before.length, e + before.length);
    }
    input.focus(); preview();
  }

  /* line tools (list, quote): the mark goes to the start of every selected line; a second press removes it */
  function prefix(mark) {
    var v = input.value, s = input.selectionStart, e = input.selectionEnd;
    var from = v.lastIndexOf("\n", s - 1) + 1, to = v.indexOf("\n", e);
    if (to < 0) to = v.length;
    var lines = v.slice(from, to).split("\n");
    var all = lines.every(function (l) { return l.indexOf(mark) === 0; });
    var next = lines.map(function (l) { return all ? l.slice(mark.length) : mark + l; }).join("\n");
    input.value = v.slice(0, from) + next + v.slice(to);
    input.setSelectionRange(from, from + next.length);
    input.focus(); preview();
  }

  var LINK_STUB = "https://";
  function addLink() {
    var s = input.selectionStart, e = input.selectionEnd, text = input.value.slice(s, e) || "текст";
    input.value = input.value.slice(0, s) + "[" + text + "](" + LINK_STUB + ")" + input.value.slice(e);
    var at = s + text.length + 3; // the address is selected, ready to be typed or pasted over
    input.setSelectionRange(at, at + LINK_STUB.length);
    input.focus(); preview();
  }

  /* [text, label, action, Ctrl+key, style of the button's own text] */
  var TOOLS = [
    ["Ж", "Жирное (Ctrl+B)", function () { wrap("**", "**"); }, "b", "font-weight:700"],
    ["К", "Курсив (Ctrl+I)", function () { wrap("*", "*"); }, "i", "font-style:italic"],
    ["Ч", "Подчёркивание (Ctrl+U)", function () { wrap("<u>", "</u>"); }, "u", "text-decoration:underline"],
    ["З", "Зачёркивание", function () { wrap("~~", "~~"); }, "", "text-decoration:line-through"],
    ["В", "Выделение цветом", function () { wrap("==", "=="); }, "", "background-color:#ffd40080"],
    ["</>", "Код", function () { wrap("`", "`"); }, "", ""],
    ["🔗", "Ссылка (Ctrl+K)", addLink, "k", ""],
    ["x²", "Верхний индекс", function () { wrap("<sup>", "</sup>"); }, "", ""],
    ["x₂", "Нижний индекс", function () { wrap("<sub>", "</sub>"); }, "", ""],
    ["•", "Список", function () { prefix("- "); }, "", ""],
    ["❝", "Цитата", function () { prefix("> "); }, "", ""]
  ];
  var toolsEl = el("div", { class: "er-n-row er-n-tools", role: "toolbar", "aria-label": "Разметка заметки" },
    TOOLS.map(function (t) {
      var b = button(t[0], t[1], t[2]);
      if (t[4]) b.setAttribute("style", t[4]);
      b.addEventListener("mousedown", function (e) { e.preventDefault(); }); // the selection in the field stays
      return b;
    }));
  var tabBtn = button("↗", "Открыть заметки в отдельной вкладке", function () {
    chrome.runtime.sendMessage({ type: "open-notes", key: st.paper.key });
    close();
  });
  var closeBtn = button("✕", "Закрыть заметки", close);
  tabBtn.hidden = true; closeBtn.hidden = !!notesPage;
  var previewEl = el("div", { class: "er-n-preview", "aria-label": "Как заметка будет выглядеть", hidden: "" });
  var saveBtn = button("Сохранить (Ctrl+Enter)", "Сохранить заметку в Zotero", save);
  var cancelBtn = button("Отмена", "Не менять заметку", function () { resetForm(); render(); });
  var msgEl = el("div", { class: "er-n-soft er-n-msg", role: "status" });
  var extraEl = el("div"); // assist-ui.js mounts the assistant section here
  var listHead = el("div", { class: "er-n-soft" });
  var listEl = el("div");
  var panel = el("div", { id: "er-notes", class: "er-ui", role: "complementary", "aria-label": "Заметки к статье", hidden: "" }, [
    el("div", { class: "er-n-head" }, [titleEl, el("span", { class: "er-n-row" }, [tabBtn, closeBtn])]),
    statusEl, linksEl, pdfEl, matsEl, quoteEl, toolsEl, input, previewEl,
    el("div", { class: "er-n-row" }, [saveBtn, cancelBtn]),
    msgEl, extraEl, listHead, listEl
  ]);

  function say(text) { msgEl.textContent = text || ""; }

  /* ---------- formatted text ---------- */

  var SHOWN = { P: "p", BR: "br", STRONG: "strong", B: "strong", EM: "em", I: "em", U: "u", S: "s", CODE: "code",
    SUB: "sub", SUP: "sup", UL: "ul", OL: "ol", LI: "li", H1: "strong", H2: "strong", H3: "strong", BLOCKQUOTE: "blockquote" };

  /* Formatted text of a note as fresh elements. Only the tags of SHOWN, a highlight and http(s) links are
   * rebuilt; everything else becomes its text. Nothing is inserted as HTML. */
  function shown(from, into) {
    from.childNodes.forEach(function (n) {
      if (n.nodeType === 3) { into.appendChild(doc.createTextNode(n.data)); return; }
      if (n.nodeType !== 1) return;
      var tag = SHOWN[n.tagName], e = null;
      if (tag) e = doc.createElement(tag);
      else if (n.tagName === "SPAN" && n.style.backgroundColor) e = doc.createElement("mark");
      else if (n.tagName === "A" && /^https?:/.test(n.getAttribute("href") || "")) e = link("", n.getAttribute("href"));
      shown(n, e || into);
      if (e) into.appendChild(e);
    });
    return into;
  }

  /* markdown -> a block of formatted elements; plain text when papers.js is not loaded yet or the page
   * forbids parsing HTML */
  function formatted(md, cls) {
    var box = el("div", { class: cls });
    try {
      if (!st.P) throw new Error("papers.js is not loaded yet");
      return shown(new DOMParser().parseFromString(st.P.mdToHtml(md), "text/html").body, box);
    } catch (e) {
      console.debug("easy-read notes: formatted view is not available here", e);
      box.textContent = md;
      box.style.whiteSpace = "pre-wrap";
      return box;
    }
  }

  /* under the field: how the text being typed will look */
  function preview() {
    var text = input.value.trim();
    previewEl.hidden = !text;
    previewEl.textContent = "";
    if (!text) return;
    if (!st.P) { shared().then(preview, function (e) { console.debug("easy-read notes: no preview", e); }); return; }
    previewEl.appendChild(formatted(text, ""));
  }
  input.addEventListener("input", preview);

  function resetForm() {
    st.editing = null; st.summary = false; st.pending = { quote: "", page: null, full: "" };
    input.value = "";
    preview();
  }

  function render() {
    var p = st.paper;
    titleEl.textContent = p ? "Заметки · " + p.label : "Заметки";
    tabBtn.hidden = !p || !!notesPage;
    if (notesPage) doc.title = (p ? "Заметки · " + p.label + " — " + p.title : "Заметки") + " · easy-read";
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
    renderMaterials();
  }

  /* links to everything attached to the paper (supplementary PDFs, notes, videos, threads, slides) */
  function renderMaterials() {
    matsEl.textContent = "";
    matsEl.hidden = !st.materials.length;
    if (matsEl.hidden) return;
    if (!st.P) { shared().then(renderMaterials, function (e) { console.debug("easy-read notes: no materials block", e); }); return; } // kinds and addresses come from papers.js
    var viewer = chrome.runtime.getURL("viewer.html");
    matsEl.appendChild(doc.createTextNode("Материалы:"));
    st.materials.forEach(function (m) {
      var href = st.P.materialHref(m, viewer);
      var a = link((st.P.MATERIAL_KINDS[m.kind] || m.kind) + ": " + m.title, href);
      if (href.indexOf(viewer) === 0) { // a web page cannot open the viewer itself: the service worker does
        a.addEventListener("click", function (e) { e.preventDefault(); chrome.runtime.sendMessage({ type: "open-vault-pdf", path: m.path }); });
      }
      matsEl.appendChild(a);
    });
    matsEl.appendChild(button("Reading list", "Добавить или убрать материалы: reading list", function () { chrome.runtime.sendMessage({ type: "open-reading-list" }); }));
  }

  function noteItem(n) {
    var found = !n.quote || st.ranges.some(function (r) { return r.noteKey === n.key; });
    var body = n.md.split("\n").filter(function (l) { return l.indexOf(">") !== 0; }).join("\n").trim();
    var item = el("div", { class: "er-n-item", "data-key": n.key }, []);
    if (n.quote) item.appendChild(el("p", { class: "er-n-quote", text: n.quote.length > 160 ? n.quote.slice(0, 157) + "…" : n.quote }));
    if (!n.readOnly) item.appendChild(button("✎", "Править заметку", function (e) { e.stopPropagation(); startEdit(n); }));
    var text = formatted(body, "er-n-body");
    if (n.summary) text.insertBefore(el("strong", { text: "★ Вывод: " }), text.firstChild);
    item.appendChild(text);
    if (!found && !notesPage) item.appendChild(el("p", { class: "er-n-soft", text: "цитата не найдена в этом тексте" }));
    item.addEventListener("click", function () { if (notesPage) notesPage.show(n.key, !!n.quote); else scrollToNote(n.key); });
    return item;
  }

  function startEdit(n) {
    st.editing = { key: n.key, version: n.version }; st.summary = false;
    input.value = n.md;
    say(""); render(); preview(); input.focus();
  }

  function startSummary() {
    var old = st.notes.find(function (n) { return n.summary; });
    if (old) { startEdit(old); return; }
    st.summary = true; st.editing = null; input.value = "";
    say(""); render(); preview(); input.focus();
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
      if (res.paper !== undefined) { st.paper = res.paper; st.notes = res.notes; st.pdfUrl = res.pdfUrl; st.materials = res.materials || []; }
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

  var VAULT_WHY = {
    "": "Сохранено: Zotero и vault.",
    "no-vault": "Сохранено в Zotero. В vault появится после синхронизации: папка vault не выбрана в настройках easy-read.",
    permission: "Сохранено в Zotero. В vault появится после синхронизации: доступ к папке vault не подтверждён (подтверди его в reading list).",
    "no-passport": "Сохранено в Zotero. В vault появится после синхронизации: у статьи там ещё нет заметки.",
    error: "Сохранено в Zotero. В vault появится после синхронизации: файл записать не удалось."
  };

  /* Alt+Shift+N on a selection: the quote is saved at once (Zotero, the list here, the vault). The new note
   * then stays open for an optional comment; Escape leaves it as it is. Nothing selected: the panel. */
  async function quickNote() {
    var picked = selectionQuote();
    if (!picked.quote) { open(); return; }
    panel.hidden = false;
    if (st.busy) { // another request is out: nothing is saved, and the quote is kept in the form
      st.pending = picked; st.editing = null; st.summary = false; render();
      say("Заметка ещё не сохранена: шёл другой запрос к Zotero. Цитата в поле, нажми Ctrl+Enter.");
      return;
    }
    var res = await run("note", { quote: picked.quote, page: picked.page, comment: "" });
    if (!res) { st.pending = picked; st.editing = null; st.summary = false; render(); return; } // the quote waits in the form
    var made = st.notes.find(function (n) { return n.key === res.made; });
    if (made) startEdit(made);
    say(VAULT_WHY[res.vaultNote || ""] || VAULT_WHY.error);
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
    if (!viewerPdf || !p || p.pdf || !p.slug || docInfo().inVault) return; // (a material PDF of the vault is not the paper's PDF)
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
    return rangeRaw(block, map[start], map[start + length - 1] + 1);
  }

  /* from / to: indices in block.textContent */
  function rangeRaw(block, from, to) {
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

  /* PDF view: a text layer has no spaces between its lines and keeps the hyphens of broken words, so the
   * quote and the page are compared without whitespace and hyphens. */
  var LOOSE = /[\s\u00ad\u2010\u2011-]/g;
  var LOOSE_PROBE = 60, LOOSE_MIN = 10; // a long quote may differ near its end: its start is tried too

  /* -> { chars: the text without whitespace and hyphens, idx: where each of those characters is in raw } */
  function loose(raw) {
    var idx = [], chars = [];
    for (var i = 0; i < raw.length; i++) {
      LOOSE.lastIndex = 0;
      if (!LOOSE.test(raw[i])) { idx.push(i); chars.push(raw[i]); }
    }
    return { chars: chars.join(""), idx: idx };
  }

  /* -> { from, to } in the raw text behind `text`, or null */
  function locateLoose(text, quote) {
    var q = quote.replace(LOOSE, "");
    var probes = q.length > LOOSE_PROBE ? [q, q.slice(0, LOOSE_PROBE)] : [q];
    for (var i = 0; i < probes.length; i++) {
      if (!probes[i] || (i > 0 && probes[i].length < LOOSE_MIN)) continue;
      var at = text.chars.indexOf(probes[i]);
      if (at >= 0) return { from: text.idx[at], to: text.idx[at + probes[i].length - 1] + 1 };
    }
    return null;
  }

  function rangeInLayers(layers, texts, quote) {
    for (var i = 0; i < layers.length; i++) {
      var hit = locateLoose(texts[i], quote);
      if (hit) return rangeRaw(layers[i], hit.from, hit.to);
    }
    return null;
  }

  async function paint() {
    if (!window.CSS || !CSS.highlights) return;
    var P = await shared();
    var pdf = !!viewerView && viewerView.mode() === "pdf";
    var blocks = pdf ? viewerView.layers() : reader.blocks();
    var texts = blocks.map(function (b) { return pdf ? loose(b.textContent) : b.textContent; });
    var ranges = [];
    st.notes.forEach(function (n) {
      if (!n.quote) return;
      var hit = pdf ? null : P.locateQuote(texts, n.quote);
      var range = pdf ? rangeInLayers(blocks, texts, n.quote) : hit && rangeIn(blocks[hit.block], hit.start, hit.length, P);
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
  function close() { if (!notesPage) panel.hidden = true; }

  /* quietly on load: highlights of earlier notes, and (viewer) the PDF into the vault */
  async function refresh() {
    var gen = st.gen;
    try {
      var res = await send("status");
      if (gen !== st.gen) return;
      st.vault = res.vault || "";
      st.paper = res.paper; st.notes = res.notes; st.pdfUrl = res.pdfUrl; st.materials = res.materials || [];
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
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.target === input) { // text tools; only while typing a note
      var tool = TOOLS.find(function (t) { return t[3] && t[3] === e.key.toLowerCase(); });
      if (tool) { e.preventDefault(); tool[2](); }
    }
    e.stopPropagation(); // typing a note never triggers the reader's Space / the page's shortcuts
  });

  chrome.runtime.onMessage.addListener(function (m, sender, respond) {
    if (m.toTab != null && m.toTab !== window.__erTabId) return;
    if (m.type === "notes-open") open();
    else if (m.type === "notes-quick") quickNote();
    else if (m.type === "notes-show") { panel.hidden = false; refresh().then(function () { scrollToNote(m.key); }); } // from the notes tab
    else if (m.type === "notes-save") open().then(function () { if (!st.paper) run("save"); });
    else return;
    respond({ ok: true });
  });

  /* the text is rebuilt by easy-read (bold word starts) and by the viewer: ranges must be rebuilt too */
  er.onChange(function (s) {
    noteBtn.hidden = !s.enabled || !!notesPage;
    if (!s.enabled) { if (!viewerDoc) close(); if (window.CSS && CSS.highlights) CSS.highlights.delete("er-note"); return; }
    if (st.notes.length) paint().then(function () { if (!panel.hidden) render(); });
  });
  window.addEventListener("er-doc", function () { st.gen++; st.paper = null; st.notes = []; st.materials = []; resetForm(); refresh(); });

  doc.body.appendChild(noteBtn);
  doc.body.appendChild(panel);
  noteBtn.hidden = !er.getState().enabled || !!notesPage;
  window.__easyReadNotes = {
    at: noteAt, // reader.js: a click on a note opens it and is not a jump
    open: open, refresh: refresh,
    repaint: function () { return paint().then(function () { if (!panel.hidden) render(); }); }, // the viewer changed its view
    mount: function (node) { extraEl.appendChild(node); },
    quote: function () { return selectionQuote().full || st.pending.full || ""; }, // the whole selection, never shortened
    fill: function (text) { input.value = (input.value ? input.value + "\n\n" : "") + text; input.focus(); preview(); },
  };
  if (notesPage) open();
  else if (viewerDoc ? !!viewerDoc().hash : !!doc.querySelector(ARTICLE_META)) refresh();
})();
