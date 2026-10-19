/*
Module: review-prompt
Purpose: Decide when the popup may ask for a store review and build localized store review links.

Inputs:
- Usage records (first-seen time and distinct local days with successful furigana), prompt state, the current time, a store name, and the UI language.

Outputs:
- Show/hide decisions with the next prompt state, updated usage records, and fixed store review URLs.

Side Effects:
- None; the background persists usage and the popup persists prompt state in chrome.storage.local.

Failure Modes:
- Missing or malformed records are treated as empty, so the prompt stays hidden until usage is recorded again.

Security Notes:
- Store URLs come from a fixed list; only timestamps, local dates, and counters are stored, never page content or words.
- Every reader is sent to the store to rate freely; no rating is collected or filtered here.
*/
export const REVIEW_USAGE_KEY = 'reviewPromptUsage';
export const REVIEW_STATE_KEY = 'reviewPromptState';

const DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEW_PROMPT_RULES = Object.freeze({
  minDaysSinceFirstSeen: 7,
  minActiveDays: 3,
  // An ask stays visible across popup openings for one day, then rests.
  askVisibleMs: DAY_MS,
  restMs: 30 * DAY_MS,
  maxAsks: 3,
});
const MAX_ACTIVE_DAYS = 7;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const STORE_REVIEW_URLS = Object.freeze({
  chrome: 'https://chromewebstore.google.com/detail/tsukeru-for-ezfurigana/lmfkndmjigoadbmidhlenapakagnbkpc/reviews',
  edge: 'https://microsoftedge.microsoft.com/addons/detail/tsukeru-for-ezfurigana/cdlcehkdgoaboeapgjdhnklgicmiknia',
  firefox: 'https://addons.mozilla.org/{locale}/firefox/addon/tsukeru-for-ezfurigana/',
});
// Store locale codes for the extension's display languages.
const STORE_LANGUAGES = Object.freeze({ en: 'en', ja: 'ja', ko: 'ko', 'zh-TW': 'zh-TW' });
const FIREFOX_LANGUAGES = Object.freeze({ en: 'en-US', ja: 'ja', ko: 'ko', 'zh-TW': 'zh-TW' });

export function localDay(now) {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const finiteTime = value => (Number.isFinite(value) && value > 0 ? value : 0);

function normalizeUsage(usage) {
  const days = Array.isArray(usage?.activeDays)
    ? usage.activeDays.filter(day => typeof day === 'string' && DAY_PATTERN.test(day))
    : [];
  return { firstSeenAt: finiteTime(usage?.firstSeenAt), activeDays: [...new Set(days)].slice(-MAX_ACTIVE_DAYS) };
}

function normalizeState(state) {
  const asks = Number.isInteger(state?.asks) && state.asks > 0 ? state.asks : 0;
  return {
    asks,
    lastAskAt: finiteTime(state?.lastAskAt),
    restUntil: finiteTime(state?.restUntil),
    done: state?.done === true,
  };
}

/** Start the usage clock at install, or at the update that introduced the prompt. */
export function markFirstSeen(usage, now) {
  const current = normalizeUsage(usage);
  if (current.firstSeenAt) return { usage: current, changed: false };
  return { usage: { ...current, firstSeenAt: now }, changed: true };
}

/** Record a local day with successful furigana; at most one change per day. */
export function recordUsageDay(usage, now) {
  const current = normalizeUsage(usage);
  const day = localDay(now);
  if (current.firstSeenAt && current.activeDays.includes(day)) return { usage: current, changed: false };
  return {
    usage: {
      firstSeenAt: current.firstSeenAt || now,
      activeDays: [...current.activeDays.filter(value => value !== day), day].slice(-MAX_ACTIVE_DAYS),
    },
    changed: true,
  };
}

export function decideReviewPrompt(usage, state, now, rules = REVIEW_PROMPT_RULES) {
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

/** `later` rests the prompt; `reviewed` and `never` end it permanently. */
export function dismissReviewPrompt(state, action, now, rules = REVIEW_PROMPT_RULES) {
  const current = normalizeState(state);
  if (action === 'later') return { ...current, restUntil: now + rules.restMs };
  if (action === 'reviewed' || action === 'never') return { ...current, done: true };
  return current;
}

export function storeReviewUrl(store, language) {
  const template = STORE_REVIEW_URLS[store] || STORE_REVIEW_URLS.chrome;
  if (store === 'firefox') {
    return template.replace('{locale}', FIREFOX_LANGUAGES[language] || FIREFOX_LANGUAGES.en);
  }
  const url = new URL(template);
  url.searchParams.set('hl', STORE_LANGUAGES[language] || STORE_LANGUAGES.en);
  return url.toString();
}
