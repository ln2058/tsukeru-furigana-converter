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
- Records keep only a word, its reading, its state, schedule times, a short definition, and at most three short plain-text sentences; no URLs or page markup.
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

  function addDetails(record, { sentence = '', level = 0, pos = '', definition = '' }) {
    record.sentences = withSentence(record.sentences, fitSentence(sentence, record.word));
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
    return {
      ...identity,
      state: row.state,
      count: count > 0 ? Math.min(count, 100000) : 0,
      sentences: (Array.isArray(row.sentences) ? row.sentences : [])
        .filter((value) => typeof value === 'string')
        .map((value) => fitSentence(value, identity.word))
        .filter(Boolean)
        .slice(0, MAX_SENTENCES),
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

  const SYNCED_FIELDS = ['state', 'count', 'sentences', 'step', 'dueAt', 'firstSeenAt', 'lastSeenAt',
    'lastReviewedAt', 'knownAt', 'changedAt', 'level'];

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
    incoming.forEach((record, id) => {
      const local = store.records[id];
      if (local && local.updatedAt > startedAt) return;
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
    removeState,
    removeWord,
    setDefinition,
    setWordState,
    statesOf,
    summarize,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
