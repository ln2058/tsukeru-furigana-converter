/*
Module: bg-discover
Purpose: Own Discover's reading state in the background: the reading visit of each tab opened from Discover (its pages and how much was read), the reader's history that the ranker learns from (with their likes and dislikes), the days an article was read to the end (which join the My Words streak), the website's last streak, the days Discover was opened, and the queue of anonymous counts and success counters sent to EZFurigana.

Inputs:
- Articles opened from the popup (with where they were chosen), `discoverSession`, `discoverProgress`, `discoverVote` and `discoverMissing` messages from the content script on those tabs, `discoverNote` messages from the popup (shown, hidden, unhidden, liked, disliked, unvoted, tab, picks_short, daily_done, all_viewed, level_filter, reset), and the website's streak from the EZFurigana sync.
- The stored Discover feed (`bg-api`), for the article behind an ID.

Outputs:
- The article's start and end snippets and length for the tab's content script; the visit's outcome.
- Reading days for the EZFurigana sync push.
- Batched `{ id, kind }` counts (`shown`, `opened`, `finished`, `liked`, `disliked`, `hidden`, `not_found`) and `{ name, dims }` success counters posted through `bg-api`.

Side Effects:
- `chrome.storage.session`: `discoverVisits` (per tab: article ID, page totals, active time, the counters' dimensions), dropped after three hours or when replaced.
- `chrome.storage.local`: `discoverHistory` (per article: outcome, time, category, site, style, length, vote), `discoverReadDays`, `discoverOpenDays`, `discoverSiteStreak`, and `discoverCrowd` (the unsent counts and counters, and today's already-counted ones).

Failure Modes:
- Storage failures reject the request; the next one reads storage again. A failed count post keeps the counts for the next try, bounded.
- Progress from tabs without a visit, or for another article, is ignored.

Security Notes:
- Only this extension's content scripts and popup reach these handlers (checked in background.js); a page cannot report reading for itself.
- Page addresses are kept only in session storage, to tell an article's pages apart; nothing with an address, title or reading history leaves the browser. The counts carry only an article ID and a kind, and the counters only a fixed name and short fixed dimension values (the backend keeps only its allowlisted ones), without cookies or any identifier.
*/
import './discover-reading.js';
import { articleFeatures, calendarDay, noteOutcome, noteVote, normalizeHistory, DISCOVER_HISTORY_KEY } from './discover-rank.js';
import { statDims } from './discover.js';
import { discoverArticle, postDiscoverEvents } from './bg-api.js';

const Reading = globalThis.TsukeruDiscoverReading;

const VISITS_KEY = 'discoverVisits';
const READ_DAYS_KEY = 'discoverReadDays';
const SITE_STREAK_KEY = 'discoverSiteStreak';
const CROWD_KEY = 'discoverCrowd';
const OPEN_DAYS_KEY = 'discoverOpenDays';
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
const DIM_KEYS = new Set(['view', 'position', 'category', 'level', 'reason', 'known', 'streak', 'reader_level']);
const DIM_VALUE_RE = /^[A-Za-z0-9_+-]{1,24}$/;
const VOTE_KINDS = { liked: 1, disliked: -1, unvoted: 0 };

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

// ── Anonymous counts and success counters ────────────────────────────────────

/** The counter dimensions a sender gave, keeping only known keys with short plain values. */
function cleanDims(dims) {
  if (!dims || typeof dims !== 'object') return {};
  return Object.fromEntries(Object.entries(dims)
    .filter(([key, value]) => DIM_KEYS.has(key) && typeof value === 'string' && DIM_VALUE_RE.test(value)));
}

/** Queue items; with `onceKey`, only the first time today. False when already counted. */
async function enqueue(items, now, onceKey = '') {
  const day = calendarDay(now);
  const stored = await read('local', CROWD_KEY, {});
  const counted = stored.day === day && Array.isArray(stored.counted) ? stored.counted : [];
  if (onceKey && counted.includes(onceKey)) return false;
  const pending = Array.isArray(stored.queue) ? stored.queue : [];
  await chrome.storage.local.set({
    [CROWD_KEY]: {
      day,
      counted: onceKey ? [...counted, onceKey].slice(-MAX_QUEUE * 2) : counted,
      queue: [...pending, ...items].slice(-MAX_QUEUE),
      sentAt: Number(stored.sentAt) || 0,
    },
  });
  return true;
}

/** Queue one count, with its success counter, at most once a day per article and kind. */
function queueCount(id, kind, now, dims = null) {
  return enqueue([{ id, kind }, ...(dims ? [{ name: kind, dims }] : [])], now, `${kind}:${id}`);
}

function queueStat(name, now, dims = {}, onceKey = '') {
  return enqueue([{ name, dims }], now, onceKey);
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
  if (!batch) return;
  const events = batch.filter((item) => typeof item?.id === 'string' && typeof item.kind === 'string');
  const stats = batch.filter((item) => typeof item?.name === 'string').map(({ name, dims }) => ({ name, dims: cleanDims(dims) }));
  if (!(await postDiscoverEvents(events, stats))) return;
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

/** A tab opened `article` from Discover (`dims`: where the popup showed it): start its visit and count the open. */
export function startDiscoverVisit(tabId, article, now = Date.now(), dims = null) {
  const counted = { ...statDims(article), ...cleanDims(dims) };
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
      dims: counted,
    };
    await chrome.storage.session.set({ [VISITS_KEY]: visits });
    await updateHistory(article, 'opened', now);
    await queueCount(article.id, 'opened', now, counted);
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
        await queueCount(visit.id, 'finished', now, cleanDims(visit.dims));
      }
    }
    return visits[tab.id].outcome;
  }).finally(() => flushSoon(now));
}

