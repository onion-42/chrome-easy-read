/* text.js: pure text logic for immersive reading: citation filter, sentence chunks, word timing.
 * A classic script (no import/export) so Chrome can inject it; it publishes globalThis.erText.
 * A segment is { text, say }: `text` is shown in the subtitles, `say` goes to the voice
 * ("" = muted, e.g. a citation; a different string = replaced, e.g. a URL spoken as its domain). */
(function () {
  "use strict";
  if (globalThis.erText) return;

  var MIN_CHARS = 40;   // sentences shorter than this join the next one (fewer TTS requests)
  var PAUSE_WEIGHT = 3; // extra time a word gets before punctuation, in characters

  var NAME = "\\p{Lu}[\\p{L}'’\\-]+";
  var ETAL = "\\s+(?:et\\s+al\\.?|и\\s+др\\.?)";
  var COAUTHORS = "(?:(?:,?\\s+(?:and|&|и)\\s+" + NAME + "|,\\s+" + NAME + ")+(?:" + ETAL + ")?|" + ETAL + ")";
  var YEAR = "(?:19|20)\\d{2}[a-z]?";
  /* one name needs a comma ("Smith, 2020") so "(Since 2020)" or "(Windows 2000)" are still read;
   * the price: comma-less Harvard "(Smith 2020)" is read aloud */
  var AUTH = NAME + "(?:" + COAUTHORS + ",?|,)\\s+" + YEAR + "(?:\\s*,\\s*" + YEAR + ")*";
  var PREFIX = "(?:(?:e\\.g\\.|i\\.e\\.|see(?:\\s+also)?|cf\\.|reviewed\\s+in|напр\\.|см\\.(?:\\s+также)?)\\s*,?\\s*)?";
  var PAGE = "(?:с|c|p|pp|S)\\.\\s*\\d+(?:\\s*[-–—]\\s*\\d+)?";
  var NUMS = "\\d+[a-z]?(?:\\s*[-–—,;]\\s*\\d+[a-z]?)*";
  var SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";

  /* [kind, regex]; on overlapping matches the earlier start, then the longer one, then the earlier rule wins */
  var RULES = [
    ["doi", /(?:\bdoi:\s*|\bhttps?:\/\/(?:dx\.)?doi\.org\/)10\.\d{4,9}\/[^\s<>"]*[^\s<>".,;:)\]]/giu],
    ["url", /\b(?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:)\]]/giu],
    ["cite", new RegExp("\\[\\s*" + NUMS + "(?:\\s*,\\s*" + PAGE + ")?\\s*\\]", "gu")],             // [1, 2] [1, с. 25]
    ["cite", new RegExp("\\[[^\\[\\]]{1,80}?" + YEAR + "(?:\\s*,\\s*" + PAGE + ")?\\]", "gu")],      // [Иванов, 2020]
    ["cite", /\[(?:citation needed|clarification needed|note \d+|[a-z])\]/giu],                     // Wikipedia
    ["cite", new RegExp("\\(" + PREFIX + AUTH + "(?:\\s*;\\s*" + PREFIX + AUTH + ")*\\)", "gu")],   // (Smith et al., 2020)
    ["cite", new RegExp("(?<=(?:et\\s+al\\.|и\\s+др\\.|" + NAME + ")\\s)\\(" + YEAR + "(?:\\s*[,;]\\s*" + YEAR + ")*\\)", "gu")], // Smith (2020)
    /* mice¹² is a citation; 10⁶, m², metres², (a+b)² are not: a lone ² or ³ stays a unit / power */
    ["cite", new RegExp("(?<=(?:\\p{L}{3,}|[.,;:]))(?![²³](?![" + SUP + "⁻,]))[" + SUP + "]+(?:[⁻,][" + SUP + "]+)*", "gu")],
    ["mark", /(?<=[\p{L}\p{N}.,;:)])[*†‡§¶]+/gu]                                                     // author*
  ];

  function domainOf(url) {
    try { return new URL(/^www\./i.test(url) ? "http://" + url : url).hostname.replace(/^www\./, ""); }
    catch (e) { return ""; }
  }

  function sayFor(kind, text, opts) {
    if (kind === "url") return domainOf(text);
    if (kind === "cite" && opts.readCitations) return text;
    return "";
  }

  function findMatches(text) {
    var found = [];
    RULES.forEach(function (rule, priority) {
      rule[1].lastIndex = 0;
      var m;
      while ((m = rule[1].exec(text))) found.push({ start: m.index, end: m.index + m[0].length, kind: rule[0], priority: priority });
    });
    found.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.priority - b.priority; });
    var kept = [], lastEnd = 0;
    found.forEach(function (m) { if (m.start >= lastEnd) { kept.push(m); lastEnd = m.end; } });
    return kept;
  }

  /** Plain text -> segments with citations muted, URLs replaced by their domain. */
  function splitCitations(text, opts) {
    var o = opts || {}, out = [], pos = 0;
    findMatches(text).forEach(function (m) {
      if (m.start > pos) out.push({ text: text.slice(pos, m.start), say: text.slice(pos, m.start) });
      var t = text.slice(m.start, m.end);
      out.push({ text: t, say: sayFor(m.kind, t, o) });
      pos = m.end;
    });
    if (pos < text.length) out.push({ text: text.slice(pos), say: text.slice(pos) });
    return out;
  }

  /** Segments collected from the page (some already muted by DOM rules) -> filtered segments. */
  function splitSegments(segments, opts) {
    return segments.reduce(function (acc, s) {
      return acc.concat(s.say === s.text ? splitCitations(s.text, opts) : [s]);
    }, []);
  }

  /** A <sup> is a citation unless it follows a digit (10⁶) or a 1-2 letter unit (m², cm³). */
  function isCitationSup(supText, before, hasAnchorLink) {
    if (hasAnchorLink) return true;
    var prev = before.replace(/\s+$/, "");
    if (/\p{N}$/u.test(prev)) return false;
    var word = /\p{L}*$/u.exec(prev)[0];
    if (word.length > 0 && word.length <= 2) return false;
    return /^(?:\[[^\]]{1,40}\]|\(?\d+[a-z]?(?:\s*[-–—,]\s*\d+[a-z]?)*\)?|[a-z]|[*†‡§¶]+)$/iu.test(supText.trim());
  }

  var SUP_DIGITS = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", "−": "⁻" };
  var POWER = { ru: " в степени ", en: " to the power of " };

  /** A non-citation <sup>: digits are shown as superscript; after a number they are read as a power. */
  function supSay(supText, before, lang) {
    var t = supText.trim();
    if (!/^[-−]?\d+$/.test(t)) return { text: supText, say: supText };
    var shown = t.replace(/./g, function (c) { return SUP_DIGITS[c] || c; });
    if (!/\p{N}$/u.test(before.replace(/\s+$/, ""))) return { text: shown, say: " " + t };
    return { text: shown, say: (POWER[(lang || "en").slice(0, 2)] || POWER.en) + t };
  }

  /* index of the sentence that owns a muted/replaced segment starting at pos:
   * muted ones (say "") stay with the sentence they follow */
  function ownerOf(ranges, pos, isEmpty) {
    for (var j = 0; j < ranges.length; j++) {
      var r = ranges[j];
      if (isEmpty ? (pos > r[0] && pos <= r[1]) || (pos === 0 && j === 0) : pos >= r[0] && pos < r[1]) return j;
    }
    return ranges.length - 1;
  }

  /** Segments -> sentence chunks { parts, say }; parts keep muted text for the subtitles. */
  function toChunks(segments, opts) {
    var o = opts || {}, minChars = o.minChars || MIN_CHARS, say = "", starts = [];
    segments.forEach(function (s) { starts.push(say.length); say += s.say; });
    if (!say.trim()) return [];
    var sentences = Array.from(new Intl.Segmenter(o.lang || undefined, { granularity: "sentence" }).segment(say),
      function (x) { return [x.index, x.index + x.segment.length]; });
    var ranges = [];
    sentences.forEach(function (r) {
      var last = ranges[ranges.length - 1];
      if (last && say.slice(last[0], last[1]).trim().length < minChars) last[1] = r[1];
      else ranges.push(r.slice());
    });
    var chunks = ranges.map(function (r) { return { parts: [], say: say.slice(r[0], r[1]) }; });
    segments.forEach(function (s, i) {
      var a = starts[i], b = a + s.say.length;
      if (s.say !== s.text) { chunks[ownerOf(ranges, a, !s.say)].parts.push(s); return; }
      ranges.forEach(function (r, j) {
        var x = Math.max(a, r[0]), y = Math.min(b, r[1]);
        if (y > x) chunks[j].parts.push({ text: s.text.slice(x - a, y - a), say: s.text.slice(x - a, y - a) });
      });
    });
    return chunks;
  }

  var WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

  /** Estimated start time of each word, for voices that report no word timings. */
  function wordTimings(say, durationMs) {
    var words = [], total = 0, m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(say))) {
      var end = m.index + m[0].length;
      var weight = m[0].length + 1 + (/^\s*[.,;:!?—–]/.test(say.slice(end, end + 3)) ? PAUSE_WEIGHT : 0);
      words.push({ index: m.index, length: m[0].length, weight: weight });
      total += weight;
    }
    var acc = 0;
    return words.map(function (w) {
      var t = total ? (acc / total) * durationMs : 0;
      acc += w.weight;
      return { index: w.index, length: w.length, t: t };
    });
  }

  /** Char index (in `say`) of the word being spoken at ms, or -1. */
  function wordAt(timings, ms) {
    var hit = -1;
    for (var i = 0; i < timings.length && timings[i].t <= ms; i++) hit = timings[i].index;
    return hit;
  }

  globalThis.erText = {
    splitCitations: splitCitations, splitSegments: splitSegments, isCitationSup: isCitationSup, supSay: supSay,
    toChunks: toChunks, wordTimings: wordTimings, wordAt: wordAt
  };
})();
