import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks, buildCleanRequest, cleanPdf, CLEAN_MODEL, MAX_PDF_BYTES } from "../extension/pdf-clean.js";

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
