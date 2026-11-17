/*
Module: bg-vocab
Purpose: Own the reader's vocabulary estimate in the background, as EZFurigana does: the Japanese level they chose (or that they skipped the question), this browser's reading evidence (words met in a read stretch and words looked up there, per difficulty), and the evidence of the reader's other browsers that EZFurigana passes on. Answer the popup with the estimate and take part in the EZFurigana word sync.

Inputs:
- `vocabGet` and `vocabSetLevel` messages from the popup; `vocabEvidence` messages from content scripts (difficulty bins only).
- The estimate part of an EZFurigana snapshot (`applySyncPart`), through bg-words.
- `chrome.storage.local` key `vocabEstimate`.

Outputs:
- The chosen level, whether to ask for it, the fitted ability, and whether the estimate rests on anything yet.
- The estimate part for the EZFurigana sync push (`syncPart`).

Side Effects:
- Writes `vocabEstimate` in `chrome.storage.local`: `{ level: { value, at }, device, devices: { id: { at, n, k } } }` with numbers only.

Failure Modes:
- Invalid levels, bins, or device entries are ignored; a storage failure rejects the request and nothing changes.

Security Notes:
- Holds no words, sentences, or page addresses: only a level, counts per difficulty, and a random id for this browser's entry, which goes only to EZFurigana in this browser.
- Evidence is accepted from this extension's own content scripts and the level only from extension pages (the popup).
*/
import './vocab-model.js';

const Vocab = globalThis.TsukeruVocab;
const KEY = 'vocabEstimate';
const LEVELS = new Set([...Vocab.READER_LEVELS, 'skipped']);
const DEVICE_RE = /^[A-Za-z0-9_-]{8,32}$/;
const MAX_DEVICES = 8;
// One page settles at most this many words of evidence.
const MAX_BINS = 2000;
// The estimate rests on something once this many words are evidence.
const READY_EVIDENCE = 30;

let queue = Promise.resolve();

function validCounts(values) {
  return Array.isArray(values) && values.length === Vocab.BAND_COUNT
    && values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000);
}

function validEntry(entry) {
  return entry && Number.isFinite(entry.at) && entry.at > 0 && validCounts(entry.n) && validCounts(entry.k);
}

function validLevel(level) {
  return level && LEVELS.has(level.value) && Number.isFinite(level.at) && level.at > 0;
}

function newDeviceId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function read() {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  const state = stored && typeof stored === 'object' ? stored : {};
  const devices = {};
  Object.entries(state.devices && typeof state.devices === 'object' ? state.devices : {}).forEach(([id, entry]) => {
    if (DEVICE_RE.test(id) && validEntry(entry)) devices[id] = entry;
  });
  return {
    level: validLevel(state.level) ? { value: state.level.value, at: state.level.at } : null,
    device: typeof state.device === 'string' && DEVICE_RE.test(state.device) ? state.device : newDeviceId(),
    devices,
  };
}

async function write(state) {
  const newest = Object.entries(state.devices).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DEVICES);
  await chrome.storage.local.set({ [KEY]: { level: state.level, device: state.device, devices: Object.fromEntries(newest) } });
}

/** Apply one change to the stored estimate at a time. */
function change(fn) {
  const run = queue.then(async () => {
    const state = await read();
    const changed = fn(state, Date.now());
    if (changed) await write(state);
    return state;
  });
  queue = run.catch(() => {});
  return run;
}

function chosen(state) {
  return state.level && Vocab.READER_LEVELS.includes(state.level.value) ? state.level.value : null;
}

function describe(state) {
  const counts = Vocab.pooledCounts(state.devices, Date.now());
  const evidence = counts.n.reduce((sum, value) => sum + value, 0);
  const level = chosen(state);
  return {
    level,
    ask: !state.level,
    ability: Vocab.fitAbility(counts, level),
    ready: Boolean(level) || evidence >= READY_EVIDENCE,
  };
}

function bins(values) {
  return (Array.isArray(values) ? values : [])
    .slice(0, MAX_BINS)
    .filter((value) => Number.isInteger(value) && value >= 0 && value < Vocab.BAND_COUNT);
}

/** The chosen level and every browser's evidence, for the EZFurigana sync push. */
export async function syncPart() {
  const state = await read();
  const part = {};
  if (state.level) part.level = state.level;
  if (Object.keys(state.devices).length) part.vocab = state.devices;
  return part;
}

/** Take in the estimate part of an EZFurigana snapshot: the later level, each browser's newer evidence. */
export async function applySyncPart(part) {
  if (!part || typeof part !== 'object') return;
  await change((state) => {
    let changed = false;
    if (validLevel(part.level) && (!state.level || part.level.at > state.level.at)) {
      state.level = { value: part.level.value, at: part.level.at };
      changed = true;
    }
    Object.entries(part.vocab && typeof part.vocab === 'object' ? part.vocab : {}).forEach(([id, entry]) => {
      if (!DEVICE_RE.test(id) || !validEntry(entry)) return;
      if (!state.devices[id] || entry.at > state.devices[id].at) {
        state.devices[id] = { at: entry.at, n: entry.n, k: entry.k };
        changed = true;
      }
    });
    return changed;
  });
}

const VOCAB_ACTIONS = new Set(['vocabGet', 'vocabSetLevel', 'vocabEvidence']);

export function isVocabAction(action) {
  return VOCAB_ACTIONS.has(action);
}

function fromExtensionPage(sender) {
  return Boolean(sender) && sender.id === chrome.runtime.id && !sender.tab;
}

/** Answer one estimate message; rejects on storage failure. */
export async function handleVocabMessage(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id) return { success: false };
  switch (message.action) {
    case 'vocabGet':
      return { success: true, ...describe(await read()) };
    case 'vocabSetLevel': {
      if (!fromExtensionPage(sender) || !LEVELS.has(message.level)) return { success: false };
      const state = await change((current, at) => {
        current.level = { value: message.level, at };
        return true;
      });
      return { success: true, ...describe(state) };
    }
    case 'vocabEvidence': {
      const read = bins(message.read);
      const looked = bins(message.looked);
      if (!read.length && !looked.length) return { success: true };
      await change((state, at) => {
        state.devices[state.device] = Vocab.addEvidence(state.devices[state.device], { read, looked }, at);
        return true;
      });
      return { success: true };
    }
    default:
      return { success: false };
  }
}
