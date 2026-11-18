/*
Module: kakurenbo-slip
Purpose: Decide when My Words may suggest EZFurigana's daily word game, かくれんぼ, and build its localized link.

Inputs:
- The review-prompt usage record (first-seen time and days with successful furigana), the slip's state, the current time, and the UI language.

Outputs:
- Show/hide decisions with the next state, and a fixed ezfurigana.com URL.

Side Effects:
- None; the popup persists the state in chrome.storage.local.

Failure Modes:
- Missing or malformed records are treated as empty, so the slip stays hidden.

Security Notes:
- Links only to a fixed path on https://www.ezfurigana.com; the only query value is the fixed `from=tsukeru` tag. Stores only timestamps and counters.
*/
import { normalizeUsage } from './review-prompt.js';

export const KAKURENBO_SLIP_STATE_KEY = 'kakurenboSlipState';

const DAY_MS = 24 * 60 * 60 * 1000;
// Puzzle 1 starts at midnight on 19 November 2026 in Japan.
export const KAKURENBO_LAUNCH_AT = Date.UTC(2026, 10, 18, 15);
export const KAKURENBO_SLIP_RULES = Object.freeze({
  minDaysSinceFirstSeen: 3,
  minActiveDays: 2,
  // A suggestion stays across popup openings for one day.
  askVisibleMs: DAY_MS,
  // The next showing comes a week later, or two weeks after Not now.
  gapMs: 7 * DAY_MS,
  restMs: 14 * DAY_MS,
  maxAsks: 4,
});

// The game's page in each display language.
const PAGE_PREFIXES = Object.freeze({ en: '', ja: '/jp', ko: '/ko', 'zh-CN': '/zh', 'zh-TW': '/zh-hant' });

const finiteTime = value => (Number.isFinite(value) && value > 0 ? value : 0);

function normalizeState(state) {
  return {
    asks: Number.isInteger(state?.asks) && state.asks > 0 ? state.asks : 0,
    lastAskAt: finiteTime(state?.lastAskAt),
    restUntil: finiteTime(state?.restUntil),
    done: state?.done === true,
  };
}

export function decideKakurenboSlip(usage, state, now, rules = KAKURENBO_SLIP_RULES) {
  const current = normalizeState(state);
  const records = normalizeUsage(usage);
  const hide = { show: false, state: current };
  if (now < KAKURENBO_LAUNCH_AT) return hide;
  if (current.done || !records.firstSeenAt) return hide;
  if (now - records.firstSeenAt < rules.minDaysSinceFirstSeen * DAY_MS) return hide;
  if (records.activeDays.length < rules.minActiveDays) return hide;
  if (now < current.restUntil) return hide;
  if (current.lastAskAt && now - current.lastAskAt < rules.askVisibleMs) return { show: true, state: current };
  if (current.lastAskAt && now - current.lastAskAt < rules.gapMs) return hide;
  if (current.asks >= rules.maxAsks) return hide;
  return { show: true, state: { ...current, asks: current.asks + 1, lastAskAt: now } };
}

/** `later` rests the slip; `opened` ends it, since the reader has found the game. */
export function dismissKakurenboSlip(state, action, now, rules = KAKURENBO_SLIP_RULES) {
  const current = normalizeState(state);
  if (action === 'later') return { ...current, restUntil: now + rules.restMs };
  if (action === 'opened') return { ...current, done: true };
  return current;
}

export function kakurenboUrl(language) {
  const prefix = PAGE_PREFIXES[language] ?? '';
  const url = new URL(`https://www.ezfurigana.com${prefix}/japanese-wordle`);
  url.searchParams.set('from', 'tsukeru');
  return url.toString();
}
