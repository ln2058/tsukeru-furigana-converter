/*
Module: popup-auto-sites.test
Purpose: Check the popup's "Always on <site>" switch under Apply and the Settings list of sites with automatic furigana.
Inputs: Each browser's popup-settings.js, run with fake DOM nodes, tab, and site store.
Outputs: node:test results.
Side Effects: None.
Failure Modes: Fails when the switch shows where Tsukeru cannot run, loses the site name, or the list and its empty hint drift apart.
Security Notes: Uses fake data only.
*/
import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function node(tag = 'div') {
  const listeners = {};
  const element = {
    tagName: tag.toUpperCase(), hidden: false, checked: false, className: '', title: '', children: [], attributes: {},
    get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : (this._text || ''); },
    set textContent(value) { this._text = String(value); this.children = []; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelectorAll(selector) {
      const found = [];
      const walk = (item) => (item.children || []).forEach((child) => {
        if (selector === `.${child.className}`) found.push(child);
        walk(child);
      });
      walk(this);
      return found;
    },
    focus() {},
    fire: (type) => listeners[type]?.(),
  };
  return element;
}

function loadAutoSites(browser, { url, sites }) {
  const fileUrl = new URL(`../${browser}/js/popup-settings.js`, import.meta.url);
  const source = readFileSync(fileUrl, 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '')
    .replaceAll('export ', '');
  const ids = Object.fromEntries(['autoSiteRow', 'autoSite', 'autoSiteLabel', 'autoSiteList', 'autoSiteEmpty'].map((id) => [id, node()]));
  const store = { sites: [...sites] };
  const sandbox = {
    console,
    chrome: { i18n: { getMessage: () => '' }, tabs: { query: async () => [{ url }] } },
    document: {
      getElementById: (id) => ids[id] || null,
      createElement: (tag) => node(tag),
      createElementNS: (_ns, tag) => node(tag),
      createTextNode: (text) => ({ textContent: String(text) }),
    },
    siteKey: (value) => (/^https?:\/\//.test(value) ? new URL(value).hostname.replace(/^www\./, '') : ''),
    readAutoSites: async () => [...store.sites],
    setAutoSite: async (site, listed) => {
      store.sites = listed ? [...new Set([...store.sites, site])] : store.sites.filter((item) => item !== site);
      return [...store.sites];
    },
  };
  loadI18n(sandbox, browser);
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return { sandbox, ids, store };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} the switch under Apply names the open site and lists it in Settings once on`, async () => {
    let listed = 0;
    const { sandbox, ids, store } = loadAutoSites(browser, { url: 'https://www.youtube.com/watch?v=1', sites: ['nhk.or.jp'] });
    await sandbox.initAutoSites({ onListed: () => { listed += 1; } });

    assert.equal(ids.autoSiteRow.hidden, false);
    assert.equal(ids.autoSiteLabel.textContent, 'Always on youtube.com');
    assert.equal(ids.autoSiteLabel.children[1].className, 'auto-site-label-host');
    assert.equal(ids.autoSite.checked, false);
    assert.deepEqual(ids.autoSiteList.children.map((item) => item.children[0].textContent), ['nhk.or.jp']);
    assert.equal(ids.autoSiteEmpty.hidden, true);

    ids.autoSite.checked = true;
    ids.autoSite.fire('change');
    await settle();
    assert.deepEqual(store.sites, ['nhk.or.jp', 'youtube.com']);
    assert.equal(listed, 1, 'switching it on adds furigana to the open page');
    assert.deepEqual(ids.autoSiteList.children.map((item) => item.children[0].textContent), ['nhk.or.jp', 'youtube.com']);
    assert.equal(ids.autoSite.checked, true);

    // Removing the open site from Settings turns its switch off.
    const removeYoutube = ids.autoSiteList.children[1].children[1];
    removeYoutube.fire('click');
    await settle();
    assert.equal(ids.autoSite.checked, false);
    assert.deepEqual(store.sites, ['nhk.or.jp']);
  });

  test(`${browser} the switch stays hidden where Tsukeru cannot run, and an empty list shows its hint`, async () => {
    const { sandbox, ids } = loadAutoSites(browser, { url: 'chrome://extensions/', sites: [] });
    await sandbox.initAutoSites();
    assert.equal(ids.autoSiteRow.hidden, true);
    assert.equal(ids.autoSiteList.hidden, true);
    assert.equal(ids.autoSiteEmpty.hidden, false);
  });
}
