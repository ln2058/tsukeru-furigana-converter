// Purpose: My Words' review strip names the words one EZFurigana session asks about, not the whole backlog.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function loadStrip(browserName) {
  const fileUrl = new URL(`../${browserName}/js/popup-vocab.js`, import.meta.url);
  let source = readFileSync(fileUrl, 'utf8');
  source = source.replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/popup-settings\.js';/, '');
  source = source.replaceAll('export ', '');
  const elements = {};
  const element = (id) => (elements[id] ||= { textContent: '', hidden: false, dataset: {} });
  const sandbox = {
    document: { getElementById: element },
    t: (key, substitutions, fallback) => fallback,
    TsukeruWords: { SESSION_WORDS: 7 },
    TsukeruI18n: { language: () => 'en', websiteUrl: () => 'https://www.ezfurigana.com' },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return { renderStrip: sandbox.renderStrip, elements };
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} the review strip counts one session's words`, () => {
    const { renderStrip, elements } = loadStrip(browserName);
    renderStrip({ due: 30, learning: 40, known: 5 });
    assert.equal(elements.wordReviewStripTitle.textContent, '7 words to review');
    renderStrip({ due: 3, learning: 40, known: 5 });
    assert.equal(elements.wordReviewStripTitle.textContent, '3 words to review');
  });
}
