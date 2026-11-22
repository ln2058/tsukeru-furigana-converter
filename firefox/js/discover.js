/*
Module: discover
Purpose: Check the Discover feed, turn each article's word list into the page-word shape, give each card picture's address, filter and order articles for the popup's Discover tab, and describe a chosen article for the anonymous success counters.

Inputs:
- Feed bodies from EZFurigana's Discover endpoint (or the bundled prototype sample), the reader's coverage figure and learning-word count per article, the stored hidden/read record, and the chosen filters.

Outputs:
- A checked feed, raw page-style word lists, card picture addresses on EZFurigana, filtered and ordered article lists, the next hidden/read record, and a counter's dimensions (where an article was chosen, its place, category, level, pick reason and known band).

Side Effects:
- None; the popup stores the hidden/read record in chrome.storage.local.

Failure Modes:
- Malformed feeds give null; malformed articles and words are dropped, so a bad entry never breaks the list.

Security Notes:
- Article URLs must be https with a host and no credentials; every text field is bounded plain text, which the popup inserts with textContent.
- Card pictures load only from EZFurigana's fixed picture path (the feed's `thumb` must match it), never from the article's site.
*/

export const DISCOVER_STATE_KEY = 'discoverState';
// Category IDs the backend may send; names live in the locale catalogs as discover_category_<id>.
export const DISCOVER_CATEGORIES = Object.freeze([
  'learner', 'did_you_know', 'science', 'tech', 'news', 'culture', 'food_travel',
  'anime_games', 'entertainment_sports', 'life_society', 'stories',
]);
export const DISCOVER_LEVELS = Object.freeze(['N5', 'N4', 'N3', 'N2', 'N1']);
const DISCOVER_STYLES = Object.freeze(['news_report', 'explainer', 'essay', 'interview', 'review', 'fiction', 'learner']);

const MAX_ARTICLES = 200;
const MAX_WORDS = 4000;
const MAX_STATE_IDS = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CATEGORY_SET = new Set(DISCOVER_CATEGORIES);
const LEVEL_SET = new Set(DISCOVER_LEVELS);
const STYLE_SET = new Set(DISCOVER_STYLES);
// Card pictures are served by EZFurigana itself, named by their digest.
const THUMB_ORIGIN = 'https://www.ezfurigana.com';
const THUMB_PATH_RE = /^\/api\/extension\/discover\/thumb\/[A-Za-z0-9_-]{1,64}-[0-9a-f]{16}\.webp$/;

function count(value, max = 100000000) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : 0;
}

