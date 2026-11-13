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

test("only the root folder of the Obsidian vault is accepted as the vault; a subfolder is refused with the reason", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  // the folder dialog is replaced: first a subfolder (no .obsidian inside), then the vault root
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const sub = await root.getDirectoryHandle("pdfs", { create: true });
    const vault = await root.getDirectoryHandle("my_vault", { create: true });
    await vault.getDirectoryHandle(".obsidian", { create: true });
    const picks = [sub, vault];
    window.showDirectoryPicker = async () => picks.shift();
  });
  const zotero = async () => (await sw.evaluate(() => chrome.storage.local.get("zotero"))).zotero ?? {};

  await page.getByRole("button", { name: "Корневая папка vault…" }).click();
  await expect(page.locator("#z-status")).toContainText("«pdfs» — не корень vault");
  await expect(page.locator("#z-vault-state")).toHaveText("не выбрана");
  expect((await zotero()).vaultName).toBeUndefined();

  await page.getByRole("button", { name: "Корневая папка vault…" }).click();
  await expect(page.locator("#z-vault-state")).toHaveText("my_vault ✓");
  await expect.poll(async () => (await zotero()).vaultName).toBe("my_vault");
});
