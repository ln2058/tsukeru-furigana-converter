import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DAY = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 10, 1, 3);
const usage = { firstSeenAt: start, activeDays: ['2026-11-01'] };

test('both browsers ship the same reading-picks modules', () => {
  for (const file of ['reading-picks.js', 'popup-reading-picks.js']) {
    const read = browser => readFileSync(new URL(`../${browser}/js/${file}`, import.meta.url), 'utf8');
    assert.equal(read('firefox'), read('chrome'));
  }
});

const { decideReadingPicks, dismissReadingPicks, readingPicksAvailable, readingPicksUrl } = await import('../chrome/js/reading-picks.js');

test('the slip waits two days and for furigana to have worked once', () => {
  assert.equal(decideReadingPicks(usage, undefined, start + 1 * DAY).show, false);
  assert.equal(decideReadingPicks({ firstSeenAt: start, activeDays: [] }, undefined, start + 3 * DAY).show, false);
  assert.equal(decideReadingPicks(undefined, undefined, start + 3 * DAY).show, false);
  assert.equal(decideReadingPicks(usage, undefined, start + 2 * DAY).show, true);
});

test('a showing lasts a day, rests two weeks, and stops after four', () => {
  let now = start + 3 * DAY;
  let decision = decideReadingPicks(usage, undefined, now);
  assert.deepEqual([decision.show, decision.state.asks], [true, 1]);
  const reopened = decideReadingPicks(usage, decision.state, now + 2 * 60 * 60 * 1000);
  assert.deepEqual([reopened.show, reopened.state.asks], [true, 1], 'reopening the popup is the same showing');
  assert.equal(decideReadingPicks(usage, decision.state, now + 2 * DAY).show, false);
  for (const expected of [2, 3, 4]) {
    now += 15 * DAY;
    decision = decideReadingPicks(usage, decision.state, now);
    assert.deepEqual([decision.show, decision.state.asks], [true, expected]);
  }
  assert.equal(decideReadingPicks(usage, decision.state, now + 15 * DAY).show, false);
});

test('Not now rests the slip and opening the page ends it', () => {
  const now = start + 3 * DAY;
  const shown = decideReadingPicks(usage, undefined, now).state;
  const rested = dismissReadingPicks(shown, 'later', now);
  assert.equal(decideReadingPicks(usage, rested, now + 1 * DAY).show, false);
  assert.equal(decideReadingPicks(usage, rested, now + 15 * DAY).show, true);
  const opened = dismissReadingPicks(shown, 'opened', now);
  assert.equal(decideReadingPicks(usage, opened, now + 60 * DAY).show, false);
});

test('the link opens the page in the display language, filtered to the reader level', () => {
  assert.equal(readingPicksUrl('en', null), 'https://www.ezfurigana.com/japanese-reading-practice');
  assert.equal(readingPicksUrl('ko', 'n3'), 'https://www.ezfurigana.com/ko/japanese-reading-practice?level=n3');
  assert.equal(readingPicksUrl('zh-CN', 'n5'), 'https://www.ezfurigana.com/zh/japanese-reading-practice?level=beginner');
  assert.equal(readingPicksUrl('zh-TW', 'beyond'), 'https://www.ezfurigana.com/zh-hant/japanese-reading-practice?level=n1');
  assert.equal(readingPicksUrl('en', 'skipped'), 'https://www.ezfurigana.com/japanese-reading-practice');
  // The page is for learners of Japanese, so Japanese readers are not shown it.
  assert.equal(readingPicksAvailable('ja'), false);
  assert.equal(readingPicksAvailable('en'), true);
});
