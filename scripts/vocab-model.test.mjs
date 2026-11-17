import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

// The cases EZFurigana's static/js/vocab-model.js passes; both copies must give the same answers.
const cases = JSON.parse(readFileSync(new URL('./fixtures/vocab_model_cases.json', import.meta.url), 'utf8'));
const near = (actual, expected, tolerance = 1e-6) => Math.abs(actual - expected) <= tolerance;

function loadModel(browserName) {
  const sandbox = {};
  const fileUrl = new URL(`../${browserName}/js/vocab-model.js`, import.meta.url);
  vm.runInNewContext(readFileSync(fileUrl, 'utf8'), sandbox, { filename: fileUrl.pathname });
  return sandbox.TsukeruVocab;
}

test('both browser copies of the model are the same file', () => {
  const chrome = readFileSync(new URL('../chrome/js/vocab-model.js', import.meta.url), 'utf8');
  const firefox = readFileSync(new URL('../firefox/js/vocab-model.js', import.meta.url), 'utf8');
  assert.equal(chrome, firefox);
});

for (const browserName of ['chrome', 'firefox']) {
  const Vocab = loadModel(browserName);

  test(`${browserName} gives EZFurigana's answers for the shared cases`, () => {
    cases.difficulty.forEach(({ band, jlpt, expected }) => {
      const actual = Vocab.wordDifficulty(band, jlpt);
      assert.ok(expected === null ? actual === null : near(actual, expected), `${band}/${jlpt}`);
    });
    cases.ability.forEach(({ name, level, n, k, expected }) => {
      assert.ok(near(Vocab.fitAbility({ n, k }, level), expected, 1e-3), name);
    });
    cases.coverage.forEach(({ name, ability, words, expected }) => {
      assert.equal(Vocab.textCoverage(words, ability), expected, name);
    });
    cases.stretches.forEach(({ name, units, lookups, options, expected }) => {
      assert.deepEqual([...Vocab.readStretches(units, lookups, options)].sort((a, b) => a - b), expected, name);
    });
    cases.sizes.forEach(({ level, expected }) => {
      assert.equal(Vocab.vocabularySize(Vocab.levelAbility(level)), expected, level);
    });
    cases.shares.forEach(({ level, expected }) => {
      const shares = Vocab.levelShares(Vocab.levelAbility(level), new Map(), null);
      Object.entries(expected).forEach(([jlpt, share]) => assert.ok(near(shares.get(Number(jlpt)), share, 1e-5), `${level} N${jlpt}`));
    });
  });
}
