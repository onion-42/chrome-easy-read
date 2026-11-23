// Runs in a page (injected by the service worker, or called by the PDF viewer): hands easy-read its
// profile, storage and font folder. Self-contained on purpose: chrome.scripting serialises it.
// Returns "pdf" on Chrome's own PDF viewer (nothing to restyle there; the extension's viewer takes over).
export function prepareHost(profile, fontBase, profileKey, saveDelayMs) {
  if (document.contentType === "application/pdf") return "pdf";
  if (window.__easyRead) {
    window.__easyRead.setEnabled(true);
    return "ok";
  }
  let timer = 0;
  window.__easyReadHost = {
    load: () => profile,
    save: (settings) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        chrome.storage.sync.set({ [profileKey]: settings })
          .catch((e) => console.error("easy-read: saving settings failed", e));
      }, saveDelayMs);
    },
    fontBase,
  };
  return "ok";
}

/** Load classic scripts into this extension page one after another (easy-read, the reader, the notes panel). */
export async function loadPageScripts(sources) {
  for (const src of sources) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`${src} did not load`));
      document.body.append(s);
    });
  }
}
