import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (browser, file) => readFileSync(new URL(`../${browser}/${file}`, import.meta.url), 'utf8');
const languageCases = [
  ['en', 'en', 'en'], ['ja', 'ja', 'ja'], ['ko-KR', 'ko', 'ko'], ['zh-TW', 'zh_TW', 'zh-TW'],
  ['zh-CN', 'en', 'en'], ['zh-HK', 'en', 'en'], ['fr', 'en', 'en'],
  ['fr', null, 'en'],
];

function i18n(browser, browserLanguage, locale) {
  // Chrome resolves the catalog; unsupported UI languages use the default English catalog.
  const catalog = locale ? JSON.parse(read(browser, `_locales/${locale}/messages.json`)) : {};
  return {
    getUILanguage: () => browserLanguage,
    getMessage: key => catalog[key]?.message || '',
  };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} popup language is available before styles even when the theme cache fails`, () => {
    for (const [browserLanguage, locale, expected] of languageCases) {
      const root = {};
      vm.runInNewContext(read(browser, 'js/popup-theme-init.js'), {
        document: { documentElement: root },
        chrome: { i18n: i18n(browser, browserLanguage, locale) },
        localStorage: { getItem() { assert.equal(root.lang, expected); throw new Error('cache unavailable'); } },
      });
      assert.equal(root.lang, expected);
    }
  });

  test(`${browser} injected UI follows the displayed catalog without changing the page language`, () => {
    for (const [browserLanguage, locale, expected] of languageCases) {
      const host = { lang: 'ja' };
      const sandbox = {
        chrome: { i18n: i18n(browser, browserLanguage, locale) },
        document: { documentElement: host },
      };
      vm.createContext(sandbox);
      loadI18n(sandbox, browser);
      vm.runInContext(read(browser, 'js/content-ui.js'), sandbox);
      const surface = { dataset: {}, removeAttribute() {}, isConnected: true };
      sandbox.applyTsukeruUiTheme(surface);
      assert.equal(surface.lang, expected);
      assert.equal(host.lang, 'ja');
    }
  });

  test(`${browser} Japanese font overrides require an explicit tag below the UI root`, () => {
    for (const [file, expected] of [
      ['popup.css', ['.locale-select:lang(ja)', 'body [lang="ja"]']],
      ['content.css', ['.tsukeru-word-tooltip [lang="ja"]', '.tsukeru-content-report-modal [lang="ja"]']],
    ]) {
      const css = read(browser, file).replace(/\/\*[\s\S]*?\*\//g, '');
      const selectors = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, selector, declarations]) => /lang[^{}]*ja/.test(selector) && /font-family:/.test(declarations))
        .flatMap(([, selector]) => selector.split(',').map(value => value.trim()));
      // Inherited :lang(ja) or an unscoped [lang="ja"] changes Japanese UI typography.
      assert.deepEqual(selectors, expected);
    }
  });

  test(`${browser} dictionary words, alternative readings, and example sentences retain their language`, () => {
    const node = () => ({ append() {}, appendChild() {} });
    const sandbox = {
      chrome: { i18n: { getMessage: () => '' } },
      document: { createElement: node, createDocumentFragment: node },
      escapeHtml: value => String(value),
      sanitizeHtmlFragment: value => value,
    };
    vm.createContext(sandbox);
    loadI18n(sandbox, browser);
    vm.runInContext(read(browser, 'js/content-tooltip.js'), sandbox);
    assert.match(sandbox.getTooltipLoadingHtml({ word: '漢字' }), /class="tooltip-word-label" lang="ja">漢字/);
    assert.match(sandbox.generateAltReadingsDropdown(['かんじ'], 1), /lang="ja">かんじ/);
    let children;
    sandbox.document.createElement = () => ({ append(...nodes) { children = nodes; }, appendChild() {} });
    sandbox.createExampleSentenceContent({ japanese_furigana_html: '漢字', english: 'kanji' });
    assert.equal(children[0].lang, 'ja');
    assert.equal(children[1].lang, 'en');
  });
}
