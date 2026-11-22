/*
Module: popup-discover
Purpose: Show the Discover tab: today's picks (about five articles chosen for this reader, with why each was picked, how many are read and the reading streak), the last few articles read to the end, and one tap away the full feed filtered by level and category. Each card has its picture (or a tile in its category's colour), its JLPT tag, how much of it the reader knows, and how many of their learning words it has; a finished article's card has like and dislike buttons.

Inputs:
- The Discover feed from the background (`discoverFeed`), the reader's word states (`wordsGetStates`), the vocabulary estimate (`vocabGet`), the stored hidden/opened record, reading history, today's picks, reading days and the website's streak, and popup clicks and scrolling.

Outputs:
- Today's picks and recently read articles, or the filter chips and article list, loaded a page at a time as the list scrolls; `discoverOpen` requests for a chosen article, with where it was shown; `discoverNote` messages (picks shown, an article hidden, liked or disliked, the tab opened, today's picks short of readable articles, all picks read, the full list opened, a level filter chosen, a reset of what Discover learned), each with the fixed dimensions of the anonymous success counters.
- A mark on the Discover tab when a new day's picks are waiting.

Side Effects:
- Reads and writes the hidden/opened record (`discoverState`) and today's picks (`discoverDaily`) in chrome.storage.local; reads the history, reading days and website streak that bg-discover writes.
- Opening an article asks the background to open it in a new tab with furigana, which closes the popup.

Failure Modes:
- Without a feed the tab shows a retry message; without a chosen level the cards show only their JLPT tag.
- If the background cannot open the article, the browser opens it directly, without automatic furigana or reading measurement.

Security Notes:
- Article text is inserted with textContent only. The background opens articles by ID from its stored feed; the popup's own fallback opens only that same feed's https address.
- Word states, the reader's level and what Discover learned stay on this device; coverage and picks are worked out here. Counter notes carry only fixed bands (where and in which place a card was shown, its category, level, pick reason and known band; the streak and level bands), never words, titles or addresses.
- Card pictures load only from EZFurigana's picture path, without cookies or a referrer; the article's own site is not contacted until the reader opens the article.
*/
import { t } from './popup-settings.js';
import { coverageWordsOf, pageKnownShare } from './popup-vocab.js';
import {
  DISCOVER_CATEGORIES,
  DISCOVER_LEVELS,
  DISCOVER_STATE_KEY,
  articleRawWords,
  discoverThumbUrl,
  markArticle,
  normalizeDiscoverState,
  selectArticles,
  statDims,
} from './discover.js';
import {
  DISCOVER_DAILY_KEY,
  DISCOVER_HISTORY_KEY,
  DAILY_SIZE,
  calendarDay,
  combinedStreak,
  dailySet,
  normalizeDaily,
  normalizeHistory,
  noteVote,
  pickDay,
  rankEntries,
  readableCount,
  recentReads,
  voteOf,
} from './discover-rank.js';

const PAGE_SIZE = 15;
const RECENT_SIZE = 5;
// Written by bg-discover.
const READ_DAYS_KEY = 'discoverReadDays';
const SITE_STREAK_KEY = 'discoverSiteStreak';

let loading = null;
let entries = [];
let record = normalizeDiscoverState(null);
let history = {};
let daily = null;
let view = 'today';
let filters = { category: 'all', level: 'for_you' };
let shown = [];
let rendered = 0;
let observer = null;
let chooseLevel = () => {};
let readerLevel = 'none';

const byId = (id) => document.getElementById(id);

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn('Tsukeru: Discover request failed', error?.message);
    return null;
  }
}

async function readStored() {
  try {
    return await chrome.storage.local.get([DISCOVER_STATE_KEY, DISCOVER_HISTORY_KEY, DISCOVER_DAILY_KEY, READ_DAYS_KEY, SITE_STREAK_KEY]);
  } catch (_) {
    return {};
  }
}

function saveRecord() {
  chrome.storage.local.set({ [DISCOVER_STATE_KEY]: record }).catch(() => {});
}

