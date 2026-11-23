// The Obsidian vault, through the File System Access API. easy-read writes PDFs into 0_media/papers/
// (the paper's own PDF: create, replace on request, read; a material PDF: create), creates the file of a
// note it has just made in 1_education/papers/notes/ (plus its link in the paper's note) and copies a
// material .md that is not in the vault yet into 1_education/papers/materials/. It never edits or replaces
// an existing note or material: edits go through Zotero and the sync. The handle lives in IndexedDB; after a Chrome restart the permission is
// "prompt" again and needs a click.
import * as P from "./papers.js";

const DB = "easy-read", STORE = "kv", KEY = "vault";
export const PDF_DIR = ["0_media", "papers"];
export const MAX_PDF_BYTES = 95 * 1024 * 1024; // GitHub rejects a push with a file >= 100 MB

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

/** The root of an Obsidian vault has a .obsidian folder. A subfolder would get the PDFs in the wrong place,
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

/** Write <slug>.pdf into 0_media/papers/. An existing file is kept unless replace is set. */
export async function savePdf(dir, slug, bytes, { replace = false } = {}) {
  let d = dir;
  for (const name of PDF_DIR) d = await d.getDirectoryHandle(name, { create: true });
  const name = `${slug}.pdf`;
  const path = [...PDF_DIR, name].join("/");
  if (!replace) {
    try {
      await d.getFileHandle(name);
      return { path, existed: true };
    } catch (e) {
      if (e.name !== "NotFoundError") throw e;
    }
  }
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  await w.write(bytes);
  await w.close();
  return { path, existed: false };
}

/**
 * The whole "keep this PDF" step with its refusals -> { path, existed } or { reason }:
 * "no-vault" (no folder chosen), "permission" (needs a click), "too-big".
 */
export async function keepPdf(slug, bytes, { interactive = false, replace = false } = {}) {
  if (bytes.byteLength >= MAX_PDF_BYTES) return { reason: "too-big" };
  const dir = await getVault();
  if (!dir) return { reason: "no-vault" };
  if ((await permission(dir, interactive)) !== "granted") return { reason: "permission" };
  return savePdf(dir, slug, bytes, { replace });
}

/* ---------- materials of a paper ---------- */

/** Path of a picked file inside the vault ("a/b/c.md"), or null when it lies outside. */
export async function vaultPathOf(dir, handle) {
  const parts = await dir.resolve(handle);
  return parts ? parts.join("/") : null;
}

const MAX_SAME_NAMES = 9;

/** Copy a material file into the vault: a note (.md) to 1_education/papers/materials/, any other file (PDF, Word,
 * Excel) to 0_media/papers/, the folder of attachments.
 * -> { path, existed }. A file is never overwritten: the same name with the same bytes is the same file
 * (existed), another file under that name gets "-2", "-3", … */
export async function saveMaterial(dir, name, bytes) {
  const folder = /\.md$/i.test(name) ? P.MATERIALS_DIR.split("/") : PDF_DIR;
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

/** Read a PDF of the vault (0_media/papers/ only) -> File, or null when it is not there. */
export async function openPdf(dir, path) {
  const parts = path.split("/");
  if (parts.length !== PDF_DIR.length + 1 || PDF_DIR.some((name, i) => parts[i] !== name)) throw new Error(`not a vault PDF path: ${path}`);
  try {
    let d = dir;
    for (const name of PDF_DIR) d = await d.getDirectoryHandle(name);
    return await (await d.getFileHandle(parts.at(-1))).getFile();
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
}
