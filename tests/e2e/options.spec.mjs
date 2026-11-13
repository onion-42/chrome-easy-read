import { test, expect } from "./fixtures.mjs";
import { RATES } from "../../extension/reader-options.js";

test("options page has a speed slider from 0.75x to 10x and saves the choice", async ({ context, sw }) => {
  const id = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const speed = page.getByRole("slider", { name: "Speed" });
  await expect(speed).toHaveAttribute("max", String(RATES.length - 1));
  await expect(page.locator("#rate-value")).toHaveText("1×");
  await speed.fill(String(RATES.indexOf(7)));
  await expect(page.locator("#rate-value")).toHaveText("7×");
  await expect(speed).toHaveAttribute("aria-valuetext", "7×");
  await expect.poll(async () => (await sw.evaluate(() => chrome.storage.local.get("reader"))).reader?.rate).toBe(7);
});

test("options offer the local and the built-in voice; a voice saved as Gemini shows as built-in and stays usable", async ({ context, sw }) => {
  await sw.evaluate(() => chrome.storage.local.set({ reader: { engine: "gemini", apiKey: "scan-key" } }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await expect(page.locator('input[name="engine"]')).toHaveCount(2);
  await expect(page.locator('input[name="engine"][value="builtin"]')).toBeChecked();
  await expect(page.locator('input[name="apiKey"]')).toHaveValue("scan-key"); // the Gemini key is kept for scans
  await page.locator('input[name="engine"][value="local"]').check();
  await expect.poll(async () => (await sw.evaluate(() => chrome.storage.local.get("reader"))).reader?.engine).toBe("local");
});
