// Clean-up for PDFs -> clean Markdown, then plain blocks for the viewer. DeepSeek gets the text read from the
// PDF; Gemini gets the PDF file itself and is used for scans, which have no text.
import { NO_KEY, interactionRequest, send, modelOutputs } from "./gemini-api.js";
import { bytesToBase64 } from "./wav.js";
import { post } from "./assist.js";

export const CLEAN_MODEL = "gemini-3.8-flash";
export const MAX_PDF_BYTES = 20 * 1024 * 1024; // inline requests; bigger files would need the Files API

const RULES = [
  "- Keep the original language and wording. Do not summarize, translate or add anything.",
  "- Follow the reading order across columns; join words split by a hyphen at a line end.",
  "- Headings as #, ## or ###; paragraphs separated by a blank line; lists as \"- \".",
  "- Leave out running headers, footers, page numbers and line numbers.",
  "- Keep citations exactly as printed, such as [12] or (Smith et al., 2020).",
  "- Write each equation in words, for example \"x squared plus one\".",
  "- For each figure or table write one line: \"Figure 2: <its caption>\" or \"Table 1: <its caption>\".",
];
const PDF_PROMPT = [
  "Turn this PDF into clean Markdown for a reader with dyslexia who will also listen to it.",
  ...RULES,
  "- Put a line [[page N]] where page N begins, starting with [[page 1]].",
].join("\n");
const TEXT_PROMPT = [
  "The user's message is text extracted from a PDF; the extraction left broken lines, split words and stray headers.",
  "Turn it into clean Markdown for a reader with dyslexia who will also listen to it.",
  ...RULES,
  "- Keep every [[page N]] line exactly where it is.",
  "- Output only the Markdown.",
].join("\n");

export const MAX_CLEAN_CHARS = 1_500_000; // far above any paper; a bigger text is refused, never cut silently

export function buildCleanRequest(pdfBase64, apiKey) {
  return interactionRequest({
    model: CLEAN_MODEL,
    input: [{ type: "document", data: pdfBase64, mime_type: "application/pdf" }, { type: "text", text: PDF_PROMPT }],
  }, apiKey);
}

/** PDF bytes -> clean Markdown (Gemini reads the pages, so this works for scans). Throws an Error with a message fit for the user. */
export async function cleanPdf(bytes, apiKey, fetchFn = fetch) {
  if (!apiKey) throw new Error(NO_KEY);
  if (bytes.length > MAX_PDF_BYTES) throw new Error("This PDF is too big for the Gemini clean-up (20 MB at most).");
  const body = await send(buildCleanRequest(bytesToBase64(bytes), apiKey), fetchFn);
  const md = modelOutputs(body, "text").map((c) => c.text).join("").trim();
  if (!md) throw new Error("Gemini returned no text for this PDF.");
  return md;
}

/** Viewer blocks -> the text sent for clean-up (the reverse of markdownToBlocks).
 * Headings read from a PDF carry no level; they are written as level 1, the way the viewer shows them. */
export function blocksToText(blocks) {
  return blocks.map((b) =>
    b.kind === "page" ? `[[page ${b.page}]]` : b.kind === "h" ? `${"#".repeat(b.level ?? 1)} ${b.text}` : b.kind === "li" ? `- ${b.text}` : b.text
  ).join("\n\n");
}

export function buildCleanTextRequest(text, { deepseekKey, deepseekUrl, deepseekModel }) {
  return {
    url: `${deepseekUrl.replace(/\/+$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deepseekKey}` },
      body: JSON.stringify({ model: deepseekModel, messages: [{ role: "system", content: TEXT_PROMPT }, { role: "user", content: text }] }),
    },
  };
}

/** Text of a PDF -> clean Markdown (DeepSeek). Throws an Error with a message fit for the user. */
export async function cleanText(text, opts, fetchFn = fetch) {
  if (!opts.deepseekKey) throw new Error("Add your DeepSeek API key in the extension options.");
  if (text.length > MAX_CLEAN_CHARS) throw new Error("This PDF has too much text to clean up in one piece.");
  const body = await post("DeepSeek", buildCleanTextRequest(text, opts), fetchFn);
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("DeepSeek stopped before the end of the text. The local text is still shown.");
  const md = choice?.message?.content?.trim();
  if (!md) throw new Error("DeepSeek returned no text for this PDF.");
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
