// Paper and note text for the Zotero <-> Obsidian link. Pure: no network, no fs, no DOM, no chrome.*.
// One source of truth (skill zotero-link); both extensions ship byte-identical copies.

export const PAPERS_DIR = "1_education/papers";
export const NOTES_DIR = "1_education/papers/notes";
export const INBOX_PATH = "2_work/inbox.md";

// ---------- identity ----------

// Regex body = easy-read text.js (DOI in running text).
export const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"]*[^\s<>".,;:)\]]/iu;
const DOI_META = ["citation_doi", "dc.identifier", "prism.doi", "bepress_citation_doi"];

function safeDecode(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export function findDoi({ meta = {}, url = "", text = "" } = {}) {
  for (const name of DOI_META) {
    const m = DOI_RE.exec(meta[name] || "");
    if (m) return m[0].toLowerCase();
  }
  const m = DOI_RE.exec(safeDecode(url)) || DOI_RE.exec(text.slice(0, 4000));
  return m ? m[0].toLowerCase() : null;
}

const PUBMED_URL = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/;
export function findPmid({ meta = {}, url = "" } = {}) {
  const fromMeta = /^\d+$/.exec((meta["citation_pmid"] || "").trim());
  if (fromMeta) return fromMeta[0];
  const fromUrl = PUBMED_URL.exec(url);
  return fromUrl ? fromUrl[1] : null;
}

/** Address of the document's PDF: the PDF itself, else citation_pdf_url (may be relative to the page), else null. */
export function pdfUrlOf({ meta = {}, url = "", isPdf = false } = {}) {
  if (isPdf) return url || null;
  const raw = (meta["citation_pdf_url"] || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw, url || undefined).href;
  } catch {
    return null;
  }
}

// ---------- small helpers ----------

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const stripTags = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const ascii = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Value of a "key: value" line in Zotero's Extra field, or null. */
export function extraGet(extra, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.+)$`, "im").exec(extra || "");
  return m ? m[1].trim() : null;
}

/** Extra with the "key: value" line set (replaced or appended). Returns a new string. */
export function extraSet(extra, key, value) {
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:.*$`, "im");
  if (re.test(extra || "")) return extra.replace(re, line);
  return extra ? `${extra.trimEnd()}\n${line}` : line;
}

// ---------- Crossref / Zenodo -> Zotero item ----------

export function crossrefToItem(m, doi) {
  const creators = (m.author || []).map((a) => ({ creatorType: "author", lastName: a.family || a.name || "", firstName: a.given || "" }));
  const parts = (m.published || m.issued || {})["date-parts"]?.[0] || [];
  const base = {
    title: stripTags((m.title || []).join(" ")),
    creators,
    DOI: doi,
    url: `https://doi.org/${doi}`,
    date: parts.map((x) => String(x).padStart(2, "0")).join("-"),
    abstractNote: stripTags(m.abstract).slice(0, 6000),
  };
  if (m.type === "posted-content") {
    return { itemType: "preprint", ...base, repository: m.institution?.[0]?.name || "bioRxiv" };
  }
  return {
    itemType: "journalArticle",
    ...base,
    publicationTitle: (m["container-title"] || []).join(" "),
    volume: m.volume || "",
    issue: m.issue || "",
    pages: m.page || "",
  };
}

export function zenodoToItem(m, doi) {
  const creators = (m.creators || []).map((c) => ({
    creatorType: "author",
    lastName: c.name.split(",")[0].trim(),
    firstName: c.name.includes(",") ? c.name.split(",").at(-1).trim() : "",
  }));
  return {
    itemType: "dataset",
    title: m.title,
    creators,
    DOI: doi,
    url: `https://doi.org/${doi}`,
    date: m.publication_date || "",
    repository: "Zenodo",
    abstractNote: stripTags(m.description).slice(0, 3000),
  };
}

// ---------- paper note ("passport") ----------

const STOP = new Set(["a", "an", "the", "of", "in", "on", "for", "and", "to", "by", "with", "from", "at", "as", "is", "are", "via"]);
const familyOf = (item) => item.creators?.[0]?.lastName || item.creators?.[0]?.name || "";
const yearOf = (item) => /\d{4}/.exec(item.date || "")?.[0] || "";

export function slugOf(item) {
  const words = ascii(item.title).split("-").filter((w) => w && !STOP.has(w)).slice(0, 3);
  return [ascii(familyOf(item)), yearOf(item), ...words].filter(Boolean).join("-") || "paper";
}

