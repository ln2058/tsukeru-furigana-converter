import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function selectorSpecificity(selector) {
  const classesAndAttributes = (selector.match(/\.[\w-]+|\[[^\]]+\]/g) || []).length;
  return classesAndAttributes;
}

function loadPopupVocab(browserName, {
  activeTabId = 7,
  pageTabActive = true,
  getPageWords = async () => ({ words: [] }),
  sendWords = async () => ({ success: true, states: {} }),
} = {}) {
  const fileUrl = new URL(`../${browserName}/js/popup-vocab.js`, import.meta.url);
  let source = readFileSync(fileUrl, 'utf8');
  source = source.replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/popup-settings\.js';/, '');
  source = source.replaceAll('export ', '');
  const listeners = [];
  const pageRequests = [];
  const wordRequests = [];
  const sandbox = {
    console,
    DEFAULT_SETTINGS: { studyMode: false },
    DEFINITION_CACHE_TTL: 0,
    getActiveTab: async () => ({ id: activeTabId, url: 'https://example.com/' }),
    isSupportedPageTab: () => true,
    sendWordDisplaySettings: async () => {},
    t: (_key, _subs, fallback) => fallback,
    chrome: {
      runtime: {
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => {
          wordRequests.push(message);
          return sendWords(message);
        },
      },
      storage: {
        sync: { get: async (defaults) => defaults, set: async () => {} },
        onChanged: { addListener() {} },
      },
      tabs: {
        sendMessage: async (tabId, message) => {
          pageRequests.push([tabId, message.action]);
          return getPageWords(message);
        },
      },
    },
    document: {
      getElementById: (id) => (id === 'page-tab'
        ? { classList: { contains: (name) => name === 'active' && pageTabActive } }
        : null),
    },
  };
  const context = vm.createContext(sandbox);
  const rulesUrl = new URL(`../${browserName}/js/word-rules.js`, import.meta.url);
  vm.runInContext(readFileSync(rulesUrl, 'utf8'), context, { filename: rulesUrl.pathname });
  vm.runInContext(source, context, { filename: fileUrl.pathname });
  return {
    sandbox, listeners, pageRequests, wordRequests,
    pageState: (id) => vm.runInContext('pageStates', context)[id],
    pageWordCount: () => vm.runInContext('pageWords.length', context),
  };
}

