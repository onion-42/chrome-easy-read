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

// ---------- words of the files and of the messages ----------
// Both languages are read everywhere. New text is written in the language of setLang (default ru: the CLI and
// easy-read); a section added to an existing paper note follows the language that note is written in.
export const WORDS = {
  ru: {
    paper: "Статья", notes: "## Заметки", materials: "## Материалы", reading: "## Чтение", related: "### 🔗 context - Связано с:",
    firstAuthor: "Первый автор", year: "Год", source: "Источник", address: "Адрес", openInZotero: "открыть в Zotero", key: "ключ",
    why: "Зачем читаю", page: "Стр.", note: "заметка", summary: "вывод", minutes: "мин", total: "Всего", hours: "ч", done: "готово",
    conflict: (date) => `Конфликт ${date}: версия из Zotero`,
    kinds: { pdf: "PDF", note: "заметка", doc: "документ", sheet: "таблица", video: "видео", thread: "тред", slides: "слайды", link: "ссылка", file: "файл" },
    highlights: "выделения", drawing: "(область или рисунок)", noHighlights: "Выделений пока нет.",
    readOnlyCopy: "Копия выделений из PDF в Zotero, только для чтения. Правь выделения в Zotero: текст этого файла заменяется при синхронизации.",
    inboxHead: "# Входящие\n\n## Задачи\n",
    // sync: what a failed step is called, the errors, the report
    stepPaper: "статья", stepMaterial: "материал", stepTasks: "задачи в", stepReadingLog: "журнал чтения", stepNote: "заметка", stepFile: "файл",
    stepHighlights: "выделения",
    groupMissing: (ids, slugs) => `Заметки-паспорта в vault ссылаются на группу Zotero ${ids}, но эта группа не подключена: в ней нет коллекции верхнего уровня с именем списка чтения (переименована или удалена?), или у ключа нет доступа к группе. Синхронизация остановлена, ничего не изменено. Верни коллекцию в группе. Если группа больше не нужна, поправь ссылку Zotero в этих паспортах: ${slugs}.`,
    twinKeys: (keys) => `Одна запись есть в двух библиотеках Zotero (${keys}). Заверши перенос командой share или удали копию. Синхронизация остановлена, ничего не изменено.`,
    changedMeanwhile: "изменилась в Zotero во время синхронизации, повторится в следующий раз",
    noCollection: (scope) => `Коллекция Zotero ${scope} не найдена.`,
    noPaperLine: "нет строки «Статья: [[…]]», заметка не синхронизируется",
    noPaperNote: "у статьи нет заметки в vault",
    fileTaken: (name) => `файл ${name} уже есть и не привязан к этой заметке`,
    paperNotInZotero: (slug) => `статья [[${slug}]] не найдена в Zotero`,
    report: { papers: "статей", notes: "заметок", created: "новых файлов", pulled: "из Zotero", pushed: "в Zotero", conflicts: "конфликтов",
      deleted: "удалено в Zotero", closed: "закрыто задач", materials: "материалов", highlights: "файлов выделений", marked: "отмечено прочитанным",
      reading: "журналов чтения", errors: "ошибок" },
    // Zotero API
    noKey: "Добавь ключ Zotero API в настройках расширения.",
    keyRejected: "Zotero отклонил ключ API. Проверь ключ и его права (library, notes, write) в настройках.",
    notFound: (path) => `Zotero: запись не найдена (${path}).`,
    unavailable: (status) => `Zotero сейчас недоступен (HTTP ${status}). Попробуй позже.`,
    offline: "Нет связи с Zotero. Проверь интернет.",
    notCreated: (reason) => `Zotero не создал запись: ${reason || "неизвестная причина"}`,
    noVersion: "Zotero не вернул версию записи после изменения.",
    noMetadata: (status, url) => `Метаданные не получены (HTTP ${status}): ${url}`,
    quota: "В хранилище Zotero не хватает места для этого файла (квота владельца библиотеки).",
    fileChanged: "Файл в Zotero изменился с прошлого чтения. Повтори ещё раз.",
    uploadFailed: (status) => `Файл не загружен в хранилище Zotero (HTTP ${status}).`,
  },
  en: {
    paper: "Paper", notes: "## Notes", materials: "## Materials", reading: "## Reading", related: "### 🔗 context - Related:",
    firstAuthor: "First author", year: "Year", source: "Source", address: "Address", openInZotero: "open in Zotero", key: "key",
    why: "Why I read it", page: "p.", note: "note", summary: "summary", minutes: "min", total: "Total", hours: "h", done: "done",
    conflict: (date) => `Conflict ${date}: the version from Zotero`,
    kinds: { pdf: "PDF", note: "note", doc: "document", sheet: "spreadsheet", video: "video", thread: "thread", slides: "slides", link: "link", file: "file" },
    highlights: "highlights", drawing: "(area or drawing)", noHighlights: "No highlights yet.",
    readOnlyCopy: "A read-only copy of the PDF highlights in Zotero. Edit the highlights in Zotero: the text of this file is replaced by the sync.",
    inboxHead: "# Inbox\n\n## Tasks\n",
    stepPaper: "paper", stepMaterial: "material", stepTasks: "tasks in", stepReadingLog: "reading log", stepNote: "note", stepFile: "file",
    stepHighlights: "highlights",
    groupMissing: (ids, slugs) => `Paper notes of the vault point at the Zotero group ${ids}, but this group is not connected: it has no top-level collection named like the reading list (renamed or deleted?), or the key has no access to it. The sync has stopped, nothing was changed. Restore the collection in the group. If the group is no longer used, fix the Zotero link in these paper notes: ${slugs}.`,
    twinKeys: (keys) => `One item is in two Zotero libraries (${keys}). Finish the move with the share command or delete the copy. The sync has stopped, nothing was changed.`,
    changedMeanwhile: "changed in Zotero during the sync, it will be repeated next time",
    noCollection: (scope) => `Zotero collection ${scope} was not found.`,
    noPaperLine: "the line «Paper: [[…]]» is missing, the note is not synced",
    noPaperNote: "the paper has no note in the vault",
    fileTaken: (name) => `the file ${name} already exists and is not linked to this note`,
    paperNotInZotero: (slug) => `the paper [[${slug}]] was not found in Zotero`,
    report: { papers: "papers", notes: "notes", created: "new files", pulled: "from Zotero", pushed: "to Zotero", conflicts: "conflicts",
      deleted: "deleted in Zotero", closed: "tasks closed", materials: "materials", highlights: "highlights files", marked: "marked as read",
      reading: "reading logs", errors: "errors" },
    noKey: "Add your Zotero API key in the extension options.",
    keyRejected: "Zotero rejected the API key. Check the key and its permissions (library, notes, write) in the options.",
    notFound: (path) => `Zotero: the item was not found (${path}).`,
    unavailable: (status) => `Zotero is unavailable right now (HTTP ${status}). Try again later.`,
    offline: "No connection to Zotero. Check the internet connection.",
    notCreated: (reason) => `Zotero did not create the item: ${reason || "unknown reason"}`,
    noVersion: "Zotero did not return the item version after the change.",
    noMetadata: (status, url) => `The metadata was not received (HTTP ${status}): ${url}`,
    quota: "Zotero storage has no room for this file (the quota of the library owner).",
    fileChanged: "The file in Zotero has changed since it was read. Try again.",
    uploadFailed: (status) => `The file was not uploaded to Zotero storage (HTTP ${status}).`,
  },
};
const LANGS = Object.keys(WORDS);
let lang = "ru";

