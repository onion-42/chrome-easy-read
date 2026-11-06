// PDF text items -> reading blocks: lines, paragraphs, headings, two columns, no running headers.
// Pure (no PDF.js here): the viewer passes items with x, y (y grows upwards), width w and font size.

const BAND = 0.1;          // share of the page height at top and bottom where running headers live
const MARGIN = 0.09;       // share of the page width at the sides where line numbers live
const SAME_LINE = 0.5;     // baselines closer than this (in font sizes) are one line
const SPACE_GAP = 0.15;    // a horizontal gap wider than this (in font sizes) means a space
const COLUMN_GAP = 2;      // a gap wider than this (in font sizes) splits a row into column pieces
const GUTTER = 0.02;       // tolerance around the page middle, as a share of the width
const TWO_COLUMNS = 0.25;  // share of lines starting right of the middle that makes a page two-column
const PARA_GAP = 1.5;      // a line gap this many times the usual one starts a paragraph
const LINE_SPACING = 1.6;  // the usual line gap is at most this many font sizes (few lines: no good median)
const INDENT = 0.8;        // first-line indent, in font sizes
const SIZE_STEP = 0.15;    // a font size change bigger than this share starts a paragraph
const HEADING = 1.15;      // a paragraph this much larger than body text is a heading...
const HEADING_MAX = 200;   // ...if it is shorter than this many characters
const SENTENCE_END = /[.!?:;"”»)\]]$/;

const BROKEN_LINK = /(?:https?:\/\/|www\.|doi:)\S*[-/._]$/i; // a URL or DOI cut at a line end

/** Lines joined into one text. A hyphen at a line end before a lowercase letter is a split word
 * (a real compound hyphen there, "short-chain", cannot be told apart and is lost too). */
function joinLines(texts) {
  return texts.reduce((acc, t) => {
    if (!acc) return t;
    if (BROKEN_LINK.test(acc) || (/\p{N}-$/u.test(acc) && /^\p{N}/u.test(t))) return acc + t;
    if (/\p{L}[-­]$/u.test(acc) && /^\p{Ll}/u.test(t)) return acc.slice(0, -1) + t;
    return `${acc} ${t}`;
  }, "").replace(/\s+/g, " ").trim();
}

function isLineNumber(item, width) {
  return /^\d{1,4}$/.test(item.str.trim()) && (item.x < width * MARGIN || item.x > width * (1 - MARGIN));
}

/* items -> rows of items sharing a baseline, top to bottom */
function rows(items) {
  const out = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = out[out.length - 1];
    if (row && Math.abs(row.y - item.y) < SAME_LINE * Math.max(row.size, item.size)) {
      row.items.push(item);
      row.size = Math.max(row.size, item.size);
    } else out.push({ y: item.y, size: item.size, items: [item] });
  }
  return out;
}

function toLine(items, y) {
  let text = "";
  items.forEach((item, i) => {
    const prev = items[i - 1];
    if (prev && item.x - (prev.x + prev.w) > item.size * SPACE_GAP && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
    text += item.str;
  });
  const last = items[items.length - 1];
  return { text: text.replace(/\s+/g, " ").trim(), x: items[0].x, xEnd: last.x + last.w, y,
    size: Math.max(...items.map((i) => i.size)) };
}

/* a row split at wide gaps: the left and right column pieces of a two-column page become separate lines */
function pieces(row) {
  const items = [...row.items].sort((a, b) => a.x - b.x);
  const groups = [[items[0]]];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    if (items[i].x - (prev.x + prev.w) > COLUMN_GAP * row.size) groups.push([items[i]]);
    else groups[groups.length - 1].push(items[i]);
  }
  return groups.map((g) => toLine(g, row.y));
}

function pageLines(p) {
  const items = p.items.filter((i) => i.str.trim() && !isLineNumber(i, p.width));
  return rows(items).flatMap(pieces);
}

/* drop lines in the top/bottom band that repeat (numbers ignored) on at least half of the pages */
function dropRunningLines(pages) {
  if (pages.length < 2) return pages;
  const key = (t) => t.replace(/\d+/g, "#").toLowerCase().trim();
  const inBand = (l, h) => l.y > h * (1 - BAND) || l.y < h * BAND;
  const counts = new Map();
  for (const pg of pages) {
    new Set(pg.lines.filter((l) => inBand(l, pg.height)).map((l) => key(l.text)))
      .forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
  }
  const limit = Math.max(2, Math.ceil(pages.length / 2));
  return pages.map((pg) => ({
    ...pg, lines: pg.lines.filter((l) => !(inBand(l, pg.height) && counts.get(key(l.text)) >= limit)),
  }));
}

