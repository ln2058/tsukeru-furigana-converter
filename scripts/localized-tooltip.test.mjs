import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class Element {
  constructor(tag = 'div', text = '') {
    this.tagName = tag;
    this.children = [];
    this.text = text;
    this.dataset = {};
    this.events = {};
    this.classList = { contains: () => true, add() {} };
  }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...children) {
    for (const child of children) {
      if (child.tagName === 'fragment') this.append(...child.children);
      else { child.parent = this; this.children.push(child); }
    }
  }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute() {}
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelector(selector) {
    return this.children.find(child => `.${child.className}` === selector)
      || this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
  }
}

function fixture(browser, language = 'ko') {
  const requests = [];
  const renders = [];
  const tooltip = new Element();
  tooltip._lookupVersion = 1;
  tooltip.dataset.word = '本';
  const sandbox = {
    console, URL, requestAnimationFrame() {},
    TsukeruI18n: { language: () => language, t: (_key, _subs, fallback) => fallback },
    chrome: { runtime: { sendMessage(message, callback) { requests.push({ message, callback }); } } },
    document: {
      createElement: tag => new Element(tag),
      createTextNode: text => new Element('text', text),
      createDocumentFragment: () => new Element('fragment'),
    },
  };
  vm.createContext(sandbox);
  for (const file of ['ui-messages.js', 'content-tooltip.js']) {
    vm.runInContext(readFileSync(new URL(`../${browser}/js/${file}`, import.meta.url), 'utf8'), sandbox);
  }
  sandbox.renderDefinitionTooltip = (_tooltip, _word, data) => { renders.push(data); tooltip.replaceChildren(); };
  sandbox.bindTooltipProgress = () => {};
  const english = { source: 'je_dict', entry: { gloss: 'book' } };
  const translated = { source: 'je_localized_cache', locale: language === 'zh-TW' ? 'zh-Hant' : language, entry: { gloss: '번역' } };
  return { sandbox, tooltip, requests, renders, english, translated,
    start() { sandbox.startLocalizedTooltip(tooltip, { word: '本', lookupReading: 'ほん' }, english, Promise.resolve({}), 1); },
    button() { return tooltip.querySelector('.tsukeru-translation-button'); },
  };
}

