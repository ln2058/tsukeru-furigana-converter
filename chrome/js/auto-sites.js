/*
Module: auto-sites
Purpose: Keep the reader's list of sites that get furigana automatically when a page opens, keyed by hostname.

Inputs:
- Page URLs from the browser (tab addresses) and the stored `autoSites` list in `chrome.storage.sync`.

Outputs:
- Site keys (lowercase hostname, without a leading `www.`), the cleaned list, and whether a URL's site is listed.

Side Effects:
- Reads and writes the `autoSites` key in `chrome.storage.sync`, which the browser may sync to the reader's other devices.

Failure Modes:
- Non-http(s) or malformed URLs have no site key and are never listed.
- Stored values that are not hostnames are dropped; the list is capped at MAX_AUTO_SITES.

Security Notes:
- The list stays in extension storage; it is never sent to EZFurigana or any other server.
- Matching is by exact hostname (with `www.` treated as the same site), so listing one site never turns furigana on for its subdomains.
*/

export const AUTO_SITES_KEY = 'autoSites';
export const MAX_AUTO_SITES = 100;
const MAX_HOST_LENGTH = 253;
const HOST_RE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;

/** The site a page belongs to: its lowercase hostname without `www.`, or '' for non-web pages. */
export function siteKey(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return host.length <= MAX_HOST_LENGTH && HOST_RE.test(host) ? host : '';
}

/** A stored list as unique, valid hostnames, newest first, at most MAX_AUTO_SITES. */
export function cleanAutoSites(value) {
  const sites = [];
  (Array.isArray(value) ? value : []).forEach((site) => {
    if (typeof site !== 'string' || site.length > MAX_HOST_LENGTH || !HOST_RE.test(site)) return;
    if (!sites.includes(site)) sites.push(site);
  });
  return sites.slice(0, MAX_AUTO_SITES);
}

export async function readAutoSites() {
  const stored = await chrome.storage.sync.get({ [AUTO_SITES_KEY]: [] });
  return cleanAutoSites(stored[AUTO_SITES_KEY]);
}

/** Add or remove one site; returns the saved list. */
export async function setAutoSite(site, listed) {
  const current = await readAutoSites();
  const others = current.filter((value) => value !== site);
  const next = listed && site ? cleanAutoSites([site, ...others]) : others;
  await chrome.storage.sync.set({ [AUTO_SITES_KEY]: next });
  return next;
}

/** Whether a page's URL belongs to a listed site. */
export async function isAutoSite(url) {
  const site = siteKey(url);
  return Boolean(site) && (await readAutoSites()).includes(site);
}
