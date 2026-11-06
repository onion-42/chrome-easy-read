// Immersive-reading options, kept in chrome.storage.local (the API key never syncs).

export const READER_KEY = "reader";

/** Speeds offered in the subtitle bar and on the options page. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 4.5, 5];

export const READER_DEFAULTS = {
  engine: "gemini",                     // "gemini" | "builtin"
  apiKey: "",
  model: "gemini-3.8-flash-tts",
  voice: "Kore",
  style: "calm and clear",
  rate: 1,
  readCitations: false,
  builtinOnly: "", // domains whose text never goes to Google (e.g. an employer's wiki)
};

export async function loadReaderOptions() {
  const stored = (await chrome.storage.local.get(READER_KEY))[READER_KEY];
  return { ...READER_DEFAULTS, ...stored };
}

export async function saveReaderOptions(changes) {
  const next = { ...(await loadReaderOptions()), ...changes };
  await chrome.storage.local.set({ [READER_KEY]: next });
  return next;
}
