// Options page, Zotero section: API key check, collection, the vault folder for PDFs.
import { client, collectionTree } from "./zotero-api.js";
import { getVault, pickVault, keepVault, forgetVault, isVaultRoot, permission } from "./vault-pdf.js";

const KEY = "zotero"; // storage.local: { apiKey, userId, collection, vaultName }
const DEFAULT_COLLECTION = "Reading list";
const $ = (id) => document.getElementById(id);

function say(text, isError = false) {
  $("z-status").textContent = text;
  $("z-status").className = text ? (isError ? "bad" : "ok") : "";
}

const load = async () => (await chrome.storage.local.get(KEY))[KEY] ?? {};
const save = async (changes) => chrome.storage.local.set({ [KEY]: { ...(await load()), ...changes } });

function fillCollections(collections, chosen) {
  const select = $("z-collection");
  select.textContent = "";
  for (const root of collections.filter((c) => !c.data.parentCollection)) {
    for (const c of collectionTree(collections, root.key)) {
      const option = document.createElement("option");
      option.value = c.key;
      option.textContent = `${c.parent ? "— " : ""}${c.name}`;
      select.append(option);
    }
  }
  const fallback = collections.find((c) => c.data.name === DEFAULT_COLLECTION && !c.data.parentCollection)?.key;
  select.value = chosen && collections.some((c) => c.key === chosen) ? chosen : fallback || select.options[0]?.value || "";
  select.disabled = !select.options.length;
  return select.value;
}

async function check() {
  const apiKey = $("z-key").value.trim();
  if (!apiKey) {
    say("Вставь ключ Zotero API.", true);
    return;
  }
  say("Проверяю…");
  try {
    const me = await client({ apiKey, userId: 0 }).whoami();
    if (!me.access?.user?.write) throw new Error("У ключа нет права записи (write). Создай ключ с правами library, notes, write.");
    const collections = await client({ apiKey, userId: me.userID }).collections();
    const collection = fillCollections(collections, (await load()).collection);
    await save({ apiKey, userId: me.userID, collection });
    say(collection ? `Ключ работает: ${me.username}.` : `Ключ работает (${me.username}), но в библиотеке нет коллекций. Создай коллекцию «${DEFAULT_COLLECTION}» в Zotero.`, !collection);
  } catch (e) {
    say(e.message, true);
  }
}

async function showVault() {
  const dir = await getVault();
  const state = dir ? await permission(dir) : null;
  const wrong = state === "granted" && !(await isVaultRoot(dir));
  $("z-vault-state").textContent = !dir ? "не выбрана"
    : wrong ? `«${dir.name}» — не корень vault (нажми кнопку и выбери папку, в которой лежит .obsidian)`
    : state === "granted" ? `${dir.name} ✓` : `${dir.name}: доступ нужно подтвердить (нажми кнопку)`;
}

$("z-check").addEventListener("click", check);
$("z-collection").addEventListener("change", async (e) => {
  await save({ collection: e.target.value });
  say("Сохранено");
});
$("z-vault").addEventListener("click", async () => {
  try {
    const known = await getVault();
    const dir = known && (await permission(known)) === "prompt" ? known : await pickVault();
    if ((await permission(dir, true)) !== "granted") throw new Error("Нет доступа к папке. Нажми кнопку ещё раз и выбери «Разрешить».");
    if (await isVaultRoot(dir)) {
      await keepVault(dir);
      await save({ vaultName: dir.name });
      say("");
    } else {
      await forgetVault(); // the next click opens the folder dialog again
      say(`«${dir.name}» — не корень vault: в этой папке нет .obsidian. Нажми кнопку ещё раз и выбери саму папку vault (например obsidian_vault).`, true);
    }
  } catch (e) {
    if (e.name !== "AbortError") say(e.message, true);
  }
  await showVault();
});

const stored = await load();
$("z-key").value = stored.apiKey ?? "";
await showVault();
if (stored.apiKey) await check();
