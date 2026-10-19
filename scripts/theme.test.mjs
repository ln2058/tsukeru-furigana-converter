import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (browser, path) => readFileSync(new URL(`../${browser}/${path}`, import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function declarations(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing selector: ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open)).split(';')
    .map(value => value.trim()).filter(Boolean).sort();
}

function fakeSurface() {
  return {
    dataset: {},
    isConnected: true,
    removeAttribute(name) {
      assert.equal(name, 'data-tsukeru-theme');
      delete this.dataset.tsukeruTheme;
    },
  };
}

function popupHarness(browser, { systemDark = false, cached = null, get } = {}) {
  const cache = new Map(cached ? [['tsukeru.uiTheme', cached]] : []);
  const root = { dataset: {}, removeAttribute: () => { delete root.dataset.theme; } };
  const attributes = {};
  const events = {};
  const storageListeners = new Set();
  const writes = [];
  const button = {
    title: '',
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (event, handler) => { events[event] = handler; },
  };
  let systemChange;
  const media = {
    matches: systemDark,
    addEventListener: (event, handler) => { systemChange = handler; },
  };
  const sandbox = vm.createContext({
    console,
    document: { documentElement: root, getElementById: () => button },
    window: { matchMedia: () => media, addEventListener: () => {} },
    localStorage: {
      getItem: key => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
      removeItem: key => cache.delete(key),
    },
    chrome: {
      i18n: { getMessage: () => '' },
      storage: {
        sync: {
          get: get || (() => Promise.resolve({ uiTheme: cached })),
          set: async value => {
            writes.push(value.uiTheme);
            for (const listener of storageListeners) {
              listener({ uiTheme: { newValue: value.uiTheme } }, 'sync');
            }
          },
        },
        onChanged: {
          addListener: listener => storageListeners.add(listener),
          removeListener: listener => storageListeners.delete(listener),
        },
      },
    },
  });
  loadI18n(sandbox, browser);
  vm.runInContext(read(browser, 'js/popup-theme-init.js'), sandbox);
  vm.runInContext(read(browser, 'js/popup-settings.js')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '')
    .replaceAll('export ', ''), sandbox);
  sandbox.initThemeToggle();
  return {
    root, cache, writes, attributes,
    click: () => events.click(),
    systemChange(dark) { media.matches = dark; systemChange(); },
    storedChange(value) {
      for (const listener of storageListeners) listener({ uiTheme: { newValue: value } }, 'sync');
    },
  };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} manual and system dark palettes stay identical, including native controls and badges`, () => {
    const popup = read(browser, 'popup.css');
    const system = declarations(popup, ':root:not([data-theme="light"])');
    assert.deepEqual(declarations(popup, ':root[data-theme="dark"]'), system);
    assert.ok(system.includes('color-scheme: dark'));
    const content = read(browser, 'content.css');
    const injectedSystem = declarations(content, '.tsukeru-toast:not([data-tsukeru-theme="light"])');
    assert.deepEqual(declarations(content, '.tsukeru-toast[data-tsukeru-theme="dark"]'), injectedSystem);
    assert.ok(injectedSystem.includes('color-scheme: dark !important'));
    assert.ok(injectedSystem.some(value => value.startsWith('--tsukeru-group-n1:')));
    assert.ok(declarations(content, '.tsukeru-toast').some(value => value.startsWith('--tsukeru-group-n1:')));
    assert.doesNotMatch(content, /:root[^\n{]*data-tsukeru-theme/);
  });

  test(`${browser} a cached choice is applied synchronously before the stylesheet`, () => {
    const html = read(browser, 'popup.html');
    assert.ok(html.indexOf('src="js/popup-theme-init.js"') < html.indexOf('rel="stylesheet"'));
    assert.match(html, /<script src="js\/popup-theme-init\.js"><\/script>/);
    const script = read(browser, 'js/popup-theme-init.js');
    for (const choice of ['light', 'dark', 'invalid', null]) {
      const root = { dataset: {} };
      vm.runInNewContext(script, {
        document: { documentElement: root },
        localStorage: { getItem: () => choice },
      });
      assert.equal(root.dataset.theme, choice === 'light' || choice === 'dark' ? choice : undefined);
    }
    assert.doesNotThrow(() => vm.runInNewContext(script, {
      document: { documentElement: { dataset: {} } },
      localStorage: { getItem: () => { throw new Error('unavailable'); } },
    }));
  });

  test(`${browser} system changes apply until a click, which persists and updates the accessible label`, async () => {
    const popup = popupHarness(browser);
    await settle();
    assert.equal(popup.attributes['aria-label'], 'Switch to dark mode');
    popup.systemChange(true);
    assert.equal(popup.root.dataset.theme, undefined);
    assert.equal(popup.attributes['aria-label'], 'Switch to light mode');
    popup.click();
    assert.equal(popup.root.dataset.theme, 'light');
    assert.equal(popup.cache.get('tsukeru.uiTheme'), 'light');
    assert.equal(popup.attributes['aria-label'], 'Switch to dark mode');
    popup.systemChange(false);
    popup.systemChange(true);
    assert.equal(popup.root.dataset.theme, 'light');
    await settle();
    assert.deepEqual(popup.writes, ['light']);
    popup.storedChange(undefined);
    assert.equal(popup.root.dataset.theme, undefined);
    assert.equal(popup.cache.has('tsukeru.uiTheme'), false);
    assert.equal(popup.attributes['aria-label'], 'Switch to light mode');
  });

  test(`${browser} cached overrides survive opposite system colours and rapid clicks beat an older read`, async () => {
    for (const cached of ['light', 'dark']) {
      let resolveRead;
      const popup = popupHarness(browser, {
        cached, systemDark: cached === 'light',
        get: () => new Promise(resolve => { resolveRead = resolve; }),
      });
      assert.equal(popup.root.dataset.theme, cached);
      popup.click();
      popup.click();
      popup.click();
      const finalTheme = cached === 'light' ? 'dark' : 'light';
      resolveRead({ uiTheme: cached });
      await settle();
      assert.equal(popup.root.dataset.theme, finalTheme);
      assert.equal(popup.cache.get('tsukeru.uiTheme'), finalTheme);
      assert.equal(popup.writes.length, 3);
      assert.equal(popup.writes.at(-1), finalTheme);
    }
  });

  test(`${browser} content theme changes update only registered surfaces and discard disconnected references`, async () => {
    let resolveRead;
    let changed;
    const hostRoot = { dataset: { theme: 'host-theme' } };
    const sandbox = vm.createContext({
      console,
      document: { documentElement: hostRoot },
      chrome: { storage: {
        sync: { get: () => new Promise(resolve => { resolveRead = resolve; }) },
        onChanged: { addListener: listener => { changed = listener; } },
      } },
    });
    loadI18n(sandbox, browser);
    vm.runInContext(read(browser, 'js/content-ui.js'), sandbox);
    const tooltip = fakeSurface();
    const report = fakeSurface();
    const toast = fakeSurface();
    for (const surface of [tooltip, report, toast]) sandbox.applyTsukeruUiTheme(surface);
    changed({ uiTheme: { newValue: 'dark' } }, 'sync');
    resolveRead({ uiTheme: 'light' });
    await settle();
    for (const surface of [tooltip, report, toast]) assert.equal(surface.dataset.tsukeruTheme, 'dark');
    changed({ uiTheme: { newValue: 'light' } }, 'sync');
    for (const surface of [tooltip, report, toast]) assert.equal(surface.dataset.tsukeruTheme, 'light');
    toast.isConnected = false;
    changed({ uiTheme: { newValue: 'invalid' } }, 'sync');
    assert.equal(tooltip.dataset.tsukeruTheme, undefined);
    assert.equal(report.dataset.tsukeruTheme, undefined);
    assert.equal(vm.runInContext('tsukeruUiThemeSurfaces.size', sandbox), 2);
    assert.deepEqual(hostRoot.dataset, { theme: 'host-theme' });
  });
}
