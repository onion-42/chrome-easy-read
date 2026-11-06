// Copy the parts of PDF.js the viewer needs from node_modules into extension/vendor/pdfjs/.
// MV3 extensions may not load remote code, so PDF.js ships inside the extension.
import { cp, mkdir, rm, readFile } from "node:fs/promises";

const SRC = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const DEST = new URL("../extension/vendor/pdfjs/", import.meta.url);
const PARTS = [
  "build/pdf.min.mjs",
  "build/pdf.worker.min.mjs",
  "cmaps",          // text in CID fonts (Cyrillic, CJK)
  "standard_fonts", // drawing pages that use the 14 standard PDF fonts
  "wasm",           // image decoders (JPX, JBIG2) for "Show page"
  "LICENSE",
];

// not needed: JavaScript inside PDF forms (quickjs), and JS fallbacks for when WebAssembly is blocked
const SKIP = /quickjs|_nowasm_fallback/;

const { version } = JSON.parse(await readFile(new URL("package.json", SRC), "utf8"));
await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });
for (const part of PARTS) {
  await cp(new URL(part, SRC), new URL(part, DEST), { recursive: true, filter: (src) => !SKIP.test(src) });
}
console.log(`pdfjs-dist ${version} -> extension/vendor/pdfjs/`);