// Category names, written out so the locale check sees every key.
const CATEGORY_LABELS = {
  learner: () => t('discover_category_learner', undefined, 'Learner-written'),
  did_you_know: () => t('discover_category_did_you_know', undefined, 'Did you know'),
  science: () => t('discover_category_science', undefined, 'Science & nature'),
  tech: () => t('discover_category_tech', undefined, 'Technology'),
  news: () => t('discover_category_news', undefined, 'News'),
  culture: () => t('discover_category_culture', undefined, 'Culture & history'),
  food_travel: () => t('discover_category_food_travel', undefined, 'Food & travel'),
  anime_games: () => t('discover_category_anime_games', undefined, 'Anime, manga & games'),
  entertainment_sports: () => t('discover_category_entertainment_sports', undefined, 'Entertainment & sports'),
  life_society: () => t('discover_category_life_society', undefined, 'Life & society'),
  stories: () => t('discover_category_stories', undefined, 'Stories'),
};
const categoryLabel = (category) => CATEGORY_LABELS[category]?.() || '';

const REASONS = {
  category: (reason) => (categoryLabel(reason.category)
    ? t('discover_reason_category', [categoryLabel(reason.category)], `Because you read ${categoryLabel(reason.category)}`)
    : ''),
  source: (reason) => t('discover_reason_source', [reason.name], `From ${reason.name}, a site you read`),
  crowd: () => t('discover_reason_crowd', undefined, 'Readers often finish this one'),
  level: () => t('discover_reason_level', undefined, 'A good fit for your level'),
  explore: () => t('discover_reason_explore', undefined, 'Something new to try'),
};
const reasonText = (reason) => (reason && REASONS[reason.kind] ? REASONS[reason.kind](reason) : '');

const STATUS = {
  loading: () => t('discover_loading', undefined, 'Loading articles…'),
  empty: () => t('discover_empty', undefined, 'No articles match these filters.'),
  error: () => t('discover_error', undefined, "Couldn't load articles. Check your connection and try again."),
  today_empty: () => t('discover_today_empty', undefined, 'No new picks today. See all articles below.'),
};

/** Show a status line instead of the list ('loading', 'empty', 'error'), or hide it with null. */
function setStatus(kind) {
  byId('discoverStatus').hidden = !kind;
  if (kind) byId('discoverStatusText').textContent = STATUS[kind]();
  byId('discoverRetry').hidden = kind !== 'error';
}

