import { test, expect, toggleSite, badge } from "./fixtures.mjs";
import { RATES } from "../../extension/reader-options.js";

const PROFILE = { font: "od", lh: 2, bionic: true };

/* Replace the voices with a fake that records what it was asked to say.
 * autoEnd: report the end after a short "speech", so reading walks through the page. */
async function fakeVoices(sw, { autoEnd }) {
  await sw.evaluate((auto) => {
    self.__spoken = [];
    const fake = (engine) => (msg, tab, send) => {
      self.__spoken.push({ engine, text: msg.text, lang: msg.lang, rate: msg.rate, startFrac: msg.startFrac });
      send({ event: "start", durationMs: 600 });
      if (auto) setTimeout(() => send({ event: "end" }), 150);
    };
    self.easyRead.engines.builtin = fake("builtin");
    self.easyRead.engines.local = fake("local");
  }, autoEnd);
}

async function startReading(sw, url, fromContext = false) {
  await sw.evaluate(async ({ u, ctx }) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await self.easyRead.startReading(tab, ctx);
  }, { u: url, ctx: fromContext });
}

const spoken = (sw) => sw.evaluate(() => self.__spoken);

/* a real left click on the second letter of one word of a paragraph (bold word starts split words into nodes) */
async function clickWord(page, selector, word) {
  const at = await page.evaluate(({ sel, w }) => {
    const el = document.querySelector(sel);
    let left = el.textContent.indexOf(w) + 1;
    if (left < 1) throw new Error("word not found: " + w);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (left >= n.nodeValue.length) { left -= n.nodeValue.length; continue; }
      const r = document.createRange();
      r.setStart(n, left); r.setEnd(n, left + 1);
      n.parentElement.scrollIntoView({ block: "nearest" });
      const box = r.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    throw new Error("word not found: " + w);
  }, { sel: selector, w: word });
  await page.mouse.click(at.x, at.y);
}
/* the reading block scrolls into view smoothly: wait until the page stops moving before aiming a click */
async function settled(page) {
  let last = -1;
  await expect.poll(async () => { const y = await page.evaluate(() => scrollY); const same = y === last; last = y; return same; },
    { intervals: [150] }).toBe(true);
}

async function setup(context, sw, server, reader = { engine: "builtin" }) {
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await sw.evaluate(({ p, r }) => Promise.all([chrome.storage.sync.set({ settings: p }), chrome.storage.local.set({ reader: r })]),
    { p: PROFILE, r: reader });
  await page.goto(url);
  return { page, url };
}

