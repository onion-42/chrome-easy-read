// The Obsidian vault, through the File System Access API. easy-read creates the file of a note it has just made
// in 1_education/papers/notes/ (plus its link in the paper's note) and copies a material .md that is not in the
// vault yet into 1_education/papers/materials/. It never edits or replaces an existing note or material: edits
// go through Zotero and the sync. PDFs and other files are not kept here: they are stored in Zotero (zotero.js,
// zoteroFiles). The handle lives in IndexedDB; after a Chrome restart the permission is "prompt" again and
// needs a click.
import * as P from "./papers.js";

const DB = "easy-read", STORE = "kv", KEY = "vault";

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

// Tests inject an OPFS directory here instead of the picker (window.__vaultOverride).
export async function getVault() {
  return globalThis.__vaultOverride || (await idb("readonly", (s) => s.get(KEY))) || null;
}

/** Ask for a folder. Nothing is remembered here: the caller checks the folder first (isVaultRoot), then keepVault. */
export const pickVault = () => window.showDirectoryPicker({ id: "vault", mode: "readwrite" });
export const keepVault = (dir) => idb("readwrite", (s) => s.put(dir, KEY));
export const forgetVault = () => idb("readwrite", (s) => s.delete(KEY));

/** The root of an Obsidian vault has a .obsidian folder. A subfolder would get the notes in the wrong place,
 * and its name would not open anything in Obsidian. Needs read access to the folder. */
export async function isVaultRoot(dir) {
  try {
    await dir.getDirectoryHandle(".obsidian");
    return true;
  } catch (e) {
    if (e.name === "NotFoundError") return false;
    throw e;
  }
}

// "granted" | "prompt" | "denied"; interactive = true must run inside a click handler.
export async function permission(dir, interactive = false) {
  if (!dir.queryPermission) return "granted"; // OPFS handles have no permission model
  const state = await dir.queryPermission({ mode: "readwrite" });
  if (state !== "prompt" || !interactive) return state;
  return dir.requestPermission({ mode: "readwrite" });
}

/* ---------- materials of a paper ---------- */

/** Path of a picked file inside the vault ("a/b/c.md"), or null when it lies outside. */
export async function vaultPathOf(dir, handle) {
  const parts = await dir.resolve(handle);
  return parts ? parts.join("/") : null;
}

const MAX_SAME_NAMES = 9;

/** Copy a material note (.md) into 1_education/papers/materials/. Any other file is stored in Zotero instead.
 * -> { path, existed }. A file is never overwritten: the same name with the same bytes is the same file
 * (existed), another file under that name gets "-2", "-3", … */
export async function saveMaterial(dir, name, bytes) {
  if (!/\.md$/i.test(name)) throw new Error(`not a note: ${name}`);
  const folder = P.MATERIALS_DIR.split("/");
  const d = await walk(dir, folder, true);
  const dot = name.lastIndexOf(".");
  for (let n = 1; n <= MAX_SAME_NAMES; n++) {
    const candidate = n === 1 ? name : `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
    const path = [...folder, candidate].join("/");
    try {
      const old = await (await d.getFileHandle(candidate)).getFile();
      if (old.size === bytes.byteLength) {
        const was = new Uint8Array(await old.arrayBuffer());
        if (was.every((b, i) => b === bytes[i])) return { path, existed: true };
      }
    } catch (e) {
      if (e.name !== "NotFoundError") throw e;
      const w = await (await d.getFileHandle(candidate, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
      return { path, existed: false };
    }
  }
  throw new Error(`в vault уже есть ${MAX_SAME_NAMES} разных файлов с именем ${name}`);
}

/* ---------- text files ---------- */

async function walk(dir, names, create = false) {
  let d = dir;
  for (const name of names) d = await d.getDirectoryHandle(name, { create });
  return d;
}

/** -> the text of a file, or null when the file (or its folder) is not there. */
async function readText(dir, names, name) {
  try {
    return await (await (await (await walk(dir, names)).getFileHandle(name)).getFile()).text();
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
}

async function writeText(dir, names, name, text) {
  const w = await (await (await walk(dir, names, true)).getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
}

/**
 * The file of a note that was just created in Zotero, exactly as the sync would write it, and its link in
 * the paper's note -> { path } or { reason: "no-passport" } (the paper has no note in the vault yet: the
 * sync writes both). An existing file is never touched.
 */
export async function saveNote(dir, { slug, label, key, version, body, summary = false }) {
  const papers = P.PAPERS_DIR.split("/"), notes = P.NOTES_DIR.split("/");
  const passport = slug ? await readText(dir, papers, `${slug}.md`) : null;
  if (passport === null) return { reason: "no-passport" };
  const name = P.noteFileName(slug, key);
  const path = `${P.NOTES_DIR}/${name}`;
  if ((await readText(dir, notes, name)) !== null) return { path };
  await writeText(dir, notes, name, P.renderNoteFile({ title: P.noteTitle(label, body, summary), paperSlug: slug, body, key, version, summary }));
  // read again: the sync may have added a line to the paper's note while the note file was being written
  const now = (await readText(dir, papers, `${slug}.md`)) ?? passport;
  const linked = P.withNoteLink(now, name.replace(/\.md$/, ""));
  if (linked !== now) await writeText(dir, papers, `${slug}.md`, linked);
  return { path };
}

/** saveNote with its refusals -> { path } or { reason }: "no-vault", "permission", "no-passport". */
export async function keepNote(note) {
  const dir = await getVault();
  if (!dir) return { reason: "no-vault" };
  if ((await permission(dir)) !== "granted") return { reason: "permission" };
  return saveNote(dir, note);
}
