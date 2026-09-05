import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function loadPaginationHelper(browserName) {
  const fileUrl = new URL(`../${browserName}/js/popup-vocab.js`, import.meta.url);
  let source = readFileSync(fileUrl, 'utf8');
  source = source.replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/popup-settings\.js';/, '');
  source = source.replaceAll('export ', '');
  const sandbox = {};
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return sandbox.getVocabularyPage;
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} vocabulary pagination appends bounded slices and resets cleanly`, () => {
    const source = readFileSync(new URL(`../${browserName}/js/popup-vocab.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bvocabRenderedCount\b/);
    assert.match(source, /\bvocabularyRenderedCount\b/);
    const getVocabularyPage = loadPaginationHelper(browserName);
    const entries = Array.from({ length: 7 }, (_, index) => index);

    assert.deepEqual(getVocabularyPage(entries, 0, 3), [0, 1, 2]);
    assert.deepEqual(getVocabularyPage(entries, 3, 3), [3, 4, 5]);
    assert.deepEqual(getVocabularyPage(entries, 6, 3), [6]);
    assert.deepEqual(getVocabularyPage(entries, 0, 3), [0, 1, 2]);
    assert.deepEqual(getVocabularyPage(entries, 99, 3), []);
  });
}