const tick = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
const click = isTrusted => ({ isTrusted, stopPropagation() {} });

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} shows English first, checks cache, and requires a trusted click for generation`, async () => {
    const f = fixture(browser);
    f.start();
    assert.equal(f.renders.length, 0);
    assert.equal(f.requests[0].message.cacheOnly, true);
    assert.equal(f.button(), null, 'no controls until the cache check answers');
    f.requests[0].callback({ success: true, data: { reason: 'not_cached' } });
    await tick();
    assert.equal(f.button().disabled, false);
    f.button().events.click(click(false));
    assert.equal(f.requests.length, 1);
    f.button().events.click(click(true));
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].message.cacheOnly, false);
    assert.equal(f.button().disabled, true);
    f.button().events.click(click(true));
    assert.equal(f.requests.length, 2);
    f.requests[1].callback({ success: true, data: f.translated });
    await tick();
    assert.equal(f.renders[0], f.translated);
    assert.match(f.tooltip.textContent, /AI translation/);
    f.button().events.click(click(true));
    assert.equal(f.renders[1], f.english);
    f.button().events.click(click(true));
    assert.equal(f.renders[2], f.translated);
    assert.equal(f.requests.length, 2, 'switching between already loaded entries stays local');
  });

  test(`${browser} cached translations appear automatically; stale and English lookups do not generate`, async () => {
    const f = fixture(browser, 'zh-TW');
    f.start();
    f.requests[0].callback({ success: true, data: f.translated });
    await tick();
    assert.equal(f.renders[0], f.translated);
    const stale = fixture(browser);
    stale.start();
    stale.tooltip._lookupVersion += 1;
    stale.requests[0].callback({ success: true, data: stale.translated });
    await tick();
    assert.equal(stale.renders.length, 0);
    const english = fixture(browser, 'en');
    english.start();
    assert.equal(english.requests.length, 0);
  });

  test(`${browser} limit notes preserve English without automatic retries`, async () => {
    const f = fixture(browser);
    f.start();
    f.requests[0].callback({ success: true, data: { reason: 'rate_limited' } });
    await tick();
    assert.doesNotMatch(f.tooltip.textContent, /Translation limit reached/, 'the passive check stays silent');
    f.button().events.click(click(true));
    f.requests[1].callback({ success: true, data: { reason: 'budget_exhausted' } });
    await tick();
    assert.match(f.tooltip.textContent, /Translation limit reached/);
    assert.equal(f.renders.length, 0);
    assert.equal(f.requests.length, 2);
  });

  test(`${browser} a disabled feature or missing route leaves the English tooltip unchanged`, async () => {
    for (const reply of [{ success: true, data: { reason: 'disabled' } }, { success: false }]) {
      const f = fixture(browser, 'ja');
      f.start();
      f.requests[0].callback(reply);
      await tick();
      assert.equal(f.button(), null);
      assert.doesNotMatch(f.tooltip.textContent, /Translation unavailable/);
      assert.equal(f.requests.length, 1);
    }
    const f = fixture(browser);
    f.start();
    f.requests[0].callback({ success: true, data: { reason: 'not_cached' } });
    await tick();
    f.button().events.click(click(true));
    f.requests[1].callback({ success: false });
    await tick();
    assert.match(f.tooltip.textContent, /Translation unavailable/, 'a failed click explains itself');
    f.button().events.click(click(true));
    f.requests[2].callback({ success: true, data: { reason: 'disabled' } });
    await tick();
    assert.equal(f.button(), null, 'switching the feature off removes the controls');
  });

  test(`${browser} ruby parser creates only text and ruby nodes and preserves malformed braces`, () => {
    const { sandbox } = fixture(browser);
    const element = new Element();
    sandbox.appendDictionaryRubyText(element, 'a{漢字|かんじ}b <img src=x onerror=bad> {bad|two|pipes} {outer{字|じ}} {unclosed');
    const ruby = element.children.find(child => child.tagName === 'ruby');
    assert.equal(ruby.lang, 'ja');
    assert.equal(ruby.children[0].textContent, '漢字');
    assert.equal(ruby.children[1].tagName, 'rt');
    assert.equal(ruby.children[1].textContent, 'かんじ');
    assert.equal(element.children.filter(child => child.tagName === 'ruby').length, 1);
    assert.match(element.textContent, /<img src=x onerror=bad>/);
    assert.match(element.textContent, /\{bad\|two\|pipes\}/);
    assert.match(element.textContent, /\{outer\{字\|じ\}\}/);
    assert.match(element.textContent, /\{unclosed$/);
    assert.equal(element.children.some(child => child.tagName === 'img'), false);
  });

  test(`${browser} localized normalization retains translated examples and Japanese-only examples`, () => {
    const { sandbox } = fixture(browser);
    for (const [locale, expected] of [['ja', 'ja'], ['ko', 'ko'], ['zh-Hant', 'zh-TW']]) {
      const entry = { gloss: 'meaning', definitions: [], reading: 'ほん',
        examples: [{ japanese: '本です。', ...(locale !== 'ja' && { english: 'book', translation: 'translated example' }) }] };
      const normalized = sandbox.normalizeDefinitionData({ source: 'je_localized_cache', locale, entry });
      assert.equal(normalized.definitionLang, expected);
      assert.equal(normalized.senses[0].example.japanese.text, '本です。');
      if (locale !== 'ja') {
        assert.equal(normalized.senses[0].example.english, 'translated example');
        assert.equal(normalized.senses[0].example.translationLang, expected);
      }
    }
  });
}
