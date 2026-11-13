// Print tests/e2e/pages/paper.html to paper.pdf with Chromium: two columns, a running header and page numbers.
// Also writes scan.pdf: one page that holds a picture and no text, like a scanned paper.
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
console.log(`wrote ${pdf}`);

const scan = fileURLToPath(new URL("../tests/e2e/pages/scan.pdf", import.meta.url));
const GREY_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkqAcAAIUAgUW0RjgAAAAASUVORK5CYII=";
await page.setContent(`<img src="data:image/png;base64,${GREY_PIXEL}" style="width:300px;height:400px">`);
await page.pdf({ path: scan, format: "A5" });
console.log(`wrote ${scan}`);
await browser.close();