function loadTooltip(browserName) {
  const fileUrl = new URL(`../${browserName}/js/content-tooltip.js`, import.meta.url);
  const sent = [];
  const timers = [];
  const sandbox = {
    console,
    URL,
    chrome: {
      i18n: { getMessage: () => '' },
      runtime: { sendMessage: async (message) => { sent.push(message.action); } },
    },
    document: { documentElement: { removeAttribute() {} }, querySelectorAll: () => [], getElementById: () => null },
    requestAnimationFrame() {},
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    pageWordsNoticeTimer: 0,
    wordStates: new Map(),
    wordStatesApplied: false,
    DICTIONARY_MAX_SENSES: 5,
  };
  vm.runInNewContext(readFileSync(fileUrl, 'utf8'), sandbox, { filename: fileUrl.pathname });
  return { sandbox, sent, timers };
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} JLPT bar segments and level tags take their level colour, not the neutral tint`, () => {
    const css = readFileSync(new URL(`../${browserName}/popup.css`, import.meta.url), 'utf8');
    const levelRule = css.indexOf('[data-jlpt="5"] { --tint: var(--group-n5); }');
    assert.ok(levelRule > 0);
    for (const match of css.matchAll(/([^{}]+)\{\s*--tint:\s*var\(--group-neutral\);\s*\}/g)) {
      assert.ok(match.index < levelRule, 'the neutral tint comes before the level tints');
      for (const selector of match[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',')) {
        if (!selector.includes('[data-jlpt')) continue;
        // A more specific neutral rule would grey out every level.
        assert.equal(selectorSpecificity(selector.trim()), 1, selector.trim());
      }
    }
  });

  test(`${browserName} numbers with the same counter are one 〜年 word with their most frequent uses`, () => {
    const { sandbox } = loadPopupVocab(browserName);
    const year = (surface, reading, frequency, jlpt = '5') => ({
      word: surface, surface, reading, surfaceReading: reading, jlpt, pos: 'Numbers', frequency,
      counter: '年', counterReading: 'ねん',
    });
    const words = sandbox.collectPageWords([
      year('2024年', 'にせんにじゅうよねん', 1, ''),
      { word: '天気', surface: '天気', reading: 'てんき', jlpt: '5', frequency: 1 },
      year('1998年', 'せんきゅうひゃくきゅうじゅうはちねん', 3),
      year('3年', 'さんねん', 1),
      year('5年', 'ごねん', 1),
      year('2024年', 'にせんにじゅうよねん', 1),
    ]);
    assert.equal(words.length, 2);
    const [counter, plainWord] = words;
    assert.equal(counter.id, '年\u0000ねん');
    assert.equal(counter.occurrences, 7);
    assert.equal(counter.level, 5, 'the counter row takes its easiest level');
    assert.deepEqual([...sandbox.counterExamples(counter).map((example) => example.surface)], ['1998年', '2024年', '3年']);
    assert.equal(plainWord.word, '天気');
    assert.equal(plainWord.examples, null);
    assert.equal(sandbox.counterExamples(plainWord).length, 0);
  });

  test(`${browserName} Words in this text re-lists the page when its furigana changes`, async () => {
    const { sandbox, listeners, pageRequests } = loadPopupVocab(browserName);
    await sandbox.initPageTab();
    assert.equal(listeners.length, 1);

    listeners[0]({ action: 'pageWordsChanged' }, { tab: { id: 7 } });
    await flush();
    assert.deepEqual(pageRequests, [[7, 'getPageWords']]);

    // Other tabs and other messages do not re-list this page.
    listeners[0]({ action: 'pageWordsChanged' }, { tab: { id: 8 } });
    listeners[0]({ action: 'wordsGetStates' }, { tab: { id: 7 } });
    await flush();
    assert.equal(pageRequests.length, 1);
  });

  test(`${browserName} Words in this text waits for its tab to be shown`, async () => {
    const { sandbox, listeners, pageRequests } = loadPopupVocab(browserName, { pageTabActive: false });
    await sandbox.initPageTab();
    listeners[0]({ action: 'pageWordsChanged' }, { tab: { id: 7 } });
    await flush();
    assert.equal(pageRequests.length, 0);
  });

  test(`${browserName} initial loading and repeated notices share one refresh plus one follow-up`, async () => {
    const first = deferred();
    const followUp = deferred();
    let requests = 0;
    const { sandbox, listeners, pageRequests } = loadPopupVocab(browserName, {
      getPageWords: () => (++requests === 1 ? first.promise : followUp.promise),
    });
    await sandbox.initPageTab();
    const initial = sandbox.requestPageWordsRefresh();
    await flush();
    assert.deepEqual(pageRequests, [[7, 'getPageWords']]);

    for (let i = 0; i < 3; i += 1) {
      listeners[0]({ action: 'pageWordsChanged' }, { tab: { id: 7 } });
    }
    await flush();
    assert.equal(pageRequests.length, 1, 'notices do not start overlapping reads');
    first.resolve({ words: [] });
    await initial;
    await flush();
    assert.deepEqual(pageRequests, [[7, 'getPageWords'], [7, 'getPageWords']]);
    followUp.resolve({ words: [] });
    await flush();
    assert.equal(pageRequests.length, 2, 'three notices produce exactly one follow-up');
  });

  test(`${browserName} saves hold refreshes, discard stale results, and release the queue after failure`, async () => {
    const raw = [
      { word: '日本', reading: 'にほん', jlpt: '5' },
      { word: '学校', reading: 'がっこう', jlpt: '5' },
    ];
    const staleStates = deferred();
    const slowPage = deferred();
    const knownSave = deferred();
    const failedSave = deferred();
    const storedStates = {};
    let heldStates = null;
    let heldPage = null;
    let savesRunning = 0;
    let readsDuringSave = 0;
    const { sandbox, listeners, pageRequests, wordRequests, pageState, pageWordCount } = loadPopupVocab(browserName, {
      getPageWords: () => {
        if (savesRunning) readsDuringSave += 1;
        const result = heldPage;
        heldPage = null;
        return result ? result.promise : { words: raw };
      },
      sendWords: async (message) => {
        if (message.action === 'wordsGetStates') {
          if (savesRunning) readsDuringSave += 1;
          const result = heldStates;
          heldStates = null;
          return result ? result.promise : { success: true, states: { ...storedStates } };
        }
        assert.equal(message.action, 'wordsSetState');
        savesRunning += 1;
        try {
          const result = await (message.state === 'known' ? knownSave.promise : failedSave.promise);
          if (result.success) {
            storedStates[sandbox.TsukeruWords.identityForPair(message.word, message.reading).id] = result.record.state;
          }
          return result;
        } finally {
          savesRunning -= 1;
        }
      },
    });
    await sandbox.initPageTab();
    await sandbox.requestPageWordsRefresh();
    const [firstWord, secondWord] = sandbox.collectPageWords(raw);

    // A read that started before a click must not undo the click when it finally returns.
    raw.push({ word: '先生', reading: 'せんせい', jlpt: '5' });
    heldStates = staleStates;
    const oldRefresh = sandbox.requestPageWordsRefresh();
    await flush();
    const saveKnown = sandbox.setPageWordState(firstWord, 'known');
    const saveLearning = sandbox.setPageWordState(secondWord, 'learning');
    listeners[0]({ action: 'pageWordsChanged' }, { tab: { id: 7 } });
    await flush();
    const requestsBeforeCompletion = pageRequests.length;
    knownSave.resolve({ success: true, record: { state: 'known' } });
    await saveKnown;
    assert.equal(pageState(firstWord.id), 'known');

    staleStates.resolve({ success: true, states: {} });
    await oldRefresh;
    await flush();
    assert.equal(pageState(firstWord.id), 'known', 'the stale snapshot cannot undo the click');
    assert.equal(pageWordCount(), 2, 'the entire stale result is discarded');
    assert.equal(pageRequests.length, requestsBeforeCompletion, 'one save finishing does not release another save');

    failedSave.reject(new Error('test save failed'));
    await saveLearning;
    await flush();
    assert.equal(readsDuringSave, 0, 'no page or state reads start while saves are pending');
    assert.equal(pageRequests.length, requestsBeforeCompletion + 1, 'a failed save still releases one queued refresh');
    assert.equal(pageState(firstWord.id), 'known');
    assert.equal(pageState(secondWord.id), undefined);
    assert.equal(pageWordCount(), 3, 'the queued refresh retains new words');

    // Also cover invalidation while page extraction, rather than state retrieval, is pending.
    heldPage = slowPage;
    const slowRefresh = sandbox.requestPageWordsRefresh();
    await flush();
    const readsBeforeSave = wordRequests.filter((message) => message.action === 'wordsGetStates').length;
    const nextSave = sandbox.setPageWordState(firstWord, 'known');
    slowPage.resolve({ words: raw });
    await slowRefresh;
    await nextSave;
    await flush();
    assert.equal(
      wordRequests.filter((message) => message.action === 'wordsGetStates').length,
      readsBeforeSave + 1,
      'the invalidated extraction skips its state read; only the queued refresh reads states'
    );
    assert.equal(pageState(firstWord.id), 'known');
  });

  test(`${browserName} applying or clearing furigana sends one throttled notice to the popup`, async () => {
    const { sandbox, sent, timers } = loadTooltip(browserName);
    sandbox.applyWordStatesTo(sandbox.document);
    sandbox.applyWordStatesTo({});
    assert.equal(timers.length, 1);
    timers[0]();
    await flush();
    assert.deepEqual(sent, ['pageWordsChanged']);

    sandbox.clearWordDisplaySettings();
    assert.equal(timers.length, 2);
  });
}
