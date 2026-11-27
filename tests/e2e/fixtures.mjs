// Playwright fixtures: a static server for test pages + Chromium with the extension loaded.
import { test as base, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(HERE, "../../extension");
const PAGES = path.join(HERE, "pages");
const TYPES = { ".html": "text/html; charset=utf-8", ".pdf": "application/pdf" };
export const TEST_PDF = path.join(PAGES, "paper.pdf");

export const test = base.extend({
  server: [async ({}, use) => {
    const srv = createServer(async (req, res) => {
      const { pathname } = new URL(req.url, "http://x");
      const name = path.basename(pathname);
      if (pathname.startsWith("/private/") && !/(^|;\s*)session=ok/.test(req.headers.cookie ?? "")) {
        res.writeHead(403); // a "logged-in only" file
        res.end();
        return;
      }
      try {
        const body = await readFile(path.join(PAGES, name));
        res.writeHead(200, { "content-type": TYPES[path.extname(name)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    await use(`http://127.0.0.1:${srv.address().port}`);
    srv.close();
  }, { scope: "worker" }],

  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },

  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    // The viewer and the reading list move files to and from Zotero themselves. Their requests are answered by the
    // service worker's fetch, where notes.spec.mjs installs its in-memory Zotero: one Zotero for the whole extension.
    await context.route("https://api.zotero.org/**", async (route) => {
      const req = route.request();
      const sent = req.postDataBuffer();
      const out = await sw.evaluate(async ({ url, method, headers, body }) => {
        const bytes = body === null ? undefined : Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
        const isForm = (headers["content-type"] || "").includes("x-www-form-urlencoded") || (headers["content-type"] || "").includes("json");
        const res = await self.fetch(url, { method, headers, body: bytes && (isForm ? new TextDecoder().decode(bytes) : new Blob([bytes])) });
        let binary = "";
        for (const b of new Uint8Array(await res.arrayBuffer())) binary += String.fromCharCode(b);
        return { status: res.status, headers: Object.fromEntries(res.headers), body: btoa(binary) };
      }, { url: req.url(), method: req.method(), headers: req.headers(), body: sent ? sent.toString("base64") : null });
      await route.fulfill({ status: out.status, headers: out.headers, body: Buffer.from(out.body, "base64") });
    });
    await use(sw);
  },
});

/** Run the extension's toggle for the tab showing `url`, as a toolbar click would. */
export async function toggleSite(sw, url) {
  await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await self.easyRead.toggleSite(tab);
  }, url);
}

export async function badge(sw, url) {
  return sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, url);
}

export const expect = test.expect;
