import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DAY = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 10, 20, 3);
const usage = { firstSeenAt: start, activeDays: ['2026-11-20', '2026-11-21'] };

test('both browsers ship the same word game slip modules', () => {
  for (const file of ['kakurenbo-slip.js', 'popup-kakurenbo.js']) {
    const read = browser => readFileSync(new URL(`../${browser}/js/${file}`, import.meta.url), 'utf8');
    assert.equal(read('firefox'), read('chrome'));
  }
});

const { KAKURENBO_LAUNCH_AT, decideKakurenboSlip, dismissKakurenboSlip, kakurenboUrl } = await import('../chrome/js/kakurenbo-slip.js');

test('the slip waits for the game to start, three days, and two days with furigana', () => {
  const early = { firstSeenAt: KAKURENBO_LAUNCH_AT - 10 * DAY, activeDays: ['2026-11-10', '2026-11-11'] };
  assert.equal(decideKakurenboSlip(early, undefined, KAKURENBO_LAUNCH_AT - 1).show, false);
  assert.equal(decideKakurenboSlip(early, undefined, KAKURENBO_LAUNCH_AT).show, true);
  assert.equal(decideKakurenboSlip(usage, undefined, start + 2 * DAY).show, false);
  assert.equal(decideKakurenboSlip({ firstSeenAt: start, activeDays: ['2026-11-20'] }, undefined, start + 4 * DAY).show, false);
  assert.equal(decideKakurenboSlip(usage, undefined, start + 3 * DAY).show, true);
});

test('a showing lasts a day, comes back a week later, and stops after four', () => {
  let now = start + 3 * DAY;
  let decision = decideKakurenboSlip(usage, undefined, now);
  assert.deepEqual([decision.show, decision.state.asks], [true, 1]);
  const reopened = decideKakurenboSlip(usage, decision.state, now + 2 * 60 * 60 * 1000);
  assert.deepEqual([reopened.show, reopened.state.asks], [true, 1], 'reopening the popup is the same showing');
  assert.equal(decideKakurenboSlip(usage, decision.state, now + 2 * DAY).show, false);
  for (const expected of [2, 3, 4]) {
    now += 7 * DAY;
    decision = decideKakurenboSlip(usage, decision.state, now);
    assert.deepEqual([decision.show, decision.state.asks], [true, expected]);
  }
  assert.equal(decideKakurenboSlip(usage, decision.state, now + 7 * DAY).show, false);
});

test('Not now rests the slip two weeks and opening the game ends it', () => {
  const now = start + 3 * DAY;
  const shown = decideKakurenboSlip(usage, undefined, now).state;
  const rested = dismissKakurenboSlip(shown, 'later', now);
  assert.equal(decideKakurenboSlip(usage, rested, now + 8 * DAY).show, false);
  assert.equal(decideKakurenboSlip(usage, rested, now + 15 * DAY).show, true);
  const opened = dismissKakurenboSlip(shown, 'opened', now);
  assert.equal(decideKakurenboSlip(usage, opened, now + 60 * DAY).show, false);
});

test('the link opens the game in the display language, tagged as from Tsukeru', () => {
  assert.equal(kakurenboUrl('en'), 'https://www.ezfurigana.com/japanese-wordle?from=tsukeru');
  assert.equal(kakurenboUrl('ja'), 'https://www.ezfurigana.com/jp/japanese-wordle?from=tsukeru');
  assert.equal(kakurenboUrl('zh-TW'), 'https://www.ezfurigana.com/zh-hant/japanese-wordle?from=tsukeru');
  assert.equal(kakurenboUrl('xx'), 'https://www.ezfurigana.com/japanese-wordle?from=tsukeru');
});
