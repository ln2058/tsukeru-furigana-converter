/*
Module: popup-vocab
Purpose: Power the popup's My Words tab (review strip, Learning / Known lists, exports) and This page tab (Study mode switch, JLPT profile meter, and Words in this text with Learning / Known switches), styled after EZFurigana's My Words and result panel.

Inputs:
- Word records and summaries from the background store, page words from the active tab, the stored Study mode setting, popup UI events, background dictionary and audio responses, and `pageWordsChanged` notices from the active tab's content script.

Outputs:
- Rendered My Words and page word lists (each saved word with a pronunciation button; numbers that share a counter form one 〜年 row with their most frequent uses), Learning/Known/removal requests, Study mode updates, and CSV export downloads.

Side Effects:
- Sends word requests to the background store and page messages to the active tab.
- Coalesces page refreshes, pauses them during word saves, and skips unchanged page-list renders.
- Sends one `playAudio` request per speaker click (none before a click) and plays the clip, or the browser's Japanese voice when it fails.
- Writes the Study mode setting to `chrome.storage.sync` and triggers browser downloads.
- Export fills a bounded number of missing definitions through background lookups and stores them with the words.

Failure Modes:
- Storage/message failures render empty lists; failed definition lookups leave the definition blank.
- The hidden-reading note respects the saved setting.

Security Notes:
- Words, readings, and sentences are written with textContent only.
- CSV cells are neutralized against spreadsheet formulas; exports contain vocabulary fields only, no page URLs.
*/
// My Words tab, This page tab, dictionary helpers for exports.
import {
  DEFAULT_SETTINGS,
  DEFINITION_CACHE_TTL,
  getActiveTab,
  isSupportedPageTab,
  sendWordDisplaySettings,
  t,
} from './popup-settings.js';

// ── Shared utilities ──────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
// Easiest first, like the website's meter; 0 is beyond N1.
const PAGE_LEVEL_ORDER = [5, 4, 3, 2, 1, 0];
const PAGE_INITIAL_ROWS = 60;
// Missing definitions an export looks up, so a large list cannot flood the dictionary.
const EXPORT_DEFINITION_LOOKUPS = 60;

function wordRules() {
  return globalThis.TsukeruWords;
}

export function neutralizeCsvFormulaCell(value) {
  const text = String(value ?? '');
  return /^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function uiLanguage() {
  return (chrome.i18n?.getUILanguage?.() || 'en').toLowerCase();
}

/** EZFurigana in the reader's language; `#review` opens a review of the due words. */
export function ezfuriganaUrl(hash = '') {
  const base = uiLanguage().startsWith('ja') ? 'https://www.ezfurigana.com/jp' : 'https://www.ezfurigana.com/';
  return `${base}${hash}`;
}

function relativeTime(time) {
  const ms = time - Date.now();
  try {
    const format = new Intl.RelativeTimeFormat(uiLanguage(), { numeric: 'auto' });
    const minutes = Math.round(ms / 60000);
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    const hours = Math.round(ms / 3600000);
    if (Math.abs(hours) < 24) return format.format(hours, 'hour');
    return format.format(Math.round(ms / 86400000), 'day');
  } catch (_) {
    return new Date(time).toLocaleDateString();
  }
}

function textSpan(className, text, lang) {
  const span = document.createElement('span');
  span.className = className;
  if (lang) span.lang = lang;
  span.textContent = text;
  return span;
}

function levelTag(level) {
  const tag = textSpan('saved-entry-tag', level ? `N${level}` : t('level_beyond_n1', undefined, 'Beyond N1'));
  tag.dataset.jlpt = String(level);
  return tag;
}

/** A sentence with the word marked, written as text nodes. */
function renderSentence(target, sentence, word) {
  target.replaceChildren();
  const parts = word ? sentence.split(word) : [sentence];
  parts.forEach((part, index) => {
    if (index > 0) {
      const mark = document.createElement('mark');
      mark.className = 'context-highlight';
      mark.textContent = word;
      target.appendChild(mark);
    }
    if (part) target.appendChild(document.createTextNode(part));
  });
}

function cardSentence(record) {
  const sentences = Array.isArray(record.sentences) ? record.sentences : [];
  return sentences.find((sentence) => sentence.includes(record.word)) || sentences[0] || '';
}

async function sendWords(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn('Tsukeru: word request failed', error?.message);
    return null;
  }
}

