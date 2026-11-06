// Debug helper: print how the viewer re-flows a PDF. Usage: node scripts/pdf-to-text.mjs file.pdf
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pageToItems, reflow } from "../extension/pdf-text.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/pdf-to-text.mjs file.pdf");
  process.exit(1);
}
const doc = await getDocument({ data: new Uint8Array(await readFile(file)) }).promise;
const pages = [];
for (let n = 1; n <= doc.numPages; n++) pages.push(await pageToItems(await doc.getPage(n)));
for (const b of reflow(pages)) console.log(b.kind === "page" ? `--- page ${b.page} ---` : `[${b.kind}] ${b.text}`);
