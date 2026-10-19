/*
Module: popup-review
Purpose: Show the occasional store-review card in the popup and record the reader's choice.

Inputs:
- Usage records written by the background, prompt state, the active store, the UI language, and card button clicks.

Outputs:
- A visible or hidden review card with a localized store link.

Side Effects:
- Reads usage and reads/writes prompt state in chrome.storage.local; the review link opens the store in a new tab.

Failure Modes:
- Storage failures keep the card hidden; a failed save only means the card may appear again later.

Security Notes:
- Opens only fixed store URLs; stores no page content, words, or ratings.
*/
import {
  REVIEW_STATE_KEY,
  REVIEW_USAGE_KEY,
  decideReviewPrompt,
  dismissReviewPrompt,
  storeReviewUrl,
} from './review-prompt.js';

async function saveState(state) {
  try {
    await chrome.storage.local.set({ [REVIEW_STATE_KEY]: state });
  } catch (_) {
    console.warn('Tsukeru: could not save the review prompt state');
  }
}

export async function initReviewPrompt({ store, language, now = Date.now() }) {
  const card = document.getElementById('reviewPrompt');
  if (!card) return;
  let stored;
  try {
    stored = await chrome.storage.local.get([REVIEW_USAGE_KEY, REVIEW_STATE_KEY]);
  } catch (_) {
    return;
  }
  const decision = decideReviewPrompt(stored[REVIEW_USAGE_KEY], stored[REVIEW_STATE_KEY], now);
  // Never compete with an error or limit notice.
  if (!decision.show || document.getElementById('status')?.hidden === false) return;
  if (decision.state.lastAskAt !== stored[REVIEW_STATE_KEY]?.lastAskAt) await saveState(decision.state);

  let state = decision.state;
  const close = (action) => {
    card.hidden = true;
    state = dismissReviewPrompt(state, action, Date.now());
    void saveState(state);
  };
  const rate = document.getElementById('reviewPromptRate');
  rate.href = storeReviewUrl(store, language);
  // The link opens the store itself; recording the choice must not block it.
  rate.addEventListener('click', () => close('reviewed'));
  document.getElementById('reviewPromptLater')?.addEventListener('click', () => close('later'));
  document.getElementById('reviewPromptNever')?.addEventListener('click', () => close('never'));
  card.hidden = false;
}
