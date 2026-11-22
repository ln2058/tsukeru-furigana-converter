/*
Module: popup-discover
Purpose: Show the Discover tab: today's picks (about five articles chosen for this reader, with why each was picked, how many are read and the reading streak), and one tap away the full feed filtered by level and category. Each card has its JLPT tag, how much of it the reader knows, and how many of their learning words it has.

Inputs:
- The Discover feed from the background (`discoverFeed`), the reader's word states (`wordsGetStates`), the vocabulary estimate (`vocabGet`), the stored hidden/opened record, reading history, today's picks, reading days and the website's streak, and popup clicks and scrolling.

Outputs:
- Today's picks or the filter chips and article list, loaded a page at a time as the list scrolls; `discoverOpen` requests for a chosen article; `discoverNote` messages (picks shown, an article hidden, a reset of what Discover learned).
- A mark on the Discover tab when a new day's picks are waiting.

Side Effects:
- Reads and writes the hidden/opened record (`discoverState`) and today's picks (`discoverDaily`) in chrome.storage.local; reads the history, reading days and website streak that bg-discover writes.
- Opening an article asks the background to open it in a new tab with furigana, which closes the popup.

Failure Modes:
- Without a feed the tab shows a retry message; without a chosen level the cards show only their JLPT tag.
- If the background cannot open the article, the browser opens it directly, without automatic furigana or reading measurement.

Security Notes:
- Article text is inserted with textContent only. The background opens articles by ID from its stored feed; the popup's own fallback opens only that same feed's https address.
- Word states, the reader's level and what Discover learned stay on this device; coverage and picks are worked out here.
*/
import { t } from './popup-settings.js';
import { coverageWordsOf, pageKnownShare } from './popup-vocab.js';
import {
  DISCOVER_CATEGORIES,
  DISCOVER_LEVELS,
  DISCOVER_STATE_KEY,
  articleRawWords,
  markArticle,
  normalizeDiscoverState,
  selectArticles,
} from './discover.js';
import {
  DISCOVER_DAILY_KEY,
  DISCOVER_HISTORY_KEY,
  calendarDay,
  combinedStreak,
  dailySet,
  normalizeDaily,
  normalizeHistory,
  pickDay,
  rankEntries,
} from './discover-rank.js';

const PAGE_SIZE = 15;
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

function card({ article, pct, label, learning }, reason = null) {
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
    openArticle(article);
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

  link.append(meta, title, excerpt, foot);
  if (why) link.prepend(span('discover-card-reason', why));

  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'discover-card-hide';
  hide.textContent = '×';
  hide.title = t('discover_hide', undefined, 'Hide');
  hide.setAttribute('aria-label', hide.title);
  hide.addEventListener('click', () => {
    record = markArticle(record, article.id, 'hidden');
    saveRecord();
    void send({ action: 'discoverNote', id: article.id, kind: 'hidden' });
    item.remove();
    shown = shown.filter((entry) => entry.article.id !== article.id);
    rendered = Math.max(0, rendered - 1);
    if (view === 'today') renderToday();
    else if (!shown.length) renderList();
  });

  item.append(link, hide);
  return item;
}

function renderMore() {
  const list = byId('discoverList');
  const next = shown.slice(rendered, rendered + PAGE_SIZE);
  list.append(...next.map((entry) => card(entry)));
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

function renderToday() {
  const picks = todayPicks();
  const read = picks.filter(({ entry }) => outcomeOf(entry.article.id) === 'finished').length;
  byId('discoverProgress').textContent = picks.length && read >= picks.length
    ? t('discover_today_done', undefined, 'All read. New picks tomorrow.')
    : t('discover_today_progress', [String(read), String(picks.length)], `${read} of ${picks.length} read`);
  renderStreak();
  const list = byId('discoverList');
  list.replaceChildren(...picks.map(({ entry, reason }) => card(entry, reason)));
  list.hidden = !picks.length;
  shown = picks.map(({ entry }) => entry);
  rendered = shown.length;
  setStatus(picks.length ? null : 'today_empty');
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
    renderFilters();
    renderList();
  }
  scrollToTop();
}

async function openArticle(article) {
  record = markArticle(record, article.id, 'read');
  await chrome.storage.local.set({ [DISCOVER_STATE_KEY]: record }).catch(() => {});
  const response = await send({ action: 'discoverOpen', id: article.id });
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
  for (const pick of daily.picks) void send({ action: 'discoverNote', id: pick.id, kind: 'shown' });
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
  entries = feed.articles.map((article) => {
    const words = coverageWordsOf(articleRawWords(article));
    const share = hasLevel ? pageKnownShare(words, states, estimate) : null;
    const learning = words.reduce((count, word) => count + (states[word.id] === 'learning' ? 1 : 0), 0);
    return { article, pct: share?.pct ?? null, label: share?.label ?? null, learning };
  });
  await ensureDaily(Date.now());
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
  byId('discoverViewToggle')?.addEventListener('click', () => setView(view === 'today' ? 'all' : 'today'));
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
