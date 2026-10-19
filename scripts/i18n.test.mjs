import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadI18n } from './i18n-harness.mjs';

const read = (browser, file) => readFileSync(new URL(`../${browser}/${file}`, import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const plain = value => JSON.parse(JSON.stringify(value));

function extension(browser, { preference = '', auto = 'en', fetchCatalog, get } = {}) {
  const listeners = new Set();
  const requests = [];
  const catalogs = Object.fromEntries(['en', 'ja', 'ko', 'zh_TW'].map(code =>
    [code, JSON.parse(read(browser, `_locales/${code}/messages.json`))]));
  const sandbox = {
    console: { warn() {} }, setTimeout, clearTimeout,
    chrome: {
      i18n: { getMessage: key => key === 'ui_lang' ? auto : `native:${key}` },
      runtime: { getURL: path => path },
      storage: {
        sync: { get: get || (async () => ({ uiLocale: preference })) },
        onChanged: { addListener: listener => listeners.add(listener) },
      },
    },
    fetch: async path => {
      const code = path.split('/')[1];
      requests.push(code);
      const catalog = fetchCatalog ? await fetchCatalog(code, catalogs[code]) : catalogs[code];
      return { ok: Boolean(catalog), json: async () => catalog };
    },
  };
  loadI18n(sandbox, browser);
  return {
    sandbox, i18n: sandbox.TsukeruI18n, requests, catalogs,
    change(value) {
      preference = value;
      for (const listener of listeners) listener({ uiLocale: { newValue: value } }, 'sync');
    },
  };
}

function page(browser, sendMessage) {
  const listeners = new Set();
  const sandbox = {
    console: { warn() {} }, setTimeout, clearTimeout,
    chrome: {
      i18n: { getMessage: key => key === 'ui_lang' ? 'en' : 'native message' },
      runtime: { sendMessage },
      storage: { onChanged: { addListener: listener => listeners.add(listener) } },
    },
    fetch() { assert.fail('content scripts must not fetch catalog resources'); },
  };
  loadI18n(sandbox, browser);
  sandbox.TsukeruI18n.initContent();
  return {
    sandbox, i18n: sandbox.TsukeruI18n,
    change(value) { for (const listener of listeners) listener({ uiLocale: { newValue: value } }, 'sync'); },
  };
}

async function popup(browser, { failSave = false } = {}) {
  const fixture = extension(browser, { preference: 'en', auto: 'zh-TW' });
  await fixture.i18n.ready();
  const events = {};
  const cache = new Map();
  const reloads = [];
  const writes = [];
  const auto = { textContent: '' };
  const select = {
    value: '', disabled: false,
    get selectedOptions() { return [{ lang: fixture.i18n.locales[this.value]?.lang || '' }]; },
    addEventListener(type, handler) { events[type] = handler; },
  };
  const sandbox = fixture.sandbox;
  Object.assign(sandbox, {
    URL,
    document: {
      documentElement: { lang: 'en' },
      getElementById: id => id === 'uiLocale' ? select : id === 'uiLocaleAuto' ? auto : null,
    },
    window: { addEventListener() {} },
    location: { href: 'chrome-extension://test/popup.html', reload() { reloads.push(this.href); } },
    history: { replaceState(_state, _title, url) { sandbox.location.href = url; } },
    localStorage: { setItem: (key, value) => cache.set(key, value) },
  });
  sandbox.chrome.storage.sync.set = async value => {
    writes.push(plain(value));
    if (failSave) throw new Error('storage unavailable');
    fixture.change(value.uiLocale);
  };
  vm.runInNewContext(read(browser, 'js/popup-settings.js')
    .replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, ''), sandbox);
  const notices = [];
  sandbox.showNotice = message => notices.push(message);
  sandbox.initLocaleSelect();
  return {
    ...fixture, select, auto, cache, reloads, writes, notices,
    choose: async value => { select.value = value; await events.change(); },
  };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} lookup uses selected → English → caller text and substitutes once`, async () => {
    const fixture = extension(browser, { preference: 'ko', fetchCatalog: (code, catalog) => ({
      ...catalog,
      custom: { message: code === 'ko' ? '$2 / $1 / $$ / $9 / $3' : 'English' },
      english_only: code === 'en' ? { message: 'English $1' } : undefined,
    }) });
    await fixture.i18n.ready();
    assert.equal(fixture.i18n.language(), 'ko');
    assert.equal(fixture.i18n.t('custom', ['$2', '두 번째', '세 번째', '', '', '', '', '', '아홉']), '두 번째 / $2 / $ / 아홉 / 세 번째');
    assert.equal(fixture.i18n.t('english_only', 'value', 'caller'), 'English value');
    assert.equal(fixture.i18n.t('missing', 'value', 'Caller $1 $$'), 'Caller value $');
    assert.equal(fixture.i18n.format('$1 $2 $$', 'one'), 'one  $');
    assert.equal(fixture.i18n.websiteUrl(), 'https://www.ezfurigana.com/ko');
    assert.equal(fixture.i18n.websiteUrl('/pricing'), 'https://www.ezfurigana.com/ko/pricing');
    await fixture.i18n.ready();
    assert.deepEqual(fixture.requests.sort(), ['en', 'ko']);
  });

  test(`${browser} invalid preferences use native Auto resolution and load failures use English`, async () => {
    for (const preference of ['', 'fr', 'zh-Hant', '../ja', null, ['ko'], { toString: () => 'ko' }]) {
      const fixture = extension(browser, { preference, auto: 'zh-TW' });
      await fixture.i18n.ready();
      assert.equal(fixture.i18n.preference(), '');
      assert.equal(fixture.i18n.language(), 'zh-TW');
      assert.equal(fixture.i18n.websiteUrl(), 'https://www.ezfurigana.com/zh-hant');
      assert.equal(fixture.i18n.websiteUrl('/pricing'), 'https://www.ezfurigana.com/zh-hant/pricing');
    }
    const failed = extension(browser, { preference: 'ko', fetchCatalog: (code, catalog) => code === 'ko' ? null : catalog });
    await failed.i18n.ready();
    assert.equal(failed.i18n.language(), 'en');
    assert.equal(failed.i18n.t('tab_settings'), failed.catalogs.en.tab_settings.message);
    const englishAuto = extension(browser, { preference: '', auto: 'en' });
    await englishAuto.i18n.ready();
    assert.deepEqual(englishAuto.requests, ['en'], 'Auto reuses native fallback, not browser-language guessing');
    assert.equal(englishAuto.i18n.websiteUrl('/pricing'), 'https://www.ezfurigana.com/pricing');
  });

  test(`${browser} sync changes beat stale initial reads and catalog fetches`, async () => {
    const initialRead = deferred();
    const korean = deferred();
    const fixture = extension(browser, {
      get: () => initialRead.promise,
      fetchCatalog: async (code, catalog) => code === 'ko' ? korean.promise : catalog,
    });
    const ready = fixture.i18n.ready();
    fixture.change('ko');
    await settle();
    fixture.change('ja');
    initialRead.resolve({ uiLocale: 'en' });
    korean.resolve(fixture.catalogs.ko);
    await ready;
    assert.equal(fixture.i18n.preference(), 'ja');
    assert.equal(fixture.i18n.language(), 'ja');
    assert.equal(fixture.i18n.websiteUrl('/pricing'), 'https://www.ezfurigana.com/jp/pricing');
  });

  test(`${browser} content catalogs are lazy, coalesced, refreshed, and reject late replies`, async () => {
    const background = extension(browser, { preference: 'ko' });
    await background.i18n.ready();
    const oldReply = deferred();
    let requests = 0;
    const content = page(browser, async message => {
      assert.equal(message.action, 'getUiCatalog');
      requests += 1;
      if (requests === 1) return oldReply.promise;
      return { success: true, catalog: plain(await background.i18n.getCatalog()) };
    });
    assert.equal(requests, 0);
    assert.equal(content.i18n.t('content_close'), 'native message');
    const first = content.i18n.ready();
    const second = content.i18n.ready();
    assert.equal(requests, 1);
    const oldCatalog = plain(await background.i18n.getCatalog());
    background.change('zh_TW');
    await background.i18n.ready();
    content.change('zh_TW');
    await settle();
    oldReply.resolve({ success: true, catalog: oldCatalog });
    await Promise.all([first, second]);
    assert.equal(content.i18n.language(), 'zh-TW');
    assert.equal(requests, 2);
    await content.i18n.ready();
    assert.equal(requests, 2);
    vm.runInNewContext(read(browser, 'js/content-ui.js'), content.sandbox);
    const surface = { dataset: {}, isConnected: true, removeAttribute() {} };
    content.sandbox.applyTsukeruUiTheme(surface);
    assert.equal(surface.lang, 'zh-TW');
  });

  test(`${browser} a failed or malformed catalog reply can retry on a later action`, async () => {
    const background = extension(browser, { preference: 'ja' });
    let requests = 0;
    const content = page(browser, async () => {
      requests += 1;
      return requests === 1 ? { success: true, catalog: { locale: '../../bad' } }
        : { success: true, catalog: plain(await background.i18n.getCatalog()) };
    });
    await content.i18n.ready();
    assert.equal(content.i18n.language(), 'en');
    await content.i18n.ready();
    assert.equal(content.i18n.language(), 'ja');
    assert.equal(requests, 2);
  });

  test(`${browser} language selection saves before reopening Settings and uses the option's font language`, async () => {
    const fixture = await popup(browser);
    assert.equal(fixture.auto.textContent, 'Auto (繁體中文)');
    assert.equal(fixture.select.lang, 'en');
    await fixture.choose('zh_TW');
    assert.equal(fixture.select.lang, 'zh-TW');
    assert.deepEqual(fixture.writes, [{ uiLocale: 'zh_TW' }]);
    assert.equal(fixture.cache.get('tsukeru.uiLocale'), 'zh_TW');
    assert.equal(fixture.reloads.length, 1, 'the storage echo must not cause another reload');
    assert.ok(fixture.reloads[0].endsWith('/popup.html#settings'));
    const automatic = await popup(browser);
    await automatic.choose('');
    assert.deepEqual(automatic.writes, [{ uiLocale: '' }]);
    assert.equal(automatic.select.lang, 'en');
    const external = await popup(browser);
    external.change('ko');
    await external.i18n.ready();
    assert.equal(external.cache.get('tsukeru.uiLocale'), 'ko');
    assert.equal(external.reloads.length, 1);
  });

  test(`${browser} a failed language save restores the old selection without reloading`, async () => {
    const fixture = await popup(browser, { failSave: true });
    await fixture.choose('ko');
    assert.equal(fixture.select.value, 'en');
    assert.equal(fixture.select.lang, 'en');
    assert.equal(fixture.select.disabled, false);
    assert.equal(fixture.cache.get('tsukeru.uiLocale'), 'en');
    assert.deepEqual(fixture.reloads, []);
    assert.deepEqual(fixture.notices, ['Could not save the display language. Please try again.']);
  });

  test(`${browser} background menu titles follow startup and changes; catalog routing stays internal`, async () => {
    const fixture = extension(browser, { preference: 'ko' });
    const updates = new Map();
    const listeners = {};
    const event = name => ({ addListener(fn) { (listeners[name] ||= []).push(fn); } });
    Object.assign(fixture.sandbox, {
      refreshWordBadge() {}, isWordsAction: () => false,
    });
    Object.assign(fixture.sandbox.chrome, {
      runtime: {
        ...fixture.sandbox.chrome.runtime, id: 'internal-id',
        onInstalled: event('install'), onStartup: event('startup'), onMessage: event('message'),
      },
      action: { onClicked: event('action') },
      tabs: { onActivated: event('tab') },
      commands: { onCommand: event('command') },
      contextMenus: {
        onClicked: event('menu'), create() {},
        update(id, properties, done) { updates.set(id, properties.title); done(); },
      },
    });
    vm.runInNewContext(read(browser, 'background.js').replace(/^import\s[\s\S]*?;\r?\n/gm, ''), fixture.sandbox);
    assert.equal(listeners.message.length, 1, 'routing is registered before loading completes');
    await fixture.i18n.ready();
    assert.equal(updates.get('applyFurigana'), fixture.catalogs.ko.contextMenuApplyFurigana.message);
    fixture.change('zh_TW');
    await fixture.i18n.ready();
    assert.equal(updates.get('clearFurigana'), fixture.catalogs.zh_TW.contextMenuClearFurigana.message);
    const handler = listeners.message[0];
    assert.equal(handler({ action: 'getUiCatalog' }, { id: 'other' }, () => assert.fail('external catalog response')), false);
    const response = await new Promise(resolve => {
      assert.equal(handler({ action: 'getUiCatalog' }, { id: 'internal-id' }, resolve), true);
    });
    assert.equal(response.success, true);
    assert.equal(response.catalog.messages.ui_lang, 'zh-TW');
    assert.equal(typeof response.catalog.messages.tab_settings, 'string');
    assert.equal(response.catalog.messages.tab_settings.description, undefined);
    const localizedCalls = [];
    fixture.sandbox.lookupLocalizedDefinition = async (...args) => { localizedCalls.push(args); return { source: 'je_localized_cache' }; };
    const payload = { action: 'lookupLocalizedDefinition', word: '本', reading: 'ほん', readingType: 'hiragana', uiLocale: 'ko', cacheOnly: true };
    for (const [change, sender] of [[{}, 'external'], [{ word: {} }, 'internal-id'],
      [{ word: 'a'.repeat(65) }, 'internal-id'], [{ reading: '\n' }, 'internal-id'],
      [{ uiLocale: 'fr' }, 'internal-id'], [{ cacheOnly: 'false' }, 'internal-id'],
      [{ readingType: 'other' }, 'internal-id']]) {
      const invalid = await new Promise(resolve => handler({ ...payload, ...change }, { id: sender }, resolve));
      assert.equal(invalid.success, false);
    }
    assert.equal(localizedCalls.length, 0);
    const localized = await new Promise(resolve => handler(payload, { id: 'internal-id' }, resolve));
    assert.equal(localized.success, true);
    assert.equal(localizedCalls.length, 1);
    assert.equal(localizedCalls[0][3], 'ko');
    assert.equal(localizedCalls[0][4].cacheOnly, true);

  });

  test(`${browser} popup waits for its catalog and reopens Settings after a language reload`, async () => {
    const catalog = deferred();
    const fixture = extension(browser, {
      preference: 'ko', fetchCatalog: (code, original) => code === 'ko' ? catalog.promise : original,
    });
    const root = { lang: 'en', pending: true, removeAttribute() { this.pending = false; } };
    const tabs = ['page', 'words', 'settings'].map(tab => ({
      dataset: { tab }, id: `${tab}-tab`, active: false,
      classList: { toggle(_name, active) { tabs.find(item => item.dataset.tab === tab).active = active; } },
      addEventListener() {},
    }));
    const links = Object.fromEntries(['header-ezfurigana-link', 'header-supporter-link', 'shortcut-text'].map(id => [id, {}]));
    links['header-review-link'] = { setAttribute() {} };
    const reviewPrompts = [];
    let bootstrap;
    let translated = false;
    Object.assign(fixture.sandbox, {
      document: {
        documentElement: root,
        getElementById: id => links[id] || { addEventListener() {}, setAttribute() {} },
        querySelectorAll: () => tabs,
        addEventListener(_type, handler) { bootstrap = handler; },
      },
      navigator: { userAgent: '', platform: 'Win32' },
      location: { hash: '#settings', pathname: '/popup.html' },
      history: { replaceState() {} },
      applyI18nToPopupDom() { translated = true; assert.equal(root.lang, 'ko'); },
      initLocaleSelect() {}, initThemeToggle() {}, closeReportModal() {},
      initSettingsForm() {}, initMyWordsTab() {}, initPageTab() {},
      loadMyWords() { assert.fail('Settings reload should not load My Words'); },
      requestPageWordsRefresh() { assert.fail('Settings reload should not open This page'); },
      storeReviewUrl: (store, language) => `${store}:${language}`,
      initReviewPrompt(options) { reviewPrompts.push(options); },
      t: fixture.i18n.t,
    });
    vm.runInNewContext(read(browser, 'js/popup-main.js').replace(/^import\s[\s\S]*?;\r?\n/gm, ''), fixture.sandbox);
    const pending = bootstrap();
    await settle();
    assert.equal(translated, false);
    assert.equal(root.pending, true);
    catalog.resolve(fixture.catalogs.ko);
    await pending;
    assert.equal(translated, true);
    assert.equal(root.pending, false);
    assert.equal(tabs.find(item => item.active).dataset.tab, 'settings');
    assert.equal(links['header-ezfurigana-link'].href, 'https://www.ezfurigana.com/ko');
    assert.equal(links['header-supporter-link'].href, 'https://www.ezfurigana.com/ko/pricing');
    const store = browser === 'firefox' ? 'firefox' : 'chrome';
    assert.equal(links['header-review-link'].href, `${store}:ko`);
    assert.deepEqual(reviewPrompts.map(options => ({ ...options })), [{ store, language: 'ko' }]);
  });
}
