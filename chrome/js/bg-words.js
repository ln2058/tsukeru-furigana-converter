/*
Module: bg-words
Purpose: Own the My Words store in the background: load and persist word records, move the retired saved-word list into Learning, answer word requests from content scripts and the popup, run the EZFurigana sync exchange, and keep the toolbar badge showing how many words are due for review.

Inputs:
- Word messages from content scripts and the popup (capture, state, definition, removal, listing).
- Sync messages from the content script on EZFurigana pages (outbox request and the page's record snapshot).
- `chrome.storage.local` word records, removals, sync metadata, and the retired `vocabulary` list.

Outputs:
- Message responses with word states, records, summaries, and sync payloads.
- Toolbar badge text with the number of learning words due now.

Side Effects:
- Writes one `chrome.storage.local` key per word (`w:`), per pending removal (`wr:`), and `wordsMeta`; removes or trims the retired `vocabulary` key after migrating it.
- Sets the toolbar badge text and colour.

Failure Modes:
- Storage failures reject the request and reload the store from storage on the next request.
- Invalid words, states, and snapshot rows are ignored; sync messages outside the HTTPS www.ezfurigana.com origin are refused.

Security Notes:
- This module is the only writer, so concurrent tabs cannot overwrite each other's changes.
- Sync is accepted only from this extension's content script on https://www.ezfurigana.com (default port).
- Records hold no page URLs; nothing here sends words over the network.
*/
import './word-rules.js';

const Words = globalThis.TsukeruWords;

const RECORD_PREFIX = 'w:';
const REMOVED_PREFIX = 'wr:';
const META_KEY = 'wordsMeta';
const LEGACY_VOCABULARY_KEY = 'vocabulary';
const MAX_TEXT_LENGTH = 400;
const BADGE_COLOR = '#1a7ffc';

let storePromise = null;
let queue = Promise.resolve();
let lastAt = 0;

// Strictly increasing times, so a change made in the same millisecond as a
// sync exchange is still recognised as newer than it.
function nextTime() {
  lastAt = Math.max(Date.now(), lastAt + 1);
  return lastAt;
}

function recordKey(id) {
  return RECORD_PREFIX + encodeURIComponent(id);
}

function removedKey(id) {
  return REMOVED_PREFIX + encodeURIComponent(id);
}

async function flush(store) {
  const set = {};
  const remove = [];
  store.dirtyRecords.forEach((id) => {
    if (store.records[id]) set[recordKey(id)] = store.records[id];
    else remove.push(recordKey(id));
  });
  store.dirtyRemoved.forEach((id) => {
    if (store.removed[id]) set[removedKey(id)] = store.removed[id];
    else remove.push(removedKey(id));
  });
  if (store.metaDirty) set[META_KEY] = store.meta;
  store.dirtyRecords.clear();
  store.dirtyRemoved.clear();
  store.metaDirty = false;
  if (remove.length) await chrome.storage.local.remove(remove);
  if (Object.keys(set).length) await chrome.storage.local.set(set);
}

async function readStore() {
  const all = await chrome.storage.local.get(null);
  const records = {};
  const removed = {};
  Object.entries(all).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    if (key.startsWith(RECORD_PREFIX) && typeof value.id === 'string') records[value.id] = value;
    else if (key.startsWith(REMOVED_PREFIX)) removed[decodeURIComponent(key.slice(REMOVED_PREFIX.length))] = value;
  });
  const store = Words.createStore(records, removed, all[META_KEY] || {});
  const legacy = all[LEGACY_VOCABULARY_KEY];
  if (Array.isArray(legacy)) {
    // Saved words are retired: they become Learning words. Kana-only words
    // cannot be tracked, so they stay where they were.
    const kept = Words.importVocabulary(store, legacy, nextTime());
    await flush(store);
    if (!kept.length) await chrome.storage.local.remove(LEGACY_VOCABULARY_KEY);
    else if (kept.length < legacy.length) await chrome.storage.local.set({ [LEGACY_VOCABULARY_KEY]: kept });
  }
  return store;
}

