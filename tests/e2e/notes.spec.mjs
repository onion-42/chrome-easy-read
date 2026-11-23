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
      if (path === "/collections/ROOT/items/top") return json(url.searchParams.get("start") === "0" ? all.filter((it) => !it.data.parentItem && (it.data.collections ?? ["ROOT"]).includes("ROOT")) : []);
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
      if (path === "/items" && url.searchParams.get("itemType") === "attachment") { // the materials of every paper
        return json(url.searchParams.get("start") === "0" ? all.filter((it) => !it.data.deleted && (it.data.tags || []).some((t) => t.tag === url.searchParams.get("tag"))) : []);
      }
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

async function openArticle(context, sw, server, file = "noted.html") {
  await sw.evaluate((p) => chrome.storage.sync.set({ settings: p }), PROFILE);
  const page = await context.newPage();
  const url = `${server}/${file}`;
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

test("reading list: attaching a PDF confirms the vault folder inside the click, before the file is chosen", async ({ context, sw }) => {
  const seeded = { key: "SEEDED02", data: { itemType: "journalArticle", title: "Clonal neoantigens", creators: [{ lastName: "McGranahan" }], date: "2016", extra: "obsidian: 1_education/papers/mcgranahan-2016-clonal.md" } };
  await fakeZotero(sw, [seeded]);
  const list = await context.newPage();
  await list.goto(viewerUrl(sw).replace("viewer.html", "reading.html"));
  await expect(list.locator("li")).toHaveCount(1);
  // a vault folder as it is after a Chrome restart: access must be confirmed again, and Chrome allows that
  // request only while a click is still "fresh" (about 5 seconds; choosing a file in the dialog takes longer)
  await list.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let state = "prompt";
    window.__vaultOverride = {
      queryPermission: async () => state,
      requestPermission: async () => {
        if (window.__clickExpired || !navigator.userActivation.isActive) throw new DOMException("User activation is required to request permissions.", "SecurityError");
        state = "granted";
        return state;
      },
      getDirectoryHandle: (name, o) => root.getDirectoryHandle(name, o),
    };
  });

  const chooser = list.waitForEvent("filechooser");
  await list.getByRole("button", { name: "Прикрепить PDF…" }).click();
  const dialog = await chooser;
  await list.evaluate(() => { window.__clickExpired = true; });
  await dialog.setFiles(TEST_PDF);
  await expect(list.locator("#status")).toContainText("PDF привязан: McGranahan 2016");
  await expect(list.locator("li")).toContainText("PDF ✓ 0_media/papers/mcgranahan-2016-clonal.pdf");
});

test("reading list: a paper is removed from the list after a confirmation; the Zotero item stays", async ({ context, sw }) => {
  const paper = (key, name) => ({ key, data: { itemType: "journalArticle", title: `Paper of ${name}`, creators: [{ lastName: name }], date: "2020", collections: ["ROOT", "OTHER"], extra: `obsidian: 1_education/papers/${name.toLowerCase()}-2020.md` } });
  await fakeZotero(sw, [paper("SEEDED03", "Cabrita"), paper("SEEDED04", "Helmink")]);
  const list = await context.newPage();
  await list.goto(viewerUrl(sw).replace("viewer.html", "reading.html"));
  await expect(list.locator("li")).toHaveCount(2);
  const row = list.locator("li", { hasText: "Cabrita 2020" });

  list.once("dialog", (d) => d.dismiss()); // "no": nothing changes
  await row.getByRole("button", { name: "Удалить из списка…" }).click();
  await expect(list.locator("li")).toHaveCount(2);

  let asked = "";
  list.once("dialog", (d) => { asked = d.message(); return d.accept(); });
  await row.getByRole("button", { name: "Удалить из списка…" }).click();
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list.locator("li")).toContainText("Helmink 2020");
  await expect(list.locator("#status")).toContainText("Убрано из списка: Cabrita 2020");
  expect(asked).toContain("Cabrita 2020");
  const kept = (await zItems(sw)).find((it) => it.key === "SEEDED03");
  expect(kept.data.collections).toEqual(["OTHER"]);
});

