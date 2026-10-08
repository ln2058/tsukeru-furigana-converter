import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function fakeNotice() {
  const label = { textContent: '' };
  const message = { textContent: '' };
  const attributes = {};
  return {
    hidden: true,
    dataset: {},
    label,
    message,
    attributes,
    setAttribute: (name, value) => { attributes[name] = value; },
    querySelector: (selector) => (selector === '.popup-notice-label' ? label : message),
  };
}

function loadNotices(browserName) {
  const fileUrl = new URL(`../${browserName}/js/popup-settings.js`, import.meta.url);
  const source = readFileSync(fileUrl, 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '')
    .replaceAll('export ', '');
  const notice = fakeNotice();
  const sandbox = {
    console,
    chrome: { i18n: { getMessage: () => '' } },
    document: { getElementById: (id) => (id === 'status' ? notice : null) },
  };
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return { sandbox, notice };
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} a closed limit countdown stays closed, but a new error still shows`, () => {
    const { sandbox, notice } = loadNotices(browserName);

    sandbox.showNotice('Furigana paused. Try again in 30s.', 'limit');
    assert.equal(notice.hidden, false);
    assert.equal(notice.dataset.status, 'limit');
    assert.equal(notice.label.textContent, 'Limit');
    assert.equal(notice.attributes.role, 'status');

    sandbox.hideNotice({ dismissed: true });
    sandbox.showNotice('Furigana paused. Try again in 29s.', 'limit', { refresh: true });
    assert.equal(notice.hidden, true, 'the next countdown tick does not reopen it');

    sandbox.showNotice('Could not reach the page.', 'error');
    assert.equal(notice.hidden, false);
    assert.equal(notice.dataset.status, 'error');
    assert.equal(notice.attributes.role, 'alert');

    // The end of a countdown only removes a limit notice, never an error.
    sandbox.hideNotice({ kind: 'limit' });
    assert.equal(notice.hidden, false);
  });
}