function chip(label, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'level-chip';
  button.textContent = label;
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function renderFilters() {
  const articles = entries.map(({ article }) => article);
  const levels = DISCOVER_LEVELS.filter((level) => articles.some((article) => article.jlpt === level));
  const categories = DISCOVER_CATEGORIES.filter((category) => articles.some((article) => article.category === category));
  byId('discoverLevels').replaceChildren(
    chip(t('discover_for_you', undefined, 'For you'), filters.level === 'for_you', () => setFilter({ level: 'for_you' })),
    ...levels.map((level) => chip(level, filters.level === level, () => setFilter({ level }))),
  );
  byId('discoverCategories').replaceChildren(
    chip(t('discover_all', undefined, 'All'), filters.category === 'all', () => setFilter({ category: 'all' })),
    ...categories.map((category) => chip(
      categoryLabel(category),
      filters.category === category,
      () => setFilter({ category }),
    )),
  );
}

function scrollToTop() {
  document.querySelector('.content')?.scrollTo({ top: 0 });
}

function setFilter(change) {
  if (change.level && change.level !== 'for_you' && change.level !== filters.level) {
    void send({ action: 'discoverNote', kind: 'level_filter', dims: { level: change.level } });
  }
  filters = { ...filters, ...change };
  renderFilters();
  renderList();
  scrollToTop();
}

function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

const outcomeOf = (id) => normalizeHistory(history)[id]?.o || '';

const THUMB_CSS_PX = 72;

/** The card's picture, over a tile in the category's colour with the site's first letter, which stays when there is no picture or it fails to load. */
function thumbnail(article) {
  const frame = document.createElement('span');
  frame.className = 'discover-card-thumb';
  frame.dataset.category = article.category || '';
  frame.setAttribute('aria-hidden', 'true');
  const initial = span('discover-card-thumb-initial', Array.from(article.source.name)[0] || '');
  initial.lang = 'ja';
  frame.append(initial);
  const src = discoverThumbUrl(article);
  if (!src) return frame;
  const image = document.createElement('img');
  image.alt = '';
  image.width = THUMB_CSS_PX;
  image.height = THUMB_CSS_PX;
  image.loading = 'lazy';
  image.decoding = 'async';
  // No cookies or referrer go with the picture request.
  image.crossOrigin = 'anonymous';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => { frame.dataset.loaded = 'true'; }, { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = src;
  frame.append(image);
  return frame;
}

const STREAK_BANDS = [[31, '31+'], [8, '8-30'], [4, '4-7'], [2, '2-3'], [1, '1']];
const streakBand = (count) => (STREAK_BANDS.find(([least]) => count >= least) || [0, '0'])[1];

function voteButton(article, kind, text, label, dims, onVote) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'discover-card-vote';
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  const value = kind === 'liked' ? 1 : -1;
  button.setAttribute('aria-pressed', String(voteOf(history, article.id) === value));
  button.addEventListener('click', () => {
    const next = voteOf(history, article.id) === value ? 0 : value;
    history = noteVote(history, article.id, next);
    void send({ action: 'discoverNote', id: article.id, kind: next ? kind : 'unvoted', dims });
    onVote();
  });
  return button;
}

/** Like and dislike buttons for a finished article's card. */
function votes(article, dims) {
  const box = document.createElement('div');
  box.className = 'discover-card-votes';
  const refresh = () => {
    for (const button of box.children) {
      const value = button.dataset.kind === 'liked' ? 1 : -1;
      button.setAttribute('aria-pressed', String(voteOf(history, article.id) === value));
    }
  };
  const up = voteButton(article, 'liked', '👍', t('discover_vote_up', undefined, 'I enjoyed it'), dims, refresh);
  up.dataset.kind = 'liked';
  const down = voteButton(article, 'disliked', '👎', t('discover_vote_down', undefined, 'Not for me'), dims, refresh);
  down.dataset.kind = 'disliked';
  box.append(up, down);
  return box;
}

/** `place`: where the card is shown ({ view, index }), for the anonymous counters. */
function card({ article, pct, label, learning }, reason = null, place = { view: 'all', index: 0 }) {
  const dims = statDims(article, { ...place, reason, pct });
  const item = document.createElement('li');
  item.className = 'discover-card';
  const outcome = outcomeOf(article.id);
  item.dataset.read = String(record.read.includes(article.id));
  if (outcome === 'finished' || outcome === 'skimmed') item.dataset.outcome = outcome;

  const link = document.createElement('a');
  link.className = 'discover-card-link';
  link.href = article.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openArticle(article, dims);
  });

  const why = reasonText(reason);
  const meta = span('discover-card-meta', '');
  meta.append(span('discover-card-source', article.source.name));
  if (article.category) meta.append(span('', `· ${categoryLabel(article.category)}`));
  if (article.minutes) meta.append(span('', `· ${t('discover_minutes', [String(article.minutes)], `${article.minutes} min`)}`));

  const title = span('discover-card-title', article.title);
  title.lang = 'ja';
  const excerpt = span('discover-card-excerpt', article.excerpt);
  excerpt.lang = 'ja';

  const foot = span('discover-card-foot', '');
  if (outcome === 'finished') foot.append(span('discover-card-outcome', t('discover_card_finished', undefined, 'Read')));
  else if (outcome === 'skimmed') foot.append(span('discover-card-outcome', t('discover_card_started', undefined, 'Started')));
  if (article.jlpt) {
    const level = span('discover-card-level', article.jlpt);
    level.dataset.jlpt = article.jlpt.slice(1);
    foot.append(level);
  }
  if (typeof pct === 'number') {
    const known = span('discover-card-known', t('discover_known', [String(pct)], `You know ${pct}%`));
    if (label) known.dataset.difficulty = label;
    foot.append(known);
  }
  if (learning > 0) {
    foot.append(span('discover-card-learning', learning === 1
      ? t('discover_learning_one', undefined, "1 word you're learning")
      : t('discover_learning_many', [String(learning)], `${learning} words you're learning`)));
  }

  const body = span('discover-card-body', '');
  body.append(meta, title, excerpt, foot);
  if (why) body.prepend(span('discover-card-reason', why));
  link.append(thumbnail(article), body);

  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'discover-card-hide';
  hide.textContent = '×';
  hide.title = t('discover_hide', undefined, 'Hide');
  hide.setAttribute('aria-label', hide.title);
  hide.addEventListener('click', () => {
    record = markArticle(record, article.id, 'hidden');
    saveRecord();
    void send({ action: 'discoverNote', id: article.id, kind: 'hidden', dims });
    item.remove();
    shown = shown.filter((entry) => entry.article.id !== article.id);
    rendered = Math.max(0, rendered - 1);
    if (view === 'today') renderToday();
    else if (!shown.length) renderList();
  });

  item.append(link, hide);
  if (outcome === 'finished') item.append(votes(article, dims));
  return item;
}