test("in PDF view: a note on a selection over two lines gets its page, and is highlighted in both views", async ({ context, sw, server }) => {
  await fakeZotero(sw);
  await sw.evaluate((p) => chrome.storage.sync.set({ settings: p }), PROFILE);
  const page = await context.newPage();
  await page.goto(viewerUrl(sw, `?file=${encodeURIComponent(`${server}/paper.pdf`)}`));
  await expect(page.locator("body")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await page.locator("#view").click();
  await expect(page.locator("body")).toHaveAttribute("data-view", "pdf");
  await expect(page.locator("#status")).toBeEmpty(); // "Drawing the pages…" is over

  const picked = await page.evaluate(() => {
    const spans = [...document.querySelectorAll("#pages .textLayer span")]
      .filter((s) => !s.classList.contains("markedContent") && !s.classList.contains("er-bw") && s.textContent.trim());
    const i = spans.findIndex((s) => s.textContent.includes("Fecal transplants"));
    const range = document.createRange();
    range.setStart(spans[i], 0);
    range.setEnd(spans[i + 1], spans[i + 1].childNodes.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return { text: getSelection().toString(), page: spans[i].closest(".er-pdf-page").dataset.page };
  });
  expect(picked.text).toMatch(/\n/); // two lines of the page

  await openNotes(sw, "/viewer.html");
  const panel = page.locator("#er-notes");
  await expect(panel.locator(".er-n-quote").first()).toContainText("Fecal transplants");
  await panel.getByLabel("Текст заметки").fill("заметка в режиме PDF");
  await panel.getByLabel("Текст заметки").press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toHaveCount(1);

  const [note] = await notesOf(sw);
  expect(note.data.note).toContain("Fecal transplants");
  expect(note.data.note).toMatch(new RegExp(`Стр\\. ${picked.page} · http`));
  expect(note.data.note).not.toMatch(/<blockquote>(<p>[^<]*<\/p>){2}/); // one quote, not one per line

  const inPdf = await highlights(page);
  expect(inPdf).toHaveLength(1);
  expect(inPdf[0].replace(/\s/g, "")).toContain("Fecaltransplants");
  await expect(panel).not.toContainText("цитата не найдена");

  await panel.getByRole("button", { name: "Закрыть заметки" }).click(); // the open panel lies over the toolbar
  await page.locator("#view").click();
  await expect(page.locator("body")).toHaveAttribute("data-view", "text");
  await expect.poll(() => highlights(page)).toHaveLength(1);
  expect((await highlights(page))[0]).toContain("Fecal transplants");
});

test("quick note: the hotkey saves the selected text at once, to Zotero, the panel and the vault", async ({ context, sw, server }) => {
  const seeded = { key: "SEEDED01", data: { itemType: "journalArticle", title: "TLS networks in three dimensions", creators: [{ lastName: "Lin" }], date: "2026", DOI: "10.1234/tls.2026.001", extra: "obsidian: 1_education/papers/lin-2026-tls.md" } };
  await fakeZotero(sw, [seeded]);
  await sw.evaluate(async () => {
    const root = (self.__vaultOverride = await navigator.storage.getDirectory());
    let dir = root;
    for (const name of ["1_education", "papers"]) dir = await dir.getDirectoryHandle(name, { create: true });
    const w = await (await dir.getFileHandle("lin-2026-tls.md", { create: true })).createWritable();
    await w.write("# Lin 2026\n\n## Заметки\n");
    await w.close();
  });
  const vaultText = (path) => sw.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split("/");
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    return (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
  }, path);
  const quick = () => sw.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url.includes("noted.html"));
    await self.easyRead.quickNote(tab);
  });

  const page = await openArticle(context, sw, server);
  await select(page, "#p2");
  await quick();
  const panel = page.locator("#er-notes");
  const field = panel.getByLabel("Текст заметки");
  await expect(panel.locator(".er-n-item")).toHaveCount(1);
  await expect(panel.locator(".er-n-msg")).toHaveText("Сохранено: Zotero и vault.");
  await expect(field).toHaveValue(/^> Each network was assembled/); // open for an optional comment
  const [note] = await notesOf(sw);
  expect(note.data.parentItem).toBe("SEEDED01");
  expect(note.data.note).toContain("<blockquote><p>Each network was assembled from serial sections");
  expect(await highlights(page)).toHaveLength(1);

  const file = await vaultText(`1_education/papers/notes/lin-2026-tls--${note.key}.md`);
  expect(file).toContain("Статья: [[lin-2026-tls]]");
  expect(file).toContain("> Each network was assembled");
  expect(file).toMatch(new RegExp(`%% zotero-note: ${note.key} · v${note.version} · h:[0-9a-f]{8} %%`));
  expect(await vaultText("1_education/papers/lin-2026-tls.md")).toContain(`- [[lin-2026-tls--${note.key}]]`);

  await field.fill(`${await field.inputValue()}\n\nтолько один пациент`);
  await field.press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toContainText("только один пациент");
  expect(await notesOf(sw)).toHaveLength(1); // the comment went into the same note

  await page.evaluate(() => getSelection().removeAllRanges());
  await quick(); // nothing selected: the panel, no note
  await expect(panel).toBeVisible();
  expect(await notesOf(sw)).toHaveLength(1);
});

