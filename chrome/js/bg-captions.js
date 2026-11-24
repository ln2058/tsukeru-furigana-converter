/*
Module: bg-captions
Purpose: Own the daily allowance for furigana in video captions: a one-time preview for readers without an account, a daily allowance for free accounts, and no daily limit for Supporters. Also opens the one-step sign-in from a caption limit card and closes that tab once Tsukeru is connected.

Inputs:
- The connection state from `bg-api` (`getSupporterStatus`, local storage only) and the plan figures (`getSupporterPerks`, `captions`).
- Playback ticks from content scripts (milliseconds of video played with Japanese captions being processed).
- The tab that asked to sign in, and the website tab that later hands over the account token.

Outputs:
- The allowance: `{ state, plan, remainingMs, limitMs }` (and `freeLimitMs` for readers without an account), where `state` is `unlimited`, `free`, `free_done`, `guest`, `guest_done`, or `unchecked` (the plan could not be read; captions keep working).

Side Effects:
- Reads and writes `captionAllowance` in `chrome.storage.local`: the local day, milliseconds counted that day, the preview's milliseconds (counted once per install), and when time was last counted.
- Keeps the sign-in tabs it opened in `chrome.storage.session` (`captionSignInTabs`), opens them with `chrome.tabs.create`, and closes them after the website connects Tsukeru.

Failure Modes:
- Storage failures answer `unchecked`, so a reader is never cut off by our own error.
- Time counted from two tabs at once, or a clock that moves backwards, is counted once at most: each tick adds at most the wall time since the last counted tick, and never more than six seconds.

Security Notes:
- Counting is local by design; the furigana request format and its anonymity do not change, and no account token is sent with captions.
- Ticks and sign-in requests are accepted only from this extension's content scripts in a tab; their values are bounds-checked.
- The sign-in tab only opens the fixed EZFurigana sign-in address; nothing from the page is put in it.
*/
import { getSupporterPerks, getSupporterStatus } from './bg-api.js';
import { localDay } from './review-prompt.js';
import './i18n.js';

export const CAPTION_ALLOWANCE_KEY = 'captionAllowance';
export const DEFAULT_FREE_DAILY_MINUTES = 30;
export const DEFAULT_GUEST_PREVIEW_MINUTES = 5;
// A tick reports at most this much playback (content scripts tick every five seconds).
export const MAX_TICK_MS = 6000;
const PERKS_WAIT_MS = 1500;
const SIGN_IN_TABS_KEY = 'captionSignInTabs';
const MINUTE_MS = 60 * 1000;

const finiteMs = (value) => (Number.isFinite(value) && value > 0 ? Math.min(value, 1e10) : 0);

/** The stored record for `day`: yesterday's count is dropped, the preview's is kept. */
export function cleanAllowanceRecord(raw, day) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const sameDay = record.day === day;
  return {
    day,
    usedMs: sameDay ? finiteMs(record.usedMs) : 0,
    guestUsedMs: finiteMs(record.guestUsedMs),
    lastCountedAt: finiteMs(record.lastCountedAt),
  };
}

/** Which allowance applies: Supporters have none, a connected or lapsed account gets the free one. */
export function captionPlanFor(status) {
  const state = status?.state;
  if (state === 'supporter') return 'supporter';
  if (state === 'free' || state === 'expired') return 'free';
  return 'guest';
}

/** The allowance a plan has left, from a cleaned record and the limits in minutes. */
export function allowanceFor(record, plan, limits = {}) {
  if (plan === 'supporter') return { state: 'unlimited', plan, remainingMs: null, limitMs: null };
  if (plan === 'free') {
    const limitMs = (limits.freeDailyMinutes || DEFAULT_FREE_DAILY_MINUTES) * MINUTE_MS;
    const remainingMs = Math.max(0, limitMs - record.usedMs);
    return { state: remainingMs > 0 ? 'free' : 'free_done', plan, remainingMs, limitMs };
  }
  const limitMs = (limits.guestMinutes || DEFAULT_GUEST_PREVIEW_MINUTES) * MINUTE_MS;
  const remainingMs = Math.max(0, limitMs - record.guestUsedMs);
  // `freeLimitMs` lets the sign-in prompt say what a free account gets each day.
  const freeLimitMs = (limits.freeDailyMinutes || DEFAULT_FREE_DAILY_MINUTES) * MINUTE_MS;
  return { state: remainingMs > 0 ? 'guest' : 'guest_done', plan, remainingMs, limitMs, freeLimitMs };
}

/** Whether captions may be processed under this allowance. */
export function allowanceOpen(allowance) {
  return !['free_done', 'guest_done'].includes(allowance?.state);
}

/**
 * Count one tick of playback. It adds at most the wall time since the last
 * counted tick, so two tabs playing at once count once; Supporters are not counted.
 */
