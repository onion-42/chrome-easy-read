// Reading list: the papers of the chosen Zotero collection, grouped by sub-collection.
// "Читать" opens the PDF kept in the vault when there is one, else the paper's address.
import { getVault, permission, keepPdf } from "./vault-pdf.js";

const $ = (id) => document.getElementById(id);
const VIEWER = chrome.runtime.getURL("viewer.html");
let groups = [];
let vault = "";
let attachTo = null; // the paper waiting for a file from the picker

function say(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "bad" : "";
}

function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

async function zotero(op, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type: "zotero", op, ...extra });
  if (!res?.ok) throw new Error(res?.message || "Нет ответа от расширения.");
  return res;
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const readUrl = (p) => (p.pdf ? `${VIEWER}?vault=${encodeURIComponent(p.pdf)}` : p.url);
const obsidianUrl = (p) => `obsidian://open?${vault ? `vault=${encodeURIComponent(vault)}&` : ""}file=${encodeURIComponent(p.slug)}`;

/** Put the chosen file into the vault as this paper's PDF (asks before replacing another file). */
async function attach(paper, file) {
  if (!file || file.type !== "application/pdf") {
    say("Нужен файл PDF.", true);
    return;
  }
  if (!paper.slug) {
    say("У статьи ещё нет заметки в Obsidian. Открой панель plan-browser (синхронизация) и повтори.", true);
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let res = await keepPdf(paper.slug, bytes, { interactive: true });
    if (res.existed && confirm(`У статьи «${paper.label}» уже есть PDF в vault. Заменить его этим файлом?`)) {
      res = await keepPdf(paper.slug, bytes, { interactive: true, replace: true });
    }
    if (res.reason) {
      const why = { "no-vault": "папка vault не выбрана (Настройки)", permission: "нет доступа к папке vault", "too-big": "файл больше 95 МБ, GitHub не примет его в vault" };
      say(`PDF не сохранён: ${why[res.reason] || res.reason}.`, true);
      return;
    }
    await zotero("pdfSaved", { key: paper.key, path: res.path, hash: await sha256(bytes) });
    say(`PDF привязан: ${paper.label} → ${res.path}`);
    await load();
  } catch (e) {
    say(`PDF не сохранён: ${e.message}`, true);
  }
}

function row(p) {
  const actions = el("div", { class: "bar" }, [
    el("a", { class: "btn", href: readUrl(p) || "#", target: "_blank", rel: "noreferrer", text: "Читать" }),
    el("a", { class: "btn", href: `zotero://select/library/items/${p.key}`, text: "Zotero" }),
  ]);
  if (p.slug) actions.append(el("a", { class: "btn", href: obsidianUrl(p), text: "Obsidian" }));
  const pick = el("button", { type: "button", text: p.pdf ? "Заменить PDF…" : "Прикрепить PDF…" });
  pick.addEventListener("click", () => {
    attachTo = p;
    $("file").click();
  });
  actions.append(pick);
  const item = el("li", {}, [
    el("p", { class: "title" }, [document.createTextNode(`${p.label} `), el("span", { text: `— ${p.title}` })]),
    actions,
    el("p", { class: "soft", text: p.pdf ? `PDF ✓ ${p.pdf}` : "PDF в vault нет" }),
  ]);
  item.addEventListener("dragover", (e) => {
    e.preventDefault();
    item.classList.add("drag");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drag"));
  item.addEventListener("drop", (e) => {
    e.preventDefault();
    item.classList.remove("drag");
    attach(p, e.dataTransfer.files[0]);
  });
  return item;
}

function render() {
  const q = $("search").value.trim().toLowerCase();
  const box = $("groups");
  box.textContent = "";
  let shown = 0;
  for (const g of groups) {
    const items = g.items.filter((p) => !q || `${p.label} ${p.title}`.toLowerCase().includes(q));
    if (!items.length) continue;
    shown += items.length;
    box.append(el("h2", { text: `${g.name} (${items.length})` }), el("ul", {}, items.map(row)));
  }
  if (!shown && groups.length) box.append(el("p", { class: "soft", text: "Ничего не найдено." }));
}

async function load() {
  try {
    const res = await zotero("list");
    groups = res.groups;
    vault = res.vault;
    const dir = await getVault();
    const access = dir ? await permission(dir) : null;
    if ($("status").textContent.startsWith("Загружаю")) {
      say(!groups.length ? "В коллекции пока нет статей." : !dir ? "Папка vault для PDF не выбрана (Настройки)." : access !== "granted" ? "Доступ к папке vault подтвердится при первом открытии или прикреплении PDF." : "");
    }
    render();
  } catch (e) {
    say(e.message, true);
  }
}

$("search").addEventListener("input", render);
$("reload").addEventListener("click", () => {
  say("Загружаю список из Zotero…");
  load();
});
$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (attachTo && file) attach(attachTo, file);
});

await load();