test("text tools: buttons and keys mark the selection, the preview and the list show the result", async ({ context, sw, server }) => {
  await fakeZotero(sw);
  const page = await openArticle(context, sw, server);
  await openNotes(sw, "noted.html");
  const panel = page.locator("#er-notes");
  const field = panel.getByLabel("Текст заметки");
  const pick = (from, to) => field.evaluate((f, [a, b]) => f.setSelectionRange(a, b), [from, to]);

  await field.fill("важно и подчёркнуто");
  await pick(0, 5);
  await panel.getByRole("button", { name: "Жирное (Ctrl+B)" }).click();
  await expect(field).toHaveValue("**важно** и подчёркнуто");
  await panel.getByRole("button", { name: "Жирное (Ctrl+B)" }).click(); // a second press takes the marks off
  await expect(field).toHaveValue("важно и подчёркнуто");
  await panel.getByRole("button", { name: "Жирное (Ctrl+B)" }).click();
  await pick(12, 23);
  await field.press("Control+u");
  await expect(field).toHaveValue("**важно** и <u>подчёркнуто</u>");
  await expect(panel.locator(".er-n-preview strong")).toHaveText("важно");
  await expect(panel.locator(".er-n-preview u")).toHaveText("подчёркнуто");

  await field.fill("**важно** и <u>подчёркнуто</u>\n\nраз\nдва");
  await pick(33, 40);
  await panel.getByRole("button", { name: "Список" }).click();
  await expect(field).toHaveValue("**важно** и <u>подчёркнуто</u>\n\n- раз\n- два");
  await field.press("Control+Enter");

  const item = panel.locator(".er-n-item");
  await expect(item).toHaveCount(1);
  await expect(item.locator("strong")).toHaveText("важно");
  await expect(item.locator("u")).toHaveText("подчёркнуто");
  await expect(item.locator("li")).toHaveCount(2);
  await expect(item).not.toContainText("**");
  await expect(panel.locator(".er-n-preview")).toBeHidden(); // the field is empty again
  const [note] = await notesOf(sw);
  expect(note.data.note).toBe("<p><strong>важно</strong> и <u>подчёркнуто</u></p>\n<ul><li>раз</li><li>два</li></ul>");
});

test("on a page that requires Trusted Types the notes list is still shown", async ({ context, sw, server }) => {
  await fakeZotero(sw);
  const page = await openArticle(context, sw, server, "noted-tt.html");
  await openNotes(sw, "noted-tt.html");
  const panel = page.locator("#er-notes");
  await panel.getByLabel("Текст заметки").fill("**важно** здесь");
  await panel.getByLabel("Текст заметки").press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toContainText("важно");
  await expect(panel.locator(".er-n-item")).toContainText("здесь");
});