/** slug, or slug-2, slug-3… when taken (roast 4: computed once, then stored in Extra). */
export function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

export const paperLabel = (item) => [familyOf(item), yearOf(item)].filter(Boolean).join(" ") || "Статья";
const sourceOf = (item) => item.publicationTitle || item.repository || item.websiteTitle || "";
export const zoteroLink = (key) => `zotero://select/library/items/${key}`;
const linkOf = (item) => (item.DOI ? `https://doi.org/${item.DOI}` : item.url || "");

export function paperNote(item, { key, slug, why = "", tags = "#papers" }) {
  const head = [
    `- **Первый автор:** ${familyOf(item) || "—"} · **Год:** ${yearOf(item) || "—"} · **Источник:** ${sourceOf(item) || "—"}`,
    item.DOI ? `- **DOI:** https://doi.org/${item.DOI}` : `- **Адрес:** ${item.url || "—"}`,
  ];
  const pmid = extraGet(item.extra, "PMID");
  if (pmid) head.push(`- **PMID:** ${pmid}`);
  head.push(`- **Zotero:** [открыть в Zotero](${zoteroLink(key)}) · ключ \`${key}\``);
  const pdf = extraGet(item.extra, "pdf");
  if (pdf) head.push(pdfLine(pdf));
  head.push(`- **Зачем читаю:** ${why}`);
  return `# ${paperLabel(item)} — ${item.title || slug}\n\n${head.join("\n")}\n\n## Заметки\n\n\n### 🔗 context - Связано с:\n\n${tags}\n`;
}

export const PAPER_KEY_RE = /zotero:\/\/select\/library\/items\/([A-Z0-9]{8})/;
const pdfLine = (path) => `- **PDF:** [[${path.split("/").at(-1)}]]`;

/** Paper note with the PDF line (after the Zotero line). Unchanged text when it is already there. */
export function withPdfLine(text, pdfPath) {
  if (/^- \*\*PDF:\*\*/m.test(text)) return text;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("- **Zotero:**"));
  if (at < 0) return text;
  return [...lines.slice(0, at + 1), pdfLine(pdfPath), ...lines.slice(at + 1)].join("\n");
}

/** Paper note with "- [[noteName]]" appended to the "## Заметки" section. Append-only. */
export function withNoteLink(text, noteName) {
  if (text.includes(`[[${noteName}]]`)) return text;
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.trim() === "## Заметки");
  if (head < 0) return text;
  let end = lines.findIndex((l, i) => i > head && /^#{1,6} /.test(l));
  if (end < 0) end = lines.length;
  let last = end;
  while (last > head + 1 && lines[last - 1].trim() === "") last--;
  return [...lines.slice(0, last), `- [[${noteName}]]`, "", ...lines.slice(end)].join("\n");
}

export function inboxLine(item, slug) {
  const source = sourceOf(item);
  const link = linkOf(item);
  return `- [ ] Статья ${paperLabel(item)}${source ? ` (${source})` : ""} · low · [[${slug}]]${link ? `; ${link}` : ""}`;
}

/** Inbox text with the line added at the end of the task list. Unchanged when the slug is already mentioned. */
export function withInboxLine(text, line, slug) {
  if (text.includes(`[[${slug}]]`)) return text;
  const lines = text.replace(/\n+$/, "").split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (/^- \[[ x]\]/.test(l)) last = i;
  });
  if (last < 0) return `${lines.join("\n")}\n${line}\n`;
  return `${[...lines.slice(0, last + 1), line, ...lines.slice(last + 1)].join("\n")}\n`;
}

// ---------- note body <-> Zotero HTML ----------
// Supported: p, br, strong, em, code, a, blockquote, ul/ol/li, h1-h3.

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeHtml = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

function inlineToHtml(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  const out = text
    .replace(/`([^`]+)`/g, (_, c) => keep(`<code>${escapeHtml(c)}</code>`))
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, href) => keep(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`));
  return escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

