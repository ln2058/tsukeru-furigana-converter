/*
Module: bg-discover
Purpose: Own Discover's reading state in the background: the reading visit of each tab opened from Discover (its pages and how much was read), the reader's history that the ranker learns from, the days an article was read to the end (which join the My Words streak), the website's last streak, and the queue of anonymous counts sent to EZFurigana.

Inputs:
- Articles opened from the popup, `discoverSession` and `discoverProgress` messages from the content script on those tabs, `discoverNote` messages from the popup (shown, hidden, unhidden, reset), and the website's streak from the EZFurigana sync.
- The stored Discover feed (`bg-api`), for the article behind an ID.

Outputs:
- The article's start and end snippets and length for the tab's content script; the visit's outcome.
- Reading days for the EZFurigana sync push.
- Batched `{ id, kind }` counts (`shown`, `opened`, `finished`) posted through `bg-api`.

Side Effects:
- `chrome.storage.session`: `discoverVisits` (per tab: article ID, page totals, active time), dropped after three hours or when replaced.
- `chrome.storage.local`: `discoverHistory` (per article: outcome, time, category, site, style, length), `discoverReadDays`, `discoverSiteStreak`, and `discoverCrowd` (the unsent counts and today's already-counted ones).

Failure Modes:
- Storage failures reject the request; the next one reads storage again. A failed count post keeps the counts for the next try, bounded.
- Progress from tabs without a visit, or for another article, is ignored.

Security Notes:
- Only this extension's content scripts and popup reach these handlers (checked in background.js); a page cannot report reading for itself.
- Page addresses are kept only in session storage, to tell an article's pages apart; nothing with an address, title or reading history leaves the browser. The counts carry only an article ID and a kind, without cookies or any identifier.
*/
import './discover-reading.js';
import { articleFeatures, calendarDay, noteOutcome, normalizeHistory, DISCOVER_HISTORY_KEY } from './discover-rank.js';
import { discoverArticle, postDiscoverEvents } from './bg-api.js';

const Reading = globalThis.TsukeruDiscoverReading;

const VISITS_KEY = 'discoverVisits';
const READ_DAYS_KEY = 'discoverReadDays';
const SITE_STREAK_KEY = 'discoverSiteStreak';
const CROWD_KEY = 'discoverCrowd';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VISIT_MS = 3 * 60 * 60 * 1000;
const MAX_VISITS = 20;
const MAX_PAGES = 8;
const MAX_READ_DAYS = 14;
const MAX_QUEUE = 200;
const MAX_POST = 40;
const FLUSH_GAP_MS = 60 * 1000;
const RANK = { opened: 1, skimmed: 2, finished: 3 };

let queue = Promise.resolve();

/** Run `work` after earlier Discover writes, so two messages never overwrite each other. */
function serial(work) {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

async function read(area, key, fallback) {
  const value = (await chrome.storage[area].get(key))[key];
  return value === undefined ? fallback : value;
}

function pageKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.slice(0, 300);
  } catch (_) {
    return '';
  }
}

function liveVisits(stored, now) {
  return Object.fromEntries(Object.entries(stored && typeof stored === 'object' ? stored : {})
    .filter(([, visit]) => visit && Number(visit.at) > now - VISIT_MS)
    .slice(-MAX_VISITS));
}

async function updateHistory(article, outcome, now) {
  const history = await read('local', DISCOVER_HISTORY_KEY, {});
  const next = noteOutcome(history, article, outcome, now);
  await chrome.storage.local.set({ [DISCOVER_HISTORY_KEY]: next });
}

async function noteReadDay(now) {
  const today = calendarDay(now);
  const days = await read('local', READ_DAYS_KEY, []);
  const kept = [...new Set([...(Array.isArray(days) ? days : []), today])]
    .filter((day) => typeof day === 'string' && DAY_RE.test(day) && day <= today)
    .sort()
    .slice(-MAX_READ_DAYS);
  await chrome.storage.local.set({ [READ_DAYS_KEY]: kept });
}

// ── Anonymous counts ─────────────────────────────────────────────────────────

/** Queue one count, at most once a day per article and kind. */
async function queueCount(id, kind, now) {
  const day = calendarDay(now);
  const stored = await read('local', CROWD_KEY, {});
  const counted = stored.day === day && Array.isArray(stored.counted) ? stored.counted : [];
  const key = `${kind}:${id}`;
  if (counted.includes(key)) return;
  const pending = Array.isArray(stored.queue) ? stored.queue : [];
  await chrome.storage.local.set({
    [CROWD_KEY]: {
      day,
      counted: [...counted, key].slice(-MAX_QUEUE * 2),
      queue: [...pending, { id, kind }].slice(-MAX_QUEUE),
      sentAt: Number(stored.sentAt) || 0,
    },
  });
}

/** Post the queued counts, at most once a minute; unsent ones stay for the next try. */
async function flushCounts(now) {
  const batch = await serial(async () => {
    const stored = await read('local', CROWD_KEY, {});
    const pending = Array.isArray(stored.queue) ? stored.queue : [];
    if (!pending.length || now - (Number(stored.sentAt) || 0) < FLUSH_GAP_MS) return null;
    await chrome.storage.local.set({ [CROWD_KEY]: { ...stored, sentAt: now } });
    return pending.slice(0, MAX_POST);
  });
  if (!batch || !(await postDiscoverEvents(batch))) return;
  await serial(async () => {
    const latest = await read('local', CROWD_KEY, {});
    const rest = (Array.isArray(latest.queue) ? latest.queue : []).slice(batch.length);
    await chrome.storage.local.set({ [CROWD_KEY]: { ...latest, queue: rest } });
  });
}

