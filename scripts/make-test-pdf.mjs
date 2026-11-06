// Print tests/e2e/pages/paper.html to paper.pdf with Chromium: two columns, a running header and page numbers.
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const html = new URL("../tests/e2e/pages/paper.html", import.meta.url);
const pdf = fileURLToPath(new URL("../tests/e2e/pages/paper.pdf", import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(html.href);
await page.pdf({
  path: pdf,
  format: "A5",
  displayHeaderFooter: true,
  headerTemplate: '<div style="font-size:8px;width:100%;text-align:center;">Journal of Easy Reading</div>',
  footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;"><span class="pageNumber"></span></div>',
  margin: { top: "50px", bottom: "50px", left: "40px", right: "40px" },
});
await browser.close();
console.log(`wrote ${pdf}`);
