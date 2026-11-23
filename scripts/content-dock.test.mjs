// The page dock sends selected text only as the server accepts it: Japanese,
// whitespace collapsed, at most 120 characters counted as the server counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function loadDock(browserName) {
  const source = readFileSync(new URL(`../${browserName}/js/content-dock.js`, import.meta.url), 'utf8');
  const sandbox = {};
  vm.runInNewContext(`${source}\nglobalThis.pageDockTextStatus = pageDockTextStatus;`, sandbox);
  return sandbox.pageDockTextStatus;
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} dock text is collapsed, Japanese, and capped at 120 characters`, () => {
    const status = loadDock(browserName);
    assert.deepEqual({ ...status('  今日は\n\tいい　天気。 ') }, { text: '今日は いい 天気。', status: 'ok', count: 10 });
    assert.equal(status('').status, 'empty');
    assert.equal(status(' \n ').status, 'empty');
    assert.equal(status('Hello there').status, 'not_japanese');
    assert.equal(status('あ'.repeat(120)).status, 'ok');
    assert.deepEqual({ ...status('あ'.repeat(121)) }, { text: 'あ'.repeat(121), status: 'too_long', count: 121 });
    // Characters outside the BMP count once, as Python's len() counts them.
    assert.equal(status(`${'𠮟'.repeat(60)}${'あ'.repeat(60)}`).status, 'ok');
    // Decomposed kana is sent composed (NFC), as the server reads it.
    assert.equal(status('が').text, 'が');
  });
}
