import { readFileSync, statSync } from "node:fs";
import { test, expect, toggleSite, TEST_PDF } from "./fixtures.mjs";

const viewerUrl = (sw, file) => `chrome-extension://${new URL(sw.url()).host}/viewer.html${file ? `?file=${encodeURIComponent(file)}` : ""}`;

async function openViewer(context, sw, server, { reader = { engine: "builtin" }, profile = { font: "od" } } = {}) {
  await sw.evaluate(({ r, p }) => Promise.all([chrome.storage.local.set({ reader: r }), chrome.storage.sync.set({ settings: p })]),
    { r: reader, p: profile });
  const page = await context.newPage();
  await page.goto(viewerUrl(sw, `${server}/paper.pdf`));
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  return page;
}

async function viewerTab(sw) {
  return sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.includes("/viewer.html")));
}

test("the viewer shows the PDF as easy-read text, without the running header", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server);
  const article = page.locator("article");
  await expect(article).toContainText("Response to checkpoint blockade varies widely [1, 2].");
  await expect(article.locator("h2", { hasText: "Methods" })).toBeVisible();
  await expect(article).not.toContainText("Journal of Easy Reading");
  expect(await page.locator(".er-page").count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator("html")).toHaveClass(/er-font/);
  await expect(page.locator("#er-toggle")).toBeVisible();
});

test("reading aloud works in the viewer: citations skipped, words marked, Space pauses", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server);
  await sw.evaluate(() => {
    self.__spoken = [];
    self.easyRead.engines.builtin = (msg, tab, send) => {
      self.__spoken.push(msg.text);
      send({ event: "start", durationMs: 5000 });
    };
  });
  await sw.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url.includes("/viewer.html"));
    await self.easyRead.startReading(tab, false);
  });
  await expect(page.locator("#er-reader .er-word")).toHaveCount(1); // speech events reach the extension page
  const bar = page.locator("#er-reader");
  for (let i = 0; i < 3 && !(await bar.locator(".er-cap").textContent()).includes("checkpoint"); i++) {
    await bar.getByRole("button", { name: "Next sentence" }).click();
  }
  await expect(bar.locator(".er-cap")).toContainText("Response to checkpoint blockade varies widely");
  await expect(bar.locator(".er-dim").first()).toHaveText("[1, 2]");
  await page.keyboard.press("Space");
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
});

test("Show page draws the real page under its marker", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server);
  await page.getByRole("button", { name: "Show page 1" }).click();
  const canvas = page.locator("figure canvas").first();
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((c) => c.width)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Hide page 1" }).click();
  await expect(canvas).toBeHidden();
});

test("the toolbar button on a PDF tab opens the viewer, and on the viewer goes back to the PDF", async ({ context, sw, server }) => {
  const page = await context.newPage();
  const pdf = `${server}/paper.pdf`;
  await page.goto(pdf).catch(() => {}); // headless Chromium may treat a PDF as a download
  test.skip(page.url() !== pdf, "this Chromium does not show PDFs in a tab");
  await toggleSite(sw, pdf);
  await expect(page).toHaveURL(/\/viewer\.html\?file=/);
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await sw.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url.includes("/viewer.html"));
    await self.easyRead.toggleSite(tab);
  });
  await expect(page).toHaveURL(pdf);
});

test("right-click 'Open PDF in easy-read' opens the viewer in a new tab", async ({ context, sw, server }) => {
  const opener = await context.newPage();
  await opener.goto(`${server}/article.html`);
  const [viewer] = await Promise.all([
    context.waitForEvent("page"),
    sw.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: `${u}/article.html` });
      await self.easyRead.openPdf(`${u}/paper.pdf`, tab);
    }, server),
  ]);
  await expect(viewer).toHaveURL(/\/viewer\.html\?file=.*paper\.pdf/);
});

