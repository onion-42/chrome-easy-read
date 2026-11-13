import { test, expect, toggleSite } from "./fixtures.mjs";

/* Replace Claude and DeepSeek with fakes that record what they were asked. */
async function fakeAssist(sw, reader = {}) {
  await sw.evaluate(async (r) => {
    self.__asked = [];
    self.__translated = [];
    self.easyRead.assist.ask = async (input) => {
      self.__asked.push(input);
      return {
        text: `Answer ${self.__asked.length}: see Figure 2.`,
        turn: { role: "assistant", content: [{ type: "text", text: `Answer ${self.__asked.length}: see Figure 2.` }] },
        usage: { tokens: 18200, cached: 17900, usd: 0.04 },
      };
    };
    self.easyRead.assist.translate = async (text) => {
      self.__translated.push(text);
      return { text: "Перевод готов." };
    };
    await chrome.storage.local.set({ reader: r });
  }, reader);
}

async function openAssistant(context, sw, server) {
  const page = await context.newPage();
  const url = `${server}/noted.html`;
  await page.goto(url);
  await toggleSite(sw, url);
  await page.locator("#er-note").click();
  const panel = page.locator("#er-notes");
  await panel.locator("summary").click();
  return { page, panel, question: panel.getByLabel("Вопрос по статье"), note: panel.getByLabel("Текст заметки") };
}

const select = (page, selector) => page.evaluate((s) => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(s));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}, selector);

test("a question shows the answer with its price, keeps the conversation and can go into the note", async ({ context, sw, server }) => {
  await fakeAssist(sw);
  const { panel, question, note } = await openAssistant(context, sw, server);

  await question.fill("Сколько пациентов?");
  await question.press("Control+Enter"); // asks; must not save a note
  await expect(panel).toContainText("Answer 1: see Figure 2.");
  await expect(panel).toContainText("≈ $0.040");
  await expect(panel).toContainText("из кэша 17");
  await expect(panel.locator(".er-n-item")).toHaveCount(0);
  await expect(question).toHaveValue("");

  await question.fill("А где это показано?");
  await panel.getByRole("button", { name: /Задать вопрос/ }).click();
  await expect(panel).toContainText("Answer 2: see Figure 2.");
  const asked = await sw.evaluate(() => self.__asked);
  expect(asked[0].paper).toContain("the sample size is one patient"); // the text of the article, not the panel
  expect(asked[0].paper).not.toContain("Помощник");
  expect(asked[0].history).toEqual([]);
  expect(asked[1].history.map((t) => t.role)).toEqual(["user", "assistant"]);
  expect(asked[1].question).toBe("А где это показано?");

  await panel.getByRole("button", { name: /Положить последний ответ/ }).click();
  await expect(note).toHaveValue("Вопрос: А где это показано?\nAnswer 2: see Figure 2.");

  await panel.getByRole("button", { name: /Забыть предыдущие вопросы/ }).click();
  await expect(panel).not.toContainText("Answer 1");
});

test("translation takes the whole selection, however long, and asks for one when there is none", async ({ context, sw, server }) => {
  await fakeAssist(sw);
  const { page, panel, note } = await openAssistant(context, sw, server);
  const translateBtn = panel.getByRole("button", { name: /Перевести выделенный текст/ });

  await translateBtn.click();
  await expect(panel).toContainText("Выдели текст в статье.");
  expect(await sw.evaluate(() => self.__translated.length)).toBe(0);

  const long = "tertiary lymphoid structure ".repeat(180).trim(); // about 5000 characters; a note quote stops at 2000
  await page.evaluate((t) => { document.querySelector("#p2").textContent = t; }, long);
  await select(page, "#p2");
  await translateBtn.click();
  await expect(panel).toContainText("Перевод готов.");
  expect(await sw.evaluate(() => self.__translated)).toEqual([long]);

  await panel.getByRole("button", { name: /Положить последний ответ/ }).click();
  await expect(note).toHaveValue("Перевод готов.");
});

test("a work site sends nothing to Claude or DeepSeek", async ({ context, sw, server }) => {
  await fakeAssist(sw, { builtinOnly: "127.0.0.1" });
  const { page, panel, question } = await openAssistant(context, sw, server);

  await question.fill("Что это?");
  await panel.getByRole("button", { name: /Задать вопрос/ }).click();
  await expect(panel).toContainText("Off for this site");
  await select(page, "#p2");
  await panel.getByRole("button", { name: /Перевести выделенный текст/ }).click();
  await expect(panel).toContainText("Off for this site");
  expect(await sw.evaluate(() => self.__asked.length + self.__translated.length)).toBe(0);
});

test("“do not send this document” switches both buttons off and is remembered for the document", async ({ context, sw, server }) => {
  await fakeAssist(sw);
  const { page, panel } = await openAssistant(context, sw, server);
  const keepLocal = panel.getByLabel("Не отправлять этот документ в Claude и DeepSeek");
  const askBtn = panel.getByRole("button", { name: /Задать вопрос/ });
  const translateBtn = panel.getByRole("button", { name: /Перевести выделенный текст/ });

  await expect(keepLocal).not.toBeChecked(); // off by default
  await expect(askBtn).toBeEnabled();
  await keepLocal.check();
  await expect(askBtn).toBeDisabled();
  await expect(translateBtn).toBeDisabled();
  await expect.poll(() => sw.evaluate(async () => Object.keys((await chrome.storage.local.get("assist-local-only"))["assist-local-only"] ?? {}).length)).toBe(1);

  await page.reload();
  await page.locator("#er-note").click();
  await panel.locator("summary").click();
  await expect(keepLocal).toBeChecked();
  await expect(askBtn).toBeDisabled();
  await expect(translateBtn).toBeDisabled();
});
