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
}