function renderMore() {
  const list = byId('discoverList');
  const next = shown.slice(rendered, rendered + PAGE_SIZE);
  list.append(...next.map((entry, offset) => card(entry, null, { view: 'all', index: rendered + offset })));
  rendered += next.length;
}

function renderList() {
  const filtered = selectArticles(entries, { ...filters, state: record });
  shown = filters.level === 'for_you' ? rankEntries(filtered, history, { now: Date.now() }) : filtered;
  rendered = 0;
  const list = byId('discoverList');
  list.replaceChildren();
  list.hidden = !shown.length;
  setStatus(shown.length ? null : 'empty');
  renderMore();
}

function renderStreak() {
  const streak = combinedStreak(lastStored[SITE_STREAK_KEY], lastStored[READ_DAYS_KEY], calendarDay(Date.now()));
  const line = byId('discoverStreak');
  line.hidden = streak.count <= 0;
  if (streak.count <= 0) return;
  const days = streak.count === 1
    ? t('discover_streak_one', undefined, '1-day streak')
    : t('discover_streak_many', [String(streak.count)], `${streak.count}-day streak`);
  line.textContent = streak.today ? days : t('discover_streak_keep', [days], `${days}: read one to the end to keep it`);
  line.dataset.today = String(streak.today);
}

/** Today's picks that are still in the feed and not hidden, each with its entry and reason. */
function todayPicks() {
  const byArticle = new Map(entries.map((entry) => [entry.article.id, entry]));
  const hidden = new Set(record.hidden);
  return (daily?.picks || [])
    .filter((pick) => byArticle.has(pick.id) && !hidden.has(pick.id))
    .map((pick) => ({ entry: byArticle.get(pick.id), reason: pick.reason }));
}

/** The last few articles read to the end that are still in the feed, not hidden and not among today's picks. */
function renderRecent(picks) {
  const byArticle = new Map(entries.map((entry) => [entry.article.id, entry]));
  const hidden = new Set(record.hidden);
  const ids = recentReads(history, { limit: RECENT_SIZE * 3, exclude: picks.map(({ entry }) => entry.article.id) })
    .filter((id) => byArticle.has(id) && !hidden.has(id))
    .slice(0, RECENT_SIZE);
  byId('discoverRecentList').replaceChildren(...ids.map((id, index) => card(byArticle.get(id), null, { view: 'recent', index })));
  byId('discoverRecent').hidden = view !== 'today' || !ids.length;
}