export function getVocabularyPage(entries, renderedCount = 0, pageSize = VOCABULARY_PAGE_SIZE) {
  const list = Array.isArray(entries) ? entries : [];
  const start = Math.max(0, Number.isFinite(renderedCount) ? renderedCount : 0);
  const size = Math.max(1, Number.isFinite(pageSize) ? pageSize : VOCABULARY_PAGE_SIZE);
  return list.slice(start, start + size);
}

// ── Dictionary helpers (definitions for exports) ──────────────────────────────

export function normalizeDefinitionData(data) {
  const richEntry = data?.source === 'je_dict' && data.entry && typeof data.entry === 'object'
    ? data.entry
    : null;
  if (richEntry) {
    const senses = [];
    const seen = new Set();
    const addSense = (gloss, explanation = '') => {
      const cleaned = String(gloss || '').trim();
      if (!cleaned || seen.has(cleaned.toLocaleLowerCase())) return;
      seen.add(cleaned.toLocaleLowerCase());
      senses.push({ glosses: [cleaned], pos: [], explanation: String(explanation || '').trim() });
    };
    getTextValuesForVocabulary(richEntry.gloss).forEach(gloss => addSense(gloss));
    if (Array.isArray(richEntry.definitions)) {
      richEntry.definitions.forEach(definition => {
        if (!definition || typeof definition !== 'object') return;
        const explanation = getTextValuesForVocabulary(definition.explanation)[0] || '';
        getTextValuesForVocabulary(definition.gloss).forEach(gloss => addSense(gloss, explanation));
      });
    }
    const trimmed = senses.slice(0, 6);
    if (trimmed.length > 0) {
      return {
        senses: trimmed,
        reading: String(richEntry.reading || '').trim()
      };
    }
  }
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return null;
  const entry = data.entries[0];
  const senses = Array.isArray(entry.senses) ? entry.senses : [];
  const trimmed = [];
  for (const sense of senses) {
    const glosses = Array.isArray(sense.glosses) ? sense.glosses.filter(Boolean) : [];
    if (!glosses.length) continue;
    trimmed.push({
      glosses: glosses.slice(0, 3),
      pos: Array.isArray(sense.pos) ? sense.pos.slice(0, 3) : []
    });
    if (trimmed.length >= 6) break;
  }
  return {
    senses: trimmed,
    reading: Array.isArray(entry.kana) && entry.kana.length ? entry.kana.join('、') : ''
  };
}

function getTextValuesForVocabulary(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
  return [];
}

const definitionCache = new Map();

async function lookupDefinition(word, reading = '') {
  const term = String(word || '').trim();
  if (!term) return null;
  const key = JSON.stringify([term, String(reading || '').trim()]);
  const cached = definitionCache.get(key);
  if (cached && Date.now() - cached.timestamp < DEFINITION_CACHE_TTL) return cached.data;
  const message = { action: 'lookupDefinition', word: term };
  if (reading) message.reading = reading;
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.success) {
    const error = new Error(response?.error || 'Definition lookup failed');
    error.rateLimitType = response?.rateLimitType;
    throw error;
  }
  definitionCache.set(key, { data: response.data, timestamp: Date.now() });
  return response.data;
}

function definitionFromData(data) {
  const normalized = normalizeDefinitionData(data);
  return (normalized?.senses || [])
    .slice(0, 2)
    .map((sense) => (sense.glosses || []).join('; '))
    .filter(Boolean)
    .join('; ');
}

// ── My Words tab ──────────────────────────────────────────────────────────────

export const VOCABULARY_PAGE_SIZE = 40;
const LISTS = ['learning', 'known'];
const ICONS = {
  known: ['M5 12.5l4.5 4.5L19 7.5'],
  again: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4v4.5h4.5'],
  remove: ['M6 6l12 12', 'M18 6L6 18'],
  listen: ['M11 5L6 9H3v6h3l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7'],
};

let wordRecords = [];
let wordSummary = null;
let selectedList = 'learning';
let vocabularyRenderedCount = 0;

