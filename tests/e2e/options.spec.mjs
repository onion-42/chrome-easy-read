import { test, expect } from "./fixtures.mjs";

test("options page offers speeds from 0.75x to 5x and saves the choice", async ({ context, sw }) => {
  const id = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const speed = page.locator('select[name="rate"]');
  const values = await speed.locator("option").evaluateAll((os) => os.map((o) => o.value));
  expect(values[0]).toBe("0.75");
  expect(values.at(-1)).toBe("5");
  expect(values).toContain("2");
  expect(values).toContain("4");
  await speed.selectOption("4.5");
  await expect.poll(async () => (await sw.evaluate(() => chrome.storage.local.get("reader"))).reader?.rate).toBe(4.5);
});
