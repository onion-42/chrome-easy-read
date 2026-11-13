import { test, expect, toggleSite, TEST_PDF } from "./fixtures.mjs";

const PROFILE = { font: "od", bionic: true }; // bold word starts wrap words in spans: highlights must survive that
const viewerUrl = (sw, query = "") => `chrome-extension://${new URL(sw.url()).host}/viewer.html${query}`;

/* An in-memory Zotero (and Crossref) inside the service worker: the extension's own fetch calls land here. */
async function fakeZotero(sw, papers = []) {
  await sw.evaluate(async (seed) => {
    const z = (self.__z = { items: new Map(), n: 0, version: 10 });
    for (const p of seed) z.items.set(p.key, { key: p.key, version: 1, data: p.data });
    const json = (body, status = 200, version = z.version) =>
      new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Last-Modified-Version": String(version), "Total-Results": String(Array.isArray(body) ? body.length : 0) } });
    const real = self.fetch;
    self.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.host === "api.crossref.org") {
        return json({ message: { type: "journal-article", title: ["TLS networks in three dimensions"], author: [{ family: "Lin", given: "J" }], issued: { "date-parts": [[2026]] }, "container-title": ["Cell"] } });
      }
      if (url.host !== "api.zotero.org") return real(input, init);
      const path = url.pathname.replace(/^\/users\/\d+/, "");
      const all = [...z.items.values()];
      const method = init.method || "GET";
      if (path === "/keys/current") return json({ userID: 1, username: "test", access: { user: { library: true, write: true } } });
      if (path === "/collections") return json([{ key: "ROOT", data: { name: "Reading list", parentCollection: false } }]);
      if (path === "/collections/ROOT/items/top") return json(url.searchParams.get("start") === "0" ? all.filter((it) => !it.data.parentItem) : []);
      if (path === "/items/top") return json(url.searchParams.get("start") === "0" ? all.filter((it) => !it.data.parentItem) : []);
      const one = /^\/items\/(\w+)(\/children)?$/.exec(path);
      if (method === "POST" && path === "/items") {
        const [data] = JSON.parse(init.body);
        const key = `NEW${String(++z.n).padStart(5, "0")}`;
        z.items.set(key, { key, version: ++z.version, data: { dateAdded: String(z.n).padStart(4, "0"), ...data } });
        return json({ successful: { 0: { key, version: z.version } }, failed: {} });
      }
      if (method === "PATCH" && one) {
        const it = z.items.get(one[1]);
        if (Number(init.headers["If-Unmodified-Since-Version"]) < it.version) return json(null, 412);
        it.data = { ...it.data, ...JSON.parse(init.body) };
        it.version = ++z.version;
        return json(null, 204);
      }
      if (one?.[2]) return json(url.searchParams.get("start") === "0" ? all.filter((it) => it.data.parentItem === one[1]) : []);
      if (one) return z.items.has(one[1]) ? json(z.items.get(one[1]), 200, z.items.get(one[1]).version) : json(null, 404);
      if (path === "/items") {
        const q = url.searchParams.get("q") || "";
        return json(all.filter((it) => (it.data.DOI || "").toLowerCase() === q.toLowerCase() || it.data.url === q));
      }
      return json(null, 404);
    };
    await chrome.storage.local.set({ zotero: { apiKey: "test-key", userId: 1, collection: "ROOT", vaultName: "vault" } });
  }, papers);
}

const zItems = (sw) => sw.evaluate(() => [...self.__z.items.values()]);
const notesOf = async (sw) => (await zItems(sw)).filter((it) => it.data.itemType === "note");

async function openNotes(sw, match) {
  await sw.evaluate(async (m) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url.includes(m));
    await self.easyRead.openNotes(tab);
  }, match);
}

const select = (page, selector) => page.evaluate((s) => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(s));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}, selector);

const highlights = (page) => page.evaluate(() => [...(CSS.highlights.get("er-note") ?? [])].map((r) => r.toString()));