export function countPlayback(record, plan, claimedMs, now) {
  if (plan === 'supporter') return record;
  const since = record.lastCountedAt ? now - record.lastCountedAt : MAX_TICK_MS;
  const counted = Math.max(0, Math.min(finiteMs(claimedMs), MAX_TICK_MS, since));
  const next = { ...record, lastCountedAt: now };
  if (plan === 'free') next.usedMs = record.usedMs + counted;
  else next.guestUsedMs = record.guestUsedMs + counted;
  return next;
}

// Every write goes through this queue, so ticks from several tabs never overwrite each other.
let writes = Promise.resolve();

async function readRecord(now) {
  const stored = await chrome.storage.local.get(CAPTION_ALLOWANCE_KEY);
  return cleanAllowanceRecord(stored[CAPTION_ALLOWANCE_KEY], localDay(now));
}

async function captionLimits() {
  // Plan figures are cached for 12 hours; a slow first request falls back to the defaults.
  const perks = await Promise.race([
    getSupporterPerks().catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), PERKS_WAIT_MS)),
  ]);
  return {
    freeDailyMinutes: perks?.captions?.free || DEFAULT_FREE_DAILY_MINUTES,
    guestMinutes: perks?.captions?.guest || DEFAULT_GUEST_PREVIEW_MINUTES,
  };
}

async function currentPlan() {
  return captionPlanFor(await getSupporterStatus());
}

/** The allowance now, or `unchecked` (captions keep working) when it cannot be read. */
export async function getCaptionAllowance(now = Date.now()) {
  try {
    const [record, plan, limits] = await Promise.all([readRecord(now), currentPlan(), captionLimits()]);
    return allowanceFor(record, plan, limits);
  } catch (_) {
    return { state: 'unchecked', plan: null, remainingMs: null, limitMs: null };
  }
}

/** Count a playback tick from a content script, then answer the allowance left. */
export function noteCaptionPlayback(claimedMs, now = Date.now()) {
  const work = writes.then(async () => {
    const [record, plan, limits] = await Promise.all([readRecord(now), currentPlan(), captionLimits()]);
    if (!allowanceOpen(allowanceFor(record, plan, limits))) return allowanceFor(record, plan, limits);
    const next = countPlayback(record, plan, claimedMs, now);
    if (next !== record) await chrome.storage.local.set({ [CAPTION_ALLOWANCE_KEY]: next });
    return allowanceFor(next, plan, limits);
  });
  writes = work.catch(() => {});
  return work.catch(() => ({ state: 'unchecked', plan: null, remainingMs: null, limitMs: null }));
}

// ── One-step sign-in from a caption limit card ───────────────────────────────

async function readSignInTabs() {
  try {
    const stored = (await chrome.storage.session.get(SIGN_IN_TABS_KEY))[SIGN_IN_TABS_KEY];
    return stored && typeof stored === 'object' ? stored : {};
  } catch (_) {
    return {};
  }
}

/** Open the sign-in page next to the video's tab, and remember both tabs. */
export async function openCaptionSignIn(videoTab) {
  await TsukeruI18n.ready();
  const tab = await chrome.tabs.create({
    url: TsukeruI18n.signInUrl('tsukeru_captions'),
    active: true,
    ...(Number.isInteger(videoTab?.index) && { index: videoTab.index + 1 }),
    ...(Number.isInteger(videoTab?.windowId) && { windowId: videoTab.windowId }),
  });
  if (!tab?.id) return false;
  const tabs = await readSignInTabs();
  // Keep a handful; an abandoned sign-in tab is simply never closed by us.
  const kept = Object.entries(tabs).slice(-4);
  await chrome.storage.session.set({
    [SIGN_IN_TABS_KEY]: { ...Object.fromEntries(kept), [tab.id]: { videoTabId: videoTab.id, windowId: videoTab.windowId } },
  }).catch(() => {});
  return true;
}

/**
 * After the website connected Tsukeru in a sign-in tab we opened: close that
 * tab, return to the video, and tell its page. Other tabs are left alone.
 */
export async function finishCaptionSignIn(signInTabId, plan) {
  if (!Number.isInteger(signInTabId) || (plan !== 'free' && plan !== 'supporter')) return;
  const tabs = await readSignInTabs();
  const entry = tabs[signInTabId];
  if (!entry) return;
  delete tabs[signInTabId];
  await chrome.storage.session.set({ [SIGN_IN_TABS_KEY]: tabs }).catch(() => {});
  const videoTabId = Number(entry.videoTabId);
  if (Number.isInteger(videoTabId)) {
    await chrome.tabs.update(videoTabId, { active: true }).catch(() => {});
    if (Number.isInteger(entry.windowId)) await chrome.windows?.update?.(entry.windowId, { focused: true }).catch(() => {});
    chrome.tabs.sendMessage(videoTabId, { action: 'captionConnected', plan }).catch(() => {});
  }
  await chrome.tabs.remove(signInTabId).catch(() => {});
}
