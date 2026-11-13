import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOps, makeCache, docIds } from "../extension/zotero.js";

const LIN = { key: "6CB3DZSS", version: 3, data: { itemType: "journalArticle", title: "Multiplexed 3D atlas", creators: [{ lastName: "Lin" }], date: "2023", DOI: "10.1234/lin", extra: "obsidian: 1_education/papers/lin-2023-3d-crc-atlas.md\npdf: 0_media/papers/lin-2023-3d-crc-atlas.pdf" } };
const note = (key, html, more = {}) => ({ key, version: 5, data: { itemType: "note", parentItem: LIN.key, note: html, tags: [], dateAdded: key, ...more } });

function world({ items = [LIN], kids = [] } = {}) {
  const calls = [];
  const all = new Map(items.map((it) => [it.key, it]));
  let n = 0;
  const zot = {
    collections: async () => [{ key: "ROOT", data: { name: "Reading list", parentCollection: false } }, { key: "SUB", data: { name: "VBC", parentCollection: "ROOT" } }],
    collectionTop: async (key) => (key === "SUB" ? items : []),
    children: async () => kids,
    item: async (key) => all.get(key) ?? Promise.reject(new Error("404")),
    findByDoi: async (doi) => items.find((it) => it.data.DOI === doi) ?? null,
    findByUrl: async (url) => items.find((it) => it.data.url === url) ?? null,
    create: async (item) => {
      const key = `NEW${++n}`;
      calls.push({ op: "create", item });
      all.set(key, { key, version: 1, data: item });
      if (item.itemType === "note") kids.push({ key, version: 1, data: { dateAdded: "z", ...item } });
      return { key, version: 1 };
    },
    patch: async (key, fields, ifVersion) => {
      calls.push({ op: "patch", key, fields, ifVersion });
      return ifVersion === 999 ? { conflict: true } : { version: 77 };
    },
  };
  const mem = {};
  const storage = { get: async (k) => ({ [k]: mem[k] }), set: async (o) => void Object.assign(mem, o) };
  const fetched = [];
  const fetchFn = async (url) => {
    fetched.push(url);
    if (url.includes("esummary")) return { ok: true, json: async () => ({ result: { 42: { articleids: [{ idtype: "doi", value: "10.1234/new" }] } } }) };
    if (url.includes("crossref")) return { ok: true, json: async () => ({ message: { type: "journal-article", title: ["The new paper about cells"], author: [{ family: "Isaev" }], issued: { "date-parts": [[2026]] } } }) };
    return { ok: false, status: 404 };
  };
  return { calls, fetched, mem, ops: makeOps({ zot, cache: makeCache(storage), collection: "ROOT", fetchFn }) };
}

test("docIds: hash, DOI, address without the fragment", () => {
  assert.deepEqual(docIds({ hash: "ab", url: "https://x.org/a#page=2" }, "10.1/x"), ["h:ab", "d:10.1/x", "u:https://x.org/a"]);
  assert.deepEqual(docIds({ url: "" }, null), []);
});

test("status finds a paper by the page's DOI meta tag and lists its notes, summary first", async () => {
  const kids = [note("B", "<blockquote><p>quoted words</p></blockquote><p>mine</p>"), note("A", "<p>вывод</p>", { tags: [{ tag: "summary" }] }), note("C", "<p>x</p>", { deleted: 1 }), note("D", '<p><img src="i"></p>')];
  const w = world({ kids });
  const out = await w.ops.status({ doc: { url: "https://cell.com/x", meta: { citation_doi: "10.1234/lin", citation_pdf_url: "https://cell.com/x.pdf" } } });
  assert.deepEqual(out.paper, { key: "6CB3DZSS", title: "Multiplexed 3D atlas", label: "Lin 2023", url: "https://doi.org/10.1234/lin", slug: "lin-2023-3d-crc-atlas", pdf: "0_media/papers/lin-2023-3d-crc-atlas.pdf" });
  assert.equal(out.pdfUrl, "https://cell.com/x.pdf");
  assert.deepEqual(out.notes.map((n) => [n.key, n.summary, n.quote, n.readOnly]), [["A", true, "", false], ["B", false, "quoted words", false], ["D", false, "", true]]);
  assert.deepEqual(w.mem.zoteroDocs, [["d:10.1234/lin", "6CB3DZSS"], ["u:https://cell.com/x", "6CB3DZSS"]]);
});

test("an unknown page is not saved by status", async () => {
  const w = world();
  assert.deepEqual(await w.ops.status({ doc: { url: "https://x.org/a", meta: {} } }), { paper: null, pdfUrl: null, notes: [] });
  assert.deepEqual(w.calls, []);
});

test("save: PubMed page -> DOI by PMID -> Crossref item in the collection, slug in Extra, PDF link attached", async () => {
  const w = world();
  const doc = { url: "https://pubmed.ncbi.nlm.nih.gov/42/", meta: { citation_pdf_url: "https://x.org/p.pdf" } };
  const out = await w.ops.save({ doc });
  assert.equal(out.paper.slug, "isaev-2026-new-paper-about");
  const [paper, pdf] = w.calls;
  assert.deepEqual([paper.item.itemType, paper.item.DOI, paper.item.collections, paper.item.tags], ["journalArticle", "10.1234/new", ["ROOT"], [{ tag: "reading-list" }]]);
  assert.equal(paper.item.extra, "obsidian: 1_education/papers/isaev-2026-new-paper-about.md\nPMID: 42");
  assert.deepEqual(pdf.item, { itemType: "attachment", linkMode: "linked_url", parentItem: "NEW1", title: "PDF", url: "https://x.org/p.pdf", contentType: "application/pdf" });
  assert.equal((await w.ops.save({ doc })).paper.key, "NEW1"); // second time: found in the cache, nothing created
  assert.equal(w.calls.length, 2);
});

