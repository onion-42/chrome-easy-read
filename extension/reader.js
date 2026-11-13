/* reader.js: immersive reading. Collects paragraphs from a start point, sends each sentence to the
 * extension's voice, and shows it in a subtitle bar that follows the easy-read settings.
 * Injected after easy-read.js and text.js, in the same isolated world. */
(function () {
  "use strict";
  if (window.__easyReadReader) return;
  var er = window.__easyRead, T = globalThis.erText;
  if (!er || !T) { console.error("easy-read reader: inject easy-read.js and text.js first"); return; }
  window.__easyReadReader = { blocks: function () { return readableBlocks(); } }; // notes.js highlights in the same blocks

  var doc = document;
  var BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, dd, dt, td, th, blockquote, figcaption";
  var SKIP = "nav, footer, aside, form, button, pre, script, style, svg, textarea, select, input, [role=navigation], [aria-hidden=true], .er-ui";
  var MATH = "math, .katex, mjx-container, .MathJax";              // raw TeX read aloud is noise
  var CITE_EL = "cite.ltx_cite, sup.reference, a[role=doc-noteref], a[role=doc-biblioref]";
  var WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;                     // same words as text.js timings
  var LOOKAHEAD = 2, MAX_LOOKAHEAD = 8;                             // sentences the voice may prepare ahead
  var BASE_PX = 22;                                                   // subtitle size before the easy-read scale
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var st = { chunks: [], i: 0, n: 0, active: false, paused: false, errored: false, rate: 1, rates: [1], readCitations: false,
    resumeAt: null, startMs: 0, session: Math.random().toString(36).slice(2) };
  var timings = null, mediaMs = 0, lastFrame = 0, raf = 0, wordEvents = false;
  var readingBlock = null, markedWord = null, wordEls = [];

  var css = doc.createElement("style");
  css.textContent = [
    "#er-read{position:fixed;left:70px;bottom:16px;z-index:2147483000;box-shadow:0 4px 14px rgba(0,0,0,.18)}",
    "#er-read[hidden],#er-reader[hidden]{display:none}",
    "#er-reader{position:fixed;left:16px;right:16px;bottom:62px;max-width:52rem;margin:0 auto;z-index:2147482999;" +
      "background:var(--er-p);color:var(--er-i);border:1px solid var(--er-b);border-radius:14px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.22);padding:14px 18px 10px;display:grid;gap:10px}",
    "html.er-scheme #er-reader{background:var(--er-bg);color:var(--er-fg);border-color:var(--er-line)}",
    "#er-reader input[type=range]{width:9rem;accent-color:currentColor}",
    "#er-reader .er-rate{min-width:3em;font-variant-numeric:tabular-nums}",
    "#er-reader .er-cap{line-height:1.5;max-height:40vh;overflow:auto}",
    "#er-reader .er-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    "#er-reader .er-msg{flex:1;min-width:8rem;color:var(--er-s);font-size:13px}",
    /* these must beat easy-read's colour scheme rule (transparent backgrounds, !important) */
    "html body #er-reader .er-dim{opacity:.5;font-size:.78em}",
    "html body #er-reader .er-word{background:color-mix(in srgb,var(--er-hl,#f2c14e) 55%,transparent)!important;" +
      "border-radius:3px;box-shadow:0 0 0 2px color-mix(in srgb,var(--er-hl,#f2c14e) 55%,transparent)}",
    "html body .er-reading.er-reading.er-reading{background:color-mix(in srgb,var(--er-hl,#f2c14e) 22%,transparent)!important;" +
      "border-radius:4px;box-shadow:0 0 0 4px color-mix(in srgb,var(--er-hl,#f2c14e) 22%,transparent)}"
  ].join("\n");
  doc.head.appendChild(css);

  /* ---------- collecting text ---------- */

  function skipped(e) { return !!e.closest(SKIP) || (!!e.closest("header") && !e.closest("main, article")); }
  function elementOf(n) { return n && n.nodeType === 1 ? n : n && n.parentElement; }
  function langOf(b) { var h = b.closest("[lang]"); return (h && h.getAttribute("lang")) || doc.documentElement.lang || ""; }

  function readableBlocks() {
    return Array.prototype.filter.call(doc.body.querySelectorAll(BLOCKS), function (b) {
      return !skipped(b) && b.textContent.trim();
    });
  }

  /* selection, then the right-clicked element, then the pinned easy-read focus */
  function startPoint(fromContext) {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode) return elementOf(sel.anchorNode);
    if (fromContext && window.__erContextTarget) return window.__erContextTarget;
    return doc.querySelector(".er-focus");
  }

  function startIndex(blocks, from) {
    if (from) {
      var k = blocks.indexOf(from.closest(BLOCKS));
      if (k < 0) k = blocks.findIndex(function (b) {
        return b.contains(from) || (from.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (k >= 0) return k;
    }
    var main = doc.querySelector("main, article, [role=main]");
    return main ? Math.max(0, blocks.findIndex(function (b) { return main.contains(b); })) : 0;
  }

  function textBefore(node, block) {
    var r = doc.createRange();
    r.setStart(block, 0);
    r.setEndBefore(node);
    return r.toString().slice(-24);
  }

  function supSegment(sup, block, lang) {
    var text = sup.textContent.replace(/\s+/g, " ");
    var before = textBefore(sup, block);
    var linksToRef = !!sup.querySelector("a[href^='#']") || !!sup.closest("a[href^='#']");
    return T.isCitationSup(text, before, linksToRef) ? { text: text, say: "" } : T.supSay(text, before, lang);
  }

  /* text nodes of this block (not of nested blocks) -> segments; DOM-level citations, math and sups decided here */
  function rawSegments(block, lang) {
    var out = [], seenSups = [], w = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      var n = w.currentNode, p = n.parentElement;
      if (p.closest(BLOCKS) !== block || skipped(p)) continue;
      var sup = p.closest("sup");
      if (sup && block.contains(sup)) {
        if (seenSups.indexOf(sup) < 0) { seenSups.push(sup); out.push(supSegment(sup, block, lang)); }
        continue;
      }
      var text = n.nodeValue.replace(/\s+/g, " ");
      if (!text) continue;
      out.push(p.closest(MATH) || p.closest(CITE_EL) ? { text: text, say: "" } : { text: text, say: text });
    }
    return out;
  }

  /* join neighbouring plain segments, so "(" + <a>Smith et al., 2020</a> + ")" is seen as one citation */
  function mergePlain(segs) {
    return segs.reduce(function (acc, s) {
      var last = acc[acc.length - 1];
      if (last && last.say === last.text && s.say === s.text) {
        var t = (last.text + s.text).replace(/ {2,}/g, " ");
        acc[acc.length - 1] = { text: t, say: t };
      } else acc.push(s);
      return acc;
    }, []);
  }

  function collect(from) {
    var blocks = readableBlocks(), out = [];
    blocks.slice(startIndex(blocks, from)).forEach(function (b) {
      var lang = langOf(b);
      var segs = T.splitSegments(mergePlain(rawSegments(b, lang)), { readCitations: st.readCitations });
      T.toChunks(segs, { lang: lang }).forEach(function (c) {
        if (c.say.trim()) out.push({ block: b, parts: c.parts, say: c.say, lang: lang });
      });
    });
    return out;
  }

  /* ---------- UI ---------- */

  function el(tag, attrs, kids) {
    var e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { e.appendChild(k); });
    return e;
  }
  function button(text, label, onClick) {
    var b = el("button", { type: "button", "aria-label": label, title: label, text: text });
    b.addEventListener("click", onClick);
    return b;
  }

  var readBtn = el("button", { id: "er-read", type: "button", class: "er-ui", text: "🔊",
    "aria-label": "Read aloud (Alt+Shift+R)", title: "Read aloud (Alt+Shift+R)" });
  var cap = el("div", { class: "er-cap" });
  var msgEl = el("span", { class: "er-msg", role: "status" });
  var playBtn = button("⏸", "Pause", togglePause);
  var rateIn = el("input", { type: "range", min: "0", step: "1", "aria-label": "Speed", title: "Speed" });
  var rateOut = el("span", { class: "er-rate", "aria-hidden": "true" });
  function showRate() {
    var r = st.rates[+rateIn.value];
    rateOut.textContent = r + "×";
    rateIn.setAttribute("aria-valuetext", r + "×");
  }
  function fillRates(rates, current) {
    st.rates = rates;
    rateIn.max = String(rates.length - 1);
    var i = rates.indexOf(current);
    rateIn.value = String(i < 0 ? rates.indexOf(1) : i);
    showRate();
  }
  var bar = el("div", { id: "er-reader", class: "er-ui", role: "region", "aria-label": "Reading aloud", hidden: "" }, [
    cap,
    el("div", { class: "er-ctl" }, [
      button("⏮", "Previous sentence", function () { if (st.active) play(st.i - 1); }),
      playBtn,
      button("⏭", "Next sentence", function () { if (st.active) play(st.i + 1); }),
      rateIn, rateOut, msgEl,
      button("✕", "Stop reading", stop)
    ])
  ]);

  function showMsg(text) { msgEl.textContent = text; }
  function setPlayButton() {
    var resume = st.paused || st.errored;
    playBtn.textContent = resume ? "▶" : "⏸";
    playBtn.setAttribute("aria-label", resume ? "Resume" : "Pause");
    playBtn.title = (resume ? "Resume" : "Pause") + " (Space)";
  }

  /* subtitle = the chunk's parts; each spoken word is a span keyed by its index in chunk.say */
  function showChunk(c) {
    cap.textContent = "";
    cap.style.fontSize = BASE_PX * er.getState().size + "px";
    wordEls = []; markedWord = null;
    var offset = 0;
    c.parts.forEach(function (p) {
      if (p.say !== p.text) {
        var unit = el("span", { class: p.say ? "er-unit" : "er-dim", text: p.text });
        if (p.say) { unit.dataset.i = offset; wordEls.push(unit); }  // e.g. a URL spoken as its domain
        cap.appendChild(unit);
      } else {
        var last = 0, m;
        WORD.lastIndex = 0;
        while ((m = WORD.exec(p.text))) {
          if (m.index > last) cap.appendChild(doc.createTextNode(p.text.slice(last, m.index)));
          var w = el("span", { class: "er-w" });
          w.dataset.i = offset + m.index;
          w.appendChild(er.emphasize(m[0]));
          cap.appendChild(w); wordEls.push(w);
          last = m.index + m[0].length;
        }
        if (last < p.text.length) cap.appendChild(doc.createTextNode(p.text.slice(last)));
      }
      offset += p.say.length;
    });
  }

  function markWord(charIndex) {
    var hit = null;
    for (var k = 0; k < wordEls.length && +wordEls[k].dataset.i <= charIndex; k++) hit = wordEls[k];
    if (hit === markedWord) return;
    if (markedWord) markedWord.classList.remove("er-word");
    markedWord = hit;
    if (hit) hit.classList.add("er-word");
  }
  function markedIndex() { return markedWord ? +markedWord.dataset.i : -1; }

  /* where to continue: the marked word (char index in chunk.say) and, with estimated timing, its audio time */
  function currentWord() {
    var char = markedIndex();
    if (char < 0) return { char: 0, ms: 0 };
    var w = timings && timings.filter(function (t) { return t.index <= char; }).pop();
    return { char: char, ms: w ? w.t : 0 };
  }

  function markBlock(b) {
    if (readingBlock === b) return;
    if (readingBlock) readingBlock.classList.remove("er-reading");
    readingBlock = b;
    if (b) {
      b.classList.add("er-reading");
      b.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    }
  }

  /* ---------- playback ---------- */

  function speechId() { return st.session + ":" + st.n; }

  function fail(e) {
    console.error("easy-read reader:", e);
    var gone = /context invalidated/i.test(String(e && e.message));
    showMsg(gone ? "The extension was updated. Reload the page to read aloud." : String(e && e.message || e));
    st.errored = true;
    setPlayButton();
  }

  function send(m) { chrome.runtime.sendMessage(m).catch(fail); }

  /* from = { char, ms }: continue this sentence at a word (after a pause or a speed change) */
  function play(i, from) {
    if (i >= st.chunks.length) { stop(); return; }
    st.i = Math.max(0, i); st.n += 1; st.paused = false; st.errored = false;
    var c = st.chunks[st.i], at = from || { char: 0, ms: 0 };
    timings = null; wordEvents = false; mediaMs = at.ms; st.startMs = at.ms;
    if (!from) showChunk(c); // continuing keeps the subtitle and the marked word
    markBlock(c.block); showMsg(""); setPlayButton();
    // fast speech outruns a short prefetch: 2 sentences at 1x, 4 at 2x, 6 at 3x, at most 8
    var ahead = Math.min(MAX_LOOKAHEAD, Math.max(LOOKAHEAD, Math.ceil(st.rate * 2)));
    send({ type: "speak", id: speechId(), text: c.say, startChar: at.char, startMs: at.ms, lang: c.lang, rate: st.rate,
      next: st.chunks.slice(st.i + 1, st.i + 1 + ahead).map(function (x) { return x.say; }) });
  }

  function start(fromContext) {
    var from = startPoint(fromContext);
    return chrome.runtime.sendMessage({ type: "reader-options" }).then(function (o) {
      stop();
      st.readCitations = o.readCitations;
      fillRates(o.rates, o.rate);
      st.rate = st.rates[+rateIn.value]; // a stored speed off the slider snaps to 1x
      st.chunks = collect(from);
      bar.hidden = false;
      if (!st.chunks.length) { showMsg("No readable text from here."); return; }
      st.active = true;
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
      play(0);
    }).catch(fail);
  }

  function stop() {
    if (st.active) send({ type: "control", cmd: "stop" });
    st.active = false; st.paused = false; st.errored = false; st.chunks = [];
    cancelAnimationFrame(raf); timings = null;
    markBlock(null); bar.hidden = true; showMsg("");
  }

  /* pause keeps the place at the marked word; resume sends the sentence again with that word as the start,
   * so nothing depends on audio kept alive while paused (Chrome closes idle audio pages after 30 s) */
  function togglePause() {
    if (!st.active) return;
    if (st.errored) { play(st.i); return; }
    if (st.paused) { play(st.i, st.resumeAt); return; }
    st.resumeAt = currentWord();
    st.paused = true;
    send({ type: "control", cmd: "pause" });
    setPlayButton();
  }

  /* word highlight for voices without word events: estimated from the audio length */
  function frame(now) {
    if (st.active && !st.paused && timings && !wordEvents) {
      mediaMs += (now - lastFrame) * st.rate;
      markWord(T.wordAt(timings, mediaMs));
    }
    lastFrame = now;
    raf = requestAnimationFrame(frame);
  }

  function onSpeech(m) {
    if (!st.active || m.id !== speechId()) return; // an older sentence
    if (m.event === "start") {
      lastFrame = performance.now(); mediaMs = st.startMs;
      if (m.durationMs) timings = T.wordTimings(st.chunks[st.i].say, m.durationMs);
    } else if (m.event === "word") { wordEvents = true; markWord(m.charIndex); }
    else if (m.event === "end") play(st.i + 1);
    else if (m.event === "error") { showMsg(m.message); st.errored = true; setPlayButton(); }
  }

  /* ---------- wiring ---------- */

  rateIn.addEventListener("input", showRate); // the number follows the thumb while dragging
  rateIn.addEventListener("change", function () {
    st.rate = st.rates[+rateIn.value];
    send({ type: "control", cmd: "rate", value: st.rate }); // remembered as the default speed
    if (st.active && !st.paused) play(st.i, currentWord());  // continue from this word at the new speed
  });
  readBtn.addEventListener("click", function () { start(false); });

  /* Space = pause / resume while reading. It still types in fields and presses the page's own buttons;
   * on the reading bar's buttons (focused after a click) it pauses instead of pressing them again */
  var INTERACTIVE = "input, textarea, select, button, a[href], [role=button], [role=textbox], [role=slider]";
  function spaceIsOurs(e) {
    if (!st.active || e.key !== " " || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
    var t = e.target;
    if (!t || t.isContentEditable || !t.closest) return !!t;
    if (t.closest("#er-reader button, #er-read")) return true;
    return !t.closest(INTERACTIVE);
  }
  window.addEventListener("keydown", function (e) {
    if (!spaceIsOurs(e)) return;
    e.preventDefault(); // no page scroll, no button press
    e.stopPropagation();
    if (!e.repeat) togglePause();
  }, true);
  window.addEventListener("keyup", function (e) {
    if (spaceIsOurs(e)) e.preventDefault(); // a focused button would click on keyup
  }, true);

  chrome.runtime.onMessage.addListener(function (m, sender, respond) {
    // in the PDF viewer (an extension page) messages are broadcast with the tab they are for
    if (m.toTab != null && m.toTab !== window.__erTabId) return;
    if (m.type === "tts-event") onSpeech(m);
    else if (m.type === "reader-start") start(m.fromContext);
    else if (m.type === "reader-toggle") { if (st.active) togglePause(); else start(false); }
    else return;
    respond({ ok: true });
  });

  /* subtitles follow easy-read: re-render on any change (bold starts, size); stop when it is switched off */
  er.onChange(function (s) {
    readBtn.hidden = !s.enabled;
    if (!s.enabled) { if (st.active) stop(); return; }
    if (st.active) { var at = markedIndex(); showChunk(st.chunks[st.i]); markWord(at); }
  });

  doc.body.appendChild(readBtn);
  doc.body.appendChild(bar);
  readBtn.hidden = !er.getState().enabled;
})();
