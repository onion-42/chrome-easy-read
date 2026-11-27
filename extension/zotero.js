// Zotero for the service worker: which paper is this document, save it, its notes, the reading list.
// Papers, notes, PDFs and material files go to Zotero; the vault gets the notes through plan-browser's sync
// (background.js also writes the file of a note it has just made, so that it is in the vault at once).
// The personal library and every group that has a top-level collection named like the chosen one are read as one.
import { collectionTree, lookupDoi, pmidToDoi, putMaterial, putPdf, workspace, NO_KEY } from "./zotero-api.js";
import * as P from "./papers.js";

const SETTINGS_KEY = "zotero";       // storage.local: { apiKey, userId, collection }
const CACHE_KEY = "zoteroDocs";      // storage.local: [[id, itemKey], …], newest first
const CACHE_SIZE = 200;
const NOT_PAPER = new Set(["note", "attachment", "annotation"]);
const WORKSPACE_TTL_MS = 10 * 60 * 1000; // how long the list of group libraries is trusted

/* ---------- which Zotero item is this document ---------- */

/** Stable ids of a document, strongest first: file hash, DOI, address. */
export function docIds(doc, doi) {
  return [doc.hash && `h:${doc.hash}`, doi && `d:${doi}`, doc.url && `u:${doc.url.split("#")[0]}`].filter(Boolean);
}

export function makeCache(storage) {
  const read = async () => (await storage.get(CACHE_KEY))[CACHE_KEY] ?? [];
  return {
    async get(ids) {
      const list = await read();
      for (const id of ids) { // strongest id first: a DOI match beats an address that was cached for another paper
        const hit = list.find(([cached]) => cached === id);
        if (hit) return hit[1];
      }
      return null;
    },
    async set(ids, key) {
      const list = (await read()).filter(([id]) => !ids.includes(id));
      await storage.set({ [CACHE_KEY]: [...ids.map((id) => [id, key]), ...list].slice(0, CACHE_SIZE) });
    },
  };
}

// pdf: the Zotero key of the attachment that holds the paper's own PDF, or null. zoteroUrl: opens the paper in Zotero.
const paperView = (it, pdf = null) => ({
  key: it.key,
  title: it.data.title || "",
  label: P.paperLabel(it.data),
  url: it.data.DOI ? `https://doi.org/${it.data.DOI}` : it.data.url || "",
  slug: P.extraGet(it.data.extra, "obsidian")?.split("/").at(-1).replace(/\.md$/, "") || "",
  pdf,
  zoteroUrl: P.zoteroLink(it.key, it.lib),
});

/** The attachments of one paper -> { pdf: key of its own PDF | null, materials }. */
function filesView(kids) {
  const main = P.mainPdf(kids);
  return { pdf: main?.key || null, materials: kids.filter((k) => P.isMaterial(k, main?.key)).map(P.materialView) };
}

const noteView = (n) => {
  const html = n.data.note || "";
  const md = P.htmlToMd(html);
  return {
    key: n.key,
    version: n.version,
    md,
    quote: P.quoteOf(md),
    summary: (n.data.tags || []).some((t) => t.tag === P.SUMMARY_TAG),
    readOnly: P.RICH_HTML.test(html),
  };
};

/** The operations behind the "zotero" message. Everything outside is injected, so tests need no network.
 * collection: the root collection key, or one per library (the personal one first: new papers go there). */
