/*
Module: discover-rank
Purpose: Learn what this reader likes in Discover and pick the day's articles: a reading history (shown, opened, skimmed, finished, hidden per article, and the reader's like or dislike of a finished one), a decaying Beta profile per category, site, style and length, a day-seeded Thompson-sampled daily set with an exploration slot and variety caps, the reason shown on each pick, and the streak that joins EZFurigana's review days with reading days.

Inputs:
- Feed articles (from `discover`), the reader's coverage and learning-word counts per article, the stored history, the anonymous crowd counts, the day key, and the time.

Outputs:
- The next history, a profile, scores, the daily set ({ id, reason } picks), the full-feed order, the recently read articles, and streak figures.

Side Effects:
- None; bg-discover stores the history and the popup stores the day's set.

Failure Modes:
- Malformed history entries are dropped; with no history every category starts at the same prior, so the first sets lean on level fit, freshness and the crowd.

Security Notes:
- The history and profile stay in this browser's storage; nothing here is sent anywhere.
*/
import { fitScore } from './discover.js';

export const DISCOVER_HISTORY_KEY = 'discoverHistory';
export const DISCOVER_DAILY_KEY = 'discoverDaily';
export const DAILY_SIZE = 5;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 500;
const HALF_LIFE_DAYS = 30;
const PRIOR_MEAN = 0.3;
const PRIOR_STRENGTH = 4;
// How each outcome teaches the profile: a reward in [0, 1] and how much it counts.
const OUTCOMES = Object.freeze({
  shown: { rank: 0, reward: 0, weight: 0.25 },
  opened: { rank: 1, reward: 0.05, weight: 1 },
  skimmed: { rank: 2, reward: 0.4, weight: 1 },
  finished: { rank: 3, reward: 1, weight: 1 },
  hidden: { rank: 4, reward: 0, weight: 2 },
});
// A vote on a finished article: liked counts as a full reward twice over; disliked as almost none.
const VOTES = Object.freeze({ 1: { reward: 1, weight: 2 }, [-1]: { reward: 0.1, weight: 1.5 } });
const FAMILIES = Object.freeze([['c', 0.45], ['s', 0.25], ['y', 0.15], ['l', 0.15]]);
const PER_CATEGORY = 2;
const PER_SOURCE = 2;
const EXPLORE_SLOT = 2;
const EXPLORE_EVIDENCE = 1;
// The day's set turns over at 4 a.m. local time, so late-night reading stays in the same day.
const DAY_START_HOURS = 4;

/** The local calendar day ('YYYY-MM-DD') of `time`. */
export function calendarDay(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The daily set's day: the calendar day, starting at 4 a.m. */
export function pickDay(time) {
  return calendarDay(time - DAY_START_HOURS * 60 * 60 * 1000);
}

export function lengthBucket(chars) {
  if (!(chars > 0)) return '';
  if (chars < 1500) return 'short';
  if (chars < 4000) return 'medium';
  return 'long';
}

/** The features the profile learns from: category, site, style and length bucket. */
export function articleFeatures(article) {
  return [
    article?.category || '',
    article?.source?.id || '',
    article?.style || '',
    lengthBucket(article?.chars),
  ].map((value) => String(value).slice(0, 40));
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || !OUTCOMES[entry.o] || !Number.isFinite(entry.t)) return null;
  const features = Array.isArray(entry.f) ? entry.f.slice(0, 4).map((value) => (typeof value === 'string' ? value.slice(0, 40) : '')) : [];
  while (features.length < 4) features.push('');
  const vote = entry.o === 'finished' && (entry.v === 1 || entry.v === -1) ? entry.v : 0;
  return vote ? { o: entry.o, t: entry.t, f: features, v: vote } : { o: entry.o, t: entry.t, f: features };
}

/** The stored history ({ [articleId]: { o: outcome, t: time, f: features, v?: 1 | -1 } }) with bad entries dropped. */
export function normalizeHistory(history) {
  const entries = Object.entries(history && typeof history === 'object' ? history : {})
    .filter(([id]) => ID_RE.test(id))
    .map(([id, entry]) => [id, normalizeEntry(entry)])
    .filter(([, entry]) => entry)
    .sort(([, a], [, b]) => b.t - a.t)
    .slice(0, MAX_HISTORY);
  return Object.fromEntries(entries);
}

