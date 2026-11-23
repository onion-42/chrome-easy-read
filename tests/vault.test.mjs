import { test } from "node:test";
import assert from "node:assert/strict";
import { saveNote, saveMaterial } from "../extension/vault-pdf.js";
import * as P from "../extension/papers.js";

/* an in-memory directory handle: just what vault-pdf.js calls */
function fakeDir(files = {}, path = "") {
  const notFound = () => Object.assign(new Error("missing"), { name: "NotFoundError" });
  return {
    files,
    async getDirectoryHandle(name, { create = false } = {}) {
      const prefix = `${path}${name}/`;
      if (!create && !Object.keys(files).some((f) => f.startsWith(prefix))) throw notFound();
      return fakeDir(files, prefix);
    },
    async getFileHandle(name, { create = false } = {}) {
      const full = path + name;
      if (!(full in files)) {
        if (!create) throw notFound();
        files[full] = "";
      }
      return {
        getFile: async () => ({ text: async () => files[full], size: files[full].length, arrayBuffer: async () => files[full].buffer }),
        createWritable: async () => ({ write: async (data) => void (files[full] = data), close: async () => {} }),
      };
    },
  };
}

const PASSPORT = "# Lin 2023\n\n- **Zotero:** x\n\n## Заметки\n\n";
const NOTE = { slug: "lin-2023-atlas", label: "Lin 2023", key: "ABCD1234", version: 7, body: "> quoted words\n\nmine" };

test("saveNote writes the file the sync would write and links it from the paper's note", async () => {
  const dir = fakeDir({ "1_education/papers/lin-2023-atlas.md": PASSPORT });
  const out = await saveNote(dir, NOTE);
  assert.deepEqual(out, { path: "1_education/papers/notes/lin-2023-atlas--ABCD1234.md" });
  assert.equal(dir.files[out.path], P.renderNoteFile({ title: "Lin 2023 — mine", paperSlug: "lin-2023-atlas", body: NOTE.body, key: "ABCD1234", version: 7 }));
  assert.equal(P.decide({ local: P.parseNoteFile(dir.files[out.path]), remote: { key: "ABCD1234", version: 7, html: "" } }).op, "skip");
  assert.match(dir.files["1_education/papers/lin-2023-atlas.md"], /## Заметки\n- \[\[lin-2023-atlas--ABCD1234\]\]/);
});

test("saveNote never overwrites a note file, and waits for the sync when the paper has no note yet", async () => {
  const path = "1_education/papers/notes/lin-2023-atlas--ABCD1234.md";
  const dir = fakeDir({ "1_education/papers/lin-2023-atlas.md": PASSPORT, [path]: "mine, edited in Obsidian" });
  await saveNote(dir, NOTE);
  assert.equal(dir.files[path], "mine, edited in Obsidian");

  const empty = fakeDir({});
  assert.deepEqual(await saveNote(empty, NOTE), { reason: "no-passport" });
  assert.deepEqual(Object.keys(empty.files), []);
});

test("saveMaterial: the same bytes are the same file, other bytes of the same length get the next name", async () => {
  const dir = fakeDir({});
  const first = await saveMaterial(dir, "supp.pdf", new Uint8Array([1, 2, 3]));
  const again = await saveMaterial(dir, "supp.pdf", new Uint8Array([1, 2, 3]));
  const revised = await saveMaterial(dir, "supp.pdf", new Uint8Array([1, 2, 4]));

  assert.equal(first.existed, false);
  assert.deepEqual(again, { path: first.path, existed: true });
  assert.equal(revised.existed, false);
  assert.notEqual(revised.path, first.path);
  assert.deepEqual([...dir.files[first.path]], [1, 2, 3]);
  assert.deepEqual([...dir.files[revised.path]], [1, 2, 4]);
});

test("saveMaterial: Word and Excel files go next to the PDFs, a note goes to the materials folder", async () => {
  const dir = fakeDir({});
  const sheet = await saveMaterial(dir, "lin-2023--table-s1.xlsx", new Uint8Array([1]));
  const doc = await saveMaterial(dir, "lin-2023--reviewers.docx", new Uint8Array([2]));
  const note = await saveMaterial(dir, "lin-2023--talk.md", new Uint8Array([3]));

  assert.equal(sheet.path, "0_media/papers/lin-2023--table-s1.xlsx");
  assert.equal(doc.path, "0_media/papers/lin-2023--reviewers.docx");
  assert.equal(note.path, "1_education/papers/materials/lin-2023--talk.md");
});
