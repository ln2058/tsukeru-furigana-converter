import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Katakana and romaji furigana change the shown reading only: word audio, the
// browser voice, and saved sentence readings still use kana.

const read = (browser, path) => readFileSync(new URL(`../${browser}/${path}`, import.meta.url), 'utf8');

function node() {
  return { value: '', innerHTML: '', isConnected: true, dataset: {}, classList: { add() {}, remove() {}, contains() { return true; } } };
}

function tooltipHarness(browser, audioResponse = { success: false }) {
  const tooltip = Object.assign(node(), {
    _activeRuby: {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const requests = [];
  const spoken = [];
  const sandbox = {
    console, URL, dictionaryTooltip: tooltip, DICTIONARY_MAX_SENSES: 5,
    chrome: {
      i18n: { getMessage() { return ''; } },
      runtime: { sendMessage(message, reply) { requests.push(JSON.parse(JSON.stringify(message))); reply?.(audioResponse); } },
    },
    applyTsukeruUiTheme() {}, requestAnimationFrame() {},
    document: {
      getElementById() { return null; },
      // escapeHtml reads text back through innerHTML, as browsers serialize text nodes.
      createElement() {
        const element = node();
        Object.defineProperty(element, 'innerHTML', {
          get() { return String(this.textContent || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); },
          set() {},
        });
        return element;
      },
      body: { appendChild() {} },
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  };
  sandbox.window = { speechSynthesis: { cancel() {}, speak(utterance) { spoken.push(utterance.text); } } };
  vm.createContext(sandbox);
  const dom = read(browser, 'js/content-dom.js');
  const start = dom.indexOf('function escapeHtml(text)');
  vm.runInContext(dom.slice(start, dom.indexOf('\nfunction escapeRegex', start)), sandbox);
  loadI18n(sandbox, browser);
  vm.runInContext(read(browser, 'js/content-tooltip.js'), sandbox);
  return { sandbox, tooltip, requests, spoken };
}

const definition = { entries: [{ kana: ['たべる'], senses: [{ glosses: ['to eat'], pos: ['verb'] }] }] };
const speakerReading = html => /tsukeru-tooltip-speaker"[^>]*?data-reading="([^"]*)"/.exec(html)?.[1];
const reportReading = html => /tsukeru-tooltip-report-btn"[^>]*?data-reading="([^"]*)"/.exec(html)?.[1];

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} word audio asks for the hiragana lookup reading under romaji and katakana furigana`, () => {
    for (const reading of ['taberu', 'タベル', 'たべる']) {
      const { sandbox, tooltip } = tooltipHarness(browser);
      sandbox.renderDefinitionTooltip(tooltip, { word: '食べる', reading, lookupReading: 'たべる', altReadings: [] }, definition);
      assert.equal(speakerReading(tooltip.innerHTML), 'たべる', reading);
      // The reading row and the report still show the reading the reader sees.
      assert.equal(reportReading(tooltip.innerHTML), reading);
    }
  });

  test(`${browser} word audio keeps the shown reading when the page gives no lookup reading`, () => {
    const { sandbox, tooltip } = tooltipHarness(browser);
    sandbox.renderDefinitionTooltip(tooltip, { word: '猫', reading: 'ねこ', altReadings: [] }, definition);
    assert.equal(speakerReading(tooltip.innerHTML), 'ねこ');
  });

  test(`${browser} the browser voice reads the kana reading, or the word without one`, () => {
    const { sandbox, requests, spoken } = tooltipHarness(browser);
    sandbox.speakWord('食べる', 'たべる', null);
    sandbox.speakWord('食べる', 'taberu', null);
    sandbox.speakWord('食べる', '', null);
    assert.deepEqual(spoken, ['たべる', '食べる', '食べる']);
    assert.deepEqual(requests.map(({ reading }) => reading), ['たべる', 'taberu', '']);
  });

  test(`${browser} sentence readings are hiragana whatever the furigana type`, () => {
    const { sandbox } = tooltipHarness(browser);
    const reading = info => sandbox.sentenceKanaReading(info);
    // Hiragana and katakana furigana: the shown surface reading, in hiragana.
    assert.equal(reading({ surface: '食べました', dictForm: '食べる', surfaceReading: 'たべました', lookupReading: 'たべる' }), 'たべました');
    assert.equal(reading({ surface: '食べました', dictForm: '食べる', surfaceReading: 'タベマシタ', lookupReading: 'たべる' }), 'たべました');
    assert.equal(reading({ surface: '珈琲', dictForm: '珈琲', surfaceReading: 'コーヒー', lookupReading: 'こーひー' }), 'こーひー');
    // Romaji: an uninflected word's lookup reading is its surface reading.
    assert.equal(reading({ surface: '猫', dictForm: '猫', surfaceReading: 'neko', lookupReading: 'ねこ' }), 'ねこ');
    // An inflected word has no kana surface reading on the page, so no span.
    assert.equal(reading({ surface: '食べました', dictForm: '食べる', surfaceReading: 'tabemashita', lookupReading: 'たべる' }), '');
    // Older output without a lookup reading falls back to the romaji reading: no span.
    assert.equal(reading({ surface: '猫', dictForm: '猫', surfaceReading: 'neko', lookupReading: 'neko' }), '');
    assert.equal(reading({ surface: '猫', dictForm: '猫', surfaceReading: '', lookupReading: '' }), '');
  });
}