/**
 * The history after `outcome` for `article`. Outcomes only move up (shown, opened, skimmed,
 * finished), except hidden, which replaces any of them; 'unhidden' forgets the article.
 */
export function noteOutcome(history, article, outcome, now) {
  const current = normalizeHistory(history);
  const id = article?.id;
  if (!ID_RE.test(String(id))) return current;
  if (outcome === 'unhidden') {
    if (current[id]?.o === 'hidden') delete current[id];
    return current;
  }
  const next = OUTCOMES[outcome];
  if (!next) return current;
  const previous = current[id];
  if (previous && OUTCOMES[previous.o].rank >= next.rank && outcome !== 'hidden') return current;
  if (previous?.o === 'hidden') return current;
  current[id] = { o: outcome, t: now, f: previous?.f?.some(Boolean) ? previous.f : articleFeatures(article) };
  return normalizeHistory(current);
}

/** The history after the reader liked (1) or disliked (-1) a finished article; 0 takes the vote back. Others are unchanged. */
export function noteVote(history, id, vote) {
  const current = normalizeHistory(history);
  const entry = current[id];
  if (!entry || entry.o !== 'finished' || ![1, -1, 0].includes(vote)) return current;
  const { v, ...rest } = entry;
  current[id] = vote ? { ...rest, v: vote } : rest;
  return current;
}

/** The reader's vote on an article (1, -1), or 0. */
export function voteOf(history, id) {
  return normalizeHistory(history)[id]?.v || 0;
}

/** The IDs of the latest finished articles, newest first. */
export function recentReads(history, { limit = 5, exclude = [] } = {}) {
  const skip = new Set(exclude);
  return Object.entries(normalizeHistory(history))
    .filter(([id, entry]) => entry.o === 'finished' && !skip.has(id))
    .slice(0, limit)
    .map(([id]) => id);
}

/** The decaying Beta profile: per feature `${family}:${value}`, its { a, b, n } and the reader's mean reward. */
export function buildProfile(history, now) {
  const entries = Object.values(normalizeHistory(history));
  let rewardSum = 0;
  let weightSum = 0;
  const counted = entries.map((entry) => {
    const outcome = (entry.v && VOTES[entry.v]) || OUTCOMES[entry.o];
    const decay = 0.5 ** (Math.max(0, now - entry.t) / (HALF_LIFE_DAYS * DAY_MS));
    const weight = outcome.weight * decay;
    rewardSum += weight * outcome.reward;
    weightSum += weight;
    return { entry, weight, reward: outcome.reward };
  });
  const mean = (rewardSum + PRIOR_MEAN * PRIOR_STRENGTH) / (weightSum + PRIOR_STRENGTH);
  const features = {};
  for (const { entry, weight, reward } of counted) {
    FAMILIES.forEach(([family], index) => {
      const value = entry.f[index];
      if (!value) return;
      const key = `${family}:${value}`;
      const feature = features[key] || (features[key] = { a: mean * PRIOR_STRENGTH, b: (1 - mean) * PRIOR_STRENGTH, n: 0 });
      feature.a += weight * reward;
      feature.b += weight * (1 - reward);
      feature.n += weight;
    });
  }
  return { mean, features };
}