function loadStore() {
  if (!storePromise) {
    storePromise = readStore().catch((error) => {
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}

async function refreshBadge(store) {
  const { due } = Words.summarize(store, Date.now());
  const text = due > 99 ? '99+' : (due > 0 ? String(due) : '');
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } catch (error) {
    console.warn('Tsukeru: could not update the badge', error?.message);
  }
}

/** Apply one change to the store, one at a time, and persist what it touched. */
function update(change) {
  const run = queue.then(async () => {
    const store = await loadStore();
    const result = change(store, nextTime());
    const recordsChanged = store.dirtyRecords.size > 0;
    try {
      await flush(store);
    } catch (error) {
      // Memory and storage may now differ; read storage again next time.
      storePromise = null;
      throw error;
    }
    if (recordsChanged) refreshBadge(store);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export async function refreshWordBadge() {
  try {
    await refreshBadge(await loadStore());
  } catch (error) {
    console.warn('Tsukeru: could not read words', error?.message);
  }
}

function text(value, max = MAX_TEXT_LENGTH) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function wordInput(message) {
  return {
    word: text(message.word, 200),
    reading: text(message.reading, 200),
    sentence: text(message.sentence),
    level: message.level,
    pos: text(message.pos, 80),
    definition: text(message.definition),
  };
}

function brief(record) {
  return record ? { id: record.id, word: record.word, reading: record.reading, state: record.state } : null;
}

function isEzfuriganaSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url || sender.tab?.url || '');
    return url.origin === 'https://www.ezfurigana.com';
  } catch (_) {
    return false;
  }
}

const WORD_ACTIONS = new Set([
  'wordsGetStates', 'wordsList', 'wordsCapture', 'wordsSetState', 'wordsSetDefinition',
  'wordsRemove', 'wordsClear', 'wordsSyncStart', 'wordsSyncFinish',
]);

export function isWordsAction(action) {
  return WORD_ACTIONS.has(action);
}

/** Answer one word message; rejects on storage failure. */
export async function handleWordsMessage(message, sender) {
  switch (message.action) {
    case 'wordsGetStates': {
      const store = await loadStore();
      return { success: true, states: Words.statesOf(store) };
    }
    case 'wordsList': {
      const store = await loadStore();
      return { success: true, records: Words.listRecords(store), summary: Words.summarize(store, Date.now()) };
    }
    case 'wordsCapture': {
      const record = await update((store, at) => Words.captureWord(store, wordInput(message), at, {
        countCheck: message.countCheck === true,
        source: message.source === 'study' ? 'study' : 'lookup',
      }));
      return { success: true, record: brief(record) };
    }
    case 'wordsSetState': {
      const record = await update((store, at) => Words.setWordState(store, wordInput(message), message.state, at));
      return { success: Boolean(record), record: brief(record) };
    }
    case 'wordsSetDefinition': {
      await update((store, at) => Words.setDefinition(store, wordInput(message), message.definition, at));
      return { success: true };
    }
    case 'wordsRemove': {
      const removed = await update((store, at) => Words.removeWord(store, text(message.id), at));
      return { success: removed };
    }
    case 'wordsClear': {
      if (message.state !== 'learning' && message.state !== 'known') return { success: false };
      const count = await update((store, at) => Words.removeState(store, message.state, at));
      return { success: true, count };
    }
    case 'wordsSyncStart': {
      if (!isEzfuriganaSender(sender)) return { success: false };
      const storeId = text(message.storeId, 100) || null;
      const outbox = await update((store, at) => Words.buildOutbox(store, storeId, at));
      return { success: true, ...outbox };
    }
    case 'wordsSyncFinish': {
      if (!isEzfuriganaSender(sender)) return { success: false };
      const startedAt = Number(message.startedAt);
      if (!Number.isFinite(startedAt) || startedAt <= 0 || !Array.isArray(message.records)) return { success: false };
      const storeId = text(message.storeId, 100) || null;
      const changed = await update((store, at) => Words.mergeSnapshot(store, message.records, { startedAt, storeId, at }));
      return { success: true, changed };
    }
    default:
      return { success: false };
  }
}