export function makeOps({ zot, cache, collection, fetchFn = fetch }) {
  const roots = [collection].flat();
  async function doiOf(doc) {
    const doi = P.findDoi(doc);
    if (doi) return doi;
    const pmid = P.findPmid(doc);
    if (!pmid) return null;
    try {
      return await pmidToDoi(pmid, fetchFn);
    } catch (e) {
      console.warn("easy-read: PMID lookup failed", e);
      return null;
    }
  }

  /** -> { item | null, doi } : cache, then DOI, then the page address. */
  async function resolve(doc) {
    if (doc.key) return { item: await zot.item(doc.key), doi: null }; // the notes tab names its paper
    const doi = await doiOf(doc);
    const ids = docIds(doc, doi);
    const cached = await cache.get(ids);
    if (cached) {
      try {
        const it = await zot.item(cached);
        if (!it.data.deleted) return { item: it, doi };
      } catch (e) {
        console.debug("easy-read: cached Zotero item is gone", e);
      }
    }
    const found = doi ? await zot.findByDoi(doi) : doc.url ? await zot.findByUrl(doc.url) : null;
    if (found && !found.data.deleted) {
      await cache.set(ids, found.key);
      return { item: found, doi };
    }
    return { item: null, doi };
  }

  async function papersOfTree() {
    const tree = collectionTree(await zot.collections(), roots);
    if (!tree.length) throw new Error("Коллекция Zotero не найдена. Выбери её в настройках easy-read.");
    const groups = [];
    for (const c of tree) {
      const items = (await zot.collectionTop(c.key)).filter((it) => !NOT_PAPER.has(it.data.itemType) && !it.data.deleted);
      // a collection of a group library carries the name of the group
      groups.push({ key: c.key, name: c.lib?.type === "group" ? `${c.name} · ${c.lib.name}` : c.name, items });
    }
    return groups;
  }

  async function metadata(doc, doi) {
    if (doi) {
      try {
        return await lookupDoi(doi, fetchFn);
      } catch (e) {
        console.warn("easy-read: Crossref lookup failed, saving as a web page", e);
      }
    }
    const title = (doc.title || "").replace(/ · easy-read$/, "") || doc.url || "Без названия";
    return doc.url ? { itemType: "webpage", title, url: doc.url, ...(doi ? { extra: `DOI: ${doi}` } : {}) } : { itemType: "document", title };
  }

  async function save(doc, doi) {
    const fields = await metadata(doc, doi);
    const taken = new Set((await papersOfTree()).flatMap((g) => g.items).map((it) => paperView(it).slug).filter(Boolean));
    const slug = P.uniqueSlug(P.slugOf(fields), taken); // computed once, read by everyone else from Extra
    const pmid = P.findPmid(doc);
    let extra = P.extraSet(fields.extra || "", "obsidian", `${P.PAPERS_DIR}/${slug}.md`);
    if (pmid) extra = P.extraSet(extra, "PMID", pmid);
    const { key } = await zot.create({ ...fields, extra, collections: [roots[0]], tags: [{ tag: "reading-list" }] });
    await cache.set(docIds(doc, doi), key);
    return zot.item(key);
  }

  /** The children of a paper, read once -> { notes (summary first), materials, pdf: key of its own PDF | null }. */
  async function kidsOf(key) {
    const kids = await zot.children(key);
    const notes = kids
      .filter((k) => k.data.itemType === "note" && !k.data.deleted)
      .sort((a, b) => (a.data.dateAdded || "").localeCompare(b.data.dateAdded || ""))
      .map(noteView)
      .sort((a, b) => Number(b.summary) - Number(a.summary));
    return { notes, ...filesView(kids.filter((k) => !k.data.deleted)) };
  }
  const notesOf = async (key) => (await kidsOf(key)).notes;

  async function status(item, doc) {
    const { notes, materials, pdf } = item ? await kidsOf(item.key) : { notes: [], materials: [], pdf: null };
    return { paper: item ? paperView(item, pdf) : null, pdfUrl: P.pdfUrlOf(doc), notes, materials };
  }

  return {
    async list() {
      const byPaper = new Map(); // one request per library for the attachments of every paper
      for (const it of await zot.attachments()) {
        if (!it.data.deleted) byPaper.set(it.data.parentItem, [...(byPaper.get(it.data.parentItem) || []), it]);
      }
      const view = (it) => {
        const { pdf, materials } = filesView(byPaper.get(it.key) || []);
        return { ...paperView(it, pdf), materials };
      };
      return { groups: (await papersOfTree()).map((g) => ({ name: g.name, items: g.items.map(view) })).filter((g) => g.items.length) };
    },
    async status({ doc }) {
      return status((await resolve(doc)).item, doc);
    },
    async save({ doc }) {
      const { item, doi } = await resolve(doc);
      return status(item || (await save(doc, doi)), doc);
    },
    /** New note on the document (the paper is saved first when it is new). One summary note per paper. */
    async note({ doc, quote = "", comment = "", page = null, summary = false }) {
      const { item, doi } = await resolve(doc);
      const paper = item || (await save(doc, doi));
      const body = P.noteBody({ quote: summary ? "" : quote, comment, page, url: doc.url || "" });
      if (!body) throw new Error("Пустая заметка: выдели текст или напиши комментарий.");
      const old = summary ? (await notesOf(paper.key)).find((n) => n.summary) : null;
      if (old) {
        const res = await zot.patch(old.key, { note: P.mdToHtml(body) }, old.version);
        if (res.conflict) throw new Error("Вывод изменился в Zotero. Открой заметки заново.");
        return status(paper, doc);
      }
      const html = P.mdToHtml(body);
      const made = await zot.create({ itemType: "note", parentItem: paper.key, note: html, tags: summary ? [{ tag: P.SUMMARY_TAG }] : [] });
      // madeNote: what the vault file of this note needs (the body as the sync would read it back)
      return { ...(await status(paper, doc)), made: made.key, madeNote: { key: made.key, version: made.version, body: P.htmlToMd(html), summary } };
    },
    /** Edit a note; a conflict returns the remote text and changes nothing. */
    async edit({ noteKey, md, version }) {
      const res = await zot.patch(noteKey, { note: P.mdToHtml(md) }, version);
      if (!res.conflict) return { version: res.version };
      const it = await zot.item(noteKey);
      return { conflict: true, remote: { md: P.htmlToMd(it.data.note || ""), version: it.version } };
    },
    /** The PDF of the paper is now stored in Zotero (the page uploaded it, see zoteroFiles): remember the file's
     * hash, so the same file opened from the disk is known as this paper. */
    async pdfSaved({ key, hash }) {
      if (hash) await cache.set([`h:${hash}`], key);
      return {};
    },
    /** Take the paper out of the reading list: out of every collection of the tree. The item, its notes and PDF stay. */
    async remove({ key }) {
      const tree = new Set(collectionTree(await zot.collections(), collection).map((c) => c.key));
      if (!tree.size) throw new Error("Коллекция Zotero не найдена. Выбери её в настройках easy-read.");
      for (let attempt = 0; ; attempt++) {
        const it = await zot.item(key);
        const now = it.data.collections || [];
        const left = now.filter((c) => !tree.has(c));
        if (left.length === now.length) break; // already out
        const res = await zot.patch(key, { collections: left }, it.version);
        if (!res.conflict) break;
        if (attempt) throw new Error("Запись изменилась в Zotero, статья не убрана. Повтори.");
      }
      return {};
    },
    /** Attach a link to a paper as a material. target: an address, or the path of a note (.md) inside the vault.
     * A file goes through zoteroFiles().putMaterial instead: its bytes are stored in Zotero. */
    async materialAdd({ key, title = "", target, vaultName = "" }) {
      if (!target) throw new Error("Пустой материал: нужен адрес или файл.");
      const dup = filesView((await zot.children(key)).filter((k) => !k.data.deleted)).materials.find((m) => (m.path || m.url) === target);
      if (dup) return { key: dup.key, existed: true };
      const made = await zot.create(P.materialItem({ parent: key, title, target, vaultName }));
      return { key: made.key, existed: false };
    },
    /** Take a material off the paper: the Zotero child goes to the trash, with its file when it is stored in Zotero.
     * A note of the vault stays. The paper's own PDF is not a material and is refused. */
    async materialRemove({ materialKey }) {
      for (let attempt = 0; ; attempt++) {
        const it = await zot.item(materialKey);
        const main = it.data.parentItem ? P.mainPdf(await zot.children(it.data.parentItem)) : null;
        if (!it.data.parentItem || !P.isMaterial(it, main?.key)) throw new Error("Эта запись Zotero — не материал статьи.");
        const res = await zot.patch(materialKey, { deleted: 1 }, it.version);
        if (!res.conflict) return {};
        if (attempt) throw new Error("Запись изменилась в Zotero, материал не убран. Повтори.");
      }
    },
    /** "This open document is that paper" (a local file tied to an item by hand). */
    async attach({ key, doc }) {
      await cache.set(docIds(doc, null), key);
      return status(await zot.item(key), doc);
    },
  };
}

