import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markdownToBlocks, buildCleanRequest, cleanPdf, CLEAN_MODEL, MAX_PDF_BYTES,
  blocksToText, buildCleanTextRequest, cleanText, MAX_CLEAN_CHARS,
} from "../extension/pdf-clean.js";

test("markdownToBlocks keeps headings, paragraphs, list items and page markers as plain text", () => {
  const md = "# Title\n\nPara one\ncontinues.\n\n## Methods\n- item one\n* item **two**\n1. step one\n\n[[page 2]]\n\n" +
    "Para [a link](http://x.org) and `code` and _stress_.\n\n| a | b |\n|---|---|\n| 1 | 2 |";
  assert.deepEqual(markdownToBlocks(md), [
    { kind: "h", level: 1, text: "Title" },
    { kind: "p", text: "Para one continues." },
    { kind: "h", level: 2, text: "Methods" },
    { kind: "li", text: "item one" },
    { kind: "li", text: "item two" },
    { kind: "li", text: "step one" },
    { kind: "page", page: 2 },
    { kind: "p", text: "Para a link and code and stress." },
    { kind: "p", text: "a · b" },
    { kind: "p", text: "1 · 2" },
  ]);
});

test("markdownToBlocks never lets HTML through as markup", () => {
  const blocks = markdownToBlocks("<img src=x onerror=alert(1)> hello");
  assert.deepEqual(blocks, [{ kind: "p", text: "<img src=x onerror=alert(1)> hello" }]); // shown as text by textContent
});

test("buildCleanRequest sends the PDF inline with the clean-up prompt", () => {
  const { url, init } = buildCleanRequest("UERG", "k-1");
  const body = JSON.parse(init.body);
  assert.match(url, /\/v1beta\/interactions$/);
  assert.equal(init.headers["x-goog-api-key"], "k-1");
  assert.equal(body.model, CLEAN_MODEL);
  assert.deepEqual(body.input[0], { type: "document", data: "UERG", mime_type: "application/pdf" });
  assert.match(body.input[1].text, /\[\[page N\]\]/);
  assert.match(body.input[1].text, /do not summari[sz]e/i);
});

test("cleanPdf joins the model's text output", async () => {
  const body = { steps: [{ type: "model_output", content: [{ type: "text", text: "# A\n\n" }, { type: "text", text: "B." }] }] };
  const md = await cleanPdf(new Uint8Array([37, 80, 68, 70]), "k", async () => new Response(JSON.stringify(body), { status: 200 }));
  assert.equal(md, "# A\n\nB.");
});

test("cleanPdf refuses without a key, with an empty answer, and for files that are too big", async () => {
  const ok = async () => new Response(JSON.stringify({ steps: [] }), { status: 200 });
  await assert.rejects(cleanPdf(new Uint8Array([1]), "", ok), /API key/);
  await assert.rejects(cleanPdf(new Uint8Array([1]), "k", ok), /no text/);
  await assert.rejects(cleanPdf({ length: MAX_PDF_BYTES + 1 }, "k", ok), /too big/);
});

test("cleanPdf explains Gemini failures in plain words, without a word about voices", async () => {
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const cases = [
    [reply(400, { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }), /API key/],
    [reply(403, { error: { status: "PERMISSION_DENIED" } }), /API key/],
    [reply(429, { error: { status: "RESOURCE_EXHAUSTED" } }), /rate limit/],
    [reply(503, { error: { status: "UNAVAILABLE" } }), /unavailable.*503/],
    [async () => { throw new TypeError("Failed to fetch"); }, /connection/],
  ];
  for (const [fetchFn, message] of cases) {
    await assert.rejects(cleanPdf(new Uint8Array([1]), "k", fetchFn), (e) => message.test(e.message) && !/voice/i.test(e.message));
  }
});

/* ---------- DeepSeek: the text read from the PDF ---------- */

const DS = { deepseekKey: "ds-test", deepseekUrl: "https://api.deepseek.com/", deepseekModel: "deepseek-flash" };
const chat = (choice, status = 200) => async () => ({ ok: status < 400, status, json: async () => ({ choices: choice ? [choice] : [] }) });
const never = async () => { throw new Error("the network must not be used"); };

test("blocksToText writes the viewer's blocks as the text that markdownToBlocks reads back", () => {
  const blocks = [
    { kind: "page", page: 1 },
    { kind: "h", level: 2, text: "Methods" },
    { kind: "p", text: "We profiled 12 tumours." },
    { kind: "li", text: "item one" },
    { kind: "page", page: 2 },
    { kind: "p", text: "Second page." },
  ];
  const text = blocksToText(blocks);
  assert.equal(text, "[[page 1]]\n\n## Methods\n\nWe profiled 12 tumours.\n\n- item one\n\n[[page 2]]\n\nSecond page.");
  assert.deepEqual(markdownToBlocks(text), blocks);
  assert.equal(blocksToText([{ kind: "h", text: "Results", page: 3 }]), "# Results"); // a heading read from the PDF has no level
});

test("the clean-up request sends the text to the DeepSeek address with the model, the key and the rules", () => {
  const { url, init } = buildCleanTextRequest("[[page 1]]\n\nBro- ken text.", DS);
  const body = JSON.parse(init.body);
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(init.headers.authorization, "Bearer ds-test");
  assert.equal(body.model, "deepseek-flash");
  assert.match(body.messages[0].content, /do not summari[sz]e/i);
  assert.match(body.messages[0].content, /Keep every \[\[page N\]\] line/);
  assert.deepEqual(body.messages[1], { role: "user", content: "[[page 1]]\n\nBro- ken text." });
});

test("cleanText returns the Markdown of the answer", async () => {
  const md = await cleanText("Bro- ken text.", DS, chat({ finish_reason: "stop", message: { content: " # Title\n\nBroken text. " } }));
  assert.equal(md, "# Title\n\nBroken text.");
});

test("cleanText reports an empty answer, a cut answer, a missing key and a text that is too long", async () => {
  await assert.rejects(cleanText("text", DS, chat(null)), /no text/);
  await assert.rejects(cleanText("text", DS, chat({ finish_reason: "length", message: { content: "# Half" } })), /stopped before the end/);
  await assert.rejects(cleanText("text", DS, chat(null, 401)), /DeepSeek rejected the API key/);
  await assert.rejects(cleanText("text", { ...DS, deepseekKey: "" }, never), /DeepSeek API key/);
  await assert.rejects(cleanText("x".repeat(MAX_CLEAN_CHARS + 1), DS, never), /too much text/);
});