test("notes in a tab of their own: one tab per paper, notes can be written there, a click shows the quote in the article", async ({ context, sw, server }) => {
  await fakeZotero(sw);
  const page = await openArticle(context, sw, server);
  await select(page, "#p2");
  await openNotes(sw, "noted.html");
  const panel = page.locator("#er-notes");
  await panel.getByLabel("Текст заметки").fill("один пациент");
  await panel.getByLabel("Текст заметки").press("Control+Enter");
  await expect(panel.locator(".er-n-item")).toHaveCount(1);

  const opened = context.waitForEvent("page");
  await panel.getByRole("button", { name: "Открыть заметки в отдельной вкладке" }).click();
  const tab = await opened;
  await expect(panel).toBeHidden(); // the panel in the article gives way to the tab
  const list = tab.locator("#er-notes");
  await expect(list.locator(".er-n-item")).toHaveCount(1);
  await expect(list.locator(".er-n-item")).toContainText("один пациент");
  await expect(tab).toHaveTitle(/Заметки · Lin 2026/);
  await expect(list.getByRole("button", { name: "Закрыть заметки" })).toBeHidden();

  // a summary written in the tab goes to Zotero
  await list.getByRole("button", { name: "Одна общая заметка ко всей статье" }).click();
  await list.getByLabel("Текст заметки").fill("сети, но n = 1");
  await list.getByLabel("Текст заметки").press("Control+Enter");
  await expect(list.locator(".er-n-item")).toHaveCount(2);
  expect((await notesOf(sw)).some((n) => n.data.tags.some((t) => t.tag === "summary"))).toBe(true);

  // a second "open in a tab" lands on the same tab
  await page.bringToFront();
  await openNotes(sw, "noted.html");
  await panel.getByRole("button", { name: "Открыть заметки в отдельной вкладке" }).click();
  await expect.poll(() => context.pages().filter((p) => p.url().includes("/notes.html")).length).toBe(1);

  // a click on the note with a quote brings the article forward, with the fresh list
  await tab.bringToFront();
  await list.locator(".er-n-item", { hasText: "один пациент" }).click();
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
  await expect(page.locator("#er-notes .er-n-item")).toHaveCount(2);
});

