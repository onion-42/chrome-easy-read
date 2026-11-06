import { test, expect, toggleSite } from "./fixtures.mjs";

const FIRST = "Gut microbiome and immunotherapy";

async function open(context, sw, server, engine) {
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await sw.evaluate((e) => Promise.all([
    chrome.storage.sync.set({ settings: {} }),
    chrome.storage.local.set({ reader: { engine: e, builtinOnly: "" } }),
  ]), engine);
  await page.goto(url);
  await toggleSite(sw, url);
  await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await self.easyRead.startReading(tab, false);
  }, url);
  return page;
}

const spoken = (sw) => sw.evaluate(() => self.__spoken);

test("built-in voice: Space pauses on the word and resumes from that word", async ({ context, sw, server }) => {
  // fake built-in voice: reports the 2nd word of whatever text it is given (indexes are relative to that text)
  await sw.evaluate(() => {
    self.__spoken = [];
    self.easyRead.engines.builtin = (msg, tab, send) => {
      self.__spoken.push({ text: msg.text });
      const words = [...msg.text.matchAll(/\S+/g)];
      send({ event: "start" });
      send({ event: "word", charIndex: words[1].index });
    };
  });
  const page = await open(context, sw, server, "builtin");
  const word = page.locator("#er-reader .er-word");
  await expect(word).toHaveText("microbiome");

  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(word).toHaveText("microbiome"); // the paused word stays marked

  await page.keyboard.press("Space");
  await expect.poll(async () => (await spoken(sw)).at(-1)?.text).toBe("microbiome and immunotherapy");
  await expect(word).toHaveText("and"); // the voice's word positions are shifted back onto the sentence
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
});

test("Gemini voice: resume continues the same audio from the paused word", async ({ context, sw, server }) => {
  await sw.evaluate(() => {
    self.__spoken = [];
    self.easyRead.engines.gemini = (msg, tab, send) => {
      self.__spoken.push({ text: msg.text, startChar: msg.startChar, startMs: msg.startMs });
      send({ event: "start", durationMs: 12000 });
    };
  });
  const page = await open(context, sw, server, "gemini");
  const word = page.locator("#er-reader .er-word");
  await expect(word).toHaveText("and", { timeout: 10_000 }); // the estimated highlight walks through the words

  await page.keyboard.press("Space");
  const paused = Number(await word.getAttribute("data-i"));
  await page.keyboard.press("Space");
  await expect.poll(async () => (await spoken(sw)).length).toBe(2);
  const resumed = (await spoken(sw))[1];
  expect(resumed.text).toBe(FIRST); // same audio, no new text
  expect(resumed.startChar).toBe(paused);
  expect(resumed.startMs).toBeGreaterThan(0);
});

test("Space types normally in a text field while reading", async ({ context, sw, server }) => {
  await sw.evaluate(() => {
    self.__spoken = [];
    self.easyRead.engines.builtin = (msg, tab, send) => { self.__spoken.push({ text: msg.text }); send({ event: "start" }); };
  });
  const page = await open(context, sw, server, "builtin");
  await page.locator("#q").click();
  await page.keyboard.press("Space");
  await expect(page.locator("#q")).toHaveValue(" ");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
});