test("subtitles follow the easy-read profile, mute citations and mark the spoken word", async ({ context, sw, server }) => {
  const { page, url } = await setup(context, sw, server);
  await fakeVoices(sw, { autoEnd: false });
  await toggleSite(sw, url);
  await startReading(sw, url);

  const bar = page.locator("#er-reader");
  const cap = bar.locator(".er-cap");
  await expect(bar).toBeVisible();
  await expect(cap).toContainText("Gut microbiome and immunotherapy");

  await bar.getByRole("button", { name: "Next sentence" }).click();
  await expect(cap).toContainText("Response to checkpoint blockade varies widely");
  await expect(cap.locator(".er-dim")).toHaveText("[1, 2]");
  await expect(page.locator("#p1")).toHaveClass(/er-reading/);
  expect(await cap.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("OpenDyslexic");
  await expect(cap.locator(".er-b").first()).toBeAttached();
  await expect(cap.locator(".er-word")).toHaveCount(1);
});

test("the voice gets clean text: no citations, URLs as domains, powers read, code and menus skipped", async ({ context, sw, server }) => {
  const { page, url } = await setup(context, sw, server);
  await fakeVoices(sw, { autoEnd: true });
  await toggleSite(sw, url);
  await startReading(sw, url);
  await expect(page.locator("#er-reader")).toBeHidden({ timeout: 15_000 }); // finished

  const said = await spoken(sw);
  const all = said.map((s) => s.text).join(" | ");
  for (const banned of ["[1", "Smith", "Lee & Kim", "doi", "https", "*", "skip me", "Home", "(2021)", "с. 25"]) {
    expect(all, banned).not.toContain(banned);
  }
  for (const wanted of ["example.org", "10 to the power of 6", "Иванов и др.", "in mice."]) {
    expect(all, wanted).toContain(wanted);
  }
  expect(said.find((s) => s.text.includes("Иванов")).lang).toBe("ru");
});

test("controls: resume and speed continue from the word, stop hides the bar and the highlight", async ({ context, sw, server }) => {
  const { page, url } = await setup(context, sw, server);
  await fakeVoices(sw, { autoEnd: false });
  await toggleSite(sw, url);
  await startReading(sw, url);
  const bar = page.locator("#er-reader");
  const first = "Gut microbiome and immunotherapy";
  await expect.poll(async () => (await spoken(sw)).length).toBe(1);

  // pause, then resume = the rest of this sentence from the marked word (built-in voice gets the tail)
  const fromAWord = (s) => s && first.endsWith(s.text) && /^\S/.test(s.text);
  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
  await bar.getByRole("button", { name: "Resume" }).click();
  await expect.poll(async () => (await spoken(sw)).length).toBe(2);
  expect(fromAWord((await spoken(sw))[1])).toBe(true);

  // a new speed continues from the current word at that speed, for every voice
  const speed = bar.getByRole("slider", { name: "Speed" });
  await speed.fill(String(RATES.indexOf(1.5)));
  await expect.poll(async () => (await spoken(sw)).at(-1)?.rate).toBe(1.5);
  expect(fromAWord((await spoken(sw)).at(-1))).toBe(true);

  // up to 10x, the value is shown next to the slider and remembered as the default speed
  await speed.fill(String(RATES.indexOf(10)));
  await expect(bar.getByText("10×")).toBeVisible();
  await expect.poll(async () => (await spoken(sw)).at(-1)?.rate).toBe(10);
  await expect.poll(async () => (await sw.evaluate(() => chrome.storage.local.get("reader"))).reader.rate).toBe(10);

  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
  await bar.getByRole("button", { name: "Stop reading" }).click();
  await expect(bar).toBeHidden();
  await expect(page.locator(".er-reading")).toHaveCount(0);
});

test("a Gemini voice saved by an older version reads with the built-in voice", async ({ context, sw, server }) => {
  const { url } = await setup(context, sw, server, { engine: "gemini" });
  await fakeVoices(sw, { autoEnd: false });
  await startReading(sw, url);
  await expect.poll(async () => (await spoken(sw))[0]?.engine).toBe("builtin");
});

test("the local voice reads everywhere, work domains included: its text stays on this computer", async ({ context, sw, server }) => {
  const { url } = await setup(context, sw, server, { engine: "local", builtinOnly: "127.0.0.1" });
  await fakeVoices(sw, { autoEnd: false });
  await startReading(sw, url);
  await expect.poll(async () => (await spoken(sw))[0]?.engine).toBe("local");
});

test("start point: right-clicked paragraph, then selection; easy-read turns on for this tab only", async ({ context, sw, server }) => {
  const { page, url } = await setup(context, sw, server);
  await fakeVoices(sw, { autoEnd: false });

  await page.locator("#p3").click({ button: "right" });
  await page.keyboard.press("Escape");
  await startReading(sw, url, true);
  await expect.poll(async () => (await spoken(sw))[0]?.text).toContain("Data are at");
  await expect(page.locator("html")).toHaveClass(/er-font/); // on for reading...
  expect(await badge(sw, url)).toBe("");                     // ...but the site is not remembered

  await page.evaluate(() => window.getSelection().selectAllChildren(document.getElementById("p4")));
  await startReading(sw, url);
  await expect.poll(async () => (await spoken(sw)).at(-1)?.text).toContain("Как показали");
});

test("start point: reading starts at the left-clicked word, with the focus highlight off", async ({ context, sw, server }) => {
  const { page, url } = await setup(context, sw, server);
  await fakeVoices(sw, { autoEnd: false });

  await clickWord(page, "#p1", "cohorts");
  await startReading(sw, url);
  await expect.poll(async () => (await spoken(sw))[0]?.text).toMatch(/^cohorts link it to the gut microbiome/);
  await expect(page.locator("#p1")).toHaveClass(/er-reading/);
  await expect(page.locator("#er-reader .er-word")).toHaveText("cohorts");
});

test("clicking a word while reading jumps there, forwards and back", async ({ context, sw, server }) => {
  const { page, url } = await setup(context, sw, server);
  await fakeVoices(sw, { autoEnd: false });
  await page.locator("#p3").dispatchEvent("contextmenu"); // no native menu left open over the page
  await startReading(sw, url, true); // reading starts at #p3, so #p1 is before the collected text
  await expect(page.locator("#p3")).toHaveClass(/er-reading/); // ...and the page starts scrolling to it

  await settled(page);
  await clickWord(page, "#p1", "blockade"); // back: the text is collected again from this paragraph
  await expect.poll(async () => (await spoken(sw)).at(-1)?.text).toMatch(/^blockade varies widely/);
  await expect(page.locator("#p1")).toHaveClass(/er-reading/);
  await settled(page);
  await clickWord(page, "#p2", "restored"); // forward, inside the collected text
  await expect.poll(async () => (await spoken(sw)).at(-1)?.text).toMatch(/^restored response in mice/);
  await settled(page);
  await clickWord(page, "#p1", "blockade");
  await expect.poll(async () => (await spoken(sw)).at(-1)?.text).toMatch(/^blockade varies widely/);

  const count = (await spoken(sw)).length;
  await page.locator("#er-reader").getByRole("button", { name: "Next sentence" }).click();
  await expect.poll(async () => (await spoken(sw)).length).toBe(count + 1); // a bar button is not a jump
  await expect.poll(async () => (await spoken(sw)).at(-1)?.text).toMatch(/^Several cohorts/);
});

test("the local voice starts inside the sentence at the clicked word", async ({ context, sw, server }) => {
  const { page, url } = await setup(context, sw, server, { engine: "local" });
  await fakeVoices(sw, { autoEnd: false });

  await clickWord(page, "#p1", "microbiome");
  await startReading(sw, url);
  await expect.poll(async () => (await spoken(sw))[0]?.text).toMatch(/^Several cohorts/); // the whole sentence is synthesised
  expect((await spoken(sw))[0].startFrac).toBeGreaterThan(0.5);                            // ...and played from the word
});

