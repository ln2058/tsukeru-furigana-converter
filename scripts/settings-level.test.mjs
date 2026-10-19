import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function fakeRoot() {
  const attributes = {};
  return {
    attributes,
    setAttribute: (name, value) => { attributes[name] = String(value); },
    removeAttribute: (name) => { delete attributes[name]; },
  };
}

function loadContentDom(browserName) {
  const fileUrl = new URL(`../${browserName}/js/content-dom.js`, import.meta.url);
  const root = fakeRoot();
  const sandbox = { console, document: { documentElement: root } };
  vm.runInNewContext(readFileSync(fileUrl, 'utf8'), sandbox, { filename: fileUrl.pathname });
  return { sandbox, root };
}

function loadPopupSettings(browserName) {
  const fileUrl = new URL(`../${browserName}/js/popup-settings.js`, import.meta.url);
  const source = readFileSync(fileUrl, 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '')
    .replaceAll('export ', '');
  const sandbox = { console, chrome: { i18n: { getMessage: () => '' } } };
  loadI18n(sandbox, browserName);
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return sandbox;
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} the page level filter covers Beyond N1 and school grades`, () => {
    const { sandbox, root } = loadContentDom(browserName);

    sandbox.setLevelFilter({ levelSystem: 'jlpt', jlptLevel: 6 });
    assert.equal(root.attributes['data-tsukeru-jlpt'], '6');

    sandbox.setLevelFilter({ levelSystem: 'grade', jlptLevel: 6, gradeLevel: 3 });
    assert.equal(root.attributes['data-tsukeru-jlpt'], '5', 'grade mode does not also filter by JLPT');
    assert.equal(root.attributes['data-tsukeru-grade'], '3');

    sandbox.setLevelFilter({ levelSystem: 'jlpt', jlptLevel: 2 });
    assert.equal(root.attributes['data-tsukeru-jlpt'], '2');
    assert.equal(root.attributes['data-tsukeru-grade'], undefined, 'leaving grade mode drops the grade filter');

    // Settings saved before levels existed carry only jlptLevel.
    sandbox.setLevelFilter({ jlptLevel: 5 });
    assert.equal(root.attributes['data-tsukeru-jlpt'], '5');
    sandbox.setLevelFilter({ jlptLevel: 9 });
    assert.equal(root.attributes['data-tsukeru-jlpt'], '5');
  });

  test(`${browserName} content.css hides readings below each school grade`, () => {
    const css = readFileSync(new URL(`../${browserName}/content.css`, import.meta.url), 'utf8');
    for (let grade = 2; grade <= 8; grade += 1) {
      const rule = css.split('\n').find((line) => line.startsWith(`:root[data-tsukeru-grade="${grade}"]`));
      assert.ok(rule, `rule for grade ${grade}`);
      assert.ok(rule.includes(`[data-grade="${grade - 1}"]`), `grade ${grade} hides grade ${grade - 1}`);
      assert.ok(!rule.includes(`[data-grade="${grade}"]`), `grade ${grade} keeps its own readings`);
    }
  });

  test(`${browserName} the popup reads old and invalid level settings safely`, () => {
    const sandbox = loadPopupSettings(browserName);
    const plain = (value) => JSON.parse(JSON.stringify(value));

    assert.deepEqual(plain(sandbox.normalizeLevel({ jlptLevel: 5 })), { levelSystem: 'jlpt', jlptLevel: 5, gradeLevel: 4 });
    assert.deepEqual(plain(sandbox.normalizeLevel({ levelSystem: 'grade', gradeLevel: 1, jlptLevel: 0 })), { levelSystem: 'grade', jlptLevel: 5, gradeLevel: 4 });
    assert.equal(sandbox.describeLevel(sandbox.normalizeLevel({ jlptLevel: 3 })), 'Furigana on words in N3, N2, N1 and words outside the JLPT lists.');
    assert.equal(
      sandbox.describeLevel({ levelSystem: 'grade', jlptLevel: 5, gradeLevel: 3 }),
      'Furigana on kanji from Gr. 3 up, plus special readings and words with more than one reading.'
    );
  });
}