function icon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  paths.forEach((d) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

function iconButton(className, label, paths) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `word-ledger-action ${className}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(icon(paths));
  return button;
}

// ── Pronunciation ─────────────────────────────────────────────────────────────

// One clip at a time, requested only when a speaker is clicked. Plays the same
// backend-proxied JapanesePod101 clip as the tooltip, falling back to the
// browser's Japanese voice reading the kana.
let audioPlayback = null;

function finishPlayback(playback) {
  playback.button.classList.remove('is-playing');
  if (audioPlayback === playback) audioPlayback = null;
}

function stopPlayback() {
  if (!audioPlayback) return;
  const playback = audioPlayback;
  playback.stopped = true;
  if (playback.audio) playback.audio.pause();
  if (playback.speaking) globalThis.speechSynthesis.cancel();
  finishPlayback(playback);
}

function speakReading(playback, kana) {
  if (playback.stopped || playback.failed) return;
  playback.failed = true;
  if (!globalThis.speechSynthesis || typeof globalThis.SpeechSynthesisUtterance !== 'function') {
    finishPlayback(playback);
    return;
  }
  globalThis.speechSynthesis.cancel();
  const utterance = new globalThis.SpeechSynthesisUtterance(kana);
  utterance.lang = 'ja-JP';
  utterance.rate = 0.9;
  utterance.onend = () => finishPlayback(playback);
  utterance.onerror = () => finishPlayback(playback);
  playback.speaking = true;
  globalThis.speechSynthesis.speak(utterance);
}

export function playWordAudio(word, reading, button) {
  const kana = reading || word;
  if (!kana || !button) return;
  // A second click while it plays sends no second request.
  if (audioPlayback && audioPlayback.button === button) return;
  stopPlayback();

  const playback = { button, audio: null, speaking: false, stopped: false, failed: false };
  audioPlayback = playback;
  button.classList.add('is-playing');

  chrome.runtime.sendMessage({ action: 'playAudio', word: word || kana, reading: kana }, (response) => {
    if (playback.stopped) return;
    // Only audio data URLs are played, as in the tooltip.
    if (chrome.runtime.lastError || !response?.success || !String(response.dataUrl || '').startsWith('data:audio/')) {
      speakReading(playback, kana);
      return;
    }
    const audio = new globalThis.Audio(response.dataUrl);
    playback.audio = audio;
    audio.addEventListener('ended', () => finishPlayback(playback));
    audio.addEventListener('error', () => speakReading(playback, kana));
    audio.play().catch(() => speakReading(playback, kana));
  });
}

// Sits beside the reading, away from the buttons that change the word.
function listenButton(record) {
  const label = t('content_play_pronunciation', undefined, 'Play pronunciation');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'word-ledger-listen';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(icon(ICONS.listen));
  button.addEventListener('click', () => playWordAudio(record.word, record.reading, button));
  return button;
}

async function changeWord(request) {
  const response = await sendWords(request);
  if (response?.success) await loadMyWords({ keepRows: true });
}

function buildLedgerRow(record) {
  const row = document.createElement('li');
  row.className = 'word-ledger-row';
  row.dataset.state = record.state;

  const term = document.createElement('div');
  term.className = 'word-ledger-term';
  term.append(
    textSpan('word-ledger-word', record.word, 'ja'),
    textSpan('word-ledger-reading', record.reading, 'ja'),
    listenButton(record)
  );
  if (record.level) term.appendChild(levelTag(record.level));
  row.appendChild(term);

  const sentence = cardSentence(record);
  if (sentence) {
    const line = textSpan('word-ledger-sentence', '', 'ja');
    renderSentence(line, sentence, record.word);
    row.appendChild(line);
  }

  const actions = document.createElement('div');
  actions.className = 'word-ledger-actions';
  const pair = { word: record.word, reading: record.reading };
  if (record.state === 'known') {
    const again = iconButton('word-ledger-again', t('learn_again_word', [record.word], `Learn ${record.word} again`), ICONS.again);
    again.addEventListener('click', () => changeWord({ action: 'wordsSetState', ...pair, state: 'learning' }));
    actions.appendChild(again);
  } else {
    const known = iconButton('word-ledger-known', t('mark_known_word', [record.word], `I know ${record.word}`), ICONS.known);
    known.addEventListener('click', () => changeWord({ action: 'wordsSetState', ...pair, state: 'known' }));
    actions.appendChild(known);
  }
  const remove = iconButton('word-ledger-remove', t('remove_listed_word', [record.word], `Remove ${record.word} from this list`), ICONS.remove);
  remove.addEventListener('click', () => changeWord({ action: 'wordsRemove', id: record.id }));
  actions.appendChild(remove);
  row.appendChild(actions);
  return row;
}

function listRecords(state) {
  return wordRecords.filter((record) => record.state === state);
}

function renderList(state, { rows = VOCABULARY_PAGE_SIZE, append = false } = {}) {
  const list = document.getElementById(`${state}WordsList`);
  const empty = document.getElementById(`${state}WordsEmpty`);
  const more = document.getElementById(`${state}WordsMore`);
  const clear = document.getElementById(`clear${state === 'learning' ? 'Learning' : 'Known'}Btn`);
  if (!list) return;
  const records = listRecords(state);
  if (!append) {
    list.replaceChildren();
    vocabularyRenderedCount = 0;
  }
  const page = getVocabularyPage(records, vocabularyRenderedCount, append ? VOCABULARY_PAGE_SIZE : rows);
  page.forEach((record) => list.appendChild(buildLedgerRow(record)));
  vocabularyRenderedCount += page.length;
  list.hidden = records.length === 0;
  if (empty) empty.hidden = records.length > 0;
  if (more) more.hidden = vocabularyRenderedCount >= records.length;
  if (clear) clear.disabled = records.length === 0;
}

function selectList(name, options) {
  selectedList = LISTS.includes(name) ? name : 'learning';
  LISTS.forEach((key) => {
    const tab = document.getElementById(`${key}ListTab`);
    const panel = document.getElementById(`${key}WordsPanel`);
    const isSelected = key === selectedList;
    if (tab) {
      tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tab.setAttribute('tabindex', isSelected ? '0' : '-1');
    }
    if (panel) panel.hidden = !isSelected;
  });
  renderList(selectedList, options);
}

function renderStrip(summary) {
  const title = document.getElementById('wordReviewStripTitle');
  const meta = document.getElementById('wordReviewStripMeta');
  const link = document.getElementById('startReviewLink');
  const strip = document.getElementById('wordReviewStrip');
  const sync = document.getElementById('wordSyncNote');
  const due = summary?.due || 0;
  const learning = summary?.learning || 0;
  const known = summary?.known || 0;
  if (title) {
    if (due > 0) {
      title.textContent = due === 1
        ? t('review_due_one', undefined, '1 word to review')
        : t('review_due_many', [String(due)], `${due} words to review`);
    } else if (learning > 0) {
      title.textContent = t('review_caught_up', undefined, 'All caught up');
    } else {
      title.textContent = t('review_nothing_yet', undefined, 'Nothing to review yet');
    }
  }
  if (meta) {
    const parts = [];
    if (!learning && !known) {
      parts.push(t('review_start_hint', undefined, 'Look up a new word or reveal its reading in Study mode to add it to your learning list.'));
    } else {
      parts.push(t('profile_learning', [String(learning)], `${learning} learning`));
      parts.push(t('profile_known', [String(known)], `${known} known`));
    }
    if (!due && summary?.nextDueAt) {
      const when = relativeTime(summary.nextDueAt);
      parts.push(t('review_next_due', [when], `Next review ${when}`));
    }
    meta.textContent = parts.join(' · ');
  }
  if (link) {
    link.hidden = due === 0;
    link.href = ezfuriganaUrl('#review');
  }
  if (strip) strip.dataset.due = due > 0 ? 'true' : 'false';
  if (sync) {
    sync.textContent = summary?.lastSyncAt
      ? t('sync_last', [relativeTime(summary.lastSyncAt)], `Review on EZFurigana · Last synced: ${relativeTime(summary.lastSyncAt)}`)
      : t('sync_never', undefined, 'Review on EZFurigana. Open it once to sync your words.');
  }
  LISTS.forEach((state) => {
    const count = document.getElementById(`${state}ListCount`);
    const value = state === 'learning' ? learning : known;
    if (count) count.textContent = value > 0 ? String(value) : '';
  });
}

/** Known and learning words against each JLPT level's kanji vocabulary, as on the website. */
export async function loadMyWords({ keepRows = false } = {}) {
  const response = await sendWords({ action: 'wordsList' });
  wordRecords = response?.success && Array.isArray(response.records) ? response.records : [];
  wordSummary = response?.success ? response.summary : null;
  renderStrip(wordSummary);
  selectList(selectedList, { rows: keepRows ? Math.max(vocabularyRenderedCount, VOCABULARY_PAGE_SIZE) : VOCABULARY_PAGE_SIZE });
}

async function fillMissingDefinitions(records) {
  let lookups = 0;
  for (const record of records) {
    if (record.definition || lookups >= EXPORT_DEFINITION_LOOKUPS) continue;
    lookups += 1;
    try {
      const definition = definitionFromData(await lookupDefinition(record.word, record.reading));
      if (!definition) continue;
      record.definition = definition;
      sendWords({ action: 'wordsSetDefinition', word: record.word, reading: record.reading, definition });
    } catch (error) {
      // A rate limit stops the lookups; the rest export without a definition.
      if (error.rateLimitType) break;
    }
  }
}

function exportRecords() {
  return listRecords(selectedList);
}

export async function exportVocabulary() {
  const records = exportRecords();
  if (records.length === 0) {
    alert(t('vocab_no_items_to_export', undefined, 'No vocabulary to export'));
    return;
  }
  const button = document.getElementById('exportVocabBtn');
  if (button) button.disabled = true;
  try {
    await fillMissingDefinitions(records);
  } finally {
    if (button) button.disabled = false;
  }
  const rows = [[
    t('csv_header_word', undefined, 'Word'),
    t('csv_header_reading', undefined, 'Reading'),
    t('csv_header_definition', undefined, 'Definition'),
    t('csv_header_sentence_plain_text', undefined, 'Sentence (plain text)'),
    t('csv_header_jlpt', undefined, 'JLPT'),
    t('csv_header_pos', undefined, 'Part of Speech'),
    t('csv_header_date', undefined, 'Date'),
  ]];
  records.forEach((record) => {
    rows.push([
      record.word || '',
      record.reading || '',
      record.definition || '',
      cardSentence(record),
      record.level ? `N${record.level}` : '',
      record.pos || '',
      record.firstSeenAt ? new Date(record.firstSeenAt).toLocaleDateString() : '',
    ]);
  });
  const csv = rows.map(row =>
    row.map(cell => {
      const safeCell = neutralizeCsvFormulaCell(cell);
      const escaped = safeCell.replace(/"/g, '""');
      return /[",\n]/.test(safeCell) ? `"${escaped}"` : escaped;
    }).join(',')
  ).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tsukeru-${selectedList}-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function initMyWordsTab() {
  const tabs = LISTS.map((name) => document.getElementById(`${name}ListTab`));
  tabs.forEach((tab, index) => {
    tab?.addEventListener('click', () => selectList(LISTS[index]));
    tab?.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + LISTS.length) % LISTS.length;
      selectList(LISTS[next]);
      tabs[next]?.focus();
    });
  });
  LISTS.forEach((state) => {
    document.getElementById(`${state}WordsMore`)?.addEventListener('click', () => renderList(state, { append: true }));
  });
  [['clearLearningBtn', 'learning'], ['clearKnownBtn', 'known']].forEach(([id, state]) => {
    document.getElementById(id)?.addEventListener('click', async () => {
      const message = state === 'learning'
        ? t('clear_learning_confirm', undefined, 'Remove every learning word? They are removed on EZFurigana too.')
        : t('clear_known_confirm', undefined, 'Remove every known word? Furigana can appear again, here and on EZFurigana, depending on your settings.');
      if (!confirm(message)) return;
      await changeWord({ action: 'wordsClear', state });
    });
  });
  document.getElementById('exportVocabBtn')?.addEventListener('click', exportVocabulary);
}

// ── This page tab ─────────────────────────────────────────────────────────────

let pageWords = [];
let pageStates = {};
// Show the note only after the stored display setting has been read.
let hideKnownFurigana = false;
let pageShowAll = false;
// A word save invalidates older reads; notices share one refresh and one pending slot.
let pageLoadSequence = 0;
let pageRefreshRunning = false;
let pageRefreshPending = false;
let pendingSaves = 0;
let pageRenderSignature = null;
let pageRenderedNonEmpty = false;

/** Count uses of a counter (2024年 にせんにじゅうよねん) in its group. */
function addCounterExample(word, raw, occurrences) {
  if (!word.examples) word.examples = new Map();
  const surface = String(raw.surface || '');
  if (!surface) return;
  const example = word.examples.get(surface);
  if (example) example.count += occurrences;
  else word.examples.set(surface, { surface, reading: String(raw.surfaceReading || raw.reading || ''), count: occurrences });
}

/** The most frequent uses of a counter, first-seen breaking ties. */
export function counterExamples(word, limit = 3) {
  if (!word?.examples) return [];
  return Array.from(word.examples.values()).sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Unique kanji words on the page, without particles, in first-seen order (like the website).
 * Numbers with the same counter (2024年, 1998年) are one 〜年 word.
 */
export function collectPageWords(rawWords) {
  const rules = wordRules();
  const byId = new Map();
  if (!rules) return [];
  (Array.isArray(rawWords) ? rawWords : []).forEach((raw) => {
    if (String(raw?.pos || '').split(',')[0].trim() === 'Particle') return;
    const isCounter = Boolean(raw.counter && raw.counterReading);
    const identity = rules.identityForWordInfo({
      surface: raw.surface,
      dictForm: raw.word,
      lookupReading: raw.lookupReading,
      reading: raw.reading,
      counter: raw.counter,
      counterReading: raw.counterReading,
    });
    if (!identity) return;
    const occurrences = Math.max(1, Number(raw.frequency) || 1);
    let word = byId.get(identity.id);
    if (word) {
      word.occurrences += occurrences;
      // A counter row takes its easiest level, the counter's own.
      if (isCounter) word.level = Math.max(word.level, rules.levelOf(raw.jlpt));
    } else {
      word = {
        ...identity,
        level: rules.levelOf(raw.jlpt),
        pos: String(raw.pos || '').split(',')[0].trim(),
        surface: raw.surface || identity.word,
        snippet: String(raw.snippet || ''),
        occurrences,
        examples: null,
      };
      byId.set(identity.id, word);
    }
    if (isCounter) addCounterExample(word, raw, occurrences);
  });
  return Array.from(byId.values());
}

/** Level counts, states, and how much of the text (counting repeats) the reader knows. */
export function summarizePageWords(words, states) {
  const byLevel = new Map(PAGE_LEVEL_ORDER.map((level) => [level, 0]));
  let learning = 0;
  let known = 0;
  let occurrences = 0;
  let knownOccurrences = 0;
  words.forEach((word) => {
    byLevel.set(word.level, (byLevel.get(word.level) || 0) + 1);
    const state = states[word.id];
    occurrences += word.occurrences;
    if (state === 'learning') learning += 1;
    else if (state === 'known') {
      known += 1;
      knownOccurrences += word.occurrences;
    }
  });
  const coverage = occurrences ? Math.floor((knownOccurrences / occurrences) * 100) : 0;
  return { byLevel, learning, known, fresh: words.length - learning - known, coverage };
}

function levelLabel(level) {
  return level ? `N${level}` : t('level_beyond_n1', undefined, 'Beyond N1');
}

function renderPageMeter(byLevel) {
  const meter = document.getElementById('pageProfileMeter');
  if (!meter) return;
  const levels = PAGE_LEVEL_ORDER.filter((level) => byLevel.get(level) > 0);
  meter.replaceChildren(...levels.map((level) => {
    const segment = document.createElement('span');
    segment.className = 'result-profile-segment';
    segment.dataset.jlpt = String(level);
    segment.style.flexGrow = String(byLevel.get(level));
    segment.title = `${levelLabel(level)} · ${byLevel.get(level)}`;
    return segment;
  }));
  meter.setAttribute('aria-label', levels
    .map((level) => `${levelLabel(level)} ${Math.round((byLevel.get(level) / pageWords.length) * 100)}%`)
    .join(', '));
}

function renderPageSummary(summary) {
  const target = document.getElementById('pageProfileSummary');
  if (target) {
    const parts = [pageWords.length === 1
      ? t('profile_words_one', undefined, '1 word')
      : t('profile_words_many', [String(pageWords.length)], `${pageWords.length} words`)];
    if (summary.fresh) parts.push(t('profile_new', [String(summary.fresh)], `${summary.fresh} new`));
    if (summary.learning) parts.push(t('profile_learning', [String(summary.learning)], `${summary.learning} learning`));
    if (summary.known) parts.push(t('profile_known', [String(summary.known)], `${summary.known} known`));
    target.textContent = parts.join(' · ');
  }
  const coverage = document.getElementById('pageProfileCoverage');
  if (coverage) {
    coverage.hidden = summary.known === 0;
    coverage.textContent = summary.known > 0
      ? t('profile_coverage', [String(summary.coverage)], `You know ${summary.coverage}%`)
      : '';
  }
  const note = document.getElementById('pageWordsKnownNote');
  if (note) {
    const hidden = hideKnownFurigana && summary.known > 0;
    note.hidden = !hidden;
    note.textContent = hidden
      ? t('known_readings_hidden', [String(summary.known)], `Furigana hidden for ${summary.known} known words`)
      : '';
  }
}

async function setPageWordState(word, state) {
  pendingSaves += 1;
  pageLoadSequence += 1;
  // An invalidated refresh may have found new words: read again after all saves finish.
  pageRefreshPending = true;
  try {
    const rules = wordRules();
    const response = await sendWords({
      action: 'wordsSetState',
      word: word.word,
      reading: word.reading,
      state,
      sentence: rules ? rules.fitSentence(word.snippet, word.surface) : '',
      level: word.level,
      pos: word.pos,
    });
    if (!response?.success || !response.record) return;
    pageStates[word.id] = response.record.state;
    renderPage();
  } finally {
    pendingSaves -= 1;
    if (!pendingSaves && pageRefreshPending) requestPageWordsRefresh();
  }
}

function pageStateButton(row, state, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'result-word-state';
  button.dataset.state = state;
  button.textContent = label;
  button.setAttribute('aria-pressed', pageStates[row.dataset.wordId] === state ? 'true' : 'false');
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-pressed') === 'true') return;
    const word = pageWords.find((item) => item.id === row.dataset.wordId);
    if (word) setPageWordState(word, state);
  });
  return button;
}

async function scrollToWordOnPage(word) {
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isSupportedPageTab(tab.url)) return;
    await chrome.tabs.sendMessage(tab.id, { action: 'scrollToWord', word: word.word, reading: word.reading });
  } catch (err) {
    console.warn('Tsukeru: could not scroll to the word', err?.message);
  }
}

function buildPageRow(word) {
  const row = document.createElement('li');
  row.className = 'result-word-row';
  row.dataset.wordId = word.id;
  row.dataset.state = pageStates[word.id] || 'new';
  const term = document.createElement('button');
  term.type = 'button';
  term.className = 'result-word-jump';
  term.title = t('vm_jump_to_word', undefined, 'Jump to word on page');
  // 〜年 is the usual way to write a counter in dictionaries and textbooks.
  const label = word.examples ? `〜${word.word}` : word.word;
  const reading = textSpan('result-word-reading', word.reading, 'ja');
  const examples = counterExamples(word)
    .map((example) => (example.reading ? `${example.surface} ${example.reading}` : example.surface))
    .join(' · ');
  if (examples) reading.append(textSpan('result-word-examples', examples, 'ja'));
  term.append(textSpan('result-word-term', label, 'ja'), reading);
  term.addEventListener('click', () => {
    const currentWord = pageWords.find((item) => item.id === row.dataset.wordId);
    if (currentWord) scrollToWordOnPage(currentWord);
  });
  const controls = document.createElement('span');
  controls.className = 'result-word-states';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', t('word_state_for', [label], `Status of ${label}`));
  controls.append(
    pageStateButton(row, 'learning', t('state_learning', undefined, 'Learning')),
    pageStateButton(row, 'known', t('state_known', undefined, 'Known'))
  );
  row.append(term, controls);
  return row;
}

function renderPageGroups() {
  const container = document.getElementById('pageWordsGroups');
  if (!container) return;
  let remaining = pageShowAll ? Infinity : PAGE_INITIAL_ROWS;
  const groups = [];
  PAGE_LEVEL_ORDER.forEach((level) => {
    if (remaining <= 0) return;
    const members = pageWords.filter((word) => word.level === level);
    if (!members.length) return;
    const group = document.createElement('section');
    group.className = 'result-words-group';
    const head = document.createElement('h3');
    head.className = 'result-words-group-head';
    head.append(levelTag(level), textSpan('result-words-group-count', String(members.length)));
    const list = document.createElement('ul');
    list.className = 'result-words-list';
    members.slice(0, remaining).forEach((word) => list.appendChild(buildPageRow(word)));
    remaining -= members.length;
    group.append(head, list);
    groups.push(group);
  });
  container.replaceChildren(...groups);
  const more = document.getElementById('pageWordsMore');
  if (more) {
    more.hidden = pageShowAll || pageWords.length <= PAGE_INITIAL_ROWS;
    more.textContent = t('show_all_words', [String(pageWords.length)], `Show all ${pageWords.length} words`);
  }
}

function renderPage() {
  // Compare the full ordered list: even undisplayed words affect counts and coverage.
  // Snippets and POS remain fresh in pageWords without replacing unchanged rows.
  const signature = JSON.stringify([pageShowAll, hideKnownFurigana, pageWords.map((word) => [
    word.id, word.word, word.reading, word.level, word.occurrences, pageStates[word.id] || 'new',
    counterExamples(word).map((example) => [example.surface, example.reading]),
  ])]);
  if (signature === pageRenderSignature) return;
  pageRenderSignature = signature;
  const has = pageWords.length > 0;
  const wasNonEmpty = pageRenderedNonEmpty;
  pageRenderedNonEmpty = has;
  const profile = document.getElementById('pageProfile');
  const slip = document.getElementById('pageWordsSlip');
  const empty = document.getElementById('pageWordsEmpty');
  if (profile) profile.hidden = !has;
  if (slip) slip.hidden = !has;
  if (empty) empty.hidden = has;
  if (!has) {
    document.getElementById('pageWordsGroups')?.replaceChildren();
    return;
  }
  const summary = summarizePageWords(pageWords, pageStates);
  renderPageMeter(summary.byLevel);
  renderPageSummary(summary);
  renderPageGroups();
  if (!wasNonEmpty) revealPageRows();
}

/** One refresh at a time, with one follow-up for notices received while loading or saving. */
export async function requestPageWordsRefresh() {
  pageRefreshPending = true;
  if (pageRefreshRunning || pendingSaves) return;
  pageRefreshPending = false;
  pageRefreshRunning = true;
  try {
    await loadPageWords();
  } catch (error) {
    console.warn('Tsukeru: could not refresh page words', error?.message);
  } finally {
    pageRefreshRunning = false;
    if (pageRefreshPending && !pendingSaves) requestPageWordsRefresh();
  }
}

async function loadPageWords() {
  const sequence = ++pageLoadSequence;
  const display = await chrome.storage.sync.get({ hideKnownFurigana: DEFAULT_SETTINGS.hideKnownFurigana });
  if (sequence !== pageLoadSequence) return;
  let rawWords = [];
  const tab = await getActiveTab();
  if (sequence !== pageLoadSequence) return;
  if (tab?.id && isSupportedPageTab(tab.url)) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageWords' });
      rawWords = Array.isArray(response?.words) ? response.words : [];
    } catch (_) {
      // No content script on this page yet: nothing to list.
    }
  }
  if (sequence !== pageLoadSequence) return;
  const words = collectPageWords(rawWords);
  const states = words.length ? await sendWords({ action: 'wordsGetStates' }) : null;
  if (sequence !== pageLoadSequence) return;
  hideKnownFurigana = display.hideKnownFurigana !== false;
  pageWords = words;
  pageStates = states?.success && states.states ? states.states : {};
  renderPage();
}

/** Animate only empty-to-nonempty listings, including the first listing after Clear. */
function revealPageRows() {
  const rows = document.getElementById('pageWordsGroups')?.querySelectorAll('.result-word-row') || [];
  Array.from(rows).slice(0, 10).forEach((row, index) => {
    row.style.animationDelay = `${index * 20}ms`;
    row.classList.add('is-entering');
  });
}

/** Re-list the page when its content script reports applied or cleared furigana. */
function followPageChanges() {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.action !== 'pageWordsChanged' || !sender?.tab?.id) return;
    if (!document.getElementById('page-tab')?.classList.contains('active')) return;
    getActiveTab().then((tab) => {
      if (tab?.id === sender.tab.id) requestPageWordsRefresh();
    }).catch(() => {});
  });
}

export async function initPageTab() {
  const toggle = document.getElementById('studyModeToggle');
  if (toggle) {
    const { studyMode } = await chrome.storage.sync.get({ studyMode: DEFAULT_SETTINGS.studyMode });
    toggle.checked = studyMode === true;
    toggle.addEventListener('change', async () => {
      await chrome.storage.sync.set({ studyMode: toggle.checked });
      await sendWordDisplaySettings();
    });
  }
  document.getElementById('pageWordsMore')?.addEventListener('click', () => {
    pageShowAll = true;
    renderPage();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.hideKnownFurigana) return;
    hideKnownFurigana = changes.hideKnownFurigana.newValue !== false;
    renderPageSummary(summarizePageWords(pageWords, pageStates));
  });
  followPageChanges();
}
