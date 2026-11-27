import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOps, makeCache, docIds } from "../extension/zotero.js";

const LIN = { key: "6CB3DZSS", version: 3, data: { itemType: "journalArticle", title: "Multiplexed 3D atlas", creators: [{ lastName: "Lin" }], date: "2023", DOI: "10.1234/lin", extra: "obsidian: 1_education/papers/lin-2023-3d-crc-atlas.md" } };
const note = (key, html, more = {}) => ({ key, version: 5, data: { itemType: "note", parentItem: LIN.key, note: html, tags: [], dateAdded: key, ...more } });

// the paper's own PDF, stored in Zotero
const PDF = { key: "PDFATT01", version: 2, data: { itemType: "attachment", linkMode: "imported_file", parentItem: LIN.key, title: "PDF", filename: "lin.pdf", contentType: "application/pdf", tags: [], dateAdded: "2026-01-01" } };

function world({ items = [LIN], kids = [], collections = null, collection = "ROOT" } = {}) {
  const calls = [];
  const all = new Map(items.map((it) => [it.key, it]));
  let n = 0;
  const zot = {
    collections: async () => collections ?? [{ key: "ROOT", data: { name: "Reading list", parentCollection: false } }, { key: "SUB", data: { name: "VBC", parentCollection: "ROOT" } }],
    collectionTop: async (key) => (key === "SUB" ? items : []),
    children: async () => kids,
    attachments: async () => kids.filter((k) => k.data.itemType === "attachment"),
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
  return { calls, fetched, mem, ops: makeOps({ zot, cache: makeCache(storage), collection, fetchFn }) };
}

test("docIds: hash, DOI, address without the fragment", () => {
  assert.deepEqual(docIds({ hash: "ab", url: "https://x.org/a#page=2" }, "10.1/x"), ["h:ab", "d:10.1/x", "u:https://x.org/a"]);
  assert.deepEqual(docIds({ url: "" }, null), []);
});

test("status finds a paper by the page's DOI meta tag and lists its notes, summary first", async () => {
  const kids = [note("B", "<blockquote><p>quoted words</p></blockquote><p>mine</p>"), note("A", "<p>вывод</p>", { tags: [{ tag: "summary" }] }), note("C", "<p>x</p>", { deleted: 1 }), note("D", '<p><img src="i"></p>')];
  const w = world({ kids: [...kids, PDF] });
  const out = await w.ops.status({ doc: { url: "https://cell.com/x", meta: { citation_doi: "10.1234/lin", citation_pdf_url: "https://cell.com/x.pdf" } } });
  assert.deepEqual(out.paper, { key: "6CB3DZSS", title: "Multiplexed 3D atlas", label: "Lin 2023", url: "https://doi.org/10.1234/lin", slug: "lin-2023-3d-crc-atlas", pdf: "PDFATT01", zoteroUrl: "zotero://select/library/items/6CB3DZSS" });
  assert.deepEqual(out.materials, []); // the paper's own PDF is not a material
  assert.equal(out.pdfUrl, "https://cell.com/x.pdf");
  assert.deepEqual(out.notes.map((n) => [n.key, n.summary, n.quote, n.readOnly]), [["A", true, "", false], ["B", false, "quoted words", false], ["D", false, "", true]]);
  assert.deepEqual(w.mem.zoteroDocs, [["d:10.1234/lin", "6CB3DZSS"], ["u:https://cell.com/x", "6CB3DZSS"]]);
});

test("an unknown page is not saved by status", async () => {
  const w = world();
  assert.deepEqual(await w.ops.status({ doc: { url: "https://x.org/a", meta: {} } }), { paper: null, pdfUrl: null, notes: [], materials: [] });
  assert.deepEqual(w.calls, []);
});

test("save: PubMed page -> DOI by PMID -> Crossref item in the collection, slug in Extra; no link to the journal's PDF", async () => {
  const w = world();
  const doc = { url: "https://pubmed.ncbi.nlm.nih.gov/42/", meta: { citation_pdf_url: "https://x.org/p.pdf" } };
  const out = await w.ops.save({ doc });
  assert.equal(out.paper.slug, "isaev-2026-new-paper-about");
  const [paper] = w.calls;
  assert.deepEqual([paper.item.itemType, paper.item.DOI, paper.item.collections, paper.item.tags], ["journalArticle", "10.1234/new", ["ROOT"], [{ tag: "reading-list" }]]);
  assert.equal(paper.item.extra, "obsidian: 1_education/papers/isaev-2026-new-paper-about.md\nPMID: 42");
  assert.equal((await w.ops.save({ doc })).paper.key, "NEW1"); // second time: found in the cache, nothing created
  assert.equal(w.calls.length, 1);
});

test("several libraries: a new paper goes to the personal collection; a collection of a group carries the group's name", async () => {
  const collections = [
    { key: "ROOT", data: { name: "Reading list", parentCollection: false } },
    { key: "SUB", lib: { type: "group", id: 42, name: "Lab group" }, data: { name: "VBC", parentCollection: "GROOT" } },
    { key: "GROOT", lib: { type: "group", id: 42, name: "Lab group" }, data: { name: "Reading list", parentCollection: false } },
  ];
  const shared = { ...LIN, lib: { type: "group", id: 42, name: "Lab group" } };
  const w = world({ items: [shared], collections, collection: ["ROOT", "GROOT"] });
  const { groups } = await w.ops.list();
  assert.deepEqual(groups.map((g) => [g.name, g.items.map((i) => i.zoteroUrl)]), [["VBC · Lab group", ["zotero://select/groups/42/items/6CB3DZSS"]]]);
  await w.ops.save({ doc: { url: "https://blog.org/post", title: "Some blog post", meta: {} } });
  assert.deepEqual(w.calls[0].item.collections, ["ROOT"]);
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

test("pdfSaved ties the file hash to the paper and writes nothing to Zotero", async () => {
  const plain = { key: "P1", version: 4, data: { itemType: "journalArticle", title: "t", extra: "obsidian: 1_education/papers/t.md" } };
  const w = world({ items: [plain] });
  await w.ops.pdfSaved({ key: "P1", hash: "abc" });
  assert.deepEqual(w.calls, []);
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

test("remove takes the paper out of every collection of the reading list and leaves the others", async () => {
  const lin = { ...LIN, data: { ...LIN.data, collections: ["SUB", "ROOT", "ELSEWHERE"] } };
  const w = world({ items: [lin] });
  await w.ops.remove({ key: lin.key });
  assert.deepEqual(w.calls, [{ op: "patch", key: lin.key, fields: { collections: ["ELSEWHERE"] }, ifVersion: 3 }]);

  const out = world({ items: [{ ...LIN, data: { ...LIN.data, collections: ["ELSEWHERE"] } }] });
  await out.ops.remove({ key: LIN.key });
  assert.deepEqual(out.calls, []); // already out of the list: nothing is sent
});

test("remove retries once when the item changed in Zotero, then reports the failure", async () => {
  const w = world({ items: [{ ...LIN, version: 999, data: { ...LIN.data, collections: ["SUB"] } }] });
  await assert.rejects(w.ops.remove({ key: LIN.key }), /статья не убрана/);
  assert.equal(w.calls.length, 2);
});

test("remove refuses when the reading-list collection is not found, instead of reporting success", async () => {
  const w = world({ items: [{ ...LIN, data: { ...LIN.data, collections: ["SUB"] } }] });
  const ops = (await import("../extension/zotero.js")).makeOps({ zot: { collections: async () => [], item: async () => LIN }, cache: null, collection: "GONE" });
  await assert.rejects(ops.remove({ key: LIN.key }), /Коллекция Zotero не найдена/);
  assert.deepEqual(w.calls, []);
});

test("note: the answer names the note it made, with what the vault file needs", async () => {
  const w = world();
  const out = await w.ops.note({ doc: { url: "https://cell.com/x", meta: { citation_doi: "10.1234/lin" } }, quote: "quoted words here", comment: "" });
  assert.equal(out.made, "NEW1");
  assert.deepEqual(out.madeNote, { key: "NEW1", version: 1, body: "> quoted words here\n\nhttps://cell.com/x", summary: false });
  assert.equal(out.notes.length, 1);
});

test("status by key: the notes tab names its paper, nothing is searched", async () => {
  const w = world({ kids: [note("B", "<p>mine</p>")] });
  const out = await w.ops.status({ doc: { key: "6CB3DZSS", url: "", meta: {} } });
  assert.equal(out.paper.key, "6CB3DZSS");
  assert.deepEqual(out.notes.map((n) => n.key), ["B"]);
  assert.deepEqual(w.fetched, []);
  assert.equal(w.mem.zoteroDocs, undefined);
});

const material = (key, title, url, kind, more = {}) => ({ key, version: 4, data: { itemType: "attachment", linkMode: "linked_url", parentItem: LIN.key, title, url, tags: [{ tag: "paper-material" }, { tag: `material-${kind}` }], ...more } });

test("materials: the reading list and the status of a paper carry them; trashed ones, the paper's own PDF and a saved web page do not count", async () => {
  const talk = material("M1", "Talk", "https://youtu.be/abc", "video");
  const gone = material("M2", "gone", "https://x.com/a/status/1", "thread", { deleted: 1 });
  const snapshot = { key: "SNAP0001", version: 1, data: { itemType: "attachment", linkMode: "imported_url", parentItem: LIN.key, title: "Snapshot", contentType: "text/html", tags: [] } };
  // a file stored in Zotero, and a link added by hand in Zotero (no tags)
  const suppl = { key: "SUPPL001", version: 1, data: { itemType: "attachment", linkMode: "imported_file", parentItem: LIN.key, title: "Supplementary", filename: "s.pdf", contentType: "application/pdf", tags: [{ tag: "paper-material" }, { tag: "material-pdf" }] } };
  const byHand = { key: "HAND0001", version: 1, data: { itemType: "attachment", linkMode: "linked_url", parentItem: LIN.key, title: "Review", url: "https://x.org/review", tags: [] } };
  const w = world({ kids: [talk, gone, PDF, snapshot, suppl, byHand, note("B", "<p>mine</p>")] });
  const views = [
    { key: "M1", title: "Talk", kind: "video", url: "https://youtu.be/abc", path: "", stored: false },
    { key: "SUPPL001", title: "Supplementary", kind: "pdf", url: "zotero://open-pdf/library/items/SUPPL001", path: "", stored: true },
    { key: "HAND0001", title: "Review", kind: "link", url: "https://x.org/review", path: "", stored: false },
  ];
  const listed = (await w.ops.list()).groups[0].items[0];
  assert.deepEqual([listed.pdf, listed.materials], ["PDFATT01", views]);
  const out = await w.ops.status({ doc: { key: LIN.key } });
  assert.deepEqual([out.paper.pdf, out.materials], ["PDFATT01", views]);
  assert.deepEqual(out.notes.map((n) => n.key), ["B"]);
});

test("materialAdd: a note of the vault gets an obsidian address; a second add is a no-op", async () => {
  const w = world();
  const path = "1_education/papers/materials/lin-2023-3d-crc-atlas--talk.md";
  const made = await w.ops.materialAdd({ key: LIN.key, title: "Talk transcript", target: path, vaultName: "vault" });
  assert.deepEqual(made, { key: "NEW1", existed: false });
  assert.deepEqual(w.calls[0].item, { itemType: "attachment", linkMode: "linked_url", parentItem: LIN.key, title: "Talk transcript",
    url: "obsidian://open?vault=vault&file=1_education%2Fpapers%2Fmaterials%2Flin-2023-3d-crc-atlas--talk.md", tags: [{ tag: "paper-material" }, { tag: "material-note" }] });

  const kids = [{ key: "NEW1", version: 1, data: w.calls[0].item }];
  const again = world({ kids });
  assert.deepEqual(await again.ops.materialAdd({ key: LIN.key, target: path, vaultName: "vault" }), { key: "NEW1", existed: true });
  assert.deepEqual(again.calls, []);
  await assert.rejects(again.ops.materialAdd({ key: LIN.key, target: "" }), /Пустой материал/);
});

test("materialRemove: the Zotero child goes to the trash; a paper and the paper's own PDF are refused", async () => {
  const byHand = { key: "HAND0001", version: 4, data: { itemType: "attachment", linkMode: "linked_url", parentItem: LIN.key, title: "Review", url: "https://x.org/review", tags: [] } };
  const w = world({ items: [LIN, PDF, byHand, material("M1", "Talk", "https://youtu.be/abc", "video")], kids: [PDF, byHand] });
  assert.deepEqual(await w.ops.materialRemove({ materialKey: "M1" }), {});
  assert.deepEqual(await w.ops.materialRemove({ materialKey: "HAND0001" }), {}); // added by hand in Zotero: no tags
  assert.deepEqual(w.calls, [{ op: "patch", key: "M1", fields: { deleted: 1 }, ifVersion: 4 }, { op: "patch", key: "HAND0001", fields: { deleted: 1 }, ifVersion: 4 }]);
  await assert.rejects(w.ops.materialRemove({ materialKey: LIN.key }), /не материал/);
  await assert.rejects(w.ops.materialRemove({ materialKey: "PDFATT01" }), /не материал/);
  assert.equal(w.calls.length, 2);
});
