import test from 'node:test';
import assert from 'node:assert/strict';

const { readFileSync } = process.getBuiltinModule('fs');

const article = (id, extra = {}) => ({
  id,
  url: `https://example.jp/articles/${id}`,
  title: `記事 ${id}`,
  excerpt: '本文の最初の文です。',
  source: { id: 'example', name: 'Example' },
  category: 'science',
  jlpt: 'N3',
  minutes: 3,
  words: [['研究', '研究', 'けんきゅう', 'けんきゅう', 4, 1, 'Noun', 2]],
  ...extra,
});

test('both browser copies of the Discover modules are the same file', () => {
  for (const file of ['js/discover.js', 'js/popup-discover.js', 'js/discover-rank.js', 'js/discover-reading.js', 'js/bg-discover.js', 'js/content-discover.js']) {
    const chrome = readFileSync(new URL(`../chrome/${file}`, import.meta.url), 'utf8');
    const firefox = readFileSync(new URL(`../firefox/${file}`, import.meta.url), 'utf8');
    assert.equal(chrome, firefox, file);
  }
});

for (const browserName of ['chrome', 'firefox']) {
  const Discover = await import(new URL(`../${browserName}/js/discover.js`, import.meta.url));

  test(`${browserName} Discover keeps only well-formed articles`, () => {
    assert.equal(Discover.normalizeDiscoverFeed(null), null);
    assert.equal(Discover.normalizeDiscoverFeed({ version: 2, articles: [] }), null);
    const feed = Discover.normalizeDiscoverFeed({
      version: 1,
      articles: [
        article('a1'),
        article('a1'),
        article('bad url', { id: 'a2', url: 'http://example.jp/plain' }),
        article('a3', { url: 'https://user:pass@example.jp/x' }),
        article('a4', { url: 'javascript:alert(1)' }),
        article('a5', { category: 'gossip', jlpt: 'N7', minutes: -1, title: '  題名\n  ' }),
        article('<script>'),
      ],
    });
    assert.deepEqual(feed.articles.map((entry) => entry.id), ['a1', 'a5']);
    const odd = feed.articles[1];
    assert.equal(odd.category, '');
    assert.equal(odd.jlpt, '');
    assert.equal(odd.minutes, null);
    assert.equal(odd.title, '題名');
    assert.equal(feed.prototype, false);
  });

  test(`${browserName} Discover card pictures load only from the EZFurigana picture path`, () => {
    const good = '/api/extension/discover/thumb/a1-0123456789abcdef.webp';
    const feed = Discover.normalizeDiscoverFeed({
      version: 1,
      articles: [
        article('p1', { thumb: good }),
        article('p2', { thumb: 'https://example.jp/og.jpg' }),
        article('p3', { thumb: '/api/extension/discover/thumb/../../account.webp' }),
        article('p4', { thumb: null }),
      ],
    });
    assert.deepEqual(feed.articles.map((entry) => entry.thumb), [good, '', '', '']);
    assert.equal(Discover.discoverThumbUrl(feed.articles[0]), `https://www.ezfurigana.com${good}`);
    assert.equal(Discover.discoverThumbUrl(feed.articles[1]), '');
    assert.equal(Discover.discoverThumbUrl({ thumb: 'https://example.jp/og.jpg' }), '');
  });

  test(`${browserName} Discover words take the page-word shape`, () => {
    const [entry] = Discover.normalizeDiscoverFeed({ version: 1, articles: [article('w1', {
      words: [['研究', '研究', 'けんきゅう', 'けんきゅう', 4, 1, 'Noun', 2], ['の', '', '', 'ノ', 0, null, 'Particle', 9], 'junk', [7]],
    })] }).articles;
    assert.deepEqual(Discover.articleRawWords(entry), [
      { surface: '研究', word: '研究', lookupReading: 'けんきゅう', reading: 'けんきゅう', jlpt: '4', band: '1', pos: 'Noun', frequency: 2 },
      { surface: 'の', word: '', lookupReading: '', reading: 'ノ', jlpt: '', band: '', pos: 'Particle', frequency: 9 },
    ]);
  });

  test(`${browserName} Discover filters, hides, and orders For you by fit`, () => {
    const entries = [
      { article: article('easy', { jlpt: 'N5', category: 'learner' }), pct: 99, learning: 0 },
      { article: article('fit', { jlpt: 'N3' }), pct: 93, learning: 0 },
      { article: article('hard', { jlpt: 'N1' }), pct: 70, learning: 0 },
      { article: article('fitLearning', { jlpt: 'N3' }), pct: 93, learning: 3 },
      { article: article('hidden', { jlpt: 'N3' }), pct: 94, learning: 0 },
    ];
    let state = Discover.markArticle(null, 'hidden', 'hidden');
    state = Discover.markArticle(state, 'fit', 'read');
    const forYou = Discover.selectArticles(entries, { state }).map(({ article: a }) => a.id);
    assert.deepEqual(forYou, ['fitLearning', 'easy', 'hard', 'fit']);
    assert.deepEqual(Discover.selectArticles(entries, { level: 'N3', state }).map(({ article: a }) => a.id), ['fit', 'fitLearning']);
    assert.deepEqual(Discover.selectArticles(entries, { category: 'learner', state }).map(({ article: a }) => a.id), ['easy']);
  });

  test(`${browserName} Discover records stay bounded and well-formed`, () => {
    let state = { hidden: ['ok', 'bad id', 5], read: 'nope' };
    assert.deepEqual(Discover.normalizeDiscoverState(state), { hidden: ['ok'], read: [] });
    for (let index = 0; index < 600; index++) state = Discover.markArticle(state, `id${index}`, 'read');
    assert.equal(state.read.length, 500);
    assert.equal(state.read[0], 'id599');
    assert.deepEqual(Discover.markArticle(state, 'x', 'starred'), Discover.normalizeDiscoverState(state));
  });
}