function renderToday() {
  const picks = todayPicks();
  const read = picks.filter(({ entry }) => outcomeOf(entry.article.id) === 'finished').length;
  const done = picks.length > 0 && read >= picks.length;
  byId('discoverProgress').textContent = done
    ? t('discover_today_done', undefined, 'All read. New picks tomorrow.')
    : t('discover_today_progress', [String(read), String(picks.length)], `${read} of ${picks.length} read`);
  if (done) void send({ action: 'discoverNote', kind: 'daily_done' });
  renderStreak();
  const list = byId('discoverList');
  list.replaceChildren(...picks.map(({ entry, reason }, index) => card(entry, reason, { view: 'today', index })));
  list.hidden = !picks.length;
  shown = picks.map(({ entry }) => entry);
  rendered = shown.length;
  setStatus(picks.length ? null : 'today_empty');
  renderRecent(picks);
}

function setView(next) {
  view = next;
  const today = view === 'today';
  byId('discoverToday').hidden = !today;
  byId('discoverFilters').hidden = today;
  byId('discoverViewToggle').textContent = today
    ? t('discover_show_all', undefined, 'Show all articles')
    : t('discover_show_today', undefined, "Back to today's picks");
  byId('discoverResetRow').hidden = today;
  if (today) renderToday();
  else {
    byId('discoverRecent').hidden = true;
    renderFilters();
    renderList();
  }
  scrollToTop();
}

async function openArticle(article, dims) {
  record = markArticle(record, article.id, 'read');
  await chrome.storage.local.set({ [DISCOVER_STATE_KEY]: record }).catch(() => {});
  const response = await send({ action: 'discoverOpen', id: article.id, dims });
  if (response?.success) return;
  // The background could not open it: open the same feed address without automatic furigana.
  try {
    await chrome.tabs.create({ url: article.url, active: true });
  } catch (_) {
    window.open(article.url, '_blank', 'noopener,noreferrer');
  }
}

function watchScrolling() {
  observer?.disconnect();
  observer = new IntersectionObserver((seen) => {
    if (view === 'all' && seen.some((entry) => entry.isIntersecting) && rendered < shown.length) renderMore();
  }, { root: document.querySelector('.content'), rootMargin: '0px 0px 240px 0px' });
  observer.observe(byId('discoverMore'));
}

let lastStored = {};

/** Today's picks: the stored ones for today, else a new set (stored, and its articles noted as shown). */
async function ensureDaily(now) {
  const day = pickDay(now);
  daily = normalizeDaily(lastStored[DISCOVER_DAILY_KEY], day);
  if (daily?.picks.length) return;
  daily = { day, picks: dailySet(entries, history, { day, now, hidden: record.hidden }) };
  await chrome.storage.local.set({ [DISCOVER_DAILY_KEY]: daily }).catch(() => {});
  // Fewer articles at the reader's level than places: unmet demand at that level.
  if (readerLevel !== 'none' && readableCount(entries, history, { hidden: record.hidden }) < DAILY_SIZE) {
    void send({ action: 'discoverNote', kind: 'picks_short', dims: { reader_level: readerLevel } });
  }
  const byArticle = new Map(entries.map((entry) => [entry.article.id, entry]));
  daily.picks.forEach((pick, index) => {
    const entry = byArticle.get(pick.id);
    const dims = entry ? statDims(entry.article, { view: 'today', index, reason: pick.reason, pct: entry.pct }) : null;
    void send({ action: 'discoverNote', id: pick.id, kind: 'shown', dims });
  });
}

