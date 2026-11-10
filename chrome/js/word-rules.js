/*
Module: word-rules
Purpose: Hold the My Words rules shared by the background store, content scripts, and popup: word identity, Learning/Known/removal changes, review counts, migration of the retired saved-word list, and the merge rules for syncing with EZFurigana.

Inputs:
- Word, reading, sentence, JLPT level, and state values from page lookups and popup actions.
- An in-memory word store, retired `vocabulary` entries, and record snapshots from the EZFurigana page.
- Caller-supplied times in milliseconds.

Outputs:
- `globalThis.TsukeruWords`: identity helpers, store mutations, summaries, and sync payloads.
- Dirty-key sets on the store that tell the caller which records, removals, and metadata to persist.

Side Effects:
- None outside the store object passed in; storage and messaging belong to the callers.

Failure Modes:
- Invalid words (no kanji, empty, or too long), states, and snapshot rows are ignored rather than stored.

Security Notes:
- Records keep only a word, its reading, its state, schedule times, a short definition, at most three short plain-text sentences with the readings their words were given (checked [start, length, kana reading, word id] spans), and at most one bounded plain-text sentence explanation a Supporter asked for; no URLs or page markup.
- The rules match EZFurigana's word records so both sides agree on identity and on which change wins.
*/
(function attachWordRules(root) {
  const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/;
  const STATES = new Set(['learning', 'known', 'ignored']);
  const MAX_FIELD_LENGTH = 100;
  const MAX_SENTENCES = 3;
  const MAX_SENTENCE_LENGTH = 120;
  const MAX_DEFINITION_LENGTH = 160;
  const MAX_RECORDS = 5000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Imported saved words fall due this many a day, like the website.
  const IMPORT_DUE_PER_DAY = 20;

  function normalize(value) {
    return String(value == null ? '' : value).trim().normalize('NFC');
  }

  function charLength(value) {
    return Array.from(value).length;
  }

  function recordId(word, reading) {
    return `${word}\u0000${reading}`;
  }

  /** The {id, word, reading} identity of a pair, or null when it cannot be tracked. */
  function identityForPair(word, reading) {
    const normalizedWord = normalize(word);
    const normalizedReading = normalize(reading);
    if (!normalizedWord || !normalizedReading || !KANJI_RE.test(normalizedWord)) return null;
    if (charLength(normalizedWord) > MAX_FIELD_LENGTH || charLength(normalizedReading) > MAX_FIELD_LENGTH) return null;
    return { id: recordId(normalizedWord, normalizedReading), word: normalizedWord, reading: normalizedReading };
  }

  /**
   * Identity of an analysed page word: its dictionary form and lookup
   * reading. Kana-only units are not tracked, as on the website. A number +
   * counter unit (2024年, 3本) is its counter (年 ねん), so every number with
   * that counter is one word, as on the website.
   */
  function identityForWordInfo(info) {
    if (!info) return null;
    const surface = normalize(info.surface);
    if (surface && !KANJI_RE.test(surface)) return null;
    if (info.counter && info.counterReading) return identityForPair(info.counter, info.counterReading);
    return identityForPair(info.dictForm || info.word || info.surface, info.lookupReading || info.reading);
  }

  function levelOf(value) {
    const level = Number.parseInt(value, 10);
    return level >= 1 && level <= 5 ? level : 0;
  }

  function timeOf(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? Math.floor(time) : 0;
  }

  /**
   * A plain sentence of at most MAX_SENTENCE_LENGTH characters, centred on
   * the word when it has to be shortened.
   */
  function fitSentence(text, word = '') {
    const sentence = String(text || '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(sentence);
    if (chars.length <= MAX_SENTENCE_LENGTH) return sentence;
    const index = word ? sentence.indexOf(word) : -1;
    const center = index >= 0 ? charLength(sentence.slice(0, index)) + Math.floor(charLength(word) / 2) : 0;
    const room = MAX_SENTENCE_LENGTH - 2;
    const begin = Math.max(0, Math.min(center - Math.floor(room / 2), chars.length - room));
    const end = begin + room;
    return `${begin > 0 ? '…' : ''}${chars.slice(begin, end).join('').trim()}${end < chars.length ? '…' : ''}`;
  }

  const SENTENCE_ENDS = new Set(['。', '！', '？', '!', '?', '\n']);
  const SENTENCE_CLOSERS = new Set(['」', '』', '）', ')', '】', '〉', '》', '”', '’', '"']);

  /** Where the sentence holding text[start, end) begins and stops in `text`. */
  function sentenceRange(value, start, end) {
    const from = Math.max(0, Math.min(Number(start) || 0, value.length));
    const to = Math.max(from, Math.min(Number(end) || from, value.length));
    let begin = from;
    while (begin > 0 && !SENTENCE_ENDS.has(value[begin - 1])) begin -= 1;
    while (begin < from && (SENTENCE_CLOSERS.has(value[begin]) || /\s/.test(value[begin]))) begin += 1;
    let stop = to;
    while (stop < value.length && !SENTENCE_ENDS.has(value[stop])) stop += 1;
    if (stop < value.length && value[stop] !== '\n') {
      stop += 1;
      while (stop < value.length && SENTENCE_CLOSERS.has(value[stop])) stop += 1;
    }
    return { begin, stop };
  }

  /**
   * The sentence of `text` holding the characters from `start` to `end`.
   * Line breaks and 。！？!? end sentences; closing quotes stay with the
   * sentence they close. The result is fitted like any stored sentence.
   */
  function sentenceAt(text, start, end, word = '') {
    const value = String(text || '');
    const { begin, stop } = sentenceRange(value, start, end);
    return fitSentence(value.slice(begin, stop), word);
  }

  // Readings kept per sentence, as on EZFurigana: at most this many words, each this long.
  const MAX_SENTENCE_READINGS = 40;
  const MAX_READING_LENGTH = 24;
  const KANA_READING_RE = /^[ぁ-ゖァ-ヺー]+$/;

  function toHiragana(text) {
    return String(text || '').normalize('NFKC')
      .replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
  }

  /**
   * Where one word's reading goes in its sentence: over its kanji only
   * (食べる -> 食 た), as [start, length, reading, word id], or null when it
   * has no kanji or no kana reading. Same rule as EZFurigana's word-progress.js.
   */
  function readingSpan(surface, reading, at, id = '') {
    if (!KANJI_RE.test(surface) || !KANA_READING_RE.test(reading || '')) return null;
    const written = Array.from(surface);
    const spoken = Array.from(toHiragana(reading));
    // Kana the surface and reading share at either end are not under the reading.
    let head = 0;
    while (head < written.length && head < spoken.length && !KANJI_RE.test(written[head])
      && toHiragana(written[head]) === spoken[head]) head += 1;
    let tail = 0;
    while (tail < written.length - head && tail < spoken.length - head
      && !KANJI_RE.test(written[written.length - 1 - tail])
      && toHiragana(written[written.length - 1 - tail]) === spoken[spoken.length - 1 - tail]) tail += 1;
    const base = written.slice(head, written.length - tail).join('');
    const over = spoken.slice(head, spoken.length - tail).join('');
    if (!base || !over || !KANJI_RE.test(base) || charLength(over) > MAX_READING_LENGTH) return null;
    return [at + written.slice(0, head).join('').length, base.length, over, typeof id === 'string' ? id : ''];
  }

  /** Valid reading spans for `sentence` (the website's checks), or none. */
  function boundedReadings(sentence, readings) {
    if (!sentence || !Array.isArray(readings)) return [];
    return readings.filter((span) => Array.isArray(span) && span.length === 4
      && Number.isInteger(span[0]) && Number.isInteger(span[1]) && span[0] >= 0 && span[1] > 0
      && span[0] + span[1] <= sentence.length && typeof span[2] === 'string'
      && KANA_READING_RE.test(span[2]) && charLength(span[2]) <= MAX_READING_LENGTH
      && typeof span[3] === 'string' && span[3].length <= 2 * MAX_FIELD_LENGTH + 1)
      .slice(0, MAX_SENTENCE_READINGS)
      .map((span) => [span[0], span[1], span[2], span[3]]);
  }

  /**
   * The sentence holding text[start, end) and the readings of the page's
   * words inside it. `words` are {from, to, reading, id} ranges in `text`,
   * in order; each is found again in the fitted sentence, whose spaces were
   * collapsed and which may be cut.
   */
  function sentenceWithReadingsAt(text, start, end, word = '', words = []) {
    const value = String(text || '');
    const { begin, stop } = sentenceRange(value, start, end);
    const sentence = fitSentence(value.slice(begin, stop), word);
    const readings = [];
    let cursor = 0;
    (Array.isArray(words) ? words : []).forEach((unit) => {
      if (readings.length >= MAX_SENTENCE_READINGS || !(unit.from >= begin && unit.to <= stop)) return;
      const surface = value.slice(unit.from, unit.to).replace(/\s+/g, ' ').trim();
      const at = surface ? sentence.indexOf(surface, cursor) : -1;
      if (at < 0) return;
      cursor = at + surface.length;
      const span = readingSpan(surface, unit.reading, at, unit.id);
      if (span) readings.push(span);
    });
    return { sentence, readings };
  }

  /** The record's readings for each sentence it keeps: `readings` for `sentence`, earlier ones for the rest. */
  function keepSentenceReadings(record, sentence, readings) {
    const current = record.sentenceReadings && typeof record.sentenceReadings === 'object' ? record.sentenceReadings : {};
    const kept = {};
    (record.sentences || []).forEach((text) => {
      const spans = text === sentence ? boundedReadings(text, readings) : [];
      if (spans.length) kept[text] = spans;
      else if (Array.isArray(current[text]) && current[text].length) kept[text] = current[text];
    });
    if (Object.keys(kept).length) record.sentenceReadings = kept;
    else delete record.sentenceReadings;
  }

  /** Readings from a website row for the sentences kept from it unchanged. */
  function snapshotReadings(row, sentences) {
    const given = row?.sentenceReadings && typeof row.sentenceReadings === 'object' && !Array.isArray(row.sentenceReadings)
      ? row.sentenceReadings
      : {};
    const kept = {};
    sentences.forEach((text) => {
      const spans = Object.prototype.hasOwnProperty.call(given, text) ? boundedReadings(text, given[text]) : [];
      if (spans.length) kept[text] = spans;
    });
    return kept;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  /** Plain text of a stored ruby sentence, without its readings. Works without a DOM. */
  function plainSentenceFromHtml(html) {
    return String(html || '')
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
      .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
      .replace(/<span\b[^>]*data-tsukeru-reading-only="true"[^>]*>[\s\S]*?<\/span>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name) => {
        if (name[0] === '#') {
          const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
        }
        return ENTITIES[name.toLowerCase()] ?? match;
      });
  }

  function boundedDefinition(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(text);
    return chars.length > MAX_DEFINITION_LENGTH ? `${chars.slice(0, MAX_DEFINITION_LENGTH - 1).join('')}…` : text;
  }

  function withSentence(sentences, sentence) {
    const list = Array.isArray(sentences) ? sentences.filter(Boolean) : [];
    if (!sentence || list.includes(sentence)) return list.slice(0, MAX_SENTENCES);
    return [sentence, ...list].slice(0, MAX_SENTENCES);
  }

  /* ---------- sentence explanations ---------- */

  // The same shape and limits as EZFurigana's word-progress.js.
  const EXPLANATION_LOCALES = new Set(['en', 'ja', 'ko', 'zh', 'zh-Hant', 'id']);
  const MAX_EXPLANATION_POINTS = 4;
  const MAX_EXPLANATION_TRANSLATION = 400;
  const MAX_EXPLANATION_PIECE = 80;
  const MAX_EXPLANATION_TEXT = 300;
  const MAX_EXPLANATION_NOTE = 200;

  function boundedText(value, limit) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim().normalize('NFC');
    return charLength(text) <= limit ? text : '';
  }

  /**
   * A record's explanation in its stored and synced shape, or null: `{ at,
   * sentence, locale, translation, points, note }`, `at` being when it was
   * kept (ms). A removed one stays as `{ at }` with empty text, so an older
   * copy elsewhere cannot bring it back.
   */
  function cleanExplanation(value) {
    if (!value || typeof value !== 'object') return null;
    const at = Number.isInteger(value.at) && value.at > 0 ? value.at : 0;
    if (!at) return null;
    if (!value.sentence && !value.translation) {
      return { at, sentence: '', locale: '', translation: '', points: [], note: '' };
    }
    const sentence = typeof value.sentence === 'string' ? value.sentence.replace(/\s+/g, ' ').trim() : '';
    const translation = boundedText(value.translation, MAX_EXPLANATION_TRANSLATION);
    if (!sentence || charLength(sentence) > MAX_SENTENCE_LENGTH || !translation || !EXPLANATION_LOCALES.has(value.locale)) {
      return null;
    }
    const points = [];
    (Array.isArray(value.points) ? value.points : []).forEach((point) => {
      const japanese = boundedText(point && point.japanese, MAX_EXPLANATION_PIECE);
      const explanation = boundedText(point && point.explanation, MAX_EXPLANATION_TEXT);
      if (japanese && explanation && points.length < MAX_EXPLANATION_POINTS) points.push({ japanese, explanation });
    });
    return { at, sentence, locale: value.locale, translation, points, note: boundedText(value.note, MAX_EXPLANATION_NOTE) };
  }

  /** The explanation kept (or removed) last of two copies, or null. */
  function laterExplanation(first, second) {
    const a = cleanExplanation(first);
    const b = cleanExplanation(second);
    if (!a) return b;
    if (!b) return a;
    return b.at > a.at ? b : a;
  }

  /* ---------- the store ---------- */

  function createStore(records = {}, removed = {}, meta = {}) {
    return {
      records,
      removed,
      meta,
      dirtyRecords: new Set(),
      dirtyRemoved: new Set(),
      metaDirty: false,
    };
  }

  function putRecord(store, record) {
    store.records[record.id] = record;
    store.dirtyRecords.add(record.id);
  }

  function dropRecord(store, id) {
    if (!store.records[id]) return;
    delete store.records[id];
    store.dirtyRecords.add(id);
  }

  function newRecord(identity, source, at) {
    return {
      ...identity,
      state: 'learning',
      source,
      count: 0,
      sentences: [],
      step: 0,
      dueAt: at,
      firstSeenAt: at,
      lastSeenAt: at,
      lastReviewedAt: 0,
      knownAt: 0,
      // When the reader last chose a state; 0 until they do.
      changedAt: 0,
      // When this browser last changed the record; drives what sync sends.
      updatedAt: at,
      level: 0,
    };
  }

  function addDetails(record, { sentence = '', readings = [], level = 0, pos = '', definition = '' }) {
    const fitted = fitSentence(sentence, record.word);
    record.sentences = withSentence(record.sentences, fitted);
    keepSentenceReadings(record, fitted, readings);
    if (!record.level) record.level = levelOf(level);
    if (!record.pos && pos) record.pos = String(pos).split(',')[0].trim().slice(0, 40);
    if (!record.definition && definition) record.definition = boundedDefinition(definition);
  }

  /** Oldest-seen records go first once the store is full. */
  function trim(store) {
    const ids = Object.keys(store.records);
    if (ids.length <= MAX_RECORDS) return;
    ids
      .sort((a, b) => store.records[a].lastSeenAt - store.records[b].lastSeenAt)
      .slice(0, ids.length - MAX_RECORDS)
      .forEach((id) => dropRecord(store, id));
  }

  function clearRemoval(store, id) {
    if (!store.removed[id]) return;
    delete store.removed[id];
    store.dirtyRemoved.add(id);
  }

  /**
   * The reader checked a word while reading. A new word starts learning; a
   * known or ignored word keeps its state, because only the reader changes it.
   */
  function captureWord(store, input, at, { countCheck = false, source = 'lookup' } = {}) {
    const identity = identityForPair(input?.word, input?.reading);
    if (!identity) return null;
    const existing = store.records[identity.id];
    const record = existing ? { ...existing } : newRecord(identity, source, at);
    if (countCheck) record.count = (record.count || 0) + 1;
    addDetails(record, input);
    record.lastSeenAt = at;
    record.updatedAt = at;
    putRecord(store, record);
    clearRemoval(store, identity.id);
    trim(store);
    return record;
  }

  /** Mark a word learning, known or ignored, creating its record if needed. */
  function setWordState(store, input, state, at) {
    const identity = identityForPair(input?.word, input?.reading);
    if (!identity || !STATES.has(state)) return null;
    const existing = store.records[identity.id];
    const record = existing ? { ...existing } : newRecord(identity, 'manual', at);
    addDetails(record, input);
    if (state === 'known' && record.state !== 'known') record.knownAt = at;
    if (state === 'learning' && existing && existing.state !== 'learning') {
      record.step = 0;
      record.dueAt = at;
    }
    record.state = state;
    record.changedAt = at;
    record.lastSeenAt = at;
    record.updatedAt = at;
    putRecord(store, record);
    clearRemoval(store, identity.id);
    trim(store);
    return record;
  }

  /**
   * Keep a sentence explanation with a tracked word (Supporters): one per
   * word, replacing an older one; its sentence joins the word's sentences.
   */
  function setExplanation(store, input, explanation, at) {
    const identity = identityForPair(input?.word, input?.reading);
    const existing = identity ? store.records[identity.id] : null;
    const kept = cleanExplanation({ ...(explanation || {}), at });
    if (!existing || !kept || !kept.translation) return null;
    const record = { ...existing, explanation: kept, updatedAt: at };
    record.sentences = withSentence(record.sentences, kept.sentence);
    // Drops the readings of a sentence the new one pushed out.
    keepSentenceReadings(record, null, []);
    putRecord(store, record);
    return record;
  }

  /** Keep the first definition the reader saw, for the list and exports. */
  function setDefinition(store, input, definition, at) {
    const identity = identityForPair(input?.word, input?.reading);
    const existing = identity ? store.records[identity.id] : null;
    const text = boundedDefinition(definition);
    if (!existing || existing.definition || !text) return false;
    putRecord(store, { ...existing, definition: text, updatedAt: at });
    return true;
  }

  function removeWord(store, id, at) {
    const record = store.records[id];
    if (!record) return false;
    dropRecord(store, id);
    store.removed[id] = { word: record.word, reading: record.reading, removedAt: at };
    store.dirtyRemoved.add(id);
    return true;
  }

  function removeState(store, state, at) {
    return Object.values(store.records)
      .filter((record) => record.state === state)
      .reduce((count, record) => count + (removeWord(store, record.id, at) ? 1 : 0), 0);
  }

  function definitionOf(entry) {
    if (entry?.definition) return String(entry.definition);
    if (!Array.isArray(entry?.definitions)) return '';
    return entry.definitions
      .slice(0, 3)
      .map((sense) => (Array.isArray(sense?.glosses) ? sense.glosses.join('; ') : ''))
      .filter(Boolean)
      .join(' | ');
  }

  /**
   * Move retired saved words into learning, like the website did. Words
   * already tracked keep their state; new ones fall due IMPORT_DUE_PER_DAY a
   * day. Returns the entries that cannot be tracked (kana-only words).
   */
  function importVocabulary(store, entries, at) {
    const kept = [];
    let fresh = 0;
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const identity = identityForPair(entry?.word, entry?.reading);
      if (!identity) {
        if (entry) kept.push(entry);
        return;
      }
      if (store.records[identity.id]) return;
      const savedAt = Math.min(timeOf(entry.timestamp) || at, at);
      const record = newRecord(identity, 'saved', savedAt);
      addDetails(record, {
        sentence: plainSentenceFromHtml(entry.sentence),
        level: entry.jlpt,
        pos: entry.pos,
        definition: definitionOf(entry),
      });
      record.dueAt = at + Math.floor(fresh / IMPORT_DUE_PER_DAY) * DAY_MS;
      record.updatedAt = at;
      fresh += 1;
      putRecord(store, record);
    });
    trim(store);
    return kept;
  }

  /* ---------- reading the store ---------- */

  function statesOf(store) {
    const states = {};
    Object.values(store.records).forEach((record) => {
      if (STATES.has(record.state)) states[record.id] = record.state;
    });
    return states;
  }

  function listRecords(store, state = '') {
    return Object.values(store.records)
      .filter((record) => !state || record.state === state)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  function isDue(record, at) {
    return record.state === 'learning' && timeOf(record.dueAt) <= at;
  }

  /** Counts for the My Words strip and the toolbar badge. */
  function summarize(store, at) {
    let due = 0;
    let learning = 0;
    let known = 0;
    let nextDueAt = 0;
    Object.values(store.records).forEach((record) => {
      if (record.state === 'learning') {
        learning += 1;
        if (isDue(record, at)) due += 1;
        else if (!nextDueAt || record.dueAt < nextDueAt) nextDueAt = record.dueAt;
      } else if (record.state === 'known') {
        known += 1;
      }
    });
    return { due, learning, known, nextDueAt, lastSyncAt: timeOf(store.meta.lastSyncAt) };
  }

  /* ---------- sync with EZFurigana ---------- */

  function pushable(record) {
    return {
      word: record.word,
      reading: record.reading,
      state: record.state,
      changedAt: record.changedAt || 0,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      level: record.level || 0,
      count: record.count || 0,
      sentences: (record.sentences || []).slice(0, MAX_SENTENCES),
      ...(record.sentenceReadings ? { sentenceReadings: record.sentenceReadings } : {}),
      ...(record.explanation ? { explanation: record.explanation } : {}),
    };
  }

  /**
   * What to send the page: words changed since the last exchange, or every
   * word when the page's store is new or was cleared (a different store id).
   */
  function buildOutbox(store, storeId, at) {
    const full = !storeId || storeId !== store.meta.storeId;
    const since = full ? -1 : timeOf(store.meta.pushedThrough);
    return {
      startedAt: at,
      full,
      changes: Object.values(store.records).filter((record) => record.updatedAt > since).map(pushable),
      removed: Object.values(store.removed).filter((gone) => gone.removedAt > since),
    };
  }

  function snapshotRecord(row) {
    const identity = identityForPair(row?.word, row?.reading);
    if (!identity || !STATES.has(row.state)) return null;
    const firstSeenAt = timeOf(row.firstSeenAt);
    const lastSeenAt = timeOf(row.lastSeenAt) || firstSeenAt;
    const step = Number.parseInt(row.step, 10);
    const count = Number.parseInt(row.count, 10);
    const sentences = (Array.isArray(row.sentences) ? row.sentences : [])
      .filter((value) => typeof value === 'string')
      .map((value) => fitSentence(value, identity.word))
      .filter(Boolean)
      .slice(0, MAX_SENTENCES);
    const readings = snapshotReadings(row, sentences);
    const explanation = cleanExplanation(row.explanation);
    return {
      ...(explanation ? { explanation } : {}),
      ...identity,
      state: row.state,
      count: count > 0 ? Math.min(count, 100000) : 0,
      sentences,
      ...(Object.keys(readings).length ? { sentenceReadings: readings } : {}),
      step: step >= 0 && step <= 20 ? step : 0,
      dueAt: timeOf(row.dueAt),
      firstSeenAt,
      lastSeenAt,
      lastReviewedAt: timeOf(row.lastReviewedAt),
      knownAt: timeOf(row.knownAt),
      changedAt: timeOf(row.changedAt),
      level: levelOf(row.level),
    };
  }

  const SYNCED_FIELDS = ['state', 'count', 'sentences', 'sentenceReadings', 'explanation', 'step', 'dueAt', 'firstSeenAt',
    'lastSeenAt', 'lastReviewedAt', 'knownAt', 'changedAt', 'level'];

  /** The page's record with this browser's readings for sentences the page sent none for. */
  function withLocalReadings(record, local) {
    const mine = local?.sentenceReadings || {};
    const theirs = record.sentenceReadings || {};
    const kept = {};
    record.sentences.forEach((text) => {
      const spans = theirs[text] || mine[text];
      if (spans) kept[text] = spans;
    });
    const next = { ...record };
    if (Object.keys(kept).length) next.sentenceReadings = kept;
    else delete next.sentenceReadings;
    // The explanation kept (or removed) last wins, as on the website.
    const explanation = laterExplanation(local?.explanation, record.explanation);
    if (explanation) next.explanation = explanation;
    else delete next.explanation;
    return next;
  }

  function sameSynced(a, b) {
    return SYNCED_FIELDS.every((field) => JSON.stringify(a[field]) === JSON.stringify(b[field]));
  }

  /**
   * Adopt the page's records after it merged our outbox: the page owns the
   * review schedule and, after the merge, every word's state. Records this
   * browser changed while the exchange ran are kept and sent next time.
   * Words the page no longer has were removed there. Returns whether any
   * record changed.
   */
  function mergeSnapshot(store, rows, { startedAt, storeId, at }) {
    const incoming = new Map();
    (Array.isArray(rows) ? rows : []).slice(0, MAX_RECORDS).forEach((row) => {
      const record = snapshotRecord(row);
      if (record) incoming.set(record.id, record);
    });
    let changed = false;
    incoming.forEach((page, id) => {
      const local = store.records[id];
      if (local && local.updatedAt > startedAt) return;
      const record = withLocalReadings(page, local);
      if (local && sameSynced(local, record)) return;
      putRecord(store, {
        ...record,
        source: local?.source || 'website',
        ...(local?.pos ? { pos: local.pos } : {}),
        ...(local?.definition ? { definition: local.definition } : {}),
        updatedAt: Math.min(local?.updatedAt || startedAt, startedAt),
      });
      changed = true;
    });
    Object.values(store.records).forEach((local) => {
      if (incoming.has(local.id) || local.updatedAt > startedAt) return;
      dropRecord(store, local.id);
      changed = true;
    });
    Object.keys(store.removed).forEach((id) => {
      if (store.removed[id].removedAt <= startedAt) clearRemoval(store, id);
    });
    store.meta = { ...store.meta, pushedThrough: startedAt, storeId: storeId || null, lastSyncAt: at };
    store.metaDirty = true;
    return changed;
  }

  root.TsukeruWords = {
    DAY_MS,
    MAX_RECORDS,
    MAX_SENTENCE_LENGTH,
    buildOutbox,
    captureWord,
    createStore,
    fitSentence,
    identityForPair,
    identityForWordInfo,
    importVocabulary,
    levelOf,
    listRecords,
    mergeSnapshot,
    plainSentenceFromHtml,
    sentenceAt,
    sentenceWithReadingsAt,
    removeState,
    removeWord,
    cleanExplanation,
    setDefinition,
    setExplanation,
    setWordState,
    statesOf,
    summarize,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