export function mdToHtml(md) {
  const out = [];
  for (const block of md.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    const heading = lines.length === 1 && /^(#{1,3}) (.+)$/.exec(lines[0]);
    if (heading) out.push(`<h${heading[1].length}>${inlineToHtml(heading[2])}</h${heading[1].length}>`);
    else if (lines.every((l) => l.startsWith(">"))) out.push(`<blockquote>${mdToHtml(lines.map((l) => l.replace(/^> ?/, "")).join("\n"))}</blockquote>`);
    else if (lines.every((l) => /^[-*] /.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inlineToHtml(l.slice(2))}</li>`).join("")}</ul>`);
    else if (lines.every((l) => /^\d+\. /.test(l))) out.push(`<ol>${lines.map((l) => `<li>${inlineToHtml(l.replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`);
    else out.push(`<p>${lines.map(inlineToHtml).join("<br>")}</p>`);
  }
  return out.join("\n");
}

const VOID = new Set(["br", "img", "hr"]);
const BLOCK = new Set(["p", "div", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre"]);

function parseHtml(html) {
  const root = { tag: "root", kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
  for (let m; (m = re.exec(html)); ) {
    const top = stack.at(-1);
    if (m[4] !== undefined) top.kids.push({ text: unescapeHtml(m[4]) });
    else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) {
        const at = stack.findLastIndex((n) => n.tag === tag);
        if (at > 0) stack.length = at;
      } else {
        const node = { tag, kids: [], href: /href\s*=\s*["']([^"']*)["']/i.exec(m[3])?.[1] };
        top.kids.push(node);
        if (!VOID.has(tag) && !m[3].trim().endsWith("/")) stack.push(node);
      }
    }
  }
  return root;
}

function inlineMd(node) {
  if (node.text !== undefined) return node.text.replace(/\s+/g, " ");
  const inner = node.kids.map(inlineMd).join("");
  if (node.tag === "br") return "\n";
  if (!inner.trim()) return inner;
  if (node.tag === "strong" || node.tag === "b") return `**${inner}**`;
  if (node.tag === "em" || node.tag === "i") return `*${inner}*`;
  if (node.tag === "code") return `\`${inner}\``;
  if (node.tag === "a" && node.href) return `[${inner}](${unescapeHtml(node.href)})`;
  return inner;
}

const tidy = (s) => s.split("\n").map((l) => l.trim()).join("\n").trim();

function blocksMd(node) {
  const blocks = [];
  let run = "";
  const flush = () => {
    const t = tidy(run);
    run = "";
    if (t) blocks.push(t);
  };
  for (const kid of node.kids) {
    if (kid.text !== undefined || !BLOCK.has(kid.tag)) {
      run += inlineMd(kid);
      continue;
    }
    flush();
    if (kid.tag === "blockquote") {
      const inner = blocksMd(kid).join("\n\n");
      if (inner) blocks.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
    } else if (kid.tag === "ul" || kid.tag === "ol") {
      const items = kid.kids.filter((k) => k.tag === "li").map((li) => blocksMd(li).join(" ").replace(/\n/g, " "));
      if (items.length) blocks.push(items.map((t, i) => (kid.tag === "ul" ? `- ${t}` : `${i + 1}. ${t}`)).join("\n"));
    } else if (/^h[1-6]$/.test(kid.tag)) {
      const t = tidy(inlineMd(kid)).replace(/\n/g, " ");
      if (t) blocks.push(`${"#".repeat(Math.min(Number(kid.tag[1]), 3))} ${t}`);
    } else blocks.push(...blocksMd(kid));
  }
  flush();
  return blocks;
}

/** Zotero note HTML -> markdown body (drops Zotero's <div data-schema-version> wrapper). */
export const htmlToMd = (html) => blocksMd(parseHtml(html || "")).join("\n\n");

// Images, tables and Zotero's own annotation/citation embeds cannot be kept in markdown.
export const RICH_HTML = /<(img|table)\b|data-annotation=|data-citation=/i;

// ---------- note file ----------

export const MARKER_RE = /^%% zotero-note: (\w{8}|deleted) · v(\d+) · h:([0-9a-f]{8})( · ro)? %%$/m;
const PAPER_LINE_RE = /^Статья: \[\[([^\]|#]+)\]\][ \t]*$/m;
const TAG_LINE_RE = /^#[\p{L}\d][^\n]*$/u;
export const SUMMARY_TAG = "summary";
const NOTE_TAGS = "#papers #paper-note";

/** -> { title, paperSlug, body, summary, marker: { key, version, hash, readOnly } | null } or null when it is not a note file. */
export function parseNoteFile(text) {
  const paper = PAPER_LINE_RE.exec(text);
  if (!paper) return null;
  const title = /^# (.+)$/m.exec(text)?.[1].trim() || "";
  const marker = MARKER_RE.exec(text);
  let rest = text.slice(paper.index + paper[0].length);
  let tail = "";
  if (marker) {
    rest = text.slice(paper.index + paper[0].length, marker.index);
    tail = text.slice(marker.index + marker[0].length);
  } else {
    const lines = rest.replace(/\s+$/, "").split("\n");
    if (TAG_LINE_RE.test(lines.at(-1) || "")) {
      tail = lines.pop();
      rest = lines.join("\n");
    }
  }
  return {
    title,
    paperSlug: paper[1].trim(),
    body: rest.trim(),
    summary: /(^|\s)#paper-summary(\s|$)/.test(tail),
    marker: marker && { key: marker[1], version: Number(marker[2]), hash: marker[3], readOnly: Boolean(marker[4]) },
  };
}

export function renderNoteFile({ title, paperSlug, body, key, version, readOnly = false, summary = false }) {
  const marker = `%% zotero-note: ${key} · v${version} · h:${fnv1a(body.trim())}${readOnly ? " · ro" : ""} %%`;
  return `# ${title}\n\nСтатья: [[${paperSlug}]]\n\n${body.trim()}\n\n${marker}\n${NOTE_TAGS}${summary ? " #paper-summary" : ""}\n`;
}

/** "Lin 2023 — <first words of my comment, else of the quote>". */
export function noteTitle(label, body, summary = false) {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.find((l) => !l.startsWith(">") && !/^https?:\/\//.test(l) && !/^Стр\. /.test(l));
  const text = (own || lines[0] || "заметка").replace(/^>\s*/, "").replace(/[*`#[\]|]/g, "").trim();
  const short = text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
  return `${label} — ${summary ? "вывод: " : ""}${short}`;
}

export const noteFileName = (paperSlug, key) => `${paperSlug}--${key}.md`;

/** Body of a new note: quote, my comment, source line. */
export function noteBody({ quote = "", comment = "", page = null, url = "" }) {
  const parts = [];
  if (quote.trim()) parts.push(quote.trim().split(/\n+/).map((l) => `> ${l.trim()}`).join("\n"));
  if (comment.trim()) parts.push(comment.trim());
  const source = [page ? `Стр. ${page}` : "", url].filter(Boolean).join(" · ");
  if (source && quote.trim()) parts.push(source);
  return parts.join("\n\n");
}

/** The quoted text of a note body (first blockquote), or "". */
export function quoteOf(body) {
  const lines = [];
  for (const line of body.split("\n")) {
    if (line.startsWith(">")) lines.push(line.replace(/^> ?/, ""));
    else if (lines.length) break;
  }
  return lines.join(" ").trim();
}

// ---------- the two-way decision ----------

/**
 * local: { body, marker } | null        remote: { key, version, html, deleted } | null
 * Every sync reads all remote notes, so `remote === null` for a marked file means "gone from Zotero".
 */
export function decide({ local, remote }) {
  if (!local) return !remote || remote.deleted ? { op: "skip" } : { op: "create-file", readOnly: RICH_HTML.test(remote.html) };
  if (!local.marker) return { op: "create-remote" };
  if (local.marker.key === "deleted") return { op: "skip" };
  if (!remote || remote.deleted) return { op: "mark-deleted" };
  const localChanged = fnv1a(local.body.trim()) !== local.marker.hash;
  const remoteChanged = remote.version > local.marker.version;
  if (local.marker.readOnly || RICH_HTML.test(remote.html)) return remoteChanged ? { op: "pull", readOnly: true } : { op: "skip" };
  if (localChanged && remoteChanged) return { op: "conflict" };
  if (remoteChanged) return { op: "pull" };
  if (localChanged) return { op: "push" };
  return { op: "skip" };
}

export function mergeConflict(localBody, remoteMd, date) {
  return `${localBody.trimEnd()}\n\n---\n\n**Конфликт ${date}: версия из Zotero**\n\n${remoteMd.trim()}\n`;
}

// ---------- quote location (highlighting) ----------

const norm = (t) => t.replace(/­/g, "").replace(/\s+/g, " ").trim();

/** For raw block text: index in its normalised form -> index in the raw text (same rules as `norm`). */
export function normIndexMap(raw) {
  const map = [];
  let lastSpace = true; // leading whitespace is trimmed
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\u00ad") continue;
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      lastSpace = true;
    } else lastSpace = false;
    map.push(i);
  }
  return map;
}

/** Where is the quote? blocks = text of each readable block. -> { block, start, length } in normalised text, or null. */
export function locateQuote(blocks, quote) {
  const q = norm(quote);
  for (const probe of [q, q.slice(0, 80)]) {
    if (probe.length < 12) continue;
    for (let i = 0; i < blocks.length; i++) {
      const at = norm(blocks[i]).indexOf(probe);
      if (at >= 0) return { block: i, start: at, length: probe.length };
    }
  }
  return null;
}
