/* easy-read: a reading-comfort panel for any HTML page. Vanilla JS, no dependencies.
 * Font (system / OpenDyslexic / Lexiad if installed), text size, line + letter spacing,
 * calm colour schemes, colour-vision daltonisation (red-green / blue-yellow), bionic-style word
 * emphasis, and a focus highlight that follows the pointer or Alt+Arrow keys. Settings persist in
 * localStorage when it is available.
 * It never touches text inside <svg> (charts, mind-maps keep their layout).
 * Comfort and choice, not a treatment: see README for the evidence note. MIT. */
(function () {
  "use strict";
  if (window.__easyRead) return;
  var api = {};
  window.__easyRead = api;
  /* optional host (e.g. a browser extension): { load(): settings, save(settings), fontBase: url/ } */
  var host = window.__easyReadHost || null;
  var FONT_BASE = (host && host.fontBase) || "https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic/files/";
  var KEY = "easy-read", doc = document, root = doc.documentElement;
  var DEFAULTS = { font: "", size: 1, lh: 0, ls: 0, scheme: "", cvd: "", bionic: false, focus: false, hl: "#f2c14e" };
  var FONTS = { "": "Page font", system: "System sans", od: "OpenDyslexic", lexiad: "Lexiad (if installed)" };
  var SCHEMES = { "": "Page colours", cream: "Cream", grey: "Soft grey", dark: "Calm dark" };
  var CVD_OPTS = { "": "As designed", "red-green": "Red-green (protan / deutan)", "blue-yellow": "Blue-yellow (tritan)" };
  /* Daltonisation, I + E(I - S) in linear RGB: Machado et al. 2009 dichromacy simulation (S) plus
   * Fidaner et al. 2005 error shift (E). Same values as the anki-deck skill (its parity test). */
  var CVD = {
    "red-green": "1 0 0 0 0 0.163 0.725 0.112 0 0 0.455 -0.645 1.191 0 0 0 0 0 1 0",
    "blue-yellow": "0.741 -0.407 0.666 0 0 0.075 0.585 0.34 0 0 0 0 1 0 0 0 0 0 1 0"
  };
  var SKIP = "svg, script, style, code, pre, kbd, samp, textarea, input, select, .er-ui";
  var BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, dd, dt, td, th, blockquote, figcaption, .er-block";
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var s = load(), enabled = true, listeners = [];

  function load() {
    if (host) return Object.assign({}, DEFAULTS, host.load());
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || "{}")); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function save() {
    if (host) { host.save(Object.assign({}, s)); return; }
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }
  /* the settings in effect: the saved profile while on, the page as designed while off */
  function cur() { return enabled ? s : DEFAULTS; }

  var css = doc.createElement("style");
  css.textContent = [
    '@font-face{font-family:"ER OpenDyslexic";font-display:swap;src:url(' + FONT_BASE + 'opendyslexic-latin-400-normal.woff2) format("woff2")}',
    '@font-face{font-family:"ER OpenDyslexic";font-weight:700;font-display:swap;src:url(' + FONT_BASE + 'opendyslexic-latin-700-normal.woff2) format("woff2")}',
    '@font-face{font-family:"ER Lexiad";src:local("Lexiad"),local("03A_test")}',
    ".er-ui{--er-p:#fffdf8;--er-i:#2b2622;--er-s:#6b6259;--er-b:#e5dccb;--er-a:#b0603f;font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--er-i)}",
    "@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .er-ui{--er-p:#2a2521;--er-i:#efe7db;--er-s:#b6ab9c;--er-b:#3d352d;--er-a:#e08a63}}",
    ":root[data-theme=dark] .er-ui{--er-p:#2a2521;--er-i:#efe7db;--er-s:#b6ab9c;--er-b:#3d352d;--er-a:#e08a63}",
    ".er-ui button,.er-ui select{font:inherit;color:inherit;background:var(--er-p);border:1px solid var(--er-b);border-radius:8px;padding:6px 10px;min-height:34px;cursor:pointer}",
    ".er-ui :focus-visible{outline:2px solid var(--er-a);outline-offset:2px}",
    "#er-toggle{position:fixed;left:16px;bottom:16px;z-index:2147483000;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.18)}",
    "#er-panel{position:fixed;left:16px;bottom:62px;z-index:2147483000;width:min(300px,calc(100vw - 32px));max-height:calc(100dvh - 80px);overflow:auto;background:var(--er-p);border:1px solid var(--er-b);border-radius:14px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.22);display:grid;gap:10px}",
    "#er-panel[hidden],#er-toggle[hidden]{display:none}",
    "#er-panel label{display:grid;gap:4px;color:var(--er-s);font-size:12px}",
    "#er-panel .er-row{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--er-i);font-size:14px}",
    "#er-panel input[type=range]{width:100%;accent-color:var(--er-a)}",
    "html.er-font body :not(" + SKIP + "):not(svg *){font-family:var(--er-font)!important}",
    "html.er-lh body :not(" + SKIP + "):not(svg *){line-height:var(--er-lh)!important}",
    "html.er-ls body :not(" + SKIP + "):not(svg *){letter-spacing:var(--er-ls)!important;word-spacing:calc(var(--er-ls) * 2)!important}",
    "html.er-scheme body{background:var(--er-bg)!important;color:var(--er-fg)!important}",
    "html.er-scheme body :not(" + SKIP + "):not(svg *){color:inherit!important;background-color:transparent!important;border-color:var(--er-line)!important}",
    /* on the root element: it is the only one whose filter does not re-anchor position:fixed
     * descendants (sticky headers, modals, this panel); the panel's neutral colours barely move */
    "html.er-cvd{filter:url(#er-cvd)}",
    ".er-b{font-weight:700}",
    /* repeated class: must outrank the colour scheme's transparent-background rule above */
    "html body .er-focus.er-focus.er-focus{background:color-mix(in srgb,var(--er-hl) 32%,transparent)!important;border-radius:4px;box-shadow:0 0 0 3px color-mix(in srgb,var(--er-hl) 32%,transparent)}"
  ].join("\n");
  doc.head.appendChild(css);

  var FONT_STACK = { system: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    od: '"ER OpenDyslexic",system-ui,sans-serif', lexiad: '"ER Lexiad","Lexiad","03A_test",system-ui,sans-serif' };
  var SCHEME_VARS = { cream: ["#f8f1e3", "#2e2a24", "#e3d8c3"], grey: ["#e9eaec", "#26282b", "#cfd2d6"],
    dark: ["#1d1f22", "#e4e1da", "#3a3d42"] };

  /* colour vision: one SVG filter whose matrix is swapped per mode */
  var SVG_NS = "http://www.w3.org/2000/svg";
  var defs = doc.createElementNS(SVG_NS, "svg"), cvdFilter = doc.createElementNS(SVG_NS, "filter"),
    cvdMatrix = doc.createElementNS(SVG_NS, "feColorMatrix");
  defs.setAttribute("class", "er-ui er-defs"); defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("width", "0"); defs.setAttribute("height", "0");
  defs.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  cvdFilter.setAttribute("id", "er-cvd"); cvdFilter.setAttribute("color-interpolation-filters", "linearRGB");
  cvdMatrix.setAttribute("type", "matrix");
  cvdFilter.appendChild(cvdMatrix); defs.appendChild(cvdFilter);

  /* text size: scale each text block from its own original size (no compounding) */
  function textBlocks() {
    return Array.prototype.filter.call(doc.body.querySelectorAll(BLOCKS + ", span, a, div, label, button"),
      function (el) {
        if (el.closest(SKIP) || el.classList.contains("er-bw")) return false;
        return Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); });
      });
  }
  var sized = false;
  function applySize(size) {
    if (size === 1 && !sized) return;
    var els = textBlocks();
    // read every original size BEFORE writing any, so a nested span never scales twice
    els.forEach(function (el) { if (!el.dataset.erSize) el.dataset.erSize = parseFloat(getComputedStyle(el).fontSize); });
    els.forEach(function (el) { el.style.fontSize = size === 1 ? "" : (el.dataset.erSize * size) + "px"; });
    sized = true;
  }

  /* bionic-style emphasis: bold the first ~half of each word; fully reversible */
  function textNodes() {
    var out = [], w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
      return n.nodeValue.trim() && !n.parentElement.closest(SKIP + ", .er-bw") ? 1 : 2; } });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }
  function emphasizeInto(into, text) {
    text.split(/([\p{L}\p{N}]+)/u).forEach(function (part, i) {
      if (i % 2 === 0) { if (part) into.appendChild(doc.createTextNode(part)); return; }
      var k = Math.ceil(part.length / 2), b = doc.createElement("b");
      b.className = "er-b"; b.textContent = part.slice(0, k);
      into.appendChild(b); into.appendChild(doc.createTextNode(part.slice(k)));
    });
    return into;
  }
  function bionicOn() {
    textNodes().forEach(function (n) {
      var span = doc.createElement("span"); span.className = "er-bw";
      n.parentNode.replaceChild(emphasizeInto(span, n.nodeValue), n);
    });
  }
  function bionicOff() {
    doc.querySelectorAll(".er-bw").forEach(function (sp) { sp.replaceWith(doc.createTextNode(sp.textContent)); });
    doc.body.normalize();
  }

  /* focus highlight: follows the pointer; click pins; Alt+ArrowUp/Down steps between blocks */
  var current = null, pinned = false;
  function blockOf(el) { var b = el && el.closest && el.closest(BLOCKS); return b && !b.closest(SKIP) ? b : null; }
  function mark(b) {
    if (current) current.classList.remove("er-focus");
    current = b; if (b) b.classList.add("er-focus");
  }
  doc.addEventListener("mouseover", function (e) { if (cur().focus && !pinned) mark(blockOf(e.target)); });
  doc.addEventListener("click", function (e) {
    if (!cur().focus || e.target.closest(".er-ui")) return;
    var b = blockOf(e.target); if (b) { pinned = !(pinned && b === current); mark(b); }
  });
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
    if (!cur().focus || !e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    var all = Array.prototype.filter.call(doc.querySelectorAll(BLOCKS), function (b) { return !b.closest(SKIP) && b.textContent.trim(); });
    var i = all.indexOf(current) + (e.key === "ArrowDown" ? 1 : -1);
    if (all[i]) { e.preventDefault(); pinned = true; mark(all[i]);
      all[i].scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" }); }
  });

  function render(st) {
    var c = root.classList;
    c.toggle("er-font", !!st.font); root.style.setProperty("--er-font", FONT_STACK[st.font] || "inherit");
    c.toggle("er-lh", st.lh > 0); root.style.setProperty("--er-lh", String(st.lh));
    c.toggle("er-ls", st.ls > 0); root.style.setProperty("--er-ls", st.ls + "em");
    var sv = SCHEME_VARS[st.scheme]; c.toggle("er-scheme", !!sv);
    if (sv) { root.style.setProperty("--er-bg", sv[0]); root.style.setProperty("--er-fg", sv[1]); root.style.setProperty("--er-line", sv[2]); }
    root.style.setProperty("--er-hl", st.hl);
    var m = CVD[st.cvd]; c.toggle("er-cvd", !!m);
    if (m) cvdMatrix.setAttribute("values", m);
    var hasBionic = !!doc.querySelector(".er-bw");
    if (st.bionic && !hasBionic) bionicOn(); else if (!st.bionic && hasBionic) bionicOff();
    if (!st.focus) { pinned = false; mark(null); }
    applySize(st.size);
    emit();
  }
  function apply() { render(cur()); save(); }
  function emit() {
    listeners.forEach(function (fn) {
      try { fn(api.getState()); } catch (e) { console.error("easy-read: onChange listener failed", e); }
    });
  }

  /* UI */
  function el(tag, attrs, kids) {
    var e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { e.appendChild(k); });
    return e;
  }
  function select(key, opts, label) {
    var sel = el("select", { "data-k": key });
    Object.keys(opts).forEach(function (v) { var o = el("option", { value: v, text: opts[v] }); if (s[key] === v) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", function () { s[key] = sel.value; apply(); });
    return el("label", {}, [doc.createTextNode(label), sel]);
  }
  function range(key, label, min, max, step) {
    var inp = el("input", { type: "range", min: min, max: max, step: step, value: s[key], "data-k": key });
    inp.addEventListener("input", function () { s[key] = parseFloat(inp.value); apply(); });
    return el("label", {}, [doc.createTextNode(label), inp]);
  }
  function check(key, label) {
    var inp = el("input", { type: "checkbox", "data-k": key }); inp.checked = !!s[key];
    inp.addEventListener("change", function () { s[key] = inp.checked; apply(); });
    return el("label", { class: "er-row" }, [doc.createTextNode(label), inp]);
  }
  var toggle = el("button", { id: "er-toggle", type: "button", class: "er-ui", "aria-expanded": "false",
    "aria-controls": "er-panel", "aria-label": "Reading comfort settings", text: "Aa" });
  var color = el("input", { type: "color", value: s.hl, "data-k": "hl", "aria-label": "Highlight colour" });
  color.addEventListener("input", function () { s.hl = color.value; apply(); });
  var reset = el("button", { type: "button", text: "Reset" });
  reset.addEventListener("click", function () {
    s = Object.assign({}, DEFAULTS); apply();
    panel.querySelectorAll("[data-k]").forEach(function (i) {
      var v = s[i.dataset.k]; if (i.type === "checkbox") i.checked = v; else i.value = v; });
  });
  var panel = el("div", { id: "er-panel", class: "er-ui", role: "dialog", "aria-label": "Reading comfort", hidden: "" }, [
    select("font", FONTS, "Font"), range("size", "Text size", 0.9, 1.6, 0.05),
    range("lh", "Line spacing (0 = page)", 0, 2.4, 0.1), range("ls", "Letter spacing", 0, 0.15, 0.01),
    select("scheme", SCHEMES, "Colours"), select("cvd", CVD_OPTS, "Colour vision"),
    check("bionic", "Bold word starts"),
    check("focus", "Focus highlight (Alt+↑/↓)"), el("label", { class: "er-row" }, [doc.createTextNode("Highlight colour"), color]),
    reset]);
  toggle.addEventListener("click", function () {
    panel.hidden = !panel.hidden; toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  function mount() { doc.body.appendChild(defs); doc.body.appendChild(toggle); doc.body.appendChild(panel); render(cur()); }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount); else mount();

  /* public API for hosts and add-ons (e.g. subtitles that must follow the same settings) */
  Object.assign(api, {
    setEnabled: function (on) {
      enabled = !!on;
      toggle.hidden = !enabled;
      if (!enabled) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
      if (doc.body.contains(toggle)) render(cur()); // before mount, mount() renders
    },
    getState: function () { return Object.assign({}, cur(), { enabled: enabled }); },
    onChange: function (fn) { listeners.push(fn); },
    /* text as a fragment, with bold word starts when that setting is on */
    emphasize: function (text) {
      var f = doc.createDocumentFragment();
      if (!cur().bionic) { f.appendChild(doc.createTextNode(text)); return f; }
      return emphasizeInto(f, text);
    }
  });
})();
