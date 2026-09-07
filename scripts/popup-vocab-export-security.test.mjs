import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function loadVocabularyHelpers(browserName) {
  const fileUrl = new URL(`../${browserName}/js/popup-vocab.js`, import.meta.url);
  let source = readFileSync(fileUrl, 'utf8');
  source = source.replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/popup-settings\.js';/, '');
  source = source.replaceAll('export ', '');
  const sandbox = {};
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return sandbox;
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} neutralizes formula-like CSV cells after leading whitespace`, () => {
    const { neutralizeCsvFormulaCell } = loadVocabularyHelpers(browserName);

    for (const prefix of ['=', '+', '-', '@']) {
      assert.equal(neutralizeCsvFormulaCell(`${prefix}SUM(A1:A2)`), `'${prefix}SUM(A1:A2)`);
      assert.equal(neutralizeCsvFormulaCell(` \t${prefix}SUM(A1:A2)`), `' \t${prefix}SUM(A1:A2)`);
    }
    assert.equal(neutralizeCsvFormulaCell('normal text'), 'normal text');
  });
}
