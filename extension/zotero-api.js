// Zotero Web API v3 client + public metadata lookups. Pure: no chrome.*, no fs; fetch is injectable for tests.
// One source of truth (skill zotero-link); both extensions ship byte-identical copies.
import { md5 } from "./md5.js";
import { WORDS, crossrefToItem, mainPdf, materialItem, words, zenodoToItem } from "./papers.js";

export const API = "https://api.zotero.org";
export const NO_KEY = WORDS.ru.noKey; // the Russian text: easy-read and watch-list show it
const RETRY_STATUS = new Set([429, 503]);
const PAGE = 100;

function failure(method, path, status) {
  if (status === 403) return words().keyRejected;
  if (status === 404) return words().notFound(path.split("?")[0]);
  if (status === 413) return words().quota;
  if (status >= 500) return words().unavailable(status);
  return `Zotero ${method} ${path.split("?")[0]}: HTTP ${status}`;
}

/** One library of the account: the personal one, or the group `groupId` (its files and items live under /groups). */
export function client({ apiKey, userId, groupId = null, groupName = "", fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey) throw new Error(words().noKey);
  const lib = groupId ? { type: "group", id: Number(groupId), name: groupName } : { type: "user", id: Number(userId) };

  // form: fields of an x-www-form-urlencoded body; as: "json" or "text"
  async function call(method, path, { body, form, ifVersion, headers: extra = {}, as = "json" } = {}) {
    const headers = { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3", ...extra };
    if (form !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    if (ifVersion != null) headers["If-Unmodified-Since-Version"] = String(ifVersion);
    const payload = form !== undefined ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(API + path, { method, headers, body: payload });
      } catch (e) {
        throw new Error(words().offline, { cause: e });
      }
      if (RETRY_STATUS.has(res.status) && attempt < 2) {
        await sleep(1000 * (Number(res.headers.get("Retry-After")) || attempt + 1));
        continue;
      }
      if (res.status === 412) return { conflict: true };
      if (!res.ok) throw Object.assign(new Error(failure(method, path, res.status)), { status: res.status });
      return {
        data: res.status === 204 ? null : as === "text" ? await res.text() : await res.json(),
        version: Number(res.headers.get("Last-Modified-Version")) || null,
        total: Number(res.headers.get("Total-Results")) || 0,
      };
    }
  }

  /** Every page of a list endpoint, as one array. */
  async function paged(path) {
    const all = [];
    for (;;) {
      const { data, total } = await call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=${PAGE}&start=${all.length}`);
      all.push(...data);
      if (!data.length || all.length >= total) return all;
    }
  }

  const u = () => (groupId ? `/groups/${groupId}` : `/users/${userId}`);

  /** POST one new item; returns { key, version } or throws with Zotero's reason. */
  async function create(item) {
    const { data } = await call("POST", `${u()}/items`, { body: [item] });
    const made = data.successful?.["0"];
    if (!made) throw new Error(words().notCreated(data.failed?.["0"]?.message));
    return { key: made.key, version: made.version };
  }

  /** Store a file on an attachment item (Zotero File Storage). oldMd5: the md5 of the file it replaces. */
  async function upload(key, { bytes, filename, mtime = Date.now(), oldMd5 = null }) {
    const match = oldMd5 ? { "If-Match": oldMd5 } : { "If-None-Match": "*" };
    const path = `${u()}/items/${key}/file`;
    const auth = await call("POST", path, { form: { md5: md5(bytes), filename, filesize: bytes.byteLength, mtime }, headers: match });
    if (auth.conflict) throw new Error(words().fileChanged);
    if (auth.data.exists) return { existed: true };
    // the storage is another host: it gets the bytes wrapped in the form parts Zotero prepared, and no API key
    const enc = new TextEncoder();
    let res;
    try {
      res = await fetchFn(auth.data.url, {
        method: "POST",
        headers: { "Content-Type": auth.data.contentType },
        body: new Blob([enc.encode(auth.data.prefix), bytes, enc.encode(auth.data.suffix)]),
      });
    } catch (e) {
      throw new Error(words().offline, { cause: e });
    }
    if (res.status !== 201) throw new Error(words().uploadFailed(res.status));
    const done = await call("POST", path, { form: { upload: auth.data.uploadKey }, headers: match });
    if (done.conflict) throw new Error(words().fileChanged); // not registered: the attachment keeps its old state
    return { existed: false };
  }

  /** The bytes of a stored file. Two requests: Zotero gives a temporary address, the file is read there with no
   * headers. A plain GET of …/file redirects to the storage host and would carry the API key to it. */
  async function download(key) {
    const path = `${u()}/items/${key}/file`;
    const address = (await call("GET", `${path}/view/url`, { as: "text" })).data.trim().replace(/^"|"$/g, "");
    let res;
    try {
      res = await fetchFn(address);
    } catch (e) {
      throw new Error(words().offline, { cause: e });
    }
    // the storage's own answer: a 403 here is an expired address, not a rejected API key
    if (!res.ok) throw Object.assign(new Error(`Zotero GET ${path}: HTTP ${res.status}`), { status: res.status });
    return new Uint8Array(await res.arrayBuffer());
  }

  return {
    lib,
    whoami: async () => (await call("GET", "/keys/current")).data,
    groups: () => paged(`/users/${userId}/groups`),
    collections: () => paged(`${u()}/collections`),
    collectionTop: (key) => paged(`${u()}/collections/${key}/items/top?includeTrashed=1`),
    notes: () => paged(`${u()}/items?itemType=note&includeTrashed=1`),
    children: (key) => paged(`${u()}/items/${key}/children`),
    // every attachment and every PDF annotation of the library, each in one paged request (trashed ones are not listed)
    // trashed: also the items in the trash (the listing of notes always has them); a move must not leave them behind
    attachments: ({ trashed = false } = {}) => paged(`${u()}/items?itemType=attachment${trashed ? "&includeTrashed=1" : ""}`),
    annotations: ({ trashed = false } = {}) => paged(`${u()}/items?itemType=annotation${trashed ? "&includeTrashed=1" : ""}`),
    item: async (key) => (await call("GET", `${u()}/items/${key}`)).data,
    // Zotero's search (?q=) does not look into the DOI field (checked on the live API: no hits for a DOI that is
    // there), so the library's top-level items are read and compared here. One request per 100 items.
    findByDoi: async (doi) => {
      const want = doi.toLowerCase();
      const has = (d) => (d.DOI || "").toLowerCase() === want || (d.url || "").toLowerCase() === `https://doi.org/${want}`
        || new RegExp(`^DOI:\\s*${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(d.extra || "");
      return (await paged(`${u()}/items/top`)).find((it) => has(it.data)) || null;
    },
    findByUrl: async (url) => (await paged(`${u()}/items/top`)).find((it) => it.data.url === url && it.data.itemType !== "attachment") || null,
    create,
    /** PATCH; returns { version } or { conflict: true } when the item changed since ifVersion. */
    patch: async (key, fields, ifVersion) => {
      const res = await call("PATCH", `${u()}/items/${key}`, { body: fields, ifVersion });
      // the marker of a note file needs the new version; without it the next sync would see a fresh file
      if (!res.conflict && !res.version) throw new Error(words().noVersion);
      return res;
    },
    /** Delete for good (not to the trash); the children of the item go with it. */
    remove: (key, ifVersion) => call("DELETE", `${u()}/items/${key}`, { ifVersion }),
    createCollection: async (name, parent = null) => {
      const { data } = await call("POST", `${u()}/collections`, { body: [{ name, parentCollection: parent || false }] });
      const made = data.successful?.["0"];
      if (!made) throw new Error(words().notCreated(data.failed?.["0"]?.message));
      return made.key;
    },
    upload,
    download,
  };
}

/**
 * Several libraries behind the interface of one client. A read is the join of all of them and fails when one fails;
 * each record says where it lives (`lib`). A write goes to the library that owns the key. clients[0] is the personal
 * library. `twins` collects the item keys met in two libraries (a move to a group that did not finish).
 */
export function libraries(clients) {
  const [home] = clients;
  const items = new Map(); // item key -> client
  const colls = new Map(); // collection key -> client
  const twins = new Set();
  const tag = (zot, list) => list.map((x) => ({ ...x, lib: zot.lib }));
  const seen = (zot, list) => {
    for (const x of list) {
      if (items.has(x.key) && items.get(x.key) !== zot) twins.add(x.key);
      items.set(x.key, zot);
    }
    return tag(zot, list);
  };
  const join = (read, note = seen) => async () => (await Promise.all(clients.map(async (zot) => note(zot, await read(zot))))).flat();
  const collections = join((zot) => zot.collections(), (zot, list) => {
    for (const c of list) colls.set(c.key, zot);
    return tag(zot, list);
  });

  async function of(key) {
    if (items.has(key)) return items.get(key);
    for (const zot of clients) {
      try {
        seen(zot, [await zot.item(key)]);
        return zot;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    throw Object.assign(new Error(words().notFound(key)), { status: 404 });
  }
  async function ofCollection(key) {
    if (!colls.has(key)) await collections();
    return colls.get(key) || home;
  }
  const first = (find) => async (arg) => {
    for (const zot of clients) {
      const hit = await find(zot, arg);
      if (hit) return seen(zot, [hit])[0];
    }
    return null;
  };

  return {
    lib: home.lib,
    libs: clients.map((zot) => zot.lib), // every connected library: the sync checks the vault's groups against it
    twins,
    whoami: () => home.whoami(),
    groups: () => home.groups(),
    collections,
    notes: join((zot) => zot.notes()),
    attachments: join((zot) => zot.attachments()),
    annotations: join((zot) => zot.annotations()),
    collectionTop: async (key) => {
      const zot = await ofCollection(key);
      return seen(zot, await zot.collectionTop(key));
    },
    children: async (key) => {
      const zot = await of(key);
      return seen(zot, await zot.children(key));
    },
    item: async (key) => {
      const zot = await of(key);
      return { ...(await zot.item(key)), lib: zot.lib };
    },
    findByDoi: first((zot, doi) => zot.findByDoi(doi)),
    findByUrl: first((zot, url) => zot.findByUrl(url)),
    /** A child goes where its parent is, a top-level item where its collection is, anything else to the personal library. */
    create: async (item) => {
      const zot = item.parentItem ? await of(item.parentItem) : item.collections?.[0] ? await ofCollection(item.collections[0]) : home;
      const made = await zot.create(item);
      items.set(made.key, zot);
      return { ...made, lib: zot.lib };
    },
    patch: async (key, fields, ifVersion) => (await of(key)).patch(key, fields, ifVersion),
    remove: async (key, ifVersion) => (await of(key)).remove(key, ifVersion),
    upload: async (key, file) => (await of(key)).upload(key, file),
    download: async (key) => (await of(key)).download(key),
  };
}

/**
 * The client and the root collections for these settings: the personal library, plus every group of the account
 * that has a top-level collection named like the personal root. Sharing a project needs no setting: the group joins
 * the sync when that collection appears in it.
 */
export async function workspace({ apiKey, userId, collection, fetchFn = fetch }) {
  const home = client({ apiKey, userId, fetchFn });
  const rootName = (await home.collections()).find((c) => c.key === collection)?.data.name;
  const zots = [home];
  const scopes = [collection];
  for (const g of rootName ? await home.groups() : []) {
    const zot = client({ apiKey, userId, groupId: g.id, groupName: g.data.name, fetchFn });
    const root = (await zot.collections()).find((c) => c.data.name === rootName && !c.data.parentCollection);
    if (!root) continue;
    zots.push(zot);
    scopes.push(root.key);
  }
  return { zot: libraries(zots), scopes, home };
}

// ---------- files of a paper (the CLI and easy-read store them the same way) ----------

// A new attachment whose upload failed has no file: it is removed again, so it is never taken for the paper's PDF.
async function createWithFile(zot, item, file) {
  const made = await zot.create(item);
  try {
    await zot.upload(made.key, file);
  } catch (e) {
    await zot.remove(made.key, made.version).catch(() => {}); // the upload error is the one to report
    throw e;
  }
  return made;
}

/** Store the paper's own PDF: new bytes for the PDF attachment the paper has, else a new attachment. */
export async function putPdf(zot, paperKey, bytes, filename) {
  const old = mainPdf(await zot.children(paperKey));
  if (old) {
    await zot.upload(old.key, { bytes, filename, oldMd5: old.data.md5 || null });
    return { key: old.key, replaced: true };
  }
  const item = { itemType: "attachment", linkMode: "imported_file", parentItem: paperKey, title: "PDF", contentType: "application/pdf", filename };
  return { key: (await createWithFile(zot, item, { bytes, filename })).key, replaced: false };
}

/** Store a file as a material of the paper; -> { key, version } of the new attachment. */
export const putMaterial = (zot, paperKey, bytes, filename, title = "") =>
  createWithFile(zot, materialItem({ parent: paperKey, title, file: filename }), { bytes, filename });

/** Keys of a collection and of everything nested in it, with names: [{ key, name, parent }], root first.
 * roots: one key or a list of keys (one root per library). */
export function collectionTree(collections, roots) {
  const out = [];
  const walk = (key) => {
    const c = collections.find((x) => x.key === key);
    if (!c) return;
    out.push({ key, name: c.data.name, parent: c.data.parentCollection || null, ...(c.lib ? { lib: c.lib } : {}) });
    collections.filter((x) => x.data.parentCollection === key).sort((a, b) => a.data.name.localeCompare(b.data.name)).forEach((x) => walk(x.key));
  };
  for (const root of [roots].flat()) walk(root);
  return out;
}

// ---------- public metadata (no key) ----------

async function publicJson(url, fetchFn) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(words().noMetadata(res.status, url));
  return res.json();
}

/** DOI -> Zotero item fields (Crossref; Zenodo for 10.5281). */
export async function lookupDoi(doi, fetchFn = fetch) {
  if (doi.startsWith("10.5281/")) {
    const rec = await publicJson(`https://zenodo.org/api/records/${doi.split(".").at(-1)}`, fetchFn);
    return zenodoToItem(rec.metadata, doi);
  }
  const body = await publicJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, fetchFn);
  return crossrefToItem(body.message, doi);
}

/** PMID -> DOI (NCBI esummary), or null. */
export async function pmidToDoi(pmid, fetchFn = fetch) {
  const body = await publicJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}`, fetchFn);
  const ids = body.result?.[pmid]?.articleids || [];
  return ids.find((x) => x.idtype === "doi")?.value?.toLowerCase() || null;
}
