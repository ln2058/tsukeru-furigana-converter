import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DAY = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 9, 1, 3);
const eligibleUsage = { firstSeenAt: start, activeDays: ['2026-10-01', '2026-10-03', '2026-10-05'] };

test('both browsers ship the same review-prompt and popup-review modules', () => {
  for (const file of ['review-prompt.js', 'popup-review.js']) {
    const read = browser => readFileSync(new URL(`../${browser}/js/${file}`, import.meta.url), 'utf8');
    assert.equal(read('firefox'), read('chrome'));
  }
});

const prompt = await import('../chrome/js/review-prompt.js');
const { decideReviewPrompt, dismissReviewPrompt, recordUsageDay, markFirstSeen, storeReviewUrl } = prompt;

test('the card waits for a week of use on three separate days', () => {
  assert.equal(decideReviewPrompt(eligibleUsage, undefined, start + 6 * DAY).show, false);
  const twoDays = { ...eligibleUsage, activeDays: eligibleUsage.activeDays.slice(0, 2) };
  assert.equal(decideReviewPrompt(twoDays, undefined, start + 8 * DAY).show, false);
  assert.equal(decideReviewPrompt(undefined, undefined, start + 8 * DAY).show, false);
  assert.equal(decideReviewPrompt({ firstSeenAt: 'x', activeDays: 'y' }, undefined, start + 8 * DAY).show, false);
  assert.equal(decideReviewPrompt(eligibleUsage, undefined, start + 7 * DAY).show, true);
});

test('an ask stays for a day, rests for 30 days, and stops after three asks', () => {
  let now = start + 8 * DAY;
  let decision = decideReviewPrompt(eligibleUsage, undefined, now);
  assert.deepEqual([decision.show, decision.state.asks], [true, 1]);
  const reopened = decideReviewPrompt(eligibleUsage, decision.state, now + 2 * 60 * 60 * 1000);
  assert.deepEqual([reopened.show, reopened.state.asks], [true, 1], 'reopening the popup is the same ask');
  assert.equal(decideReviewPrompt(eligibleUsage, decision.state, now + 2 * DAY).show, false);
  for (const expectedAsks of [2, 3]) {
    now += 31 * DAY;
    decision = decideReviewPrompt(eligibleUsage, decision.state, now);
    assert.deepEqual([decision.show, decision.state.asks], [true, expectedAsks]);
  }
  assert.equal(decideReviewPrompt(eligibleUsage, decision.state, now + 31 * DAY).show, false);
});

test('Later rests the card; leaving a review or Don\'t ask again ends it', () => {
  const now = start + 8 * DAY;
  const shown = decideReviewPrompt(eligibleUsage, undefined, now).state;
  const later = dismissReviewPrompt(shown, 'later', now);
  assert.equal(decideReviewPrompt(eligibleUsage, later, now + 1000).show, false);
  assert.equal(decideReviewPrompt(eligibleUsage, later, now + 29 * DAY).show, false);
  assert.equal(decideReviewPrompt(eligibleUsage, later, now + 31 * DAY).show, true);
  for (const action of ['reviewed', 'never']) {
    const done = dismissReviewPrompt(shown, action, now);
    assert.equal(decideReviewPrompt(eligibleUsage, done, now + 400 * DAY).show, false);
  }
});

test('usage records one local day at a time and keeps the first-seen time', () => {
  const now = new Date(2026, 9, 10, 12).getTime();
  const first = recordUsageDay(undefined, now);
  assert.equal(first.changed, true);
  assert.equal(first.usage.firstSeenAt, now);
  assert.deepEqual(first.usage.activeDays, ['2026-10-10']);
  assert.equal(recordUsageDay(first.usage, now + 60 * 1000).changed, false);
  let usage = first.usage;
  for (let day = 1; day <= 9; day += 1) usage = recordUsageDay(usage, now + day * DAY).usage;
  assert.equal(usage.activeDays.length, 7);
  assert.equal(usage.firstSeenAt, now);
  assert.equal(markFirstSeen(usage, now + 50 * DAY).changed, false);
  assert.deepEqual(markFirstSeen(undefined, now).usage, { firstSeenAt: now, activeDays: [] });
});

test('store links open the right store in the display language', () => {
  assert.equal(
    storeReviewUrl('chrome', 'ko'),
    'https://chromewebstore.google.com/detail/tsukeru-for-ezfurigana/lmfkndmjigoadbmidhlenapakagnbkpc/reviews?hl=ko',
  );
  assert.equal(
    storeReviewUrl('edge', 'zh-TW'),
    'https://microsoftedge.microsoft.com/addons/detail/tsukeru-for-ezfurigana/cdlcehkdgoaboeapgjdhnklgicmiknia?hl=zh-TW',
  );
  assert.equal(storeReviewUrl('firefox', 'ja'), 'https://addons.mozilla.org/ja/firefox/addon/tsukeru-for-ezfurigana/');
  assert.equal(storeReviewUrl('firefox', 'en'), 'https://addons.mozilla.org/en-US/firefox/addon/tsukeru-for-ezfurigana/');
  assert.match(storeReviewUrl('unknown', 'xx'), /^https:\/\/chromewebstore\.google\.com\/.*\?hl=en$/);
});

function popupFixture({ statusHidden = true, stored = {} } = {}) {
  const elements = {};
  const element = id => {
    elements[id] = { id, hidden: true, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
    return elements[id];
  };
  element('reviewPrompt');
  element('reviewPromptRate');
  element('reviewPromptLater');
  element('reviewPromptNever');
  element('status').hidden = statusHidden;
  const writes = [];
  globalThis.document = { getElementById: id => elements[id] || null };
  globalThis.chrome = {
    storage: { local: { async get() { return structuredClone(stored); }, async set(value) { writes.push(value); } } },
  };
  return { elements, writes };
}

const { initReviewPrompt } = await import('../chrome/js/popup-review.js');
const eligible = { reviewPromptUsage: eligibleUsage };

test('the popup card yields to notices, links to the store, and saves Later', async () => {
  const blocked = popupFixture({ statusHidden: false, stored: eligible });
  await initReviewPrompt({ store: 'chrome', language: 'ja', now: start + 8 * DAY });
  assert.equal(blocked.elements.reviewPrompt.hidden, true);
  assert.equal(blocked.writes.length, 0, 'a hidden card does not use up an ask');

  const f = popupFixture({ stored: eligible });
  await initReviewPrompt({ store: 'chrome', language: 'ja', now: start + 8 * DAY });
  assert.equal(f.elements.reviewPrompt.hidden, false);
  assert.match(f.elements.reviewPromptRate.href, /\?hl=ja$/);
  assert.equal(f.writes.at(-1).reviewPromptState.asks, 1);
  f.elements.reviewPromptLater.listeners.click();
  await Promise.resolve();
  assert.equal(f.elements.reviewPrompt.hidden, true);
  assert.ok(f.writes.at(-1).reviewPromptState.restUntil > start + 8 * DAY);
});
