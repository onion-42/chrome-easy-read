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
  const raw = isPdf ? url : (meta["citation_pdf_url"] || "").trim();
  if (!raw) return null;
  try {
    const found = new URL(raw, url || undefined);
    return /^https?:$/.test(found.protocol) ? found.href : null; // a page must not point the viewer at file: or chrome:
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

// ---------- materials of a paper ----------
// A material = a Zotero child of the paper: attachment, linked_url, tags paper-material + material-<kind>.
// A file of the vault is linked by an obsidian:// address (Zotero keeps it: checked on the live API).

export const MATERIAL_TAG = "paper-material";
export const MATERIALS_DIR = "1_education/papers/materials";
export const MATERIAL_KINDS = { pdf: "PDF", note: "заметка", doc: "документ", sheet: "таблица", video: "видео", thread: "тред", slides: "слайды", link: "ссылка" };
// kinds that can be a file kept in the vault, by file extension
const FILE_KINDS = [["pdf", /\.pdf$/i], ["note", /\.md$/i], ["doc", /\.docx?$/i], ["sheet", /\.xlsx?$/i]];
const fileKind = (name) => FILE_KINDS.find(([, ext]) => ext.test(name))?.[0] || "";

/** Can a file with this name be attached as a material (PDF, .md, Word, Excel)? */
export const isMaterialFile = (name) => fileKind(name) !== "";
const VIDEO_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com", "vimeo.com"];

/** Kind of a material from its address or file name. */
export function materialKind(target) {
  const file = fileKind(target);
  if (file) return file;
  let host = "", path = "";
  try {
    const u = new URL(target);
    host = u.hostname.replace(/^(www|m|mobile)\./, "");
    path = u.pathname;
  } catch {
    return "link";
  }
  if (VIDEO_HOSTS.includes(host)) return "video";
  if (host === "x.com" || host === "twitter.com") return "thread";
  if (host === "docs.google.com" && path.startsWith("/presentation/")) return "slides";
  if (host === "docs.google.com" && path.startsWith("/document/")) return "doc";
  if (host === "docs.google.com" && path.startsWith("/spreadsheets/")) return "sheet";
  return "link";
}

/** File name of a material kept for the paper: <paper-slug>--<name>.<ext>. */
export function materialFileName(paperSlug, fileName) {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const stem = ascii(dot > 0 ? fileName.slice(0, dot) : fileName).slice(0, 60) || "file";
  return `${paperSlug}--${stem}${ext ? `.${ext}` : ""}`;
}

const obsidianUrl = (vaultName, path) =>
  `obsidian://open?${vaultName ? `vault=${encodeURIComponent(vaultName)}&` : ""}file=${encodeURIComponent(path)}`;

/** The Zotero child item of a material. target = an address, or a path inside the vault. */
export function materialItem({ parent, title = "", target, vaultName = "" }) {
  const kind = materialKind(target);
  // an address that ends in .pdf / .md / .xlsx (arxiv.org/pdf/….pdf) is still an address, not a file of the vault
  const isFile = isMaterialFile(target) && !/^[a-z][a-z0-9+.-]*:/i.test(target);
  return {
    itemType: "attachment",
    linkMode: "linked_url",
    parentItem: parent,
    title: title.trim() || target,
    url: isFile ? obsidianUrl(vaultName, target) : target,
    tags: [{ tag: MATERIAL_TAG }, { tag: `material-${kind}` }],
  };
}

/** Is this Zotero child a material that is still attached? */
export const isMaterial = (it) => !it.data.deleted && (it.data.tags || []).some((t) => t.tag === MATERIAL_TAG);

/** Zotero child item -> { key, title, kind, url, path } (path: inside the vault, "" for an address). */
export function materialView(it) {
  const url = it.data.url || "";
  const kind = (it.data.tags || []).map((t) => /^material-(\w+)$/.exec(t.tag)?.[1]).find(Boolean) || "link";
  let path = "";
  if (url.startsWith("obsidian://")) {
    try {
      path = new URL(url).searchParams.get("file") || "";
    } catch {
      path = ""; // an address typed by hand in Zotero: shown as a plain link
    }
  }
  return { key: it.key, title: it.data.title || url, kind, url, path };
}

/** Where a click on a material goes: a PDF kept in 0_media/papers/ opens in the easy-read viewer. */
export const materialHref = (m, viewerUrl) =>
  m.kind === "pdf" && m.path.startsWith("0_media/papers/") ? `${viewerUrl}?vault=${encodeURIComponent(m.path)}` : m.url;

/** Paper note with one material line in "## Материалы" (the section is created before "## Заметки").
 * Append-only: unchanged when the material's Zotero key is already mentioned. */
export function withMaterialLine(text, m) {
  const mark = `%%m:${m.key}%%`;
  if (text.includes(mark)) return text;
  const link = m.path ? `[[${m.path.split("/").at(-1).replace(/\.md$/, "")}]]` : `[${m.title.replace(/[[\]]/g, "")}](${m.url})`;
  const line = `- ${MATERIAL_KINDS[m.kind] || m.kind}: ${link}${m.path ? ` — ${m.title}` : ""} ${mark}`;
  const lines = text.split("\n");
  let head = lines.findIndex((l) => l.trim() === "## Материалы");
  if (head < 0) {
    const notes = lines.findIndex((l) => l.trim() === "## Заметки");
    if (notes < 0) return text;
    lines.splice(notes, 0, "## Материалы", "");
    head = notes;
  }
  let end = lines.findIndex((l, i) => i > head && /^#{1,6} /.test(l));
  if (end < 0) end = lines.length;
  let last = end;
  while (last > head + 1 && lines[last - 1].trim() === "") last--;
  return [...lines.slice(0, last), line, "", ...lines.slice(end)].join("\n");
}

// "Статья Lin 2023 (Cell)": how every reading task starts, in the inbox and in a plan.
function taskHead(item) {
  const source = sourceOf(item);
  return `Статья ${paperLabel(item)}${source ? ` (${source})` : ""}`;
}

export function inboxLine(item, slug) {
  const link = linkOf(item);
  return `- [ ] ${taskHead(item)} · low · [[${slug}]]${link ? `; ${link}` : ""}`;
}

/** The «Что» cell of a plan row for a new paper. The links come after the first "; " or " · ", so the bar label
 * and the row id of the plan stay short. */
export function planTaskText(item, slug, key) {
  const link = linkOf(item);
  return `${taskHead(item)}${link ? `; ${link}` : ""} · [[${slug}]] · [Zotero](${zoteroLink(key)})`;
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

export const PAPER_TASK = /^Статья(\s|$)/;
export const READ_TAG = "read"; // Zotero tag of a paper that has been read

/** The reading task of the paper on one line, or null: { open, closed } (closed = the line with its tick set).
 * A reading task starts with "Статья" and links the paper: an inbox line "- [ ] Статья …", or a plan-table row whose
 * «Что» cell starts so and which has a «Готово» cell. Lines that only mention the paper are not tasks.
 * ctx.doneAt carries the «Готово» column of the table being read from line to line. */
function readingTask(line, link, ctx) {
  const isRow = line.trimStart().startsWith("|");
  if (!isRow) {
    ctx.doneAt = -1;
    const task = /^(\s*- )\[([ xX])\]( .*)$/.exec(line);
    if (!task || !line.includes(link) || !PAPER_TASK.test(task[3].trim())) return null;
    return { open: task[2] === " ", closed: `${task[1]}[x]${task[3]}` };
  }
  const cells = line.split("|");
  const header = cells.findIndex((c) => c.trim().toLowerCase() === "готово");
  if (header >= 0) ctx.doneAt = header;
  const mark = cells[ctx.doneAt]?.trim().toLowerCase();
  if (!line.includes(link) || (mark !== "[ ]" && mark !== "[x]") || !cells.some((c) => PAPER_TASK.test(c.trim()))) return null;
  return { open: mark === "[ ]", closed: cells.map((c, n) => (n === ctx.doneAt ? " [x] " : c)).join("|") };
}

/** Text with the open reading tasks of the paper [[slug]] closed. Unchanged when there is no such task. */
export function closeTasks(text, slug) {
  const link = `[[${slug}]]`, ctx = { doneAt: -1 };
  return text.split("\n").map((line) => {
    const task = readingTask(line, link, ctx);
    return task?.open ? task.closed : line;
  }).join("\n");
}

/** "open" | "done" | "none": the reading tasks of [[slug]] in an inbox or a plan. One open task makes it "open". */
export function taskState(text, slug) {
  const link = `[[${slug}]]`, ctx = { doneAt: -1 };
  if (!text.includes(link)) return "none";
  const tasks = text.split("\n").map((line) => readingTask(line, link, ctx)).filter(Boolean);
  return tasks.some((t) => t.open) ? "open" : tasks.length ? "done" : "none";
}

// ---------- reading log of a paper ----------
// Focus sessions spent on the paper: the section "## Чтение" of the paper note, mirrored in one Zotero child note.

export const READING_LOG_TAG = "reading-log";
const READING_HEAD = "## Чтение";
const READING_LINE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (\d+) мин/;
const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " ").trim();
const readingLine = (s) => [`- ${s.start}`, `${s.minutes} мин`, oneLine(s.result), oneLine(s.comment)].filter(Boolean).join(" · ");

// [first line of the section, line after it]; a missing section sits right before "## Заметки". null: no place.
function readingSpan(lines) {
  const head = lines.findIndex((l) => l.trim() === READING_HEAD);
  if (head < 0) {
    const notes = lines.findIndex((l) => l.trim() === "## Заметки");
    return notes < 0 ? null : [notes, notes];
  }
  const end = lines.findIndex((l, i) => i > head && /^#{1,6} /.test(l));
  return [head, end < 0 ? lines.length : end];
}

/** Paper note with the sessions in "## Чтение": one line per session (by start time; a session passed again
 * replaces its line, so a result written later arrives), then "Всего: N ч". Lines of sessions that are not passed
 * stay. The section is generated: other text inside it is not kept. */
export function withReadingLog(text, sessions) {
  const lines = text.split("\n");
  const span = readingSpan(lines);
  if (!sessions.length || !span) return text;
  const [head, end] = span;
  const fresh = new Map(sessions.map((s) => [s.start, readingLine(s)]));
  const kept = lines.slice(head, end).filter((l) => READING_LINE.test(l) && !fresh.has(READING_LINE.exec(l)[1]));
  const all = [...kept, ...fresh.values()].sort();
  const minutes = all.reduce((sum, l) => sum + Number(READING_LINE.exec(l)[2]), 0);
  const section = [READING_HEAD, "", ...all, "", `Всего: ${Math.round(minutes / 6) / 10} ч`, ""];
  return [...lines.slice(0, head), ...section, ...lines.slice(end)].join("\n");
}

/** HTML of the Zotero note that mirrors "## Чтение" of a paper note; "" when the note has no such section. */
export function readingLogHtml(text) {
  const lines = text.split("\n");
  const span = readingSpan(lines);
  if (!span || span[0] === span[1]) return "";
  const body = lines.slice(span[0] + 1, span[1]).join("\n").trim();
  return mdToHtml(`# ${READING_HEAD.slice(3)}\n\n${body}`);
}

// ---------- note body <-> Zotero HTML ----------
// Supported: p, br, strong, em, code, a, blockquote, ul/ol/li, h1-h3.

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeHtml = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m)).replace(/&amp;/g, "&");

const SAFE_HREF = /^(https?:|mailto:|obsidian:|zotero:|#|\/|\.)/i; // any other scheme (javascript:, data:) stays plain text
const PLAIN_TAGS = ["u", "sub", "sup"]; // tags typed as HTML in markdown: allowed bare, without attributes
const HIGHLIGHT = "#ffd40080";          // Zotero's yellow highlight in notes

function inlineToHtml(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  const out = text
    .replace(/`([^`]+)`/g, (_, c) => keep(`<code>${escapeHtml(c)}</code>`))
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (m, label, href) => (SAFE_HREF.test(href) ? keep(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`) : m));
  let html = escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<s>$1</s>")
    .replace(/==(?=\S)(.+?)(?<=\S)==/g, `<span style="background-color: ${HIGHLIGHT}">$1</span>`);
  for (const tag of PLAIN_TAGS) {
    html = html.replace(new RegExp(`&lt;${tag}&gt;(.+?)&lt;/${tag}&gt;`, "g"), `<${tag}>$1</${tag}>`);
  }
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
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
        const node = { tag, kids: [], href: /href\s*=\s*["']([^"']*)["']/i.exec(m[3])?.[1], marked: /style\s*=\s*["'][^"']*background-color/i.test(m[3]) };
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
  if (PLAIN_TAGS.includes(node.tag)) return `<${node.tag}>${inner}</${node.tag}>`;
  if (node.tag === "s" || node.tag === "strike" || node.tag === "del") return `~~${inner}~~`;
  if (node.tag === "mark" || (node.tag === "span" && node.marked)) return `==${inner}==`;
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
