/*
Module: popup-kakurenbo
Purpose: Now and then, at the top of My Words, suggest EZFurigana's daily word game, かくれんぼ.

Inputs:
- Usage records written by the background, the slip's state, the UI language, whether another card already shows in this opening, and clicks on the slip and the My Words tab.

Outputs:
- A visible or hidden slip under the My Words review strip, linking to the game in the UI language.

Side Effects:
- Reads usage and reads/writes the slip's state in chrome.storage.local (a showing is saved only once My Words is open); the link opens ezfurigana.com in a new tab.

Failure Modes:
- Storage failures keep the slip hidden; a failed save only means it may appear again later.

Security Notes:
- Opens only a fixed ezfurigana.com URL; sends and stores no page content, words, or page addresses.
*/
import { REVIEW_USAGE_KEY } from './review-prompt.js';
import {
  KAKURENBO_SLIP_STATE_KEY,
  decideKakurenboSlip,
  dismissKakurenboSlip,
  kakurenboUrl,
} from './kakurenbo-slip.js';

async function saveState(state) {
  try {
    await chrome.storage.local.set({ [KAKURENBO_SLIP_STATE_KEY]: state });
  } catch (_) {
    console.warn('Tsukeru: could not save the word game slip state');
  }
}

// One card per opening: a notice, the review card, or the level question wins.
function anotherCardShown() {
  return ['status', 'reviewPrompt', 'pageLevelAsk'].some((id) => document.getElementById(id)?.hidden === false);
}

/** Run `seen` once My Words is on screen, now or when its tab is chosen. */
function whenWordsShown(seen) {
  if (document.getElementById('words-tab')?.classList.contains('active')) {
    seen();
    return;
  }
  const tab = document.querySelector('.tab-btn[data-tab="words"]');
  tab?.addEventListener('click', seen, { once: true });
}

export async function initKakurenboSlip({ language, now = Date.now() }) {
  const slip = document.getElementById('kakurenboSlip');
  if (!slip || anotherCardShown()) return;
  let stored;
  try {
    stored = await chrome.storage.local.get([REVIEW_USAGE_KEY, KAKURENBO_SLIP_STATE_KEY]);
  } catch (_) {
    return;
  }
  const decision = decideKakurenboSlip(stored[REVIEW_USAGE_KEY], stored[KAKURENBO_SLIP_STATE_KEY], now);
  if (!decision.show || anotherCardShown()) return;

  let state = decision.state;
  // Only an opening that reaches My Words counts as a showing.
  whenWordsShown(() => {
    if (state.lastAskAt !== stored[KAKURENBO_SLIP_STATE_KEY]?.lastAskAt) void saveState(state);
  });
  const close = (action) => {
    slip.hidden = true;
    state = dismissKakurenboSlip(state, action, Date.now());
    void saveState(state);
  };
  const open = document.getElementById('kakurenboSlipOpen');
  open.href = kakurenboUrl(language);
  // The link opens the game itself; recording the choice must not block it.
  open.addEventListener('click', () => close('opened'));
  document.getElementById('kakurenboSlipLater')?.addEventListener('click', () => close('later'));
  slip.hidden = false;
}