/** The reader liked or disliked the article on `tab` after finishing it (the toast's buttons). */
export function voteFromTab(tab, kind, now = Date.now()) {
  if (!(kind in VOTE_KINDS) || kind === 'unvoted') return Promise.resolve(false);
  return serial(async () => {
    const visit = liveVisits(await read('session', VISITS_KEY, {}), now)[tab?.id];
    if (!visit || visit.outcome !== 'finished') return false;
    return applyVote(visit.id, kind, cleanDims(visit.dims), now);
  }).finally(() => flushSoon(now));
}

/** The article on `tab` could not be found on its page: count it once per visit. */
export function missingFromTab(tab, now = Date.now()) {
  return serial(async () => {
    const visits = liveVisits(await read('session', VISITS_KEY, {}), now);
    const visit = visits[tab?.id];
    if (!visit || visit.missing) return false;
    visits[tab.id] = { ...visit, missing: true };
    await chrome.storage.session.set({ [VISITS_KEY]: visits });
    const category = cleanDims(visit.dims).category;
    await queueCount(visit.id, 'not_found', now, category ? { category } : {});
    return true;
  }).finally(() => flushSoon(now));
}

async function applyVote(id, kind, dims, now) {
  const history = await read('local', DISCOVER_HISTORY_KEY, {});
  if (normalizeHistory(history)[id]?.o !== 'finished') return false;
  await chrome.storage.local.set({ [DISCOVER_HISTORY_KEY]: noteVote(history, id, VOTE_KINDS[kind]) });
  if (kind !== 'unvoted') await queueCount(id, kind, now, dims);
  return true;
}

/** Note today as a day Discover was opened; how many of the last 14 days it was, as the counters' band. */
async function noteOpenDay(now) {
  const today = calendarDay(now);
  const since = calendarDay(now - 13 * 24 * 60 * 60 * 1000);
  const stored = await read('local', OPEN_DAYS_KEY, []);
  const days = [...new Set([...(Array.isArray(stored) ? stored : []), today])]
    .filter((day) => typeof day === 'string' && DAY_RE.test(day) && day >= since && day <= today)
    .sort();
  await chrome.storage.local.set({ [OPEN_DAYS_KEY]: days });
  if (days.length >= 8) return '8+';
  if (days.length >= 4) return '4-7';
  return days.length >= 2 ? '2-3' : '1';
}

// The history keeps features, not articles; this shapes them back for `noteOutcome`.
function featureArticle([category, source, style]) {
  return { category, source: { id: source }, style, chars: 0 };
}

// ── Popup notes ──────────────────────────────────────────────────────────────

/**
 * The popup showed, hid, unhid, liked or disliked an article (`dims`: where it showed it), or the reader
 * opened the tab, read all of today's picks, opened the full list or reset what Discover learned.
 */
export function noteDiscoverEvent(id, kind, now = Date.now(), dims = null) {
  const given = cleanDims(dims);
  if (kind === 'reset') {
    return serial(async () => {
      await chrome.storage.local.set({ [DISCOVER_HISTORY_KEY]: {} });
      await queueStat('reset', now);
    }).then(() => true).finally(() => flushSoon(now));
  }
  if (kind === 'tab') {
    return serial(async () => {
      const days14 = await noteOpenDay(now);
      await queueStat('tab_opened', now);
      const { streak, reader_level: readerLevel } = given;
      await queueStat('reader_day', now, { days14, ...(streak ? { streak } : {}), ...(readerLevel ? { reader_level: readerLevel } : {}) }, 'reader_day');
      return true;
    }).finally(() => flushSoon(now));
  }
  if (kind === 'daily_done' || kind === 'all_viewed') {
    return serial(() => queueStat(kind, now, {}, kind === 'daily_done' ? 'daily_done' : '')).then(() => true).finally(() => flushSoon(now));
  }
  if (kind === 'picks_short' || kind === 'level_filter') {
    const kept = kind === 'picks_short'
      ? (given.reader_level ? { reader_level: given.reader_level } : {})
      : (given.level ? { level: given.level } : {});
    return serial(() => queueStat(kind, now, kept, kind === 'picks_short' ? 'picks_short' : '')).then(() => true).finally(() => flushSoon(now));
  }
  if (!ID_RE.test(String(id))) return Promise.resolve(false);
  if (kind in VOTE_KINDS) {
    return serial(() => applyVote(id, kind, given, now)).finally(() => flushSoon(now));
  }
  if (!['shown', 'hidden', 'unhidden'].includes(kind)) return Promise.resolve(false);
  return serial(async () => {
    const article = kind === 'unhidden' ? { id } : await discoverArticle(id, now);
    if (!article) return false;
    await updateHistory(article, kind, now);
    if (kind !== 'unhidden') await queueCount(id, kind, now, { ...statDims(article), ...given });
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