function flushSoon(now) {
  void flushCounts(now).catch(() => {});
}

// ── Visits ───────────────────────────────────────────────────────────────────

/** A tab opened `article` from Discover: start its visit and count the open. */
export function startDiscoverVisit(tabId, article, now = Date.now()) {
  return serial(async () => {
    const visits = liveVisits(await read('session', VISITS_KEY, {}), now);
    delete visits[tabId];
    visits[tabId] = {
      id: article.id,
      url: article.url,
      startText: article.start_text || '',
      endText: article.end_text || '',
      units: Reading.articleUnits(article.chars),
      features: articleFeatures(article),
      at: now,
      pages: {},
      outcome: 'opened',
    };
    await chrome.storage.session.set({ [VISITS_KEY]: visits });
    await updateHistory(article, 'opened', now);
    await queueCount(article.id, 'opened', now);
  }).finally(() => flushSoon(now));
}

/**
 * What the content script on `tab` needs to measure reading: the article's snippets and
 * length, how much earlier pages covered, and whether this address continues the article's. Null without a visit.
 */
export function discoverVisitFor(tab, now = Date.now()) {
  return serial(async () => {
    const visit = liveVisits(await read('session', VISITS_KEY, {}), now)[tab?.id];
    if (!visit || !tab?.url) return null;
    const key = pageKey(tab.url);
    const others = Object.entries(visit.pages || {}).filter(([page]) => page !== key);
    const earlier = others.reduce((sum, [, page]) => sum + (Number(page.length) || 0), 0);
    return {
      id: visit.id,
      startText: visit.startText,
      endText: visit.endText,
      units: visit.units,
      remaining: Math.max(0, visit.units - earlier),
      later: others.length > 0,
      sameArticle: Reading.samePathStem(visit.url, tab.url),
    };
  });
}

function count(value, max) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : 0;
}

/** Progress on one page of a visit; gives the visit's outcome, recording it when it improved. */
export function noteDiscoverProgress(tab, progress, now = Date.now()) {
  return serial(async () => {
    const visits = liveVisits(await read('session', VISITS_KEY, {}), now);
    const visit = visits[tab?.id];
    if (!visit || progress?.id !== visit.id) return null;
    const key = pageKey(tab.url);
    if (!key) return null;
    const pages = { ...(visit.pages || {}) };
    if (!pages[key] && Object.keys(pages).length >= MAX_PAGES) return visit.outcome;
    const before = pages[key] || { length: 0, credited: 0, end: false, activeMs: 0 };
    const length = count(progress.length, 200000);
    pages[key] = {
      length: Math.max(before.length, length),
      credited: Math.max(before.credited, Math.min(count(progress.credited, 200000), length || before.length)),
      end: before.end || progress.end === true,
      activeMs: Math.max(before.activeMs, count(progress.activeMs, VISIT_MS)),
    };
    const activeMs = Object.values(pages).reduce((sum, page) => sum + page.activeMs, 0);
    const outcome = Reading.readingOutcome(Object.values(pages), { units: visit.units, activeMs });
    const improved = (RANK[outcome] || 0) > (RANK[visit.outcome] || 0);
    visits[tab.id] = { ...visit, pages, outcome: improved ? outcome : visit.outcome };
    await chrome.storage.session.set({ [VISITS_KEY]: visits });
    if (improved) {
      await updateHistory({ id: visit.id, ...featureArticle(visit.features) }, outcome, now);
      if (outcome === 'finished') {
        await noteReadDay(now);
        await queueCount(visit.id, 'finished', now);
      }
    }
    return visits[tab.id].outcome;
  }).finally(() => flushSoon(now));
}

// The history keeps features, not articles; this shapes them back for `noteOutcome`.
function featureArticle([category, source, style]) {
  return { category, source: { id: source }, style, chars: 0 };
}

// ── Popup notes ──────────────────────────────────────────────────────────────

/** The popup showed, hid or unhid an article, or reset what Discover learned. */
export function noteDiscoverEvent(id, kind, now = Date.now()) {
  if (kind === 'reset') {
    return serial(() => chrome.storage.local.set({ [DISCOVER_HISTORY_KEY]: {} })).then(() => true);
  }
  if (!ID_RE.test(String(id)) || !['shown', 'hidden', 'unhidden'].includes(kind)) return Promise.resolve(false);
  return serial(async () => {
    const article = kind === 'unhidden' ? { id } : await discoverArticle(id, now);
    if (!article) return false;
    await updateHistory(article, kind, now);
    if (kind === 'shown') await queueCount(id, 'shown', now);
    return true;
  }).finally(() => flushSoon(now));
}

// ── Streak ───────────────────────────────────────────────────────────────────

/** Days this browser finished a Discover article, for the EZFurigana sync push. */
export async function discoverReadDays() {
  const days = await read('local', READ_DAYS_KEY, []);
  return (Array.isArray(days) ? days : []).filter((day) => typeof day === 'string' && DAY_RE.test(day)).slice(-MAX_READ_DAYS);
}

/** The website's streak from its sync snapshot ({ count, day }); a missing or malformed one changes nothing. */
export async function noteSiteStreak(streak) {
  if (!streak || typeof streak !== 'object') return;
  const value = Number.isInteger(streak.count) && streak.count >= 0 ? Math.min(streak.count, 100000) : null;
  const day = typeof streak.day === 'string' && DAY_RE.test(streak.day) ? streak.day : null;
  if (value === null) return;
  await chrome.storage.local.set({ [SITE_STREAK_KEY]: { count: value, day } });
}

export { normalizeHistory, READ_DAYS_KEY as DISCOVER_READ_DAYS_KEY, SITE_STREAK_KEY as DISCOVER_SITE_STREAK_KEY };
