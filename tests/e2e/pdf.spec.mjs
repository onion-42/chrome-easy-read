import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test, expect, toggleSite, TEST_PDF } from "./fixtures.mjs";

const SCAN_PDF = path.join(path.dirname(TEST_PDF), "scan.pdf");

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

test("in the viewer, reading starts at the left-clicked word", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server);
  await sw.evaluate(() => {
    self.__spoken = [];
    self.easyRead.engines.builtin = (msg, tab, send) => { self.__spoken.push(msg.text); send({ event: "start", durationMs: 5000 }); };
  });
  const at = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector("article"), NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const i = walker.currentNode.nodeValue.indexOf("blockade");
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(walker.currentNode, i + 1); r.setEnd(walker.currentNode, i + 2);
      walker.currentNode.parentElement.scrollIntoView({ block: "nearest" });
      const box = r.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    throw new Error("word not found");
  });
  await page.mouse.click(at.x, at.y);
  await sw.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url.includes("/viewer.html"));
    await self.easyRead.startReading(tab, false);
  });
  await expect.poll(() => sw.evaluate(() => self.__spoken[0])).toMatch(/^blockade varies widely/);
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

test("Clean up with DeepSeek sends the text of the PDF, shows the cleaned text and keeps it for next time", async ({ context, sw, server }) => {
  const reader = { engine: "builtin", deepseekKey: "test-key", builtinOnly: "" };
  const fake = () => {
    window.__calls = 0;
    window.easyReadViewer.readScan = async () => { throw new Error("a PDF with text must not go to Gemini"); };
    window.easyReadViewer.clean = async (text, opts) => {
      window.__calls += 1;
      window.__sent = { text, key: opts.deepseekKey };
      return "# Cleaned title\n\nCleaned paragraph one.\n\n[[page 2]]\n\nSecond page text.";
    };
  };
  let page = await openViewer(context, sw, server, { reader });
  await page.evaluate(fake);
  await page.getByRole("button", { name: "Clean up with DeepSeek" }).click();
  await expect(page.locator("article")).toContainText("Cleaned paragraph one.");
  await expect(page.locator("article h2", { hasText: "Cleaned title" })).toBeVisible();
  const sent = await page.evaluate(() => window.__sent);
  expect(sent.key).toBe("test-key");
  expect(sent.text).toMatch(/^\[\[page 1\]\]/); // the text read from the PDF, page markers included
  expect(sent.text).toContain("Response to checkpoint blockade varies widely [1, 2].");
  expect(sent.text).toContain("[[page 2]]");
  await expect(page.locator(".er-page[data-page='2']")).toBeAttached();
  await expect(page.locator("article")).not.toContainText("Response to checkpoint blockade");

  // reopen: the cleaned text comes from the cache, DeepSeek is not asked again
  await page.close();
  page = await openViewer(context, sw, server, { reader });
  await page.evaluate(fake);
  await page.getByRole("button", { name: "Clean up with DeepSeek" }).click();
  await expect(page.locator("article")).toContainText("Cleaned paragraph one.");
  expect(await page.evaluate(() => window.__calls)).toBe(0);

  // and back to the local text
  await page.getByRole("button", { name: "Show local text" }).click();
  await expect(page.locator("article")).toContainText("Response to checkpoint blockade");
});

test("a late clean-up answer is not shown over a PDF opened in the meantime", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server, { reader: { engine: "builtin", deepseekKey: "k", builtinOnly: "" } });
  await page.evaluate(() => {
    window.easyReadViewer.clean = () => new Promise((resolve) => { window.__release = () => resolve("# Late\n\nLate cleaned text."); });
  });
  await page.getByRole("button", { name: "Clean up with DeepSeek" }).click();
  await page.locator('input[type="file"]').setInputFiles(TEST_PDF); // another PDF while DeepSeek works
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => window.__release());
  await page.waitForTimeout(300);
  await expect(page.locator("article")).not.toContainText("Late cleaned text.");
  await expect(page.getByRole("button", { name: "Clean up with DeepSeek" })).toBeEnabled();
  await expect(page.locator("article")).toContainText("Fecal transplants restored response in mice.");
});

