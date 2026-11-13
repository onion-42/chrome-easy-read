// PDFs in the Obsidian vault, through the File System Access API. easy-read touches one folder only:
// 0_media/papers/ (create, replace on request, read). It never reads or edits notes.
// The handle lives in IndexedDB; after a Chrome restart the permission is "prompt" again and needs a click.

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

export async function pickVault() {
  const dir = await window.showDirectoryPicker({ id: "vault", mode: "readwrite" });
  await idb("readwrite", (s) => s.put(dir, KEY));
  return dir;
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