test("reading list: «Заметки» opens the notes tab of the paper", async ({ context, sw }) => {
  const seeded = { key: "SEEDED01", data: { itemType: "journalArticle", title: "A paper", creators: [{ lastName: "Meylan" }], date: "2022", extra: "obsidian: 1_education/papers/meylan-2022-tls.md" } };
  await fakeZotero(sw, [seeded, { key: "NOTE0001", data: { itemType: "note", parentItem: "SEEDED01", note: "<blockquote><p>a quote from the paper</p></blockquote><p>from before</p>", tags: [] } }]);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/reading.html`);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Заметки" }).click();
  const tab = await opened;
  await expect(tab.locator("#er-notes .er-n-item")).toContainText("from before");
  await tab.locator("#er-notes .er-n-item").click(); // no article tab is known
  await expect(tab.locator("#status")).toContainText("Вкладка статьи закрыта");
});

const MEYLAN = { key: "SEEDED01", data: { itemType: "journalArticle", title: "A paper", creators: [{ lastName: "Meylan" }], date: "2022", extra: "obsidian: 1_education/papers/meylan-2022-tls.md" } };
const materialsOf = async (sw) => (await zItems(sw)).filter((it) => !it.data.deleted && (it.data.tags || []).some((t) => t.tag === "paper-material"));

test("reading list: a link and files become materials of the paper, their links are always visible, one can be removed", async ({ context, sw }) => {
  await fakeZotero(sw, [MEYLAN]);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/reading.html`);
  // the vault is a folder inside OPFS, so that a file can also lie outside it
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const put = async (dir, name, text) => {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
      return dir.getFileHandle(name);
    };
    const vault = (window.__vaultOverride = await root.getDirectoryHandle("vault", { create: true }));
    const work = await vault.getDirectoryHandle("2_work", { create: true });
    const inside = await put(work, "talk transcript.md", "# transcript");
    const outside = await put(root, "Supplementary Tables.pdf", "%PDF-1.4 supplementary");
    window.__pickFiles = async () => [outside, inside];
  });

  const row = page.locator("li", { hasText: "Meylan 2022" }).first();
  await expect(row.locator(".mats")).toHaveCount(0);
  await row.getByRole("button", { name: /Материалы…/ }).click();
  await row.getByLabel("Адрес материала для Meylan 2022").fill("https://youtu.be/abc123");
  await row.getByLabel("Название материала для Meylan 2022").fill("Talk at ASCO");
  await row.getByRole("button", { name: "Добавить ссылку" }).click();
  await expect(row.locator(".mats a")).toHaveCount(1);
  await row.getByRole("button", { name: "Добавить файлы…" }).click();
  await expect(row.locator(".mats a")).toHaveCount(3);
  await expect(page.locator("#status")).toContainText("скопирован в vault");
  await expect(page.locator("#status")).toContainText("talk transcript.md → 2_work/talk transcript.md (на месте)");

  const viewer = `chrome-extension://${new URL(sw.url()).host}/viewer.html`;
  await expect(row.locator(".mats a", { hasText: "видео: Talk at ASCO" })).toHaveAttribute("href", "https://youtu.be/abc123");
  await expect(row.locator(".mats a", { hasText: "PDF: Supplementary Tables.pdf" })).toHaveAttribute("href", `${viewer}?vault=${encodeURIComponent("0_media/papers/meylan-2022-tls--supplementary-tables.pdf")}`);
  await expect(row.locator(".mats a", { hasText: "заметка: talk transcript.md" })).toHaveAttribute("href", "obsidian://open?vault=vault&file=2_work%2Ftalk%20transcript.md");

  const items = await materialsOf(sw);
  expect(items.map((it) => it.data.tags.map((t) => t.tag).join(" ")).sort()).toEqual(["paper-material material-note", "paper-material material-pdf", "paper-material material-video"]);
  expect(items.every((it) => it.data.parentItem === "SEEDED01" && it.data.linkMode === "linked_url")).toBe(true);
  const copied = await page.evaluate(async () => {
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("vault");
    for (const name of ["0_media", "papers"]) dir = await dir.getDirectoryHandle(name);
    return (await (await dir.getFileHandle("meylan-2022-tls--supplementary-tables.pdf")).getFile()).text();
  });
  expect(copied).toBe("%PDF-1.4 supplementary");

  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Убрать материал: Talk at ASCO" }).click();
  await expect(row.locator(".mats a")).toHaveCount(2);
  expect(await materialsOf(sw)).toHaveLength(2);
});

test("notes panel: links to the materials of the open paper; a PDF of the vault opens in the viewer", async ({ context, sw, server }) => {
  const paper = { key: "SEEDED01", data: { itemType: "journalArticle", title: "TLS networks in three dimensions", creators: [{ lastName: "Lin" }], date: "2026", DOI: "10.1234/tls.2026.001", extra: "obsidian: 1_education/papers/lin-2026-tls.md" } };
  const mat = (key, title, url, kind) => ({ key, data: { itemType: "attachment", linkMode: "linked_url", parentItem: "SEEDED01", title, url, tags: [{ tag: "paper-material" }, { tag: `material-${kind}` }] } });
  await fakeZotero(sw, [paper, mat("MAT00001", "Thread", "https://x.com/a/status/1", "thread"), mat("MAT00002", "Supplementary", "obsidian://open?vault=vault&file=0_media%2Fpapers%2Flin-2026-tls--supp.pdf", "pdf")]);
  const page = await openArticle(context, sw, server);
  await openNotes(sw, "noted.html");
  const mats = page.locator("#er-notes .er-n-mats");
  await expect(mats.locator("a")).toHaveCount(2);
  await expect(mats.locator("a", { hasText: "тред: Thread" })).toHaveAttribute("href", "https://x.com/a/status/1");
  const opened = context.waitForEvent("page");
  await mats.locator("a", { hasText: "PDF: Supplementary" }).click();
  expect((await opened).url()).toContain(`/viewer.html?vault=${encodeURIComponent("0_media/papers/lin-2026-tls--supp.pdf")}`);
});
