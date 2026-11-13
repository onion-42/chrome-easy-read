// Zotero for the service worker: which paper is this document, save it, its notes, the reading list.
// easy-read writes papers and notes to Zotero only; the vault gets them through plan-browser's sync.
import { client, collectionTree, lookupDoi, pmidToDoi, NO_KEY } from "./zotero-api.js";
import * as P from "./papers.js";

const SETTINGS_KEY = "zotero";       // storage.local: { apiKey, userId, collection }
const CACHE_KEY = "zoteroDocs";      // storage.local: [[id, itemKey], …], newest first
const CACHE_SIZE = 200;
const NOT_PAPER = new Set(["note", "attachment", "annotation"]);

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

const paperView = (it) => ({
  key: it.key,
  title: it.data.title || "",
  label: P.paperLabel(it.data),
  url: it.data.DOI ? `https://doi.org/${it.data.DOI}` : it.data.url || "",
  slug: P.extraGet(it.data.extra, "obsidian")?.split("/").at(-1).replace(/\.md$/, "") || "",
  pdf: P.extraGet(it.data.extra, "pdf"),
});

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

/** The operations behind the "zotero" message. Everything outside is injected, so tests need no network. */
export function makeOps({ zot, cache, collection, fetchFn = fetch }) {
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
    const tree = collectionTree(await zot.collections(), collection);
    if (!tree.length) throw new Error("Коллекция Zotero не найдена. Выбери её в настройках easy-read.");
    const groups = [];
    for (const c of tree) {
      const items = (await zot.collectionTop(c.key)).filter((it) => !NOT_PAPER.has(it.data.itemType) && !it.data.deleted);
      groups.push({ key: c.key, name: c.name, items });
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
    const { key } = await zot.create({ ...fields, extra, collections: [collection], tags: [{ tag: "reading-list" }] });
    const pdfUrl = P.pdfUrlOf(doc);
    if (pdfUrl) {
      await zot.create({ itemType: "attachment", linkMode: "linked_url", parentItem: key, title: "PDF", url: pdfUrl, contentType: "application/pdf" });
    }
    await cache.set(docIds(doc, doi), key);
    return zot.item(key);
  }

  async function notesOf(key) {
    const kids = await zot.children(key);
    return kids
      .filter((k) => k.data.itemType === "note" && !k.data.deleted)
      .sort((a, b) => (a.data.dateAdded || "").localeCompare(b.data.dateAdded || ""))
      .map(noteView)
      .sort((a, b) => Number(b.summary) - Number(a.summary));
  }

  const status = async (item, doc) => ({ paper: item ? paperView(item) : null, pdfUrl: P.pdfUrlOf(doc), notes: item ? await notesOf(item.key) : [] });

  return {
    async list() {
      return { groups: (await papersOfTree()).map((g) => ({ name: g.name, items: g.items.map(paperView) })).filter((g) => g.items.length) };
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
      } else {
        await zot.create({ itemType: "note", parentItem: paper.key, note: P.mdToHtml(body), tags: summary ? [{ tag: P.SUMMARY_TAG }] : [] });
      }
      return status(paper, doc);
    },
    /** Edit a note; a conflict returns the remote text and changes nothing. */
    async edit({ noteKey, md, version }) {
      const res = await zot.patch(noteKey, { note: P.mdToHtml(md) }, version);
      if (!res.conflict) return { version: res.version };
      const it = await zot.item(noteKey);
      return { conflict: true, remote: { md: P.htmlToMd(it.data.note || ""), version: it.version } };
    },
    /** The PDF now lives in the vault: remember the path on the item and the file's hash in the cache. */
    async pdfSaved({ key, path, hash }) {
      for (let attempt = 0; ; attempt++) {
        const it = await zot.item(key);
        if (P.extraGet(it.data.extra, "pdf") === path) break;
        const res = await zot.patch(key, { extra: P.extraSet(it.data.extra || "", "pdf", path) }, it.version);
        if (!res.conflict) break;
        if (attempt) throw new Error("Запись изменилась в Zotero, путь к PDF не записан. Повтори.");
      }
      if (hash) await cache.set([`h:${hash}`], key);
      return { path };
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
    /** "This open document is that paper" (a local file tied to an item by hand). */
    async attach({ key, doc }) {
      await cache.set(docIds(doc, null), key);
      return status(await zot.item(key), doc);
    },
  };
}

/* ---------- wiring to chrome.* ---------- */

export async function zotero(msg) {
  const settings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  if (!settings.apiKey || !settings.userId) throw new Error(NO_KEY);
  if (!settings.collection) throw new Error("Выбери коллекцию Zotero в настройках easy-read.");
  const ops = makeOps({ zot: client(settings), cache: makeCache(chrome.storage.local), collection: settings.collection });
  if (!Object.hasOwn(ops, msg.op)) throw new Error(`unknown zotero op: ${msg.op}`);
  return { ...(await ops[msg.op](msg)), vault: settings.vaultName || "" };
}
