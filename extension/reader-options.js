// Immersive-reading options, kept in chrome.storage.local (the API keys never sync).

export const READER_KEY = "reader";

/** Speed slider stops (subtitle bar + options page). Log-like: the step grows with the speed. */
export const RATES = [
  0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1,  // +0.05
  1.2, 1.3, 1.4, 1.5, 1.6,                    // +0.1
  1.8, 2,                                     // +0.2
  2.25, 2.5, 2.75, 3, 3.25, 3.5,              // +0.25
  4, 4.5, 5, 5.5, 6,                          // +0.5
  7, 8, 9, 10,                                // +1
];

export const READER_DEFAULTS = {
  engine: "builtin",                    // "local" | "builtin"
  localUrl: "http://127.0.0.1:5005",    // the Piper server started by scripts/local-voice.sh
  localVoiceEn: "en_US-lessac-medium",
  localVoiceRu: "ru_RU-irina-medium",
  apiKey: "",                           // Gemini: reads scanned PDFs
  rate: 1,
  readCitations: false,
  claudeKey: "",                        // questions about the paper (notes panel)
  claudeModel: "claude-opus-5-5",
  deepseekKey: "",                      // translation (notes panel) and PDF clean-up
  deepseekUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-flash",
  translateTo: "Russian",
  builtinOnly: "", // domains whose text never leaves this computer (e.g. an employer's wiki)
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