async function openArticle(context, sw, server) {
  await sw.evaluate((p) => chrome.storage.sync.set({ settings: p }), PROFILE);
  const page = await context.newPage();
  const url = `${server}/noted.html`;
  await page.goto(url);
  await toggleSite(sw, url);
  await expect(page.locator("#er-note")).toBeVisible();
  return page;
}

test("a note on selected text of an article page goes to Zotero and is highlighted", async ({ context, sw, server }) => {
  await fakeZotero(sw);
  const page = await openArticle(context, sw, server);
  await select(page, "#p2");
  await openNotes(sw, "noted.html");
  const panel = page.locator("#er-notes");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".er-n-quote").first()).toContainText("the sample size is one patient");
  await panel.getByLabel("Текст заметки").fill("Только один пациент.");
  await panel.getByLabel("Текст заметки").press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toHaveCount(1);

  const items = await zItems(sw);
  const paper = items.find((it) => it.data.itemType === "journalArticle");
  expect(paper.data.DOI).toBe("10.1234/tls.2026.001"); // recognised by the meta tag, saved with the first note
  expect(paper.data.extra).toBe("obsidian: 1_education/papers/lin-2026-tls-networks-three.md");
  expect(items.find((it) => it.data.itemType === "attachment").data.url).toBe(`${server}/paper.pdf`);
  const [note] = await notesOf(sw);
  expect(note.data.parentItem).toBe(paper.key);
  expect(note.data.note).toContain("<blockquote><p>Each network was assembled from serial sections");
  expect(note.data.note).toContain("<p>Только один пациент.</p>");

  await expect(panel).toContainText("В Zotero");
  await expect(panel.getByRole("link", { name: "Obsidian" })).toHaveAttribute("href", "obsidian://open?vault=vault&file=lin-2026-tls-networks-three");
  expect(await highlights(page)).toEqual(["Each network was assembled from serial sections of one tumour, so the sample size is one patient."]);

  // the highlight is rebuilt when easy-read rewrites the text (bold word starts off)
  await page.locator("#er-toggle").click();
  await page.locator('#er-panel input[data-k="bionic"]').uncheck();
  await expect(page.locator("#p2 .er-bw")).toHaveCount(0);
  await expect.poll(() => highlights(page)).toEqual(["Each network was assembled from serial sections of one tumour, so the sample size is one patient."]);

  // and it is there again after a reload, without opening the panel
  await page.reload();
  await expect(page.locator("#er-note")).toBeVisible();
  await expect.poll(() => highlights(page)).toHaveLength(1);
});

test("editing a note, a conflict that keeps my text, and one summary per paper", async ({ context, sw, server }) => {
  await fakeZotero(sw);
  const page = await openArticle(context, sw, server);
  await select(page, "#p3");
  await openNotes(sw, "noted.html");
  const panel = page.locator("#er-notes");
  const field = panel.getByLabel("Текст заметки");
  await field.fill("первый вариант");
  await panel.getByRole("button", { name: "Сохранить заметку в Zotero" }).click();
  await expect(panel.locator(".er-n-item")).toHaveCount(1);

  await panel.getByRole("button", { name: "Править заметку" }).click();
  await expect(field).toHaveValue(/^> B cell clones were shared[\s\S]*первый вариант/);
  await field.fill("> B cell clones were shared between follicles of the same network.\n\nвторой вариант");
  await field.press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toContainText("второй вариант");
  expect((await notesOf(sw))[0].data.note).toContain("<p>второй вариант</p>");

  // the note changes in Zotero while it is open for editing here
  await panel.getByRole("button", { name: "Править заметку" }).click();
  await sw.evaluate(() => {
    const it = [...self.__z.items.values()].find((x) => x.data.itemType === "note");
    it.data.note = "<p>правка из Zotero</p>";
    it.version = ++self.__z.version;
  });
  await field.fill("мой текст");
  await field.press("Control+Enter");
  await expect(panel.locator(".er-n-msg")).toContainText("правка из Zotero");
  await expect(field).toHaveValue("мой текст");
  await field.press("Control+Enter"); // second save goes on top of the remote version
  await expect(panel.locator(".er-n-item")).toContainText("мой текст");

  await panel.getByRole("button", { name: "Одна общая заметка ко всей статье" }).click();
  await field.fill("TLS — сети, но n = 1.");
  await field.press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toHaveCount(2);
  await expect(panel.locator(".er-n-item").first()).toContainText("★ Вывод: TLS — сети, но n = 1.");
  await panel.getByRole("button", { name: "Одна общая заметка ко всей статье" }).click();
  await expect(field).toHaveValue("TLS — сети, но n = 1."); // the same note opens for editing, no second summary
  const notes = await notesOf(sw);
  expect(notes.filter((n) => n.data.tags.some((t) => t.tag === "summary"))).toHaveLength(1);
});

