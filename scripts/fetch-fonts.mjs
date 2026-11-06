// Download OpenDyslexic (SIL Open Font License, bundling allowed) from fontsource into fonts/.
// The same files the easy-read skill loads from jsdelivr; bundled so strict-CSP sites still get the font.
import { writeFile } from "node:fs/promises";

const BASE = "https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic@5";
const FILES = {
  "opendyslexic-latin-400-normal.woff2": `${BASE}/files/opendyslexic-latin-400-normal.woff2`,
  "opendyslexic-latin-700-normal.woff2": `${BASE}/files/opendyslexic-latin-700-normal.woff2`,
  "OFL.txt": `${BASE}/LICENSE`,
};

for (const [name, url] of Object.entries(FILES)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(new URL(`../extension/fonts/${name}`, import.meta.url), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