async function load() {
  setStatus('loading');
  byId('discoverList').hidden = true;
  const [feedResponse, statesResponse, estimateResponse, stored] = await Promise.all([
    send({ action: 'discoverFeed' }),
    send({ action: 'wordsGetStates' }),
    send({ action: 'vocabGet' }),
    readStored(),
  ]);
  const feed = feedResponse?.success ? feedResponse.feed : null;
  if (!feed || !Array.isArray(feed.articles)) {
    loading = null;
    setStatus('error');
    return;
  }
  lastStored = stored;
  record = normalizeDiscoverState(stored[DISCOVER_STATE_KEY]);
  history = normalizeHistory(stored[DISCOVER_HISTORY_KEY]);
  const states = statesResponse?.success && statesResponse.states ? statesResponse.states : {};
  const estimate = estimateResponse?.success
    ? { ready: estimateResponse.ready === true, ability: Number(estimateResponse.ability), level: typeof estimateResponse.level === 'string' ? estimateResponse.level : null }
    : null;
  // The known share needs a chosen level; before that, cards show only their JLPT tag.
  const hasLevel = Boolean(estimate?.level);
  readerLevel = hasLevel ? estimate.level : 'none';
  entries = feed.articles.map((article) => {
    const words = coverageWordsOf(articleRawWords(article));
    const share = hasLevel ? pageKnownShare(words, states, estimate) : null;
    const learning = words.reduce((count, word) => count + (states[word.id] === 'learning' ? 1 : 0), 0);
    return { article, pct: share?.pct ?? null, label: share?.label ?? null, learning };
  });
  await ensureDaily(Date.now());
  const streak = combinedStreak(lastStored[SITE_STREAK_KEY], lastStored[READ_DAYS_KEY], calendarDay(Date.now()));
  void send({ action: 'discoverNote', kind: 'tab', dims: { streak: streakBand(streak.count), reader_level: readerLevel } });
  byId('discoverLevelNote').hidden = hasLevel;
  byId('discoverSampleNote').hidden = feed.prototype !== true;
  markTab(false);
  setView(view);
  watchScrolling();
}

function markTab(fresh) {
  const tab = document.querySelector('.tab-btn[data-tab="discover"]');
  if (!tab) return;
  tab.classList.toggle('has-new', fresh);
  if (fresh) tab.setAttribute('aria-description', t('discover_new_today', undefined, 'New picks today'));
  else tab.removeAttribute('aria-description');
}

/** Mark the Discover tab when today's picks have not been seen yet. */
export async function markNewDiscoverDay(now = Date.now()) {
  try {
    const stored = (await chrome.storage.local.get(DISCOVER_DAILY_KEY))[DISCOVER_DAILY_KEY];
    if (!byId('discover-tab')?.classList.contains('active')) markTab(!normalizeDaily(stored, pickDay(now)));
  } catch (_) { /* No mark. */ }
}

async function resetLearning() {
  const button = byId('discoverReset');
  button.disabled = true;
  const response = await send({ action: 'discoverNote', kind: 'reset' });
  if (response?.success) {
    history = {};
    button.textContent = t('discover_reset_done', undefined, 'Done. Discover will learn again from what you read.');
    renderList();
  } else {
    button.disabled = false;
  }
}

/** Wire the tab's buttons; `onChooseLevel` opens where the reader's level is set (Settings). */
export function initDiscover({ onChooseLevel } = {}) {
  if (typeof onChooseLevel === 'function') chooseLevel = onChooseLevel;
  byId('discoverRetry')?.addEventListener('click', () => { void showDiscover(); });
  byId('discoverLevelAction')?.addEventListener('click', () => chooseLevel());
  byId('discoverViewToggle')?.addEventListener('click', () => {
    if (view === 'today') void send({ action: 'discoverNote', kind: 'all_viewed' });
    setView(view === 'today' ? 'all' : 'today');
  });
  byId('discoverReset')?.addEventListener('click', () => { void resetLearning(); });
  void markNewDiscoverDay();
}

/** Load the feed the first time the tab is shown (and again after a failure). */
export function showDiscover() {
  if (!loading) loading = load().catch((error) => {
    console.warn('Tsukeru: Discover failed', error?.message);
    loading = null;
    setStatus('error');
  });
  return loading;
}

/** Work the cards out again (the reader's level changed): now if Discover is open, else when next shown. */
export function resetDiscover() {
  loading = null;
  if (byId('discover-tab')?.classList.contains('active')) void showDiscover();
}
