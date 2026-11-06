// Gemini clean-up for PDFs: the whole PDF in, clean Markdown out, then plain blocks for the viewer.
import { NO_KEY, interactionRequest, send, modelOutputs } from "./gemini-api.js";

export const CLEAN_MODEL = "gemini-3.8-flash";
export const MAX_PDF_BYTES = 20 * 1024 * 1024; // inline requests; bigger files would need the Files API

const PROMPT = [
  "Turn this PDF into clean Markdown for a reader with dyslexia who will also listen to it.",
  "- Keep the original language and wording. Do not summarize, translate or add anything.",
  "- Follow the reading order across columns; join words split by a hyphen at a line end.",
  "- Headings as #, ## or ###; paragraphs separated by a blank line; lists as \"- \".",
  "- Leave out running headers, footers, page numbers and line numbers.",
  "- Keep citations exactly as printed, such as [12] or (Smith et al., 2020).",
  "- Write each equation in words, for example \"x squared plus one\".",
  "- For each figure or table write one line: \"Figure 2: <its caption>\" or \"Table 1: <its caption>\".",
  "- Put a line [[page N]] where page N begins, starting with [[page 1]].",
].join("\n");

export function buildCleanRequest(pdfBase64, apiKey) {
  return interactionRequest({
    model: CLEAN_MODEL,
    input: [{ type: "document", data: pdfBase64, mime_type: "application/pdf" }, { type: "text", text: PROMPT }],
  }, apiKey);
}

function toBase64(bytes) {
  const CHUNK = 0x8000; // String.fromCharCode has an argument limit
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** PDF bytes -> clean Markdown. Throws an Error with a message fit for the user. */
export async function cleanPdf(bytes, apiKey, fetchFn = fetch) {
  if (!apiKey) throw new Error(NO_KEY);
  if (bytes.length > MAX_PDF_BYTES) throw new Error("This PDF is too big for the Gemini clean-up (20 MB at most).");
  const body = await send(buildCleanRequest(toBase64(bytes), apiKey), fetchFn);
  const md = modelOutputs(body, "text").map((c) => c.text).join("").trim();
  if (!md) throw new Error("Gemini returned no text for this PDF.");
  return md;
}

const INLINE = [[/\[([^\]]*)\]\([^)]*\)/g, "$1"], [/(\*\*|__|\*|_|`)(.+?)\1/g, "$2"]];
const plain = (s) => INLINE.reduce((t, [re, to]) => t.replace(re, to), s).replace(/\s+/g, " ").trim();

/** Markdown -> [{ kind: "h", level, text } | { kind: "p" | "li", text } | { kind: "page", page }].
 * Text only: the viewer puts it in with textContent, so any HTML in the answer stays visible text. */
export function markdownToBlocks(md) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: plain(para.join(" ")) });
    para = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if (!line) flush();
    else if ((m = /^\[\[page (\d+)\]\]$/i.exec(line))) { flush(); blocks.push({ kind: "page", page: Number(m[1]) }); }
    else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); blocks.push({ kind: "h", level: m[1].length, text: plain(m[2]) }); }
    else if ((m = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line))) { flush(); blocks.push({ kind: "li", text: plain(m[1]) }); }
    else if (line.startsWith("|")) {
      flush();
      if (!/^\|[\s:|-]+$/.test(line)) blocks.push({ kind: "p", text: line.split("|").map(plain).filter(Boolean).join(" · ") });
    } else para.push(line);
  }
  flush();
  return blocks;
}
