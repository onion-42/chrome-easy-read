// Pure helpers for per-site state. No chrome.* here, so node tests can import it.

/** Hostname of an http(s) page, or null for pages an extension cannot change. */
export function siteKey(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
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
