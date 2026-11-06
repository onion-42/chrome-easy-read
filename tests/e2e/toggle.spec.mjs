import { test, expect, toggleSite, badge } from "./fixtures.mjs";

const PROFILE = { font: "od", lh: 2, bionic: true };

test("toggle applies the saved profile per site, survives reload, and switches off cleanly", async ({ context, sw, server }) => {
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await sw.evaluate((p) => chrome.storage.sync.set({ settings: p }), PROFILE);
  await page.goto(url);
  const html = page.locator("html");

  // on
  await toggleSite(sw, url);
  await expect(html).toHaveClass(/er-font/);
  await expect(html).toHaveClass(/er-lh/);
  await expect(page.locator("#er-toggle")).toBeVisible();
  await expect(page.locator(".er-b").first()).toBeAttached();
  expect(await badge(sw, url)).toBe("ON");

  // the font comes from the extension, not a CDN (strict-CSP sites)
  const fontCss = await page.evaluate(() => [...document.querySelectorAll("style")].map((s) => s.textContent).join(""));
  expect(fontCss).toContain("chrome-extension://");

  // remembered after reload
  await page.reload();
  await expect(html).toHaveClass(/er-font/);
  expect(await badge(sw, url)).toBe("ON");

  // off: page as designed, profile kept
  await toggleSite(sw, url);
  await expect(html).not.toHaveClass(/er-font/);
  await expect(page.locator("#er-toggle")).toBeHidden();
  await expect(page.locator(".er-b")).toHaveCount(0);
  expect(await badge(sw, url)).toBe("");
  const saved = await sw.evaluate(() => chrome.storage.sync.get("settings"));
  expect(saved.settings).toMatchObject(PROFILE);

  // forgotten after reload
  await page.reload();
  await page.waitForLoadState("load");
  await expect(html).not.toHaveClass(/er-font/);
});

test("the focus highlight keeps its fill under a colour scheme", async ({ context, sw, server }) => {
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await sw.evaluate(() => chrome.storage.sync.set({ settings: { scheme: "cream", focus: true } }));
  await page.goto(url);
  await toggleSite(sw, url);
  await expect(page.locator("html")).toHaveClass(/er-scheme/);
  await page.locator("#p1").hover();
  await expect(page.locator("#p1")).toHaveClass(/er-focus/);
  expect(await page.locator("#p1").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
});

test("a change in the Aa panel is saved to chrome.storage.sync", async ({ context, sw, server }) => {
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await page.goto(url);
  await toggleSite(sw, url);
  await page.locator("#er-toggle").click();
  await page.locator('#er-panel select[data-k="font"]').selectOption("system");
  await expect.poll(async () => (await sw.evaluate(() => chrome.storage.sync.get("settings"))).settings?.font).toBe("system");
});