test("save without a DOI makes a web page item; a taken slug gets a number", async () => {
  const taken = { key: "OLD", version: 1, data: { itemType: "webpage", title: "x", extra: "obsidian: 1_education/papers/some-blog-post.md" } };
  const w = world({ items: [taken] });
  const out = await w.ops.save({ doc: { url: "https://blog.org/post", title: "Some blog post", meta: {} } });
  assert.equal(out.paper.slug, "some-blog-post-2");
  assert.deepEqual([w.calls[0].item.itemType, w.calls[0].item.url], ["webpage", "https://blog.org/post"]);
});

test("note: quote + comment + page become a child note; the paper is saved first when new", async () => {
  const w = world();
  const doc = { url: "https://cell.com/x", meta: { citation_doi: "10.1234/lin" } };
  const out = await w.ops.note({ doc, quote: "TLS form networks", comment: "один пациент", page: "14" });
  assert.deepEqual(w.calls, [{ op: "create", item: { itemType: "note", parentItem: "6CB3DZSS", tags: [], note: "<blockquote><p>TLS form networks</p></blockquote>\n<p>один пациент</p>\n<p>Стр. 14 · https://cell.com/x</p>" } }]);
  assert.equal(out.notes[0].quote, "TLS form networks");
  await assert.rejects(w.ops.note({ doc }), /Пустая заметка/);
});

test("summary: one per paper, the second save edits the first", async () => {
  const w = world();
  const doc = { url: "https://cell.com/x", meta: { citation_doi: "10.1234/lin" } };
  await w.ops.note({ doc, comment: "итог 1", summary: true, quote: "ignored" });
  assert.deepEqual(w.calls[0].item, { itemType: "note", parentItem: "6CB3DZSS", note: "<p>итог 1</p>", tags: [{ tag: "summary" }] });
  await w.ops.note({ doc, comment: "итог 2", summary: true });
  assert.deepEqual(w.calls[1], { op: "patch", key: "NEW1", fields: { note: "<p>итог 2</p>" }, ifVersion: 1 });
});

test("edit: ok returns the new version; a conflict returns the remote text and keeps mine", async () => {
  const w = world({ items: [LIN, note("N1", "<p>remote text</p>")] });
  assert.deepEqual(await w.ops.edit({ noteKey: "N1", md: "mine", version: 5 }), { version: 77 });
  assert.deepEqual(await w.ops.edit({ noteKey: "N1", md: "mine", version: 999 }), { conflict: true, remote: { md: "remote text", version: 5 } });
});

test("pdfSaved writes the path to Extra once and ties the file hash to the paper", async () => {
  const plain = { key: "P1", version: 4, data: { itemType: "journalArticle", title: "t", extra: "obsidian: 1_education/papers/t.md" } };
  const w = world({ items: [plain] });
  await w.ops.pdfSaved({ key: "P1", path: "0_media/papers/t.pdf", hash: "abc" });
  assert.deepEqual(w.calls, [{ op: "patch", key: "P1", fields: { extra: "obsidian: 1_education/papers/t.md\npdf: 0_media/papers/t.pdf" }, ifVersion: 4 }]);
  assert.equal((await w.ops.status({ doc: { hash: "abc", url: "", meta: {} } })).paper.key, "P1");
});

test("attach ties an open local file to a chosen paper; list groups the reading list", async () => {
  const w = world();
  const out = await w.ops.attach({ key: "6CB3DZSS", doc: { hash: "ff", url: "" } });
  assert.equal(out.paper.key, "6CB3DZSS");
  assert.equal((await w.ops.status({ doc: { hash: "ff", url: "", meta: {} } })).paper.key, "6CB3DZSS");
  assert.deepEqual((await w.ops.list()).groups.map((g) => [g.name, g.items.map((i) => i.key)]), [["VBC", ["6CB3DZSS"]]]);
});

test("review: a DOI match in the cache beats an address cached for another paper", async () => {
  const mem = { zoteroDocs: [["u:https://x.org/latest", "PAPER_A"], ["d:10.1234/b", "PAPER_B"]] };
  const cache = makeCache({ get: async (k) => ({ [k]: mem[k] }), set: async (o) => void Object.assign(mem, o) });
  assert.equal(await cache.get(["d:10.1234/b", "u:https://x.org/latest"]), "PAPER_B");
  assert.equal(await cache.get(["u:https://x.org/latest"]), "PAPER_A");
  assert.equal(await cache.get(["h:none"]), null);
});

test("review: pdfSaved retries once when the item changed in Zotero, then reports the failure", async () => {
  const plain = { key: "P1", version: 999, data: { itemType: "journalArticle", title: "t", extra: "" } };
  const w = world({ items: [plain] });
  await assert.rejects(w.ops.pdfSaved({ key: "P1", path: "0_media/papers/t.pdf" }), /путь к PDF не записан/);
  assert.equal(w.calls.length, 2);
});