const vm = await import('node:vm');

function loadReading(browserName) {
  const sandbox = { URL };
  const fileUrl = new URL(`../${browserName}/js/discover-reading.js`, import.meta.url);
  vm.runInNewContext(readFileSync(fileUrl, 'utf8'), sandbox);
  return sandbox.TsukeruDiscoverReading;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 22, 3);

for (const browserName of ['chrome', 'firefox']) {
  const Reading = loadReading(browserName);
  const Rank = await import(new URL(`../${browserName}/js/discover-rank.js`, import.meta.url));

  // A page: menu, the article in three paragraphs (the page spaces and punctuates it its own way), then related links.
  const page = [
    { text: 'ホームニュース', parent: 'nav' },
    { text: '新しい研究によると海の温度は上がり続けている', parent: 'main' },
    { text: '研究チームは十年分のデータを調べた'.repeat(4), parent: 'main' },
    { text: 'チームは来年も調査を続ける予定だ', parent: 'main' },
    { text: '関連記事人気の記事', parent: 'aside' },
  ].map((block) => ({ ...block, text: Reading.normalize(block.text) }));
  const anchors = { startText: '新しい研究によると、海の温度は 上がり続けている。', endText: 'チームは来年も調査を続ける予定だ。' };

  test(`${browserName} Discover finds the article between its start and end on the page`, () => {
    assert.deepEqual({ ...Reading.locateArticle(page, anchors) }, { first: 1, last: 3, end: true });
    // Only the start: the article runs on to a later page.
    assert.deepEqual({ ...Reading.locateArticle(page, { startText: anchors.startText, remaining: 30 }) }, { first: 1, last: 2, end: false });
    // Neither: not measured, unless it is a later page of the same article.
    assert.equal(Reading.locateArticle(page, { startText: '全く関係のない文章です', endText: '全く違う終わりの文です' }), null);
    assert.deepEqual({ ...Reading.locateArticle(page, { later: true }) }, { first: 1, last: 3, end: false });
  });

  test(`${browserName} Discover counts a read article as finished, not one scrolled through`, () => {
    const lengths = [400, 800, 400];
    const pageAfter = (seconds, visibleAt) => {
      const credited = [0, 0, 0];
      for (let second = 0; second < seconds; second += 1) Reading.creditReading(lengths, credited, visibleAt(second), 1);
      return { ...Reading.pageTotals(lengths, credited), end: true };
    };
    const units = 1600;
    // Scrolling to the end in ten seconds credits at most the reading speed.
    const scrolled = pageAfter(10, (second) => [Math.min(2, Math.floor(second / 4))]);
    assert.equal(Reading.readingOutcome([scrolled], { units, activeMs: 10000 }), 'bounced');
    // Reading at a steady pace, the screen moving down the article.
    const read = pageAfter(90, (second) => (second < 20 ? [0, 1] : second < 60 ? [1] : [1, 2]));
    assert.equal(Reading.readingOutcome([read], { units, activeMs: 90000 }), 'finished');
    // Read well, but the end never came on screen, or only part of the article was measured.
    assert.equal(Reading.readingOutcome([{ ...read, end: false }], { units, activeMs: 90000 }), 'skimmed');
    assert.equal(Reading.readingOutcome([read], { units: units * 3, activeMs: 90000 }), 'skimmed');
  });

  test(`${browserName} Discover follows an article onto its later pages only`, () => {
    assert.equal(Reading.samePathStem('https://gigazine.net/news/20261122-ocean/', 'https://gigazine.net/news/20261122-ocean/2/'), true);
    assert.equal(Reading.samePathStem('https://natalie.mu/music/news/600000', 'https://natalie.mu/music/news/600000/page/2'), true);
    assert.equal(Reading.samePathStem('https://example.jp/a/123.html', 'https://example.jp/a/123_2.html'), true);
    assert.equal(Reading.samePathStem('https://natalie.mu/music/news/600000', 'https://natalie.mu/music/news/600001'), false);
    assert.equal(Reading.samePathStem('https://example.jp/a/1', 'https://other.example/a/1/2'), false);
  });

  test(`${browserName} Discover history only moves up, and hiding wins`, () => {
    const one = article('a1', { chars: 2000, style: 'news_report' });
    let history = Rank.noteOutcome({}, one, 'shown', NOW);
    history = Rank.noteOutcome(history, one, 'finished', NOW + 1);
    history = Rank.noteOutcome(history, one, 'opened', NOW + 2);
    assert.equal(history.a1.o, 'finished');
    assert.deepEqual(history.a1.f, ['science', 'example', 'news_report', 'medium']);
    history = Rank.noteOutcome(history, one, 'hidden', NOW + 3);
    assert.equal(Rank.noteOutcome(history, one, 'finished', NOW + 4).a1.o, 'hidden');
    assert.equal(Rank.noteOutcome(history, one, 'unhidden', NOW + 5).a1, undefined);
  });

  const feedEntries = () => [
    ...['s1', 's2', 's3', 's4'].map((id) => ({ article: article(id, { category: 'science', source: { id: 'nazology', name: 'ナゾロジー' } }), pct: 94, learning: 0 })),
    ...['t1', 't2', 't3'].map((id) => ({ article: article(id, { category: 'tech', source: { id: `site-${id}`, name: id } }), pct: 94, learning: 0 })),
    ...['f1', 'f2'].map((id) => ({ article: article(id, { category: 'food_travel', source: { id: `site-${id}`, name: id } }), pct: 94, learning: 0 })),
    { article: article('hard', { category: 'news', source: { id: 'site-hard', name: 'hard' } }), pct: 60, learning: 0 },
  ];

  test(`${browserName} the daily set is the same all day and varied`, () => {
    const day = Rank.pickDay(NOW);
    const first = Rank.dailySet(feedEntries(), {}, { day, now: NOW });
    assert.deepEqual(Rank.dailySet(feedEntries(), {}, { day, now: NOW + 1000 }), first);
    assert.equal(first.length, Rank.DAILY_SIZE);
    const ids = first.map((pick) => pick.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.filter((id) => id.startsWith('s')).length <= 2, 'at most two from one category and site');
    assert.ok(!ids.includes('hard'), 'a text far above the reader is left out while others suit');
    // Opened and hidden articles are not picked again.
    const history = Rank.noteOutcome({}, feedEntries()[0].article, 'opened', NOW);
    const next = Rank.dailySet(feedEntries(), history, { day: '2026-11-23', now: NOW + DAY_MS, hidden: ['t1'] }).map((pick) => pick.id);
    assert.ok(!next.includes('s1') && !next.includes('t1'));
  });

  test(`${browserName} the daily set learns what the reader finishes and still explores`, () => {
    let history = {};
    // Over the past weeks: tech articles read to the end, food articles opened and left.
    for (let index = 0; index < 6; index += 1) {
      history = Rank.noteOutcome(history, article(`old-t${index}`, { category: 'tech', source: { id: `old${index}`, name: 'x' } }), 'finished', NOW - index * DAY_MS);
      history = Rank.noteOutcome(history, article(`old-f${index}`, { category: 'food_travel', source: { id: `old${index}`, name: 'x' } }), 'opened', NOW - index * DAY_MS);
    }
    let techFirst = 0;
    for (let offset = 0; offset < 20; offset += 1) {
      const day = Rank.pickDay(NOW + offset * DAY_MS);
      const picks = Rank.dailySet(feedEntries(), history, { day, now: NOW });
      if (picks[0].id.startsWith('t')) techFirst += 1;
      assert.ok(!picks[0].id.startsWith('f'), `${day}: food never leads`);
      // Science, never tried, always gets a place: the exploring slot, or on a lucky draw a top one.
      assert.ok(picks.some((pick) => pick.id.startsWith('s')), `${day}: science is tried`);
    }
    assert.ok(techFirst >= 12, `tech led ${techFirst} of 20 days`);
    const techPick = Rank.dailySet(feedEntries(), history, { day: Rank.pickDay(NOW), now: NOW }).find((pick) => pick.id.startsWith('t'));
    assert.deepEqual(techPick.reason, { kind: 'category', category: 'tech' });
  });

  test(`${browserName} the streak joins website review days with reading days`, () => {
    assert.deepEqual(Rank.combinedStreak({ count: 4, day: '2026-11-20' }, ['2026-11-21', '2026-11-22'], '2026-11-22'), { count: 6, today: true });
    // One missed day keeps it; reading days before the website's day add nothing.
    assert.deepEqual(Rank.combinedStreak({ count: 4, day: '2026-11-19' }, ['2026-11-18', '2026-11-21'], '2026-11-22'), { count: 5, today: false });
    assert.deepEqual(Rank.combinedStreak({ count: 4, day: '2026-11-15' }, ['2026-11-22'], '2026-11-22'), { count: 1, today: true });
    assert.deepEqual(Rank.combinedStreak(null, ['2026-11-18'], '2026-11-22'), { count: 0, today: false });
  });
}