/** A seeded generator (mulberry32), so a day's draws are the same every time the popup opens. */
export function seededRandom(seed) {
  let state = 0;
  for (const char of String(seed)) state = (Math.imul(state ^ char.charCodeAt(0), 2654435761) + 0x9e3779b9) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

// Marsaglia and Tsang's gamma draw (shape >= 1; smaller shapes boosted).
function gamma(shape, random) {
  if (shape < 1) return gamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    if (Math.log(Math.max(random(), 1e-12)) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return d;
}

function betaDraw(a, b, random) {
  const x = gamma(a, random);
  const y = gamma(b, random);
  return x + y > 0 ? x / (x + y) : a / (a + b);
}

function featureOf(profile, family, value) {
  const prior = { a: profile.mean * PRIOR_STRENGTH, b: (1 - profile.mean) * PRIOR_STRENGTH, n: 0 };
  return value ? profile.features[`${family}:${value}`] || prior : prior;
}

/** How much the reader is likely to enjoy the article, above (positive) or below their usual; drawn when `random` is given, else the mean. */
export function interestLift(article, profile, random = null, draws = new Map()) {
  const values = articleFeatures(article);
  let interest = 0;
  FAMILIES.forEach(([family, share], index) => {
    const { a, b } = featureOf(profile, family, values[index]);
    if (!random) {
      interest += share * (a / (a + b));
      return;
    }
    // One draw per feature value, so articles that share a category share its draw.
    const key = `${family}:${values[index]}`;
    if (!draws.has(key)) draws.set(key, betaDraw(a, b, random));
    interest += share * draws.get(key);
  });
  return interest - profile.mean;
}

/** Other readers' finish rate, smoothed so a few counts do not swing it: 1/3 with none. */
export function crowdRate(crowd) {
  const opened = Math.max(0, Number(crowd?.opened) || 0);
  const finished = Math.min(opened, Math.max(0, Number(crowd?.finished) || 0));
  return (finished + 1) / (opened + 3);
}

/** Other readers' share of likes among their votes, smoothed: 1/2 with none. */
export function crowdLikeRate(crowd) {
  const liked = Math.max(0, Number(crowd?.liked) || 0);
  const disliked = Math.max(0, Number(crowd?.disliked) || 0);
  return (liked + 1) / (liked + disliked + 2);
}

function freshness(article, now) {
  const published = Date.parse(article?.published_at || '');
  if (!Number.isFinite(published)) return 0;
  return Math.exp(-Math.max(0, now - published) / (3 * DAY_MS));
}

/**
 * One entry's score ({ article, pct, learning }): interest, how well its level suits the reader
 * (neutral without a level), learning words, the crowd's finish and like rates, and freshness.
 */
export function scoreEntry(entry, profile, { now, random = null, draws } = {}) {
  const fit = typeof entry.pct === 'number' ? fitScore(entry.pct) : 0.5;
  return 2 * interestLift(entry.article, profile, random, draws)
    + 0.6 * fit
    + 0.05 * Math.min(entry.learning || 0, 5)
    + 0.4 * (crowdRate(entry.article.crowd) - 1 / 3)
    + 0.3 * (crowdLikeRate(entry.article.crowd) - 1 / 2)
    + 0.15 * freshness(entry.article, now);
}

function categoryEvidence(profile, category) {
  return featureOf(profile, 'c', category).n;
}

/** Why the article was picked: { kind: 'explore' | 'category' | 'source' | 'crowd' | 'level' }, or null. */
export function pickReason(entry, profile, { explore = false } = {}) {
  if (explore) return { kind: 'explore' };
  const [category, source] = articleFeatures(entry.article);
  const lift = (family, value) => {
    const feature = featureOf(profile, family, value);
    return feature.n >= 1 ? feature.a / (feature.a + feature.b) - profile.mean : 0;
  };
  if (category && lift('c', category) >= 0.08) return { kind: 'category', category };
  if (source && lift('s', source) >= 0.08) return { kind: 'source', name: entry.article.source.name };
  const crowd = entry.article.crowd;
  if ((Number(crowd?.finished) || 0) >= 3 && crowdRate(crowd) >= 0.5) return { kind: 'crowd' };
  if (typeof entry.pct === 'number' && fitScore(entry.pct) >= 1) return { kind: 'level' };
  return null;
}

function seen(history, id) {
  const outcome = history[id]?.o;
  return outcome && outcome !== 'shown';
}

/**
 * The day's picks ({ id, reason }), drawn with a generator seeded by `day`: articles not opened or
 * hidden before, preferring ones the reader can read (when a level is set), at most two per category
 * and per site (relaxed when too few), with one slot for a category the reader has hardly tried.
 */
export function dailySet(entries, history, { day, now, size = DAILY_SIZE, hidden = [] } = {}) {
  const record = normalizeHistory(history);
  const hiddenIds = new Set(hidden);
  const profile = buildProfile(record, now);
  const random = seededRandom(`discover:${day}`);
  const draws = new Map();
  const fresh = (Array.isArray(entries) ? entries : []).filter(({ article }) => !hiddenIds.has(article.id) && !seen(record, article.id));
  const readable = fresh.filter((entry) => typeof entry.pct !== 'number' || fitScore(entry.pct) > 0);
  const pool = (readable.length >= size ? readable : fresh)
    .map((entry) => ({ entry, score: scoreEntry(entry, profile, { now, random, draws }) }))
    .sort((a, b) => b.score - a.score);

  const picks = [];
  const taken = new Set();
  const capsHold = (entry, strict) => {
    if (!strict) return true;
    const sameCategory = picks.filter((pick) => pick.entry.article.category === entry.article.category).length;
    const sameSource = picks.filter((pick) => pick.entry.article.source.id === entry.article.source.id).length;
    return sameCategory < PER_CATEGORY && sameSource < PER_SOURCE;
  };
  const take = (candidate, explore) => {
    taken.add(candidate.entry.article.id);
    picks.push({ entry: candidate.entry, explore });
  };
  for (const strict of [true, false]) {
    for (const candidate of pool) {
      if (picks.length >= size) break;
      if (picks.length === EXPLORE_SLOT && !picks.some((pick) => pick.explore)) {
        const explore = pool.find((other) => !taken.has(other.entry.article.id)
          && other.entry.article.category
          && categoryEvidence(profile, other.entry.article.category) < EXPLORE_EVIDENCE
          && capsHold(other.entry, strict));
        if (explore) take(explore, true);
        if (picks.length >= size) break;
      }
      if (!taken.has(candidate.entry.article.id) && capsHold(candidate.entry, strict)) take(candidate, false);
    }
  }
  return picks.map(({ entry, explore }) => ({ id: entry.article.id, reason: pickReason(entry, profile, { explore }) }));
}

/** The full feed in the reader's order (mean scores, no draws), opened articles last. */
export function rankEntries(entries, history, { now } = {}) {
  const record = normalizeHistory(history);
  const profile = buildProfile(record, now);
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({ entry, index, value: scoreEntry(entry, profile, { now }) - (seen(record, entry.article.id) ? 10 : 0) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map(({ entry }) => entry);
}

/** The stored day's set ({ day, picks }) when it is for `day`, else null. */
export function normalizeDaily(value, day) {
  if (!value || typeof value !== 'object' || value.day !== day || !Array.isArray(value.picks)) return null;
  const picks = value.picks
    .filter((pick) => pick && ID_RE.test(String(pick.id)))
    .slice(0, DAILY_SIZE)
    .map((pick) => ({ id: pick.id, reason: pick.reason && typeof pick.reason === 'object' && typeof pick.reason.kind === 'string' ? pick.reason : null }));
  return { day, picks };
}

function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / DAY_MS);
}

/**
 * Days in a row with a finished review on EZFurigana or a finished Discover article, allowing one
 * missed day between two (EZFurigana's rule): `site` is the website's last { count, day },
 * `readDays` this browser's reading days. { count, today } where `today` means today already counts.
 */
export function combinedStreak(site, readDays, today) {
  let streak = site && Number.isInteger(site.count) && site.count > 0 && DAY_RE.test(String(site.day))
    ? { count: site.count, day: site.day }
    : null;
  const days = [...new Set(Array.isArray(readDays) ? readDays : [])].filter((day) => DAY_RE.test(String(day)) && day <= today).sort();
  for (const day of days) {
    if (streak && day <= streak.day) continue;
    streak = { count: streak && daysBetween(streak.day, day) <= 2 ? streak.count + 1 : 1, day };
  }
  if (!streak || daysBetween(streak.day, today) > 2) return { count: 0, today: false };
  return { count: streak.count, today: streak.day === today };
}
