import { test } from "node:test";
import assert from "node:assert/strict";
import { siteKey, storageKey, tabPatterns, LOCAL_FILES, matchesDomain, parseDomains, looksLikePdfUrl } from "../extension/site.js";

test("looksLikePdfUrl spots .pdf paths and arXiv PDF links", () => {
  for (const url of ["https://a.org/paper.pdf", "https://a.org/x/Paper.PDF?download=1", "file:///C:/papers/a.pdf",
    "https://www.biorxiv.org/content/10.1101/2024.01.01.123v1.full.pdf", "https://arxiv.org/pdf/2401.00001v2"]) {
    assert.equal(looksLikePdfUrl(url), true, url);
  }
  for (const url of ["https://a.org/pdf-guide", "https://arxiv.org/abs/2401.00001", "chrome://settings", "", undefined]) {
    assert.equal(looksLikePdfUrl(url), false, String(url));
  }
});

test("siteKey returns the hostname for http and https pages", () => {
  assert.equal(siteKey("https://www.nature.com/articles/s41586"), "www.nature.com");
  assert.equal(siteKey("http://localhost:8080/page"), "localhost");
});

test("siteKey returns null for pages an extension cannot change", () => {
  for (const url of ["chrome://settings", "chrome-extension://abc/options.html",
    "about:blank", "", undefined, "not a url"]) {
    assert.equal(siteKey(url), null, String(url));
  }
});

test("siteKey groups every local file under one key", () => {
  assert.equal(siteKey("file:///C:/Users/me/Downloads/book.html"), LOCAL_FILES);
  assert.equal(siteKey("file:///home/me/notes.html"), LOCAL_FILES);
});

test("tabPatterns finds the tabs of a site, or every local file", () => {
  assert.deepEqual(tabPatterns("example.com"), ["http://example.com/*", "https://example.com/*"]);
  assert.deepEqual(tabPatterns(LOCAL_FILES), ["file:///*"]);
});

test("storageKey namespaces the hostname", () => {
  assert.equal(storageKey("example.com"), "site:example.com");
});

test("matchesDomain matches the domain and its subdomains only", () => {
  const domains = ["atlassian.net", "example.com"];
  assert.equal(matchesDomain("acme.atlassian.net", domains), true);
  assert.equal(matchesDomain("example.com", domains), true);
  assert.equal(matchesDomain("notatlassian.net", domains), false);
  assert.equal(matchesDomain("nature.com", domains), false);
  assert.equal(matchesDomain("nature.com", []), false);
});

test("parseDomains accepts commas, spaces and new lines, ignores *. and case", () => {
  assert.deepEqual(parseDomains(" *.Example.com,\natlassian.net  .jira.com\n\n"),
    ["example.com", "atlassian.net", "jira.com"]);
  assert.deepEqual(parseDomains(""), []);
});
