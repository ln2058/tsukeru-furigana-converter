// The popup's Supporter view: which rows show, what each plan gets, and where
// its button goes, for each connection state.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function fakeNode(tag = 'div') {
  const node = {
    tag,
    className: '',
    textContent: '',
    hidden: false,
    href: '',
    dataset: {},
    attributes: {},
    children: [],
    setAttribute(name, value) { node.attributes[name] = value; },
    append(...items) { node.children.push(...items); },
    replaceChildren(...items) { node.children = items; },
  };
  return node;
}

function textOf(node) {
  return node.children.length ? node.children.map(textOf).join('') : node.textContent;
}

function findAll(node, className, found = []) {
  if (node.className.split(' ').includes(className)) found.push(node);
  node.children.forEach((child) => findAll(child, className, found));
  return found;
}

async function renderView(browserName, { state, entry, language = 'en', perks }) {
  const source = readFileSync(new URL(`../${browserName}/js/popup-supporter.js`, import.meta.url), 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '')
    .replaceAll('export ', '');
  const ids = Object.fromEntries([
    'supporterViewLede', 'supporterViewSignIn', 'supporterViewSignInText', 'supporterViewSignInLink',
    'supporterViewPlans', 'supporterViewSolo', 'supporterViewAction',
  ].map((id) => [id, fakeNode()]));
  const sandbox = {
    setTimeout,
    clearTimeout,
    TsukeruI18n: {
      language: () => language,
      websiteUrl: (path = '') => `https://www.ezfurigana.com${path}`,
    },
    t: (_key, _substitutions, fallback) => fallback,
    chrome: { runtime: { sendMessage: async () => ({ success: true, perks }) } },
    document: { getElementById: (id) => ids[id] || null, createElement: fakeNode },
  };
  vm.runInNewContext(`${source}\nglobalThis.showSupporterView = showSupporterView;`, sandbox);
  sandbox.showSupporterView(state, entry);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rows = findAll(ids.supporterViewPlans, 'supporter-view-row').map((row) => ({
    title: textOf(findAll(row, 'supporter-view-row-title')[0]),
    free: findAll(row, 'supporter-view-value-free').map(textOf)[0],
    supporter: findAll(row, 'supporter-view-value-supporter').map(textOf)[0],
  }));
  return { ids, rows };
}

const PERKS = {
  sentenceAudio: { free: 3, supporter: 570 },
  explain: { free: 3, supporter: 50 },
  dictionary: { free: 10, supporter: 200 },
};

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} a free account compares both plans and goes on to pricing from where it opened`, async () => {
    const { ids, rows } = await renderView(browserName, { state: 'free', entry: 'account', perks: PERKS });
    // English has no translated dictionary to offer.
    assert.deepEqual(rows, [
      { title: 'Sentence audio', free: 'Free account: 3 new sentences a week', supporter: 'Supporter: About 570 new sentences a month' },
      { title: 'Explain a sentence', free: 'Free account: 3 a week', supporter: 'Supporter: 50 a day' },
    ]);
    assert.equal(ids.supporterViewSignIn.hidden, true);
    assert.equal(ids.supporterViewSolo.hidden, false);
    assert.equal(ids.supporterViewAction.textContent, 'See plans and prices');
    assert.equal(ids.supporterViewAction.href, 'https://www.ezfurigana.com/pricing?from=tsukeru&placement=extension_account');
  });

  test(`${browserName} a reader with no account is asked to sign in, and sees the dictionary row in Korean`, async () => {
    const { ids, rows } = await renderView(browserName, { state: 'none', entry: 'header', language: 'ko', perks: PERKS });
    assert.deepEqual(rows.map((row) => row.title), ['Sentence audio', 'Explain a sentence', 'Dictionary in your language']);
    assert.equal(ids.supporterViewSignIn.hidden, false);
    assert.equal(ids.supporterViewSignInText.textContent, 'Sign in for free to start: 3 sentences a week to listen to and explain.');
    assert.equal(ids.supporterViewSignInLink.href, 'https://www.ezfurigana.com/account?tsukeru=connect');
    assert.equal(ids.supporterViewAction.href, 'https://www.ezfurigana.com/pricing?from=tsukeru&placement=extension_header');
  });

  test(`${browserName} a Supporter sees only their own limits and a link to the account`, async () => {
    const { ids, rows } = await renderView(browserName, { state: 'supporter', entry: 'header', perks: PERKS });
    assert.deepEqual(rows.map((row) => [row.free, row.supporter]), [
      [undefined, 'Supporter: About 570 new sentences a month'],
      [undefined, 'Supporter: 50 a day'],
    ]);
    assert.equal(ids.supporterViewLede.textContent, "You're a Supporter. Thank you!");
    assert.equal(ids.supporterViewSolo.hidden, true);
    assert.equal(ids.supporterViewAction.href, 'https://www.ezfurigana.com/account');
  });

  test(`${browserName} without figures the rows show with no numbers, and switched-off features are left out`, async () => {
    const none = await renderView(browserName, { state: 'free', entry: 'header', perks: null });
    assert.deepEqual(none.rows.map((row) => [row.title, row.free, row.supporter]), [
      ['Sentence audio', undefined, undefined],
      ['Explain a sentence', undefined, undefined],
    ]);
    const off = await renderView(browserName, { state: 'free', entry: 'header', perks: { ...PERKS, explain: null } });
    assert.deepEqual(off.rows.map((row) => row.title), ['Sentence audio']);
  });
}
