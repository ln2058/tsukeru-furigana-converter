import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

const tooltipFiles = [
  new URL('../chrome/js/content-tooltip.js', import.meta.url),
  new URL('../firefox/js/content-tooltip.js', import.meta.url),
];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createTooltip() {
  return {
    innerHTML: '',
    isConnected: true,
    classList: {
      add() {},
      remove() {},
      contains() { return true; },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function loadRenderer(tooltipUrl) {
  const sandbox = {
    chrome: { i18n: { getMessage() { return ''; } } },
    console,
    URL,
    escapeHtml,
    requestAnimationFrame() {},
    document: {
      createElement() {
        let text = '';
        return {
          set textContent(value) { text = String(value); },
          get innerHTML() { return escapeHtml(text); },
        };
      },
      getElementById() { return null; },
    },
    DICTIONARY_MAX_SENSES: 5,
  };

  vm.runInNewContext(readFileSync(tooltipUrl, 'utf8'), sandbox, {
    filename: tooltipUrl.pathname,
  });

  const tooltip = createTooltip();
  sandbox.dictionaryTooltip = tooltip;
  return { sandbox, tooltip };
}

for (const tooltipUrl of tooltipFiles) {
  const browserName = tooltipUrl.pathname.includes('/firefox/') ? 'Firefox' : 'Chrome';

  test(`${browserName} dictionary renderers retain supplied metadata in every state`, () => {
    const { sandbox, tooltip } = loadRenderer(tooltipUrl);
    const wordInfo = { word: '猫', reading: 'ねこ', jlpt: '3', pos: 'Noun, common' };
    const definition = { entries: [{ kana: ['ねこ'], senses: [{ glosses: ['cat'], pos: ['noun'] }] }] };

    const loadingHtml = sandbox.getTooltipLoadingHtml(wordInfo);
    sandbox.renderDefinitionTooltip(tooltip, wordInfo, definition);
    const successHtml = tooltip.innerHTML;
    sandbox.renderDefinitionTooltip(tooltip, wordInfo, { entries: [] });
    const noDefinitionHtml = tooltip.innerHTML;
    sandbox.renderDefinitionTooltip(tooltip, wordInfo, { error: true });
    const errorHtml = tooltip.innerHTML;

    for (const html of [loadingHtml, successHtml, noDefinitionHtml, errorHtml]) {
      assert.match(html, /data-jlpt="3"/);
      assert.match(html, />N3<\/span>/);
      assert.match(html, /tooltip-jlpt-badge/);
      assert.match(html, /tooltip-pos-badge/);
      assert.match(html, /tooltip-pos-noun/);
      assert.match(html, />Noun<\/span>/);
    }
    assert.match(loadingHtml, /tooltip-loading-spinner/);
    assert.match(successHtml, /tooltip-word-header/);
    assert.match(noDefinitionHtml, /No definition found/);
    assert.match(errorHtml, /Dictionary not available/);
  });

  test(`${browserName} dictionary renderers do not invent missing or invalid metadata`, () => {
    const { sandbox, tooltip } = loadRenderer(tooltipUrl);
    const missingInfo = { word: '水', reading: 'みず', jlpt: '', pos: '' };
    const invalidInfo = { word: '火', reading: 'ひ', jlpt: '9', pos: '' };
    const definition = { entries: [{ kana: ['みず'], senses: [{ glosses: ['water'], pos: [] }] }] };

    const states = [
      sandbox.getTooltipLoadingHtml(missingInfo),
      sandbox.getTooltipErrorHtml(missingInfo, 'No definition found'),
    ];
    sandbox.renderDefinitionTooltip(tooltip, missingInfo, definition);
    states.push(tooltip.innerHTML);
    sandbox.renderDefinitionTooltip(tooltip, invalidInfo, { entries: [] });
    states.push(tooltip.innerHTML);

    for (const html of states) {
      assert.doesNotMatch(html, /tooltip-jlpt-badge/);
      assert.doesNotMatch(html, /tooltip-pos-badge/);
      assert.doesNotMatch(html, />N[1-5]<\/span>/);
    }

    const unknownPosHtml = sandbox.getTooltipLoadingHtml({ word: '空', reading: 'そら', pos: 'Interjection' });
    assert.match(unknownPosHtml, /tooltip-pos-other/);
  });

  test(`${browserName} renders rich TKGJE definitions with safe source metadata`, () => {
    const { sandbox, tooltip } = loadRenderer(tooltipUrl);
    const rich = {
      source: 'je_dict',
      entry: {
        headword: '大人',
        reading: 'おとな',
        part_of_speech: 'noun',
        gloss: 'adult',
        definitions: [
          { sense_number: 1, gloss: 'adult', explanation: 'A grown person.' },
          { sense_number: 2, gloss: 'grown-up' },
        ],
        examples: [{ sense_numbers: [1], japanese_ruby_html: '<ruby>大人<rt>おとな</rt></ruby>', english: 'Adult.' }],
        source_url: 'https://www.tkgje.jp/entries/02500/02856_otona.html',
      },
    };
    const normalized = sandbox.normalizeDefinitionData(rich);
    assert.equal(normalized.source, 'je_dict');
    assert.equal(normalized.reading, 'おとな');
    assert.equal(normalized.headerPos, 'noun');
    assert.deepEqual(JSON.parse(JSON.stringify(normalized.senses.map(sense => sense.glosses[0]))), ['adult', 'grown-up']);
    assert.equal(normalized.senses[0].explanation, 'A grown person.');
    assert.equal(normalized.sourceUrl, rich.entry.source_url);

    sandbox.renderDefinitionTooltip(tooltip, { word: '大人', reading: '', jlpt: '3', pos: '' }, rich);
    assert.match(tooltip.innerHTML, /A grown person\./);
    assert.match(tooltip.innerHTML, /tooltip-pos-noun/);
    assert.match(tooltip.innerHTML, /TKGJE/);
    assert.doesNotMatch(tooltip.innerHTML, /tsukeru-example-container/);
  });

  test(`${browserName} rejects unsafe TKGJE source URLs and keeps attached example selection bounded`, () => {
    const { sandbox } = loadRenderer(tooltipUrl);
    for (const url of [
      'http://www.tkgje.jp/entries/02500/02856_otona.html',
      'https://evil.example/entries/02500/02856_otona.html',
      'https://www.tkgje.jp/entries/02500/02856_otona.html?next=https://evil.example',
      'https://user:pass@www.tkgje.jp/entries/02500/02856_otona.html',
      'https://www.tkgje.jp/index.html',
    ]) {
      assert.equal(sandbox.getSafeDictionarySourceUrl('je_dict', url), '');
    }
    const normalized = sandbox.normalizeDefinitionData({
      source: 'je_dict',
      entry: {
        reading: 'おとな',
        gloss: 'adult',
        definitions: [{ sense_number: 1, gloss: 'adult' }, { sense_number: 2, gloss: 'grown-up' }],
        examples: [
          { sense_numbers: [1], japanese_ruby_html: '<ruby>大人<rt>おとな</rt></ruby>', english: 'Adult.' },
          { sense_numbers: [1], japanese_ruby_html: '<ruby>別<rt>べつ</rt></ruby>', english: 'Duplicate sense.' },
          { japanese: '大人です', english: 'No sense number.' },
        ],
      },
    });
    assert.equal(normalized.senses.filter(sense => sense.example).length, 2);
    assert.equal(normalized.senses[0].example.english, 'Adult.');
    assert.equal(normalized.senses[1].example.english, 'No sense number.');
  });

  test(`${browserName} falls back to the additive entries projection when the rich entry is empty`, () => {
    const { sandbox, tooltip } = loadRenderer(tooltipUrl);
    const data = {
      source: 'je_dict',
      entry: { headword: '猫', reading: 'ねこ', definitions: [] },
      entries: [{ kana: ['ねこ'], senses: [{ glosses: ['cat'], pos: ['noun'] }] }],
    };
    const normalized = sandbox.normalizeDefinitionData(data);
    assert.equal(normalized.source, 'jmdict');
    assert.deepEqual(JSON.parse(JSON.stringify(normalized.senses[0].glosses)), ['cat']);
    sandbox.renderDefinitionTooltip(tooltip, { word: '猫', reading: 'ねこ', jlpt: '', pos: '' }, data);
    assert.match(tooltip.innerHTML, />cat</);
    assert.doesNotMatch(tooltip.innerHTML, />TKGJE</);
  });
}
