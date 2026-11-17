/*
Module: popup-level
Purpose: Ask the reader's Japanese level once, on the This page tab after furigana has worked for them, and let them change it in Settings, as EZFurigana does. The first answer also sets the JLPT furigana level to match; after that the two change independently.

Inputs:
- The vocabulary estimate from the background (`vocabGet`), the review-prompt usage record (days with furigana), and the reader's word records (for a suggested level).
- Clicks on the level choices and Skip.

Outputs:
- `vocabSetLevel` messages; on the first answer, the JLPT furigana level in `chrome.storage.sync` and an `updateLevel` message to the active tab.
- Pressed and suggested states on the choices; a callback so the page readout refreshes.

Side Effects:
- Writes `levelSystem` and `jlptLevel` to `chrome.storage.sync` once, on the first answer.

Failure Modes:
- Without an answer from the background the question stays hidden and Settings shows no choice pressed.

Security Notes:
- Sends only a level name; no words or page addresses.
*/
import { getActiveTab, normalizeLevel } from './popup-settings.js';
import { REVIEW_USAGE_KEY } from './review-prompt.js';

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn('Tsukeru: level request failed', error?.message);
    return null;
  }
}

/** The level the reader's marked words point to (as on EZFurigana), or null. */
async function suggestedLevel() {
  const Vocab = globalThis.TsukeruVocab;
  if (!Vocab) return null;
  const response = await send({ action: 'wordsList' });
  const byLevel = new Map();
  (response?.success && Array.isArray(response.records) ? response.records : []).forEach((record) => {
    const level = Number(record.level);
    if (!(level >= 1 && level <= 5) || (record.state !== 'known' && record.state !== 'learning')) return;
    const counts = byLevel.get(level) || { known: 0, learning: 0 };
    counts[record.state] += 1;
    byLevel.set(level, counts);
  });
  return Vocab.suggestedLevel(byLevel);
}

async function furiganaHasWorked() {
  try {
    const usage = (await chrome.storage.local.get(REVIEW_USAGE_KEY))[REVIEW_USAGE_KEY];
    return Array.isArray(usage?.activeDays) && usage.activeDays.length > 0;
  } catch (_) {
    return false;
  }
}

/** Set the JLPT furigana level that matches a first answer, here and on the open page. */
async function matchFuriganaLevel(level) {
  const jlptLevel = globalThis.TsukeruVocab?.filterLevelFor(level);
  if (!jlptLevel) return;
  await chrome.storage.sync.set({ levelSystem: 'jlpt', jlptLevel });
  const settings = normalizeLevel(await chrome.storage.sync.get(['levelSystem', 'jlptLevel', 'gradeLevel']));
  const tab = await getActiveTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: 'updateLevel', settings }).catch(() => {});
}

function render(containers, estimate, suggested) {
  containers.forEach((container) => {
    const asking = container.dataset.mode === 'ask';
    container.querySelectorAll('[data-reader-level]').forEach((button) => {
      const value = button.dataset.readerLevel;
      button.setAttribute('aria-pressed', String(!asking && estimate?.level === value));
      if (asking && suggested === value) button.dataset.suggested = 'true';
      else delete button.dataset.suggested;
    });
  });
}

export async function initLevelAsk({ onChange = () => {} } = {}) {
  const containers = Array.from(document.querySelectorAll('[data-level-ask]'));
  if (!containers.length) return;
  let estimate = await send({ action: 'vocabGet' });
  if (!estimate?.success) return;
  const ask = containers.find((container) => container.dataset.mode === 'ask');
  const asking = estimate.ask === true && await furiganaHasWorked();
  const suggested = asking ? await suggestedLevel() : null;
  if (ask) ask.hidden = !asking;
  render(containers, estimate, suggested);

  async function choose(level) {
    const first = estimate.ask === true;
    const response = await send({ action: 'vocabSetLevel', level });
    if (!response?.success) return;
    estimate = response;
    if (first && level !== 'skipped') await matchFuriganaLevel(level);
    if (ask) ask.hidden = true;
    render(containers, estimate, null);
    onChange();
  }

  containers.forEach((container) => {
    container.querySelectorAll('[data-reader-level]').forEach((button) => {
      button.addEventListener('click', () => { choose(button.dataset.readerLevel); });
    });
    container.querySelector('[data-reader-level-skip]')?.addEventListener('click', () => { choose('skipped'); });
  });
}
