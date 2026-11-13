// Zotero Web API v3 client + public metadata lookups. Pure: no chrome.*, no fs; fetch is injectable for tests.
// One source of truth (skill zotero-link); both extensions ship byte-identical copies.
import { crossrefToItem, zenodoToItem } from "./papers.js";

export const API = "https://api.zotero.org";
export const NO_KEY = "Добавь ключ Zotero API в настройках расширения.";
const RETRY_STATUS = new Set([429, 503]);
const PAGE = 100;

function failure(method, path, status) {
  if (status === 403) return "Zotero отклонил ключ API. Проверь ключ и его права (library, notes, write) в настройках.";
  if (status === 404) return `Zotero: запись не найдена (${path.split("?")[0]}).`;
  if (status >= 500) return `Zotero сейчас недоступен (HTTP ${status}). Попробуй позже.`;
  return `Zotero ${method} ${path.split("?")[0]}: HTTP ${status}`;
}

export function client({ apiKey, userId, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey) throw new Error(NO_KEY);

  async function call(method, path, { body, ifVersion } = {}) {
    const headers = { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (ifVersion != null) headers["If-Unmodified-Since-Version"] = String(ifVersion);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        throw new Error("Нет связи с Zotero. Проверь интернет.", { cause: e });
      }
      if (RETRY_STATUS.has(res.status) && attempt < 2) {
        await sleep(1000 * (Number(res.headers.get("Retry-After")) || attempt + 1));
        continue;
      }
      if (res.status === 412) return { conflict: true };
      if (!res.ok) throw new Error(failure(method, path, res.status));
      return {
        data: res.status === 204 ? null : await res.json(),
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

  const u = () => `/users/${userId}`;

  /** POST one new item; returns { key, version } or throws with Zotero's reason. */
  async function create(item) {
    const { data } = await call("POST", `${u()}/items`, { body: [item] });
    const made = data.successful?.["0"];
    if (!made) throw new Error(`Zotero не создал запись: ${data.failed?.["0"]?.message || "неизвестная причина"}`);
    return { key: made.key, version: made.version };
  }

  return {
    whoami: async () => (await call("GET", "/keys/current")).data,
    collections: () => paged(`${u()}/collections`),
    collectionTop: (key) => paged(`${u()}/collections/${key}/items/top?includeTrashed=1`),
    notes: () => paged(`${u()}/items?itemType=note&includeTrashed=1`),
    children: (key) => paged(`${u()}/items/${key}/children`),
    item: async (key) => (await call("GET", `${u()}/items/${key}`)).data,
    findByDoi: async (doi) => {
      const { data } = await call("GET", `${u()}/items?q=${encodeURIComponent(doi)}&qmode=everything&limit=5`);
      return data.find((it) => (it.data.DOI || "").toLowerCase() === doi.toLowerCase()) || null;
    },
    findByUrl: async (url) => {
      const { data } = await call("GET", `${u()}/items?q=${encodeURIComponent(url)}&qmode=everything&limit=5`);
      return data.find((it) => it.data.url === url && it.data.itemType !== "attachment") || null;
    },
    create,
    /** PATCH; returns { version } or { conflict: true } when the item changed since ifVersion. */
    patch: (key, fields, ifVersion) => call("PATCH", `${u()}/items/${key}`, { body: fields, ifVersion }),
  };
}

/** Keys of a collection and of everything nested in it, with names: [{ key, name, parent }], root first. */
export function collectionTree(collections, rootKey) {
  const out = [];
  const walk = (key) => {
    const c = collections.find((x) => x.key === key);
    if (!c) return;
    out.push({ key, name: c.data.name, parent: c.data.parentCollection || null });
    collections.filter((x) => x.data.parentCollection === key).sort((a, b) => a.data.name.localeCompare(b.data.name)).forEach((x) => walk(x.key));
  };
  walk(rootKey);
  return out;
}

// ---------- public metadata (no key) ----------

async function publicJson(url, fetchFn) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Метаданные не получены (HTTP ${res.status}): ${url}`);
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
