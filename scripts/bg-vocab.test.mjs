import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

const withoutModules = (source) => source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');
const read = (browser, file) => readFileSync(new URL(`../${browser}/${file}`, import.meta.url), 'utf8');
const zeros = () => new Array(22).fill(0);

function loadVocab(browser) {
  const stored = {};
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    Uint8Array,
    chrome: {
      runtime: { id: 'extension-id' },
      storage: { local: {
        async get(key) { return key in stored ? { [key]: structuredClone(stored[key]) } : {}; },
        async set(values) { Object.assign(stored, structuredClone(values)); },
      } },
    },
  };
  vm.runInNewContext(read(browser, 'js/vocab-model.js'), sandbox);
  vm.runInNewContext(withoutModules(read(browser, 'js/bg-vocab.js')), sandbox);
  return { sandbox, stored };
}

const popup = { id: 'extension-id' };
const page = { id: 'extension-id', tab: { id: 3 } };

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} page evidence is kept as counts per difficulty, and invalid bins are dropped`, async () => {
    const { sandbox, stored } = loadVocab(browser);
    const before = await sandbox.handleVocabMessage({ action: 'vocabGet' }, popup);
    assert.equal(before.ask, true);
    assert.equal(before.ready, false);
    const read = [...new Array(40).fill(5), 99, -1, 2.5, 'x'];
    assert.equal((await sandbox.handleVocabMessage({ action: 'vocabEvidence', read, looked: [9] }, page)).success, true);
    const [entry] = Object.values(stored.vocabEstimate.devices);
    assert.equal(entry.n[5], 40);
    assert.equal(entry.n[9], 1);
    assert.equal(entry.k[9], 1);
    assert.equal(entry.n.reduce((sum, value) => sum + value, 0), 41);
    const after = await sandbox.handleVocabMessage({ action: 'vocabGet' }, popup);
    assert.equal(after.ready, true);
    assert.ok(after.ability > before.ability, 'words read without a lookup raise the estimate');
  });

  test(`${browser} only the popup sets the level, and only this extension sends evidence`, async () => {
    const { sandbox, stored } = loadVocab(browser);
    assert.equal((await sandbox.handleVocabMessage({ action: 'vocabSetLevel', level: 'n2' }, page)).success, false);
    assert.equal((await sandbox.handleVocabMessage({ action: 'vocabSetLevel', level: 'n9' }, popup)).success, false);
    assert.equal((await sandbox.handleVocabMessage({ action: 'vocabEvidence', read: [3] }, { id: 'other', tab: { id: 1 } })).success, false);
    assert.equal(stored.vocabEstimate, undefined);
    const chosen = await sandbox.handleVocabMessage({ action: 'vocabSetLevel', level: 'n2' }, popup);
    assert.equal(chosen.level, 'n2');
    assert.equal(chosen.ask, false);
    assert.equal((await sandbox.handleVocabMessage({ action: 'vocabSetLevel', level: 'skipped' }, popup)).level, null);
  });

  test(`${browser} sync keeps the level chosen last and each browser's newest evidence`, async () => {
    const { sandbox } = loadVocab(browser);
    await sandbox.handleVocabMessage({ action: 'vocabSetLevel', level: 'n3' }, popup);
    const mine = await sandbox.syncPart();
    const counts = zeros();
    counts[4] = 12;
    await sandbox.applySyncPart({
      level: { value: 'n5', at: 1 },
      vocab: {
        websiteBrowser1: { at: 10, n: counts, k: zeros() },
        'bad id!': { at: 10, n: counts, k: zeros() },
        shortCounts: { at: 10, n: [1], k: [0] },
      },
    });
    let part = await sandbox.syncPart();
    assert.deepEqual(part.level, mine.level, 'an older level does not replace the one chosen here');
    assert.deepEqual(Object.keys(part.vocab), ['websiteBrowser1']);
    await sandbox.applySyncPart({
      level: { value: 'n1', at: mine.level.at + 1 },
      vocab: { websiteBrowser1: { at: 5, n: zeros(), k: zeros() } },
    });
    part = await sandbox.syncPart();
    assert.equal(part.level.value, 'n1');
    assert.equal(part.vocab.websiteBrowser1.n[4], 12, 'older evidence does not replace newer');
  });
}
