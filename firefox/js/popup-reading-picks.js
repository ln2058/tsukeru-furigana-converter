/*
Module: popup-reading-picks
Purpose: Now and then, when This page has no words yet, suggest EZFurigana's reading picks (free things to read, sorted by JLPT level).

Inputs:
- Usage records written by the background, the reading-picks state, the UI language, the reader's level (`vocabGet`), whether the first page listing was empty, and clicks on the slip.

Outputs:
- A visible or hidden slip inside the empty This page state, linking to the page in the UI language and filtered to the reader's level.

Side Effects:
- Reads usage and reads/writes the reading-picks state in chrome.storage.local; the link opens ezfurigana.com in a new tab.

Failure Modes:
- Storage or messaging failures keep the slip hidden; a failed save only means it may appear again later.

Security Notes:
- Opens only a fixed ezfurigana.com URL; sends and stores no page content, words, or page addresses.
*/
import { REVIEW_USAGE_KEY } from './review-prompt.js';
import {
  READING_PICKS_STATE_KEY,
  decideReadingPicks,
  dismissReadingPicks,
  readingPicksAvailable,
  readingPicksUrl,
} from './reading-picks.js';

async function saveState(state) {
  try {
    await chrome.storage.local.set({ [READING_PICKS_STATE_KEY]: state });
  } catch (_) {
    console.warn('Tsukeru: could not save the reading picks state');
  }
}

async function readerLevel() {
  try {
    const estimate = await chrome.runtime.sendMessage({ action: 'vocabGet' });
    return estimate?.success && typeof estimate.level === 'string' ? estimate.level : null;
  } catch (_) {
    return null;
  }
}

// One card at a time: an error or limit notice, the review card, or the level question wins.
function anotherCardShown() {
  return ['status', 'reviewPrompt', 'pageLevelAsk'].some((id) => document.getElementById(id)?.hidden === false);
}

export async function initReadingPicks({ language, pageListed, now = Date.now() }) {
  const slip = document.getElementById('readingPicks');
  if (!slip || !readingPicksAvailable(language)) return;
  let stored;
  try {
    stored = await chrome.storage.local.get([REVIEW_USAGE_KEY, READING_PICKS_STATE_KEY]);
  } catch (_) {
    return;
  }
  const decision = decideReadingPicks(stored[REVIEW_USAGE_KEY], stored[READING_PICKS_STATE_KEY], now);
  if (!decision.show) return;
  // Only an empty page counts as a showing; a page with furigana keeps its words.
  if (!(await pageListed) || anotherCardShown()) return;
  if (decision.state.lastAskAt !== stored[READING_PICKS_STATE_KEY]?.lastAskAt) await saveState(decision.state);

  let state = decision.state;
  const close = (action) => {
    slip.hidden = true;
    state = dismissReadingPicks(state, action, Date.now());
    void saveState(state);
  };
  const open = document.getElementById('readingPicksOpen');
  open.href = readingPicksUrl(language, await readerLevel());
  // The link opens the page itself; recording the choice must not block it.
  open.addEventListener('click', () => close('opened'));
  document.getElementById('readingPicksLater')?.addEventListener('click', () => close('later'));
  slip.hidden = false;
}