test("Clean up with Gemini shows the cleaned text and keeps it for next time", async ({ context, sw, server }) => {
  const reader = { engine: "builtin", apiKey: "test-key", builtinOnly: "" };
  const fake = () => {
    window.__calls = 0;
    window.easyReadViewer.clean = async () => {
      window.__calls += 1;
      return "# Cleaned title\n\nCleaned paragraph one.\n\n[[page 2]]\n\nSecond page text.";
    };
  };
  let page = await openViewer(context, sw, server, { reader });
  await page.evaluate(fake);
  await page.getByRole("button", { name: "Clean up with Gemini" }).click();
  await expect(page.locator("article")).toContainText("Cleaned paragraph one.");
  await expect(page.locator("article h2", { hasText: "Cleaned title" })).toBeVisible();
  await expect(page.locator(".er-page[data-page='2']")).toBeAttached();
  await expect(page.locator("article")).not.toContainText("Response to checkpoint blockade");

  // reopen: the cleaned text comes from the cache, Gemini is not asked again
  await page.close();
  page = await openViewer(context, sw, server, { reader });
  await page.evaluate(fake);
  await page.getByRole("button", { name: "Clean up with Gemini" }).click();
  await expect(page.locator("article")).toContainText("Cleaned paragraph one.");
  expect(await page.evaluate(() => window.__calls)).toBe(0);

  // and back to the local text
  await page.getByRole("button", { name: "Show local text" }).click();
  await expect(page.locator("article")).toContainText("Response to checkpoint blockade");
});

test("a late Gemini answer is not shown over a PDF opened in the meantime", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server, { reader: { engine: "builtin", apiKey: "k", builtinOnly: "" } });
  await page.evaluate(() => {
    window.easyReadViewer.clean = () => new Promise((resolve) => { window.__release = () => resolve("# Late\n\nLate cleaned text."); });
  });
  await page.getByRole("button", { name: "Clean up with Gemini" }).click();
  await page.locator('input[type="file"]').setInputFiles(TEST_PDF); // another PDF while Gemini works
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => window.__release());
  await page.waitForTimeout(300);
  await expect(page.locator("article")).not.toContainText("Late cleaned text.");
  await expect(page.locator("article")).toContainText("Fecal transplants restored response in mice.");
});

test("a broken second PDF leaves the open one working", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server);
  await page.locator('input[type="file"]').setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
  await expect(page.locator("#status")).toContainText("could not be opened");
  await expect(page.locator("article")).toContainText("Fecal transplants restored response in mice.");
  await page.getByRole("button", { name: "Show page 1" }).click();
  await expect(page.locator("figure canvas").first()).toBeVisible();
  // Gemini would get the PDF on screen, not the broken file
  await page.evaluate(() => { window.easyReadViewer.clean = async (bytes) => { window.__sent = bytes.length; return "# A\n\nB."; }; });
  await page.getByRole("button", { name: "Clean up with Gemini" }).click();
  await expect.poll(() => page.evaluate(() => window.__sent)).toBe(statSync(TEST_PDF).size);
});

test("a second PDF replaces the first", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server);
  await page.locator('input[type="file"]').setInputFiles({ name: "again.pdf", mimeType: "application/pdf", buffer: readFileSync(TEST_PDF) });
  await expect(page.locator("#title")).toHaveText(/Gut microbiome|again\.pdf/);
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toBeEmpty();
});

test("PDFs behind a login open: the viewer sends the site's cookies", async ({ context, sw, server }) => {
  await context.addCookies([{ name: "session", value: "ok", url: server }]);
  const page = await context.newPage();
  await page.goto(viewerUrl(sw, `${server}/private/paper.pdf`));
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
});

test("Clean up is off for built-in-voice-only sites", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server, { reader: { engine: "gemini", apiKey: "k", builtinOnly: "127.0.0.1" } });
  await expect(page.getByRole("button", { name: "Clean up with Gemini" })).toBeDisabled();
});

test("Open a PDF… loads a file from the computer", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(viewerUrl(sw));
  await expect(page.locator("body")).toHaveAttribute("data-state", "empty");
  await page.locator('input[type="file"]').setInputFiles(TEST_PDF);
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(page.locator("article")).toContainText("Fecal transplants restored response in mice.");
});