/* ---------- wiring to chrome.* ---------- */

let known = null; // { id, at, value }: the libraries of the account, looked up at most once per WORKSPACE_TTL_MS

/** -> { settings, zot, scopes }: the personal library and the groups that joined the reading list, as one client. */
async function connect() {
  const settings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  if (!settings.apiKey || !settings.userId) throw new Error(NO_KEY);
  if (!settings.collection) throw new Error("Выбери коллекцию Zotero в настройках easy-read.");
  const id = `${settings.apiKey}:${settings.userId}:${settings.collection}`;
  if (known?.id !== id || Date.now() - known.at > WORKSPACE_TTL_MS) known = { id, at: Date.now(), value: await workspace(settings) };
  return { settings, ...known.value };
}

export async function zotero(msg) {
  const { settings, zot, scopes } = await connect();
  const ops = makeOps({ zot, cache: makeCache(chrome.storage.local), collection: scopes });
  if (!Object.hasOwn(ops, msg.op)) throw new Error(`unknown zotero op: ${msg.op}`);
  return { ...(await ops[msg.op]({ ...msg, vaultName: settings.vaultName || "" })), vault: settings.vaultName || "" };
}

/** Files in Zotero's storage, for the pages that hold the bytes (the viewer, the reading list): a file never
 * travels in a runtime message. putPdf: the paper's own PDF; putMaterial: a file attached as a material;
 * get: a stored attachment -> { bytes, name, paper: the key of the paper it belongs to | null }. */
export async function zoteroFiles() {
  const { zot } = await connect();
  return {
    putPdf: (paperKey, bytes, filename) => putPdf(zot, paperKey, bytes, filename),
    putMaterial: (paperKey, bytes, filename) => putMaterial(zot, paperKey, bytes, filename),
    get: async (attKey) => {
      const it = await zot.item(attKey);
      return { bytes: await zot.download(attKey), name: it.data.filename || it.data.title || "PDF", paper: it.data.parentItem || null };
    },
  };
}
