/*
Module: reading-picks
Purpose: Decide when the popup may suggest EZFurigana's reading picks page, and build its localized link.

Inputs:
- The review-prompt usage record (first-seen time and days with successful furigana), the reading-picks state, the current time, the UI language, and the reader's level.

Outputs:
- Show/hide decisions with the next state, and a fixed ezfurigana.com URL.

Side Effects:
- None; the popup persists the state in chrome.storage.local.

Failure Modes:
- Missing or malformed records are treated as empty, so the suggestion stays hidden.

Security Notes:
- Links only to a fixed path on https://www.ezfurigana.com; the only query value is a level from a fixed list. Stores only timestamps and counters.
*/
import { normalizeUsage } from './review-prompt.js';

export const READING_PICKS_STATE_KEY = 'readingPicksState';

const DAY_MS = 24 * 60 * 60 * 1000;
export const READING_PICKS_RULES = Object.freeze({
  // Someone who just installed is already reading something.
  minDaysSinceFirstSeen: 2,
  minActiveDays: 1,
  // A suggestion stays across popup openings for one day, then rests.
  askVisibleMs: DAY_MS,
  restMs: 14 * DAY_MS,
  maxAsks: 4,
});

// Page paths for the display languages the page is published in. Japanese
// readers are not the page's audience, so the suggestion stays hidden for them.
const PAGE_PREFIXES = Object.freeze({ en: '', ko: '/ko', 'zh-CN': '/zh', 'zh-TW': '/zh-hant' });
// The page's level filter values for the reader's level.
const FILTER_LEVELS = Object.freeze({
  beginner: 'beginner', n5: 'beginner', n4: 'beginner', n3: 'n3', n2: 'n2', n1: 'n1', beyond: 'n1',
});

const finiteTime = value => (Number.isFinite(value) && value > 0 ? value : 0);

function normalizeState(state) {
  return {
    asks: Number.isInteger(state?.asks) && state.asks > 0 ? state.asks : 0,
    lastAskAt: finiteTime(state?.lastAskAt),
    restUntil: finiteTime(state?.restUntil),
    done: state?.done === true,
  };
}

export function readingPicksAvailable(language) {
  return Object.hasOwn(PAGE_PREFIXES, language);
}

export function decideReadingPicks(usage, state, now, rules = READING_PICKS_RULES) {
  const current = normalizeState(state);
  const records = normalizeUsage(usage);
  const hide = { show: false, state: current };
  if (current.done || !records.firstSeenAt) return hide;
  if (now - records.firstSeenAt < rules.minDaysSinceFirstSeen * DAY_MS) return hide;
  if (records.activeDays.length < rules.minActiveDays) return hide;
  if (now < current.restUntil) return hide;
  if (current.lastAskAt && now - current.lastAskAt < rules.askVisibleMs) return { show: true, state: current };
  if (current.lastAskAt && now - current.lastAskAt < rules.restMs) return hide;
  if (current.asks >= rules.maxAsks) return hide;
  return { show: true, state: { ...current, asks: current.asks + 1, lastAskAt: now } };
}

/** `later` rests the suggestion; `opened` ends it, since the reader has found the page. */
export function dismissReadingPicks(state, action, now, rules = READING_PICKS_RULES) {
  const current = normalizeState(state);
  if (action === 'later') return { ...current, restUntil: now + rules.restMs };
  if (action === 'opened') return { ...current, done: true };
  return current;
}

export function readingPicksUrl(language, level) {
  const prefix = PAGE_PREFIXES[language] ?? '';
  const url = new URL(`https://www.ezfurigana.com${prefix}/japanese-reading-practice`);
  const filter = FILTER_LEVELS[level];
  if (filter) url.searchParams.set('level', filter);
  return url.toString();
}