/* reading order: wide lines above the columns, left column, right column, wide lines below */
function regions(lines, width) {
  if (!lines.length) return [];
  const mid = width / 2, tol = width * GUTTER;
  const isRight = (l) => l.x > mid - tol;
  const isLeft = (l) => l.xEnd < mid + tol;
  const right = lines.filter(isRight);
  if (right.length < 2 || right.length < lines.length * TWO_COLUMNS) return [lines];
  const cols = lines.filter((l) => isLeft(l) || isRight(l));
  const top = Math.max(...cols.map((l) => l.y));
  const wide = lines.filter((l) => !isLeft(l) && !isRight(l));
  return [wide.filter((l) => l.y > top), cols.filter(isLeft), cols.filter((l) => !isLeft(l)), wide.filter((l) => l.y <= top)]
    .filter((r) => r.length);
}

function paragraphs(lines) {
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > 0).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
  const left = Math.min(...lines.map((l) => l.x));
  const indented = (l) => l.x - left > INDENT * l.size;
  const out = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    const usual = Math.min(median, prev ? prev.size * LINE_SPACING : Infinity);
    const starts = !prev || prev.y - l.y > usual * PARA_GAP
      || Math.abs(l.size - prev.size) > prev.size * SIZE_STEP
      || (indented(l) && !indented(prev));
    if (starts) out.push({ lines: [l.text], size: l.size });
    else out[out.length - 1].lines.push(l.text);
  });
  return out.map((p) => ({ text: joinLines(p.lines), size: p.size }));
}

/* the font size that carries most of the text */
function bodySize(pages) {
  const weight = new Map();
  for (const l of pages.flatMap((p) => p.lines)) {
    const s = Math.round(l.size * 2) / 2;
    weight.set(s, (weight.get(s) || 0) + l.text.length);
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

/* a paragraph that runs on into the next column or page (no sentence end, lowercase start) is joined */
function addBlock(blocks, para, page, body) {
  const kind = para.size >= body * HEADING && para.text.length < HEADING_MAX ? "h" : "p";
  const last = blocks.findLast((b) => b.kind !== "page");
  if (kind === "p" && last?.kind === "p" && !SENTENCE_END.test(last.text) && /^\p{Ll}/u.test(para.text)) {
    blocks[blocks.lastIndexOf(last)] = { ...last, text: joinLines([last.text, para.text]) };
    return;
  }
  blocks.push({ kind, text: para.text, page });
}

const MAX_CANVAS_SIDE = 8192;    // safe canvas limits in Chrome (a poster strip would pass the hard ones)
const MAX_CANVAS_PIXELS = 16e6;

/** Scale for drawing a page: the column width at the screen's pixel density, kept inside canvas limits. */
export function drawScale(pageWidth, pageHeight, cssWidth, dpr) {
  const wanted = (cssWidth / pageWidth) * dpr;
  const bySide = MAX_CANVAS_SIDE / Math.max(pageWidth, pageHeight);
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / (pageWidth * pageHeight));
  return Math.min(wanted, bySide, byArea);
}

/** One PDF.js page -> { width, height, items } in the shape reflow() expects (y grows upwards). */
export async function pageToItems(page) {
  const viewport = page.getViewport({ scale: 1 }); // handles rotation and odd page origins
  const content = await page.getTextContent();
  const items = content.items.filter((i) => typeof i.str === "string").map((i) => {
    const [x, yDown] = viewport.convertToViewportPoint(i.transform[4], i.transform[5]);
    return { str: i.str, x, y: viewport.height - yDown, w: i.width, size: Math.hypot(i.transform[2], i.transform[3]) || i.height };
  });
  return { width: viewport.width, height: viewport.height, items };
}

/**
 * pages: [{ width, height, items: [{ str, x, y, w, size }] }] (y grows upwards)
 * -> [{ kind: "page", page } | { kind: "h" | "p", text, page }]
 */
export function reflow(pages) {
  const prepared = dropRunningLines(pages.map((p, i) => ({ page: i + 1, width: p.width, height: p.height, lines: pageLines(p) })));
  const body = bodySize(prepared);
  const blocks = [];
  for (const pg of prepared) {
    blocks.push({ kind: "page", page: pg.page });
    for (const region of regions(pg.lines, pg.width)) {
      for (const para of paragraphs(region)) addBlock(blocks, para, pg.page, body);
    }
  }
  return blocks;
}
