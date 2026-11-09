// Pure helpers for per-site state. No chrome.* here, so node tests can import it.

/** The one "site" every local file (file:///…) belongs to: one on/off for all saved pages. */
export const LOCAL_FILES = "file";

/** Hostname of an http(s) page, LOCAL_FILES for a local file, or null for pages an extension cannot change. */
export function siteKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return LOCAL_FILES;
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

/** chrome.tabs.query URL patterns for every tab of a site. */
export function tabPatterns(host) {
  return host === LOCAL_FILES ? ["file:///*"] : [`http://${host}/*`, `https://${host}/*`];
}

/** A URL that most likely opens a PDF: a .pdf path, or an arXiv PDF link (no extension there). */
export function looksLikePdfUrl(url) {
  try {
    const u = new URL(url);
    if (!["http:", "https:", "file:"].includes(u.protocol)) return false;
    return /\.pdf$/i.test(u.pathname) || (u.hostname.endsWith("arxiv.org") && u.pathname.startsWith("/pdf/"));
  } catch {
    return false;
  }
}

/** chrome.storage key that marks easy-read as on for a site. */
export function storageKey(host) {
  return `site:${host}`;
}

/** True when host is one of the domains or a subdomain of one. */
export function matchesDomain(host, domains) {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Free-text domain list (commas, spaces, new lines) -> clean lowercase domains. */
export function parseDomains(text) {
  return text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^\*?\.+/, ""))
    .filter(Boolean);
}
