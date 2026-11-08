import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

const ENGLISH = {
  source: 'je_dict',
  entry: { gloss: ['weather'], definitions: [{ gloss: ['climate'] }, { gloss: ['elements'] }, { gloss: ['mood'] }] },
};
const KOREAN = { source: 'je_localized_cache', locale: 'ko', entry: { gloss: ['날씨'], definitions: [{ gloss: ['기후'] }] } };

function loadPopupVocab(browserName, { language = 'en', respond = () => ({ success: false }), page = () => null } = {}) {
  const fileUrl = new URL(`../${browserName}/js/popup-vocab.js`, import.meta.url);
  const source = readFileSync(fileUrl, 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/popup-settings\.js';/, '')
    .replaceAll('export ', '');
  const sent = [];
  const tabMessages = [];
  const notices = [];
  const audios = [];
  let closed = 0;
  class FakeAudio {
    constructor(src) { this.src = src; audios.push(this); }
    addEventListener() {}
    play() { return Promise.resolve(); }
    pause() {}
  }
  const sandbox = {
    console,
    Audio: FakeAudio,
    DEFINITION_CACHE_TTL: 0,
    TsukeruI18n: { language: () => language },
    getActiveTab: async () => ({ id: 3, url: 'https://example.com/' }),
    isSupportedPageTab: () => true,
    showNotice: (message, kind) => notices.push([message, kind]),
    t: (_key, _subs, fallback) => fallback,
    document: { querySelectorAll: () => [] },
    close: () => { closed += 1; },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: (message, callback) => {
          sent.push(message);
          const response = respond(message);
          if (callback) callback(response);
          return Promise.resolve(response);
        },
      },
      tabs: {
        sendMessage: async (tabId, message) => {
          tabMessages.push([tabId, message]);
          return page(message);
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const messagesUrl = new URL(`../${browserName}/js/ui-messages.js`, import.meta.url);
  vm.runInContext(readFileSync(messagesUrl, 'utf8'), context, { filename: messagesUrl.pathname });
  vm.runInContext(source, context, { filename: fileUrl.pathname });
  return { sandbox, context, sent, tabMessages, notices, audios, closed: () => closed };
}

const run = (harness, code) => vm.runInContext(code, harness.context);

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} a word under Words in this text opens its dictionary popup on the page`, async () => {
    const found = loadPopupVocab(browserName, { page: (message) => (message.action === 'openWordTooltip' ? { found: true } : null) });
    await run(found, "openWordOnPage({ word: '天気', reading: 'てんき' })");
    assert.deepEqual(found.tabMessages.map(([, message]) => message.action), ['openWordTooltip']);
    assert.equal(found.tabMessages[0][1].word, '天気');
    assert.equal(found.closed(), 1, 'the extension popup steps out of the way');

    // A page that cannot open it still scrolls to the word, and the popup stays.
    const missing = loadPopupVocab(browserName, { page: () => ({ found: false }) });
    await run(missing, "openWordOnPage({ word: '天気', reading: 'てんき' })");
    assert.deepEqual(missing.tabMessages.map(([, message]) => message.action), ['openWordTooltip', 'scrollToWord']);
    assert.equal(missing.closed(), 0);
  });

  test(`${browserName} a saved word opens to its cached translation, else three English meanings`, async () => {
    const respond = (message) => {
      if (message.action === 'lookupDefinition') return { success: true, data: ENGLISH };
      if (message.action === 'lookupLocalizedDefinition') return { success: true, data: KOREAN };
      return { success: false };
    };
    const korean = loadPopupVocab(browserName, { language: 'ko', respond });
    const translated = await run(korean, "entryMeanings({ word: '天気', reading: 'てんき' })");
    assert.equal(translated.lang, 'ko');
    assert.deepEqual(Array.from(translated.senses, (sense) => sense.glosses[0]), ['날씨', '기후']);
    const localized = korean.sent.find((message) => message.action === 'lookupLocalizedDefinition');
    assert.equal(localized.cacheOnly, true, 'opening a word never creates a translation');

    const english = loadPopupVocab(browserName, { language: 'en', respond });
    const meanings = await run(english, "entryMeanings({ word: '天気', reading: 'てんき' })");
    assert.equal(meanings.lang, 'en');
    assert.deepEqual(Array.from(meanings.senses, (sense) => sense.glosses[0]), ['weather', 'climate', 'elements']);
    assert.ok(!english.sent.some((message) => message.action === 'lookupLocalizedDefinition'));
  });

  test(`${browserName} a saved sentence plays Supporter audio, and a refusal explains it`, () => {
    const button = () => {
      const classes = new Set();
      return { classes, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
    };
    const supporter = loadPopupVocab(browserName, { respond: () => ({ success: true, dataUrl: 'data:audio/mpeg;base64,AA==' }) });
    supporter.sandbox.playSentence('天気がいい。', button());
    assert.deepEqual(supporter.sent.map((message) => ({ ...message })), [{ action: 'playSentence', text: '天気がいい。' }]);
    assert.equal(supporter.audios.length, 1);

    const free = loadPopupVocab(browserName, { respond: () => ({ success: false, error: 'supporter_required' }) });
    const freeButton = button();
    free.sandbox.playSentence('天気がいい。', freeButton);
    assert.equal(free.audios.length, 0);
    assert.equal(free.notices.length, 1);
    assert.match(free.notices[0][0], /Supporter feature/);
    assert.equal(free.notices[0][1], 'info');
    assert.ok(!freeButton.classes.has('is-playing'));
  });
}
