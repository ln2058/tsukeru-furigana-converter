import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 7, 9);

function loadRules(browserName) {
  const sandbox = {};
  const fileUrl = new URL(`../${browserName}/js/word-rules.js`, import.meta.url);
  vm.runInNewContext(readFileSync(fileUrl, 'utf8'), sandbox, { filename: fileUrl.pathname });
  return sandbox.TsukeruWords;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

for (const browserName of ['chrome', 'firefox']) {
  const Words = loadRules(browserName);

  test(`${browserName} identifies words like EZFurigana: dictionary form and lookup reading, kanji only`, () => {
    // The same id format and rules as the website's word-progress identityForPair.
    assert.equal(Words.identityForPair(' 食べる ', 'たべる').id, '食べる\u0000たべる');
    assert.equal(Words.identityForPair('すごい', 'すごい'), null);
    assert.equal(Words.identityForPair('漢字', ''), null);
    assert.equal(Words.identityForPair('々', 'どう').word, '々');
    assert.equal(Words.identityForWordInfo({
      surface: '食べました', dictForm: '食べる', lookupReading: 'たべる', reading: 'たべました',
    }).id, '食べる\u0000たべる');
    // A kana surface is not tracked even when its dictionary form has kanji.
    assert.equal(Words.identityForWordInfo({ surface: 'たべる', dictForm: '食べる', reading: 'たべる' }), null);
    // A number + counter unit is its counter, like the website.
    assert.equal(Words.identityForWordInfo({
      surface: '2024年', reading: 'にせんにじゅうよねん', counter: '年', counterReading: 'ねん',
    }).id, '年\u0000ねん');
  });

  test(`${browserName} checking a word adds it to Learning, and a Known word stays Known`, () => {
    const store = Words.createStore();
    const first = Words.captureWord(store, { word: '宿題', reading: 'しゅくだい', sentence: '宿題を出す。', level: '5' }, T0, { countCheck: true });
    assert.equal(first.state, 'learning');
    assert.equal(first.changedAt, 0);
    assert.equal(first.dueAt, T0);
    assert.deepEqual(plain(first.sentences), ['宿題を出す。']);

    Words.setWordState(store, { word: '宿題', reading: 'しゅくだい' }, 'known', T0 + 1000);
    const again = Words.captureWord(store, { word: '宿題', reading: 'しゅくだい', sentence: '宿題が多い。' }, T0 + 2000, { countCheck: true });
    assert.equal(again.state, 'known');
    assert.equal(again.changedAt, T0 + 1000);
    assert.equal(again.count, 2);
    assert.deepEqual(plain(again.sentences), ['宿題が多い。', '宿題を出す。']);
    assert.ok(store.dirtyRecords.has(again.id));
  });

  test(`${browserName} learning again restarts the schedule; removal leaves a pending removal`, () => {
    const store = Words.createStore();
    Words.setWordState(store, { word: '天気', reading: 'てんき' }, 'known', T0);
    const record = Words.setWordState(store, { word: '天気', reading: 'てんき' }, 'learning', T0 + DAY);
    assert.equal(record.step, 0);
    assert.equal(record.dueAt, T0 + DAY);

    assert.equal(Words.removeWord(store, record.id, T0 + 2 * DAY), true);
    assert.equal(store.records[record.id], undefined);
    assert.deepEqual(plain(store.removed[record.id]), { word: '天気', reading: 'てんき', removedAt: T0 + 2 * DAY });
    // Checking it again brings it back and drops the pending removal.
    Words.captureWord(store, { word: '天気', reading: 'てんき' }, T0 + 3 * DAY);
    assert.equal(store.removed[record.id], undefined);
  });

  test(`${browserName} retired saved words move into Learning; kana-only words stay in the old list`, () => {
    const store = Words.createStore();
    Words.setWordState(store, { word: '先生', reading: 'せんせい' }, 'known', T0);
    const entries = [
      { word: '先生', reading: 'せんせい', timestamp: T0 - DAY },
      { word: 'すごい', reading: 'すごい' },
      { word: '漢字', reading: 'かんじ', jlpt: 3, pos: 'Noun', timestamp: T0 - DAY,
        sentence: '<ruby data-surface="漢字">漢字<rt>かんじ</rt></ruby>を&amp;書く', definitions: [{ glosses: ['kanji'] }] },
    ];
    for (let index = 0; index < 21; index += 1) entries.push({ word: `語${index}`, reading: `ご${index}` });

    const kept = Words.importVocabulary(store, entries, T0);
    assert.deepEqual(plain(kept), [{ word: 'すごい', reading: 'すごい' }]);
    assert.equal(store.records['先生\u0000せんせい'].state, 'known');
    const kanji = store.records['漢字\u0000かんじ'];
    assert.equal(kanji.state, 'learning');
    assert.equal(kanji.source, 'saved');
    assert.equal(kanji.level, 3);
    assert.equal(kanji.definition, 'kanji');
    assert.deepEqual(plain(kanji.sentences), ['漢字を&書く']);
    assert.equal(kanji.firstSeenAt, T0 - DAY);
    // New imports fall due 20 a day.
    assert.equal(Words.summarize(store, T0).due, 20);
    assert.equal(Words.summarize(store, T0 + DAY).due, 22);
  });

  test(`${browserName} sentences are plain and at most 120 characters, centred on the word`, () => {
    const long = `${'あ'.repeat(100)}勉強${'い'.repeat(100)}`;
    const fitted = Words.fitSentence(long, '勉強');
    assert.ok(Array.from(fitted).length <= 120);
    assert.ok(fitted.includes('勉強'));
    assert.ok(fitted.startsWith('…') && fitted.endsWith('…'));
    assert.equal(Words.fitSentence('  短い   文。 '), '短い 文。');
  });

  test(`${browserName} the summary counts due, learning and known words`, () => {
    const store = Words.createStore();
    Words.captureWord(store, { word: '天気', reading: 'てんき', level: 5 }, T0);
    Words.captureWord(store, { word: '性格', reading: 'せいかく', level: 3 }, T0 + 10);
    Words.setWordState(store, { word: '本当', reading: 'ほんとう', level: 5 }, 'known', T0 + 20);
    const summary = Words.summarize(store, T0 + 100);
    assert.equal(summary.due, 2);
    assert.equal(summary.learning, 2);
    assert.equal(summary.known, 1);
  });

  test(`${browserName} the outbox sends changes since the last exchange, or everything to a new website store`, () => {
    const store = Words.createStore();
    Words.captureWord(store, { word: '天気', reading: 'てんき' }, T0);
    Words.captureWord(store, { word: '映画', reading: 'えいが' }, T0 + 10);
    const first = Words.buildOutbox(store, 'store-a', T0 + 20);
    assert.equal(first.full, true);
    assert.equal(first.changes.length, 2);
    assert.deepEqual(Object.keys(first.changes[0]).sort(), [
      'changedAt', 'count', 'firstSeenAt', 'lastSeenAt', 'level', 'reading', 'sentences', 'state', 'word',
    ]);
    Words.mergeSnapshot(store, first.changes.map((change) => ({ ...change, dueAt: T0 })), { startedAt: T0 + 20, storeId: 'store-a', at: T0 + 30 });

    Words.setWordState(store, { word: '天気', reading: 'てんき' }, 'known', T0 + 40);
    Words.removeWord(store, '映画\u0000えいが', T0 + 50);
    const next = Words.buildOutbox(store, 'store-a', T0 + 60);
    assert.equal(next.full, false);
    assert.deepEqual(plain(next.changes.map((change) => [change.word, change.state, change.changedAt])), [['天気', 'known', T0 + 40]]);
    assert.deepEqual(plain(next.removed.map((gone) => gone.word)), ['映画']);

    // The website's data was cleared: its new store id gets every word again.
    assert.equal(Words.buildOutbox(store, 'store-b', T0 + 70).full, true);
    assert.equal(Words.buildOutbox(store, 'store-b', T0 + 70).changes.length, 1);
  });

  test(`${browserName} the website snapshot wins, except for words changed while the exchange ran`, () => {
    const store = Words.createStore();
    Words.captureWord(store, { word: '天気', reading: 'てんき', definition: 'weather' }, T0);
    Words.captureWord(store, { word: '映画', reading: 'えいが' }, T0 + 1);
    Words.captureWord(store, { word: '宿題', reading: 'しゅくだい' }, T0 + 2);
    const startedAt = T0 + 10;
    // Marked known in this browser while the page was merging.
    Words.setWordState(store, { word: '宿題', reading: 'しゅくだい' }, 'known', T0 + 11);
    store.dirtyRecords.clear();

    const changed = Words.mergeSnapshot(store, [
      // Reviewed on the website: schedule and state come from there.
      { word: '天気', reading: 'てんき', state: 'learning', step: 2, dueAt: T0 + 3 * DAY, changedAt: 0, level: 5, sentences: ['天気がいい。'] },
      { word: '宿題', reading: 'しゅくだい', state: 'learning', dueAt: T0 },
      // Learning only on the website.
      { word: '先生', reading: 'せんせい', state: 'known', changedAt: T0 - DAY, knownAt: T0 - DAY },
      // Not trackable; ignored.
      { word: 'すごい', reading: 'すごい', state: 'learning' },
    ], { startedAt, storeId: 'store-a', at: T0 + 20 });

    assert.equal(changed, true);
    const weather = store.records['天気\u0000てんき'];
    assert.equal(weather.step, 2);
    assert.equal(weather.dueAt, T0 + 3 * DAY);
    assert.equal(weather.definition, 'weather');
    assert.ok(weather.updatedAt <= startedAt);
    // Removed on the website (absent from its snapshot).
    assert.equal(store.records['映画\u0000えいが'], undefined);
    assert.equal(store.records['宿題\u0000しゅくだい'].state, 'known');
    assert.equal(store.records['先生\u0000せんせい'].state, 'known');
    assert.equal(store.records['すごい\u0000すごい'], undefined);
    assert.deepEqual(plain(store.meta), { pushedThrough: startedAt, storeId: 'store-a', lastSyncAt: T0 + 20 });
    // Only the word changed during the exchange goes out next time.
    assert.deepEqual(plain(Words.buildOutbox(store, 'store-a', T0 + 30).changes.map((change) => change.word)), ['宿題']);
  });
}