export function setLang(next) {
  if (!WORDS[next]) throw new Error(`Unknown language: ${next}`);
  lang = next;
}
/** The words of the current language. */
export const words = () => WORDS[lang];
/** The words of the language a note file is written in (by its paper line); the current language for a new file. */
export const wordsOfFile = (text) => WORDS[LANGS.find((l) => new RegExp(`^${WORDS[l].paper}: \\[\\[`, "m").test(text || ""))] || words();

const either = (name) => LANGS.map((l) => WORDS[l][name].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
// The first heading `name` (in either language): its line index and the language it is written in.
function headAt(lines, name) {
  for (const [at, line] of lines.entries()) {
    const found = LANGS.find((l) => line.trim() === WORDS[l][name]);
    if (found) return { at, lang: found };
  }
  return { at: -1, lang: null };
}

export const paperLabel = (item) => [familyOf(item), yearOf(item)].filter(Boolean).join(" ") || words().paper;
const sourceOf = (item) => item.publicationTitle || item.repository || item.websiteTitle || "";
// lib: { type: "user" | "group", id } of the library the item lives in; nothing = the personal library
const libPath = (lib) => (lib?.type === "group" ? `groups/${lib.id}` : "library");
export const zoteroLink = (key, lib) => `zotero://select/${libPath(lib)}/items/${key}`;
/** Opens a PDF attachment in Zotero's reader. */
export const pdfLink = (attKey, lib) => `zotero://open-pdf/${libPath(lib)}/items/${attKey}`;
const linkOf = (item) => (item.DOI ? `https://doi.org/${item.DOI}` : item.url || "");

export function paperNote(item, { key, slug, why = "", tags = "#papers", lib = null }) {
  const w = words();
  const head = [
    `- **${w.firstAuthor}:** ${familyOf(item) || "—"} · **${w.year}:** ${yearOf(item) || "—"} · **${w.source}:** ${sourceOf(item) || "—"}`,
    item.DOI ? `- **DOI:** https://doi.org/${item.DOI}` : `- **${w.address}:** ${item.url || "—"}`,
  ];
  const pmid = extraGet(item.extra, "PMID");
  if (pmid) head.push(`- **PMID:** ${pmid}`);
  head.push(`- **Zotero:** [${w.openInZotero}](${zoteroLink(key, lib)}) · ${w.key} \`${key}\``);
  head.push(`- **${w.why}:** ${why}`);
  return `# ${paperLabel(item)} — ${item.title || slug}\n\n${head.join("\n")}\n\n${w.notes}\n\n\n${w.related}\n\n${tags}\n`;
}

export const PAPER_KEY_RE = /zotero:\/\/select\/(?:library|groups\/\d+)\/items\/([A-Z0-9]{8})/;

/** Paper note whose Zotero line points at the library the paper is in now. The words of the line stay. */
export function withZoteroLine(text, key, lib) {
  return text.split("\n").map((l) => (l.startsWith("- **Zotero:**") ? l.replace(PAPER_KEY_RE, zoteroLink(key, lib)) : l)).join("\n");
}

/** Paper note with the PDF line (after the Zotero line): a link that opens the PDF in Zotero. A line that points
 * somewhere else is replaced; the words follow the language the note is written in. */
export function withPdfLine(text, link) {
  const lines = text.split("\n");
  const line = `- **PDF:** [${(WORDS[headAt(lines, "notes").lang] || words()).openInZotero}](${link})`;
  const has = lines.findIndex((l) => l.startsWith("- **PDF:**"));
  if (has >= 0) {
    if (lines[has].includes(`(${link})`)) return text;
    return lines.with(has, line).join("\n");
  }
  const at = lines.findIndex((l) => l.startsWith("- **Zotero:**"));
  if (at < 0) return text;
  return lines.toSpliced(at + 1, 0, line).join("\n");
}

/** Paper note with "- [[noteName]]" appended to the notes section. Append-only. */
export function withNoteLink(text, noteName) {
  if (text.includes(`[[${noteName}]]`)) return text;
  const lines = text.split("\n");
  const head = headAt(lines, "notes").at;
  if (head < 0) return text;
  let end = lines.findIndex((l, i) => i > head && /^#{1,6} /.test(l));
  if (end < 0) end = lines.length;
  let last = end;
  while (last > head + 1 && lines[last - 1].trim() === "") last--;
  return [...lines.slice(0, last), `- [[${noteName}]]`, "", ...lines.slice(end)].join("\n");
}

// ---------- materials of a paper ----------
// A material = any attachment under the paper except the paper's own PDF: a file stored in Zotero, or a link.
// The tags paper-material + material-<kind> are written by our tools; an attachment added by hand in Zotero has
// none and is still a material. A note of the vault (.md) stays in the vault and is linked by an obsidian://
// address (Zotero keeps it: checked on the live API).

export const MATERIAL_TAG = "paper-material";
export const MATERIALS_DIR = "1_education/papers/materials";
export const MATERIAL_KINDS = WORDS.ru.kinds; // the Russian names: easy-read and the CLI show them
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

const CONTENT_TYPES = {
  pdf: "application/pdf", md: "text/markdown", doc: "application/msword", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const hasTag = (it, tag) => (it.data.tags || []).some((t) => t.tag === tag);
const isStored = (d) => (d.linkMode || "").startsWith("imported_");

/** The paper's own PDF among its children: a PDF stored in Zotero that is not a material; the oldest one. */
/** The Zotero group a paper note points at (the id in its zotero://select/groups/<id>/… link), or null. */
export const paperGroup = (text) => /zotero:\/\/select\/groups\/(\d+)\/items\/[A-Z0-9]{8}/.exec(text || "")?.[1] || null;

export const mainPdf = (kids) => kids
  .filter((k) => k.data.itemType === "attachment" && !k.data.deleted && isStored(k.data) && k.data.contentType === "application/pdf"
    && !hasTag(k, MATERIAL_TAG))
  .sort((a, b) => (a.data.dateAdded || "").localeCompare(b.data.dateAdded || ""))[0] || null;

/** The Zotero child item of a material. target = an address, or a path inside the vault (a link to it is kept).
 * file = the name of a file whose bytes are uploaded to Zotero after the item is made. */
export function materialItem({ parent, title = "", target = "", vaultName = "", file = "" }) {
  if (file) {
    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    return {
      itemType: "attachment",
      linkMode: "imported_file",
      parentItem: parent,
      title: title.trim() || file,
      filename: file,
      contentType: CONTENT_TYPES[ext] || "application/octet-stream",
      tags: [{ tag: MATERIAL_TAG }, { tag: `material-${fileKind(file) || "file"}` }],
    };
  }
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

/** Is this Zotero child a material that is still attached: any attachment except the paper's own PDF (mainKey)
 * and the copy of a web page that Zotero's browser connector saves. */
export const isMaterial = (it, mainKey = null) => it.data.itemType === "attachment" && !it.data.deleted && it.key !== mainKey
  && !(it.data.linkMode === "imported_url" && it.data.contentType === "text/html");

/** Zotero child item -> { key, title, kind, url, path, stored }. path: inside the vault, "" otherwise. stored: the
 * file is in Zotero, and url opens it there. */
export function materialView(it) {
  const d = it.data;
  const stored = isStored(d);
  const tagged = (d.tags || []).map((t) => /^material-(\w+)$/.exec(t.tag)?.[1]).find(Boolean);
  const kind = tagged || (stored ? fileKind(d.filename || "") || "file" : materialKind(d.url || ""));
  const url = stored ? (kind === "pdf" ? pdfLink(it.key, it.lib) : zoteroLink(it.key, it.lib)) : d.url || "";
  let path = "";
  if (url.startsWith("obsidian://")) {
    try {
      path = new URL(url).searchParams.get("file") || "";
    } catch {
      path = ""; // an address typed by hand in Zotero: shown as a plain link
    }
  }
  return { key: it.key, title: d.title || d.filename || url, kind, url, path, stored };
}

/** Where a click on a material goes: a PDF stored in Zotero opens in the easy-read viewer. */
export const materialHref = (m, viewerUrl) => (m.stored && m.kind === "pdf" ? `${viewerUrl}?zotero=${m.key}` : m.url);

/** Paper note with one material line in the materials section (the section is created before the notes section).
 * Append-only: unchanged when the material's Zotero key is already mentioned. */
export function withMaterialLine(text, m) {
  const mark = `%%m:${m.key}%%`;
  if (text.includes(mark)) return text;
  const link = m.path ? `[[${m.path.split("/").at(-1).replace(/\.md$/, "")}]]` : `[${m.title.replace(/[[\]]/g, "")}](${m.url})`;
  const lines = text.split("\n");
  const section = headAt(lines, "materials"), notes = headAt(lines, "notes");
  const w = WORDS[section.lang ?? notes.lang];
  if (!w) return text;
  const line = `- ${w.kinds[m.kind] || m.kind}: ${link}${m.path ? ` — ${m.title}` : ""} ${mark}`;
  let head = section.at;
  if (head < 0) {
    lines.splice(notes.at, 0, w.materials, "");
    head = notes.at;
  }
  let end = lines.findIndex((l, i) => i > head && /^#{1,6} /.test(l));
  if (end < 0) end = lines.length;
  let last = end;
  while (last > head + 1 && lines[last - 1].trim() === "") last--;
  return [...lines.slice(0, last), line, "", ...lines.slice(end)].join("\n");
}

// "Статья Lin 2023 (Cell)" / "Paper Lin 2023 (Cell)": how every reading task starts, in the inbox and in a plan.
function taskHead(item) {
  const source = sourceOf(item);
  return `${words().paper} ${paperLabel(item)}${source ? ` (${source})` : ""}`;
}

export function inboxLine(item, slug) {
  const link = linkOf(item);
  return `- [ ] ${taskHead(item)} · low · [[${slug}]]${link ? `; ${link}` : ""}`;
}

/** The task cell of a plan row for a new paper. The links come after the first "; " or " · ", so the bar label
 * and the row id of the plan stay short. */
export function planTaskText(item, slug, key, lib = null) {
  const link = linkOf(item);
  return `${taskHead(item)}${link ? `; ${link}` : ""} · [[${slug}]] · [Zotero](${zoteroLink(key, lib)})`;
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

export const PAPER_TASK = new RegExp(`^(${either("paper")})(\\s|$)`);
const DONE_HEADERS = LANGS.map((l) => WORDS[l].done);
export const READ_TAG = "read"; // Zotero tag of a paper that has been read

/** The reading task of the paper on one line, or null: { open, closed } (closed = the line with its tick set).
 * A reading task starts with "Статья" or "Paper" and links the paper: an inbox line "- [ ] Статья …", or a
 * plan-table row whose task cell starts so and which has a done cell. Lines that only mention the paper are not
 * tasks. ctx.doneAt carries the done column of the table being read from line to line. */
function readingTask(line, link, ctx) {
  const isRow = line.trimStart().startsWith("|");
  if (!isRow) {
    ctx.doneAt = -1;
    const task = /^(\s*- )\[([ xX])\]( .*)$/.exec(line);
    if (!task || !line.includes(link) || !PAPER_TASK.test(task[3].trim())) return null;
    return { open: task[2] === " ", closed: `${task[1]}[x]${task[3]}` };
  }
  const cells = line.split("|");
  const header = cells.findIndex((c) => DONE_HEADERS.includes(c.trim().toLowerCase()));
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
// Focus sessions spent on the paper: the reading section ("## Чтение" / "## Reading") of the paper note, mirrored
// in one Zotero child note.

export const READING_LOG_TAG = "reading-log";
const READING_LINE = new RegExp(`^- (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}) · (\\d+) (?:${either("minutes")})`);
const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " ").trim();
const readingLine = (s, w) => [`- ${s.start}`, `${s.minutes} ${w.minutes}`, oneLine(s.result), oneLine(s.comment)].filter(Boolean).join(" · ");

// [first line of the section, line after it, language of the note]; a missing section sits right before the notes
// section. null: no place.
function readingSpan(lines) {
  const head = headAt(lines, "reading");
  if (head.at < 0) {
    const notes = headAt(lines, "notes");
    return notes.at < 0 ? null : [notes.at, notes.at, notes.lang];
  }
  const end = lines.findIndex((l, i) => i > head.at && /^#{1,6} /.test(l));
  return [head.at, end < 0 ? lines.length : end, head.lang];
}

/** Paper note with the sessions in the reading section: one line per session (by start time; a session passed again
 * replaces its line, so a result written later arrives), then "Всего: N ч". Lines of sessions that are not passed
 * stay. The section is generated: other text inside it is not kept. */
export function withReadingLog(text, sessions) {
  const lines = text.split("\n");
  const span = readingSpan(lines);
  if (!sessions.length || !span) return text;
  const [head, end] = span, w = WORDS[span[2]];
  const fresh = new Map(sessions.map((s) => [s.start, readingLine(s, w)]));
  const kept = lines.slice(head, end).filter((l) => READING_LINE.test(l) && !fresh.has(READING_LINE.exec(l)[1]));
  const all = [...kept, ...fresh.values()].sort();
  const minutes = all.reduce((sum, l) => sum + Number(READING_LINE.exec(l)[2]), 0);
  const section = [w.reading, "", ...all, "", `${w.total}: ${Math.round(minutes / 6) / 10} ${w.hours}`, ""];
  return [...lines.slice(0, head), ...section, ...lines.slice(end)].join("\n");
}

/** HTML of the Zotero note that mirrors the reading section of a paper note; "" when the note has no such section. */
export function readingLogHtml(text) {
  const lines = text.split("\n");
  const span = readingSpan(lines);
  if (!span || span[0] === span[1]) return "";
  const body = lines.slice(span[0] + 1, span[1]).join("\n").trim();
  return mdToHtml(`# ${WORDS[span[2]].reading.slice(3)}\n\n${body}`);
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
const PAPER_LINE_RE = new RegExp(`^(?:${either("paper")}): \\[\\[([^\\]|#]+)\\]\\][ \\t]*$`, "m");
const PAGE_LINE_RE = new RegExp(`^(?:${either("page")}) `);
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
  return `# ${title}\n\n${words().paper}: [[${paperSlug}]]\n\n${body.trim()}\n\n${marker}\n${NOTE_TAGS}${summary ? " #paper-summary" : ""}\n`;
}

/** "Lin 2023 — <first words of my comment, else of the quote>". */
export function noteTitle(label, body, summary = false) {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.find((l) => !l.startsWith(">") && !/^https?:\/\//.test(l) && !PAGE_LINE_RE.test(l));
  const text = (own || lines[0] || words().note).replace(/^>\s*/, "").replace(/[*`#[\]|]/g, "").trim();
  const short = text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
  return `${label} — ${summary ? `${words().summary}: ` : ""}${short}`;
}

export const noteFileName = (paperSlug, key) => `${paperSlug}--${key}.md`;

/** Body of a new note: quote, my comment, source line. */
export function noteBody({ quote = "", comment = "", page = null, url = "" }) {
  const parts = [];
  if (quote.trim()) parts.push(quote.trim().split(/\n+/).map((l) => `> ${l.trim()}`).join("\n"));
  if (comment.trim()) parts.push(comment.trim());
  const source = [page ? `${words().page} ${page}` : "", url].filter(Boolean).join(" · ");
  if (source && quote.trim()) parts.push(source);
  return parts.join("\n\n");
}

// ---------- highlights of a paper (PDF annotations made in Zotero's reader) ----------
// One generated file per paper, read-only: the next sync replaces its text, so nothing typed into it is kept.

export const HIGHLIGHTS_MARKER_RE = /^%% zotero-annotations: (\w{8}) %%$/m;
const HIGHLIGHT_TAGS = "#papers #paper-highlights";
const DRAWN = new Set(["image", "ink"]); // annotation types that carry no text
export const highlightsFileName = (paperSlug) => `${paperSlug}--highlights.md`;

// Zotero's reader opens at ?page=<page index + 1>; the printed page label can be "iv", so it is only shown.
function annotationLink(a) {
  let page = "";
  try {
    page = String(JSON.parse(a.data.annotationPosition).pageIndex + 1);
  } catch {
    page = ""; // no position: the annotation key alone still finds the place
  }
  return `${pdfLink(a.data.parentItem, a.lib)}?${/^\d+$/.test(page) ? `page=${page}&` : ""}annotation=${a.key}`;
}

/** annotations: Zotero annotation items of the paper's attachments. w: the words of the file's language. */
export function renderHighlightsFile({ label, paperSlug, paperKey, annotations }, w = words()) {
  const blocks = [...annotations]
    .sort((a, b) => (a.data.annotationSortIndex || "").localeCompare(b.data.annotationSortIndex || ""))
    .map((a) => {
      const d = a.data;
      const quote = d.annotationText || (DRAWN.has(d.annotationType) ? w.drawing : "");
      const who = a.meta?.createdByUser?.name || a.meta?.createdByUser?.username || ""; // set in a group library
      const source = [d.annotationPageLabel ? `${w.page} ${d.annotationPageLabel}` : "", `[${w.openInZotero}](${annotationLink(a)})`, who];
      return [noteBody({ quote, comment: d.annotationComment || "" }), source.filter(Boolean).join(" · ")].filter(Boolean).join("\n\n");
    });
  const body = blocks.join("\n\n---\n\n") || w.noHighlights;
  return `# ${label} — ${w.highlights}\n\n${w.paper}: [[${paperSlug}]]\n\n${w.readOnlyCopy}\n\n${body}\n\n%% zotero-annotations: ${paperKey} %%\n${HIGHLIGHT_TAGS}\n`;
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
  return `${localBody.trimEnd()}\n\n---\n\n**${words().conflict(date)}**\n\n${remoteMd.trim()}\n`;
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
