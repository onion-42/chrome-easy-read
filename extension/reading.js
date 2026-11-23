// Reading list: the papers of the chosen Zotero collection, grouped by sub-collection.
// "Читать" opens the PDF kept in the vault when there is one, else the paper's address.
// Every paper also shows its materials (supplementary PDFs, notes, videos, threads, slides): links that are
// always visible, and a block to add and remove them.
import { getVault, permission, keepPdf, saveMaterial, vaultPathOf } from "./vault-pdf.js";
import * as P from "./papers.js";

const $ = (id) => document.getElementById(id);
const VIEWER = chrome.runtime.getURL("viewer.html");
let groups = [];
let vault = "";
let attachTo = null; // the paper waiting for a file from the picker
const managing = new Set(); // keys of the papers whose materials block is open (kept over a reload of the list)
const MATERIAL_FILES = [{
  description: "PDF, заметки Markdown, Word, Excel",
  accept: {
    "application/pdf": [".pdf"],
    "text/markdown": [".md"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "application/msword": [".doc"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.ms-excel": [".xls"],
  },
}];

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

/** Confirm access to the vault folder -> true when a PDF can be written now. Chrome allows the request only
 * right after a click, so this runs in the button's click, before the file dialog (which outlasts the click). */
async function vaultReady() {
  try {
    const dir = await getVault();
    if (!dir) {
      say("PDF не сохранён: папка vault не выбрана (Настройки).", true);
      return false;
    }
    if ((await permission(dir, true)) === "granted") return true;
    say("PDF не сохранён: нет доступа к папке vault. Нажми кнопку ещё раз и выбери «Разрешить».", true);
  } catch (e) {
    say(`Нет доступа к папке vault: ${e.message}`, true);
  }
  return false;
}

/** Put the chosen file into the vault as this paper's PDF (asks before replacing another file).
 * Access to the folder is confirmed earlier, in the click (vaultReady); here it is only checked. */
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
    let res = await keepPdf(paper.slug, bytes);
    if (res.existed && confirm(`У статьи «${paper.label}» уже есть PDF в vault. Заменить его этим файлом?`)) {
      res = await keepPdf(paper.slug, bytes, { replace: true });
    }
    if (res.reason) {
      const why = { "no-vault": "папка vault не выбрана (Настройки)", permission: "нет доступа к папке vault: нажми «Прикрепить PDF…» и выбери «Разрешить»", "too-big": "файл больше 95 МБ, GitHub не примет его в vault" };
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

/* ---------- materials of a paper ---------- */

const materialLabel = (m) => `${P.MATERIAL_KINDS[m.kind] || m.kind}: ${m.title}`;
const materialLink = (m) => el("a", { href: P.materialHref(m, VIEWER), target: "_blank", rel: "noreferrer", text: materialLabel(m) });

/** One picked or dropped file becomes a material: a file of the vault is linked where it is, any other file
 * is copied (.md -> 1_education/papers/materials/, PDF / Word / Excel -> 0_media/papers/). -> the line for the status. */
async function addFile(p, dir, handle) {
  const file = await handle.getFile();
  const kind = P.materialKind(file.name);
  if (!P.isMaterialFile(file.name)) return `${file.name}: не прикреплён, нужен PDF, .md, .docx или .xlsx`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let path = await vaultPathOf(dir, handle);
  let how = "на месте";
  if (!path) {
    if (!p.slug) return `${file.name}: не прикреплён, у статьи ещё нет заметки в Obsidian (нужна синхронизация plan-browser)`;
    const saved = await saveMaterial(dir, P.materialFileName(p.slug, file.name), bytes);
    path = saved.path;
    how = saved.existed ? "такой файл уже был в vault" : "скопирован в vault";
  }
  const res = await zotero("materialAdd", { key: p.key, title: file.name, target: path, hash: kind === "pdf" ? await sha256(bytes) : null });
  return `${file.name} → ${path} (${res.existed ? "уже прикреплён" : how})`;
}

/** Attach several files; one failure does not stop the rest. Access to the vault is confirmed by the caller. */
async function addFiles(p, handles) {
  const dir = await getVault();
  const lines = [];
  let failed = false;
  for (const handle of handles) {
    try {
      lines.push(await addFile(p, dir, handle));
    } catch (e) {
      failed = true;
      lines.push(`${handle.name}: не прикреплён, ${e.message}`);
    }
  }
  managing.add(p.key);
  await load();
  say(`Материалы «${p.label}»: ${lines.join("; ")}`, failed);
}

async function addLink(p, address, title) {
  let url;
  try {
    url = new URL(address.trim()).href;
  } catch {
    say("Нужен полный адрес, например https://youtu.be/…", true);
    return;
  }
  try {
    const res = await zotero("materialAdd", { key: p.key, title: title.trim(), target: url });
    managing.add(p.key);
    await load();
    say(res.existed ? `Эта ссылка уже прикреплена к «${p.label}».` : `Прикреплено к «${p.label}»: ${P.MATERIAL_KINDS[P.materialKind(url)]} ${url}`);
  } catch (e) {
    say(`Ссылка не прикреплена: ${e.message}`, true);
  }
}

/** The block behind «Материалы…»: every material with «Убрать», «Добавить файлы…», and the link form. */
function manageBox(p) {
  const list = el("ul", {}, p.materials.map((m) => {
    const drop = el("button", { type: "button", text: "Убрать", "aria-label": `Убрать материал: ${m.title}` });
    drop.addEventListener("click", async () => {
      if (!confirm(`Убрать материал «${m.title}» у статьи «${p.label}»?\nЗапись уйдёт в корзину Zotero. Файл в vault останется.`)) return;
      drop.disabled = true;
      try {
        await zotero("materialRemove", { materialKey: m.key });
        await load();
        say(`Материал убран: ${m.title}. Его строка в заметке статьи остаётся: удали её в Obsidian, если не нужна.`);
      } catch (e) {
        say(`Не убрано: ${e.message}`, true);
        drop.disabled = false;
      }
    });
    return el("li", {}, [materialLink(m), drop]);
  }));
  const files = el("button", { type: "button", text: "Добавить файлы…", title: "PDF (supplementary, ответы рецензентам), заметки .md (транскрипт, заметка о видео), Word .docx и Excel .xlsx; можно несколько" });
  files.addEventListener("click", async () => {
    if (!(await vaultReady())) return;
    if (!window.__pickFiles && !navigator.userActivation.isActive) {
      say("Доступ к папке vault подтверждён. Нажми кнопку ещё раз, чтобы выбрать файлы.");
      return;
    }
    let handles;
    try {
      // tests inject the picked handles (window.__pickFiles), as they inject the vault folder
      handles = await (window.__pickFiles ? window.__pickFiles() : window.showOpenFilePicker({ multiple: true, types: MATERIAL_FILES }));
    } catch (e) {
      if (e.name !== "AbortError") say(`Файлы не выбраны: ${e.message}`, true);
      return;
    }
    await addFiles(p, handles);
  });
  const address = el("input", { type: "url", placeholder: "https://… (видео, тред в X, Google Slides, любая ссылка)", "aria-label": `Адрес материала для ${p.label}` });
  const title = el("input", { type: "text", placeholder: "Название (необязательно)", "aria-label": `Название материала для ${p.label}` });
  const add = el("button", { type: "button", text: "Добавить ссылку" });
  add.addEventListener("click", () => addLink(p, address.value, title.value));
  return el("div", { class: "manage" }, [
    ...(p.materials.length ? [list] : [el("p", { class: "soft", text: "Материалов пока нет." })]),
    el("div", { class: "bar" }, [files]),
    el("div", { class: "bar" }, [address, title, add]),
  ]);
}

function row(p) {
  const actions = el("div", { class: "bar" }, [
    el("a", { class: "btn", href: readUrl(p) || "#", target: "_blank", rel: "noreferrer", text: "Читать" }),
    el("a", { class: "btn", href: `zotero://select/library/items/${p.key}`, text: "Zotero" }),
  ]);
  if (p.slug) actions.append(el("a", { class: "btn", href: obsidianUrl(p), text: "Obsidian" }));
  actions.append(el("a", { class: "btn", href: `notes.html?key=${encodeURIComponent(p.key)}`, target: "_blank", text: "Заметки" }));
  const pick = el("button", { type: "button", text: p.pdf ? "Заменить PDF…" : "Прикрепить PDF…" });
  pick.addEventListener("click", async () => {
    attachTo = p;
    if (!(await vaultReady())) return;
    // answering Chrome's access question can outlast the click; the file dialog needs a fresh one
    if (navigator.userActivation.isActive) $("file").click();
    else say("Доступ к папке vault подтверждён. Нажми кнопку ещё раз, чтобы выбрать файл.");
  });
  actions.append(pick);
  const more = el("button", { type: "button", "aria-expanded": String(managing.has(p.key)), text: `Материалы… (${p.materials.length})`, title: "Добавить или убрать материалы статьи" });
  const box = manageBox(p);
  box.hidden = !managing.has(p.key);
  more.addEventListener("click", () => {
    box.hidden = !box.hidden;
    more.setAttribute("aria-expanded", String(!box.hidden));
    if (box.hidden) managing.delete(p.key);
    else managing.add(p.key);
  });
  actions.append(more);
  const drop = el("button", { type: "button", text: "Удалить из списка…" });
  drop.addEventListener("click", async () => {
    if (!confirm(`Убрать «${p.label}» из списка чтения?\nЗапись в Zotero, заметки и PDF останутся. Задача закроется при следующей синхронизации plan-browser.`)) return;
    drop.disabled = true;
    try {
      await zotero("remove", { key: p.key });
    } catch (e) {
      say(`Не убрано: ${e.message}`, true);
      drop.disabled = false;
      return;
    }
    say(`Убрано из списка: ${p.label}. Задача закроется при синхронизации plan-browser.`);
    await load(); // reports its own failure; the paper is already out of the list
  });
  actions.append(drop);
  const item = el("li", {}, [
    el("p", { class: "title" }, [document.createTextNode(`${p.label} `), el("span", { text: `— ${p.title}` })]),
    actions,
    el("p", { class: "soft", text: p.pdf ? `PDF ✓ ${p.pdf}` : "PDF в vault нет" }),
    ...(p.materials.length ? [el("p", { class: "soft mats" }, [document.createTextNode("Материалы:"), ...p.materials.map(materialLink)])] : []),
    box,
  ]);
  item.addEventListener("dragover", (e) => {
    e.preventDefault();
    item.classList.add("drag");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drag"));
  item.addEventListener("drop", async (e) => {
    e.preventDefault();
    item.classList.remove("drag");
    const dropped = [...e.dataTransfer.files];
    // one PDF on a paper without a PDF is the paper's own PDF; everything else is a material
    if (!p.pdf && dropped.length === 1 && dropped[0].type === "application/pdf") {
      attach(p, dropped[0]);
      return;
    }
    // the handles must be asked for inside the event; a handle tells whether the file already lies in the vault
    const asked = [...e.dataTransfer.items].filter((it) => it.kind === "file").map((it) => it.getAsFileSystemHandle());
    if (!(await vaultReady())) return;
    await addFiles(p, (await Promise.all(asked)).filter((h) => h && h.kind === "file"));
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
      say(!groups.length ? "В коллекции пока нет статей." : !dir ? "Папка vault не выбрана (Настройки)." : access !== "granted" ? "Доступ к папке vault подтвердится при первом открытии или прикреплении PDF." : "");
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
