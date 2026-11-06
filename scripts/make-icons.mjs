// Render the "Aa" toolbar icons (16/32/48/128 px PNG) with Playwright's Chromium canvas.
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const SIZES = [16, 32, 48, 128];
const browser = await chromium.launch();
const page = await browser.newPage();

for (const size of SIZES) {
  const dataUrl = await page.evaluate((px) => {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d");
    const r = px * 0.22;
    g.fillStyle = "#b0603f"; // the easy-read panel accent
    g.beginPath();
    g.roundRect(0, 0, px, px, r);
    g.fill();
    g.fillStyle = "#fffdf8";
    g.font = `700 ${Math.round(px * 0.6)}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("Aa", px / 2, px * 0.54);
    return c.toDataURL("image/png");
  }, size);
  await writeFile(new URL(`../extension/icons/icon-${size}.png`, import.meta.url), Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`icons/icon-${size}.png`);
}
await browser.close();