test("a broken second PDF leaves the open one working", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server);
  await page.locator('input[type="file"]').setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
  await expect(page.locator("#status")).toContainText("could not be opened");
  await expect(page.locator("article")).toContainText("Fecal transplants restored response in mice.");
  await page.getByRole("button", { name: "Show page 1" }).click();
  await expect(page.locator("figure canvas").first()).toBeVisible();
  // DeepSeek would get the text of the PDF on screen, not of the broken file
  await page.evaluate(() => { window.easyReadViewer.clean = async (text) => { window.__sent = text; return "# A\n\nB."; }; });
  await page.getByRole("button", { name: "Clean up with DeepSeek" }).click();
  await expect.poll(() => page.evaluate(() => window.__sent)).toContain("Fecal transplants restored response in mice.");
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

test("Clean up is off for private sites", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server, { reader: { engine: "builtin", deepseekKey: "k", builtinOnly: "127.0.0.1" } });
  const button = page.getByRole("button", { name: "Clean up with DeepSeek" });
  await expect(button).toBeDisabled();
  await page.evaluate(() => {
    window.easyReadViewer.clean = async () => { window.__sent = true; return "# A\n\nB."; };
    document.querySelector("#clean").disabled = false; // a button that is out of date
  });
  await button.click();
  await expect(page.locator("#status")).toContainText("private sites");
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
});

test("Clean up follows the “do not send this document” box of the notes panel", async ({ context, sw, server }) => {
  const page = await openViewer(context, sw, server, { reader: { engine: "builtin", deepseekKey: "k", builtinOnly: "" } });
  const button = page.getByRole("button", { name: "Clean up with DeepSeek" });
  await expect(button).toBeEnabled();
  await page.evaluate(() => chrome.storage.local.set({ "assist-local-only": { [window.__erDoc().hash]: true } }));
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("title", /do not send/);
  // the check is made again right before sending: a button that is out of date still sends nothing
  await page.evaluate(() => {
    window.easyReadViewer.clean = async () => { window.__sent = true; return "# A\n\nB."; };
    document.querySelector("#clean").disabled = false;
  });
  await button.click();
  await expect(page.locator("#status")).toContainText("do not send");
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
  await page.evaluate(() => chrome.storage.local.set({ "assist-local-only": {} }));
  await expect(button).toBeEnabled();
});

test("a scan has no text, so its button sends the PDF file to Gemini", async ({ context, sw, server }) => {
  await sw.evaluate(() => chrome.storage.local.set({ reader: { engine: "builtin", apiKey: "gemini-key", deepseekKey: "k", builtinOnly: "" } }));
  const page = await context.newPage();
  await page.goto(viewerUrl(sw, `${server}/scan.pdf`));
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(page.locator("#status")).toContainText("Read this scan with Gemini");
  await page.evaluate(() => {
    window.easyReadViewer.clean = async () => { throw new Error("a scan has no text for DeepSeek"); };
    window.easyReadViewer.readScan = async (bytes, apiKey) => { window.__scan = { size: bytes.length, apiKey }; return "# Scanned title\n\nText read from the picture."; };
  });
  await page.getByRole("button", { name: "Read this scan with Gemini" }).click();
  await expect(page.locator("article")).toContainText("Text read from the picture.");
  expect(await page.evaluate(() => window.__scan)).toEqual({ size: statSync(SCAN_PDF).size, apiKey: "gemini-key" });
});

test("Open a PDF… loads a file from the computer", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(viewerUrl(sw));
  await expect(page.locator("body")).toHaveAttribute("data-state", "empty");
  await page.locator('input[type="file"]').setInputFiles(TEST_PDF);
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(page.locator("article")).toContainText("Fecal transplants restored response in mice.");
});