function plain(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

/** One compact word: [surface, dictionary form, lookup reading, reading, JLPT 0-5, band or null, part of speech, count]. */
function normalizeWord(entry) {
  if (!Array.isArray(entry)) return null;
  const [surface, word, lookupReading, reading, jlpt, band, pos, count] = entry;
  if (typeof surface !== 'string' || !surface || surface.length > 40) return null;
  return [
    surface,
    plain(word, 40),
    plain(lookupReading, 60),
    plain(reading, 60),
    Number.isInteger(jlpt) && jlpt >= 0 && jlpt <= 5 ? jlpt : 0,
    Number.isInteger(band) && band >= 0 && band < 64 ? band : null,
    plain(pos, 30),
    Number.isInteger(count) && count > 0 ? Math.min(count, 9999) : 1,
  ];
}

function normalizeArticle(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' && ID_RE.test(entry.id) ? entry.id : '';
  const url = httpsUrl(entry.url);
  const title = plain(entry.title, 200);
  const sourceName = plain(entry.source?.name, 60);
  if (!id || !url || !title || !sourceName) return null;
  const words = (Array.isArray(entry.words) ? entry.words.slice(0, MAX_WORDS) : []).map(normalizeWord).filter(Boolean);
  return {
    id,
    url,
    title,
    excerpt: plain(entry.excerpt, 200),
    source: { id: plain(entry.source?.id, 40), name: sourceName },
    category: CATEGORY_SET.has(entry.category) ? entry.category : '',
    jlpt: LEVEL_SET.has(entry.jlpt) ? entry.jlpt : '',
    minutes: Number.isInteger(entry.minutes) && entry.minutes > 0 ? Math.min(entry.minutes, 120) : null,
    style: STYLE_SET.has(entry.style) ? entry.style : '',
    thumb: typeof entry.thumb === 'string' && THUMB_PATH_RE.test(entry.thumb) ? entry.thumb : '',
    chars: count(entry.chars, 1000000),
    published_at: typeof entry.published_at === 'string' && Number.isFinite(Date.parse(entry.published_at)) ? entry.published_at.slice(0, 40) : '',
    // Where the article starts and ends on its page, for measuring how much of it was read.
    start_text: plain(entry.start_text, 60),
    end_text: plain(entry.end_text, 60),
    crowd: {
      shown: count(entry.crowd?.shown),
      opened: count(entry.crowd?.opened),
      finished: count(entry.crowd?.finished),
      liked: count(entry.crowd?.liked),
      disliked: count(entry.crowd?.disliked),
    },
    words,
  };
}

/** The feed with only well-formed articles (each ID once), or null when the body is not a version 1 feed. */
export function normalizeDiscoverFeed(body) {
  if (!body || typeof body !== 'object' || body.version !== 1 || !Array.isArray(body.articles)) return null;
  const seen = new Set();
  const articles = [];
  for (const entry of body.articles.slice(0, MAX_ARTICLES)) {
    const article = normalizeArticle(entry);
    if (!article || seen.has(article.id)) continue;
    seen.add(article.id);
    articles.push(article);
  }
  return { version: 1, prototype: body.prototype === true, articles };
}

const STAT_VIEWS = new Set(['today', 'all', 'recent']);
const STAT_REASONS = new Set(['category', 'source', 'crowd', 'level', 'explore']);

/** How much of the article the reader knows, as the counters' band ('none' without a level). */
export function knownBand(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'none';
  if (pct < 70) return 'lt70';
  if (pct < 85) return '70-84';
  if (pct < 95) return '85-94';
  return '95+';
}

/** A place in a list (0-based) as the counters' position: 1-5, then 6-15 and 16+. */
export function positionBand(index) {
  const place = Math.floor(Number(index)) + 1;
  if (!(place >= 1)) return '1';
  if (place <= 5) return String(place);
  return place <= 15 ? '6-15' : '16+';
}

/**
 * The dimensions a success counter carries for an article: where it was chosen (`view`), its place there,
 * its category and level, why it was picked, and how much of it the reader knows. Only these fixed values.
 */
export function statDims(article, { view = 'all', index = 0, reason = null, pct = null } = {}) {
  return {
    view: STAT_VIEWS.has(view) ? view : 'all',
    position: positionBand(index),
    category: DISCOVER_CATEGORIES.includes(article?.category) ? article.category : 'none',
    level: DISCOVER_LEVELS.includes(article?.jlpt) ? article.jlpt : 'none',
    reason: STAT_REASONS.has(reason?.kind) ? reason.kind : 'none',
    known: knownBand(pct),
  };
}

/** The address of an article's card picture, or '' when it has none. */
export function discoverThumbUrl(article) {
  const path = article?.thumb;
  return typeof path === 'string' && THUMB_PATH_RE.test(path) ? `${THUMB_ORIGIN}${path}` : '';
}

/** An article's words in the shape the content script reports page words, for `coverageWordsOf`. */
export function articleRawWords(article) {
  return (Array.isArray(article?.words) ? article.words : []).map(([surface, word, lookupReading, reading, jlpt, band, pos, count]) => ({
    surface, word, lookupReading, reading,
    jlpt: jlpt ? String(jlpt) : '',
    band: band === null ? '' : String(band),
    pos,
    frequency: count,
  }));
}

export function normalizeDiscoverState(state) {
  const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, MAX_STATE_IDS) : []);
  return { hidden: ids(state?.hidden), read: ids(state?.read) };
}

/** The record with `id` added to `kind` ('hidden' or 'read'), newest first and bounded. */
export function markArticle(state, id, kind) {
  const current = normalizeDiscoverState(state);
  if (!ID_RE.test(String(id)) || (kind !== 'hidden' && kind !== 'read')) return current;
  return { ...current, [kind]: [id, ...current[kind].filter((other) => other !== id)].slice(0, MAX_STATE_IDS) };
}

/** How well a known-word share suits reading practice: 1 from 90% to 97%, less for easier or harder texts. */
export function fitScore(pct) {
  if (typeof pct !== 'number') return 0;
  if (pct >= 90 && pct <= 97) return 1;
  if (pct > 97) return Math.max(0, 1 - (pct - 97) / 6);
  return Math.max(0, 1 - (90 - pct) / 15);
}

/**
 * Entries ({ article, pct, learning }) to show: hidden ones dropped, then the
 * category and level filters. "For you" orders by fit, with a small lift for
 * learning words and read articles last; otherwise the feed order is kept.
 */
export function selectArticles(entries, { category = 'all', level = 'for_you', state = null } = {}) {
  const record = normalizeDiscoverState(state);
  const hidden = new Set(record.hidden);
  const read = new Set(record.read);
  const shown = (Array.isArray(entries) ? entries : []).filter(({ article }) => (
    !hidden.has(article.id)
    && (category === 'all' || article.category === category)
    && (level === 'for_you' || article.jlpt === level)
  ));
  if (level !== 'for_you') return shown;
  const score = ({ article, pct, learning }) => fitScore(pct) + Math.min(learning || 0, 5) * 0.06 - (read.has(article.id) ? 2 : 0);
  return shown
    .map((entry, index) => ({ entry, index, value: score(entry) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map(({ entry }) => entry);
}