test("in the PDF viewer: note with the page number, the PDF goes to the vault folder", async ({ context, sw, server }) => {
  await fakeZotero(sw);
  await sw.evaluate((p) => chrome.storage.sync.set({ settings: p }), PROFILE);
  const page = await context.newPage();
  await page.goto(viewerUrl(sw, `?file=${encodeURIComponent(`${server}/paper.pdf`)}`));
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await page.evaluate(async () => { window.__vaultOverride = await navigator.storage.getDirectory(); });

  await select(page, "article p");
  await openNotes(sw, "/viewer.html");
  const panel = page.locator("#er-notes");
  await panel.getByLabel("Текст заметки").fill("заметка в PDF");
  await panel.getByLabel("Текст заметки").press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toHaveCount(1);
  await expect(panel).toContainText("PDF ✓ 0_media/papers/");

  const items = await zItems(sw);
  const paper = items.find((it) => !["note", "attachment"].includes(it.data.itemType));
  const path = /^pdf: (.+)$/m.exec(paper.data.extra)[1];
  expect((await notesOf(sw))[0].data.note).toMatch(/Стр\. 1 · http/);
  const size = await page.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split("/");
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    return (await (await dir.getFileHandle(parts.at(-1))).getFile()).size;
  }, path);
  expect(size).toBeGreaterThan(1000);
  expect(await highlights(page)).toHaveLength(1);
});

test("my own PDF: a local file is tied to a paper of the reading list and saved under its name", async ({ context, sw }) => {
  const seeded = { key: "SEEDED01", data: { itemType: "journalArticle", title: "A paper I asked the author for", creators: [{ lastName: "Meylan" }], date: "2022", extra: "obsidian: 1_education/papers/meylan-2022-tls.md" } };
  await fakeZotero(sw, [seeded]);
  await sw.evaluate((p) => chrome.storage.sync.set({ settings: p }), PROFILE);
  const page = await context.newPage();
  await page.goto(viewerUrl(sw));
  await page.evaluate(async () => { window.__vaultOverride = await navigator.storage.getDirectory(); });
  await page.locator("#file").setInputFiles(TEST_PDF);
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });

  await openNotes(sw, "/viewer.html");
  const panel = page.locator("#er-notes");
  await panel.getByRole("button", { name: "Этот файл — статья из списка чтения" }).click();
  await panel.locator("select").selectOption("SEEDED01");
  await panel.getByRole("button", { name: "Привязать этот файл к выбранной статье" }).click();
  await expect(panel).toContainText("Заметки · Meylan 2022");
  await expect(panel).toContainText("PDF ✓ 0_media/papers/meylan-2022-tls.pdf");
  const paper = (await zItems(sw)).find((it) => it.key === "SEEDED01");
  expect(paper.data.extra).toContain("pdf: 0_media/papers/meylan-2022-tls.pdf");

  // the reading list shows it and "Читать" points at the vault copy
  const list = await context.newPage();
  await list.goto(viewerUrl(sw).replace("viewer.html", "reading.html"));
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list.locator("li")).toContainText("PDF ✓ 0_media/papers/meylan-2022-tls.pdf");
  await expect(list.getByRole("link", { name: "Читать" })).toHaveAttribute("href", /viewer\.html\?vault=0_media%2Fpapers%2Fmeylan-2022-tls\.pdf$/);
  await expect(list.getByRole("link", { name: "Zotero" })).toHaveAttribute("href", "zotero://select/library/items/SEEDED01");
});
