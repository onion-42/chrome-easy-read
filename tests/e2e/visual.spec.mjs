// Screenshots of the subtitle bar for a human look (test-results/, not compared automatically).
import { test, expect, toggleSite } from "./fixtures.mjs";

test("PDF viewer screenshot", async ({ context, sw, server }, info) => {
  await sw.evaluate(() => chrome.storage.sync.set({ settings: { font: "od", lh: 1.8, bionic: true } }));
  const page = await context.newPage();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/viewer.html?file=${encodeURIComponent(`${server}/paper.pdf`)}`);
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await page.getByRole("button", { name: "Show page 2" }).click();
  await expect(page.locator("figure canvas").first()).toBeVisible();
  await page.locator(".er-page[data-page='2']").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("viewer.png") });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("viewer-top.png") });
});

for (const scheme of ["", "dark"]) {
  test(`subtitle bar screenshot (${scheme || "page colours"})`, async ({ context, sw, server }, info) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 700 });
    const url = `${server}/article.html`;
    await sw.evaluate((s) => chrome.storage.sync.set({ settings: { font: "od", lh: 1.8, ls: 0.03, bionic: true, scheme: s } }), scheme);
    await sw.evaluate(() => {
      self.easyRead.engines.builtin = (msg, tab, send) => send({ event: "start", durationMs: 900 });
      return chrome.storage.local.set({ reader: { engine: "builtin" } });
    });
    await page.goto(url);
    await toggleSite(sw, url);
    await sw.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      await self.easyRead.startReading(tab, false);
    }, url);
    const bar = page.locator("#er-reader");
    await bar.getByRole("button", { name: "Next sentence" }).click();
    await expect(bar.locator(".er-word")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("page.png") });
  });
}
