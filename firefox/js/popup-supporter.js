/*
Module: popup-supporter
Purpose: Render the popup's Supporter view: what a free account and a Supporter get in Tsukeru (sentence audio, Explain, and the dictionary in the reader's language), what stays free, and one button on to the pricing page, or to the account for Supporters.

Inputs:
- The connection state the account card shows (`none`, `free`, `supporter`, `disconnected`, `expired`) and how the view was opened (`header` or `account`).
- Plan figures from the background (`getSupporterPerks`), the display language, and the shared i18n catalog.

Outputs:
- The view's rows, sign-in line and button inside `#supporter-tab`.

Side Effects:
- Asks the background for the plan figures once per popup opening (as it opens), and waits up to 600 ms for them before showing the rows without numbers.

Failure Modes:
- Without figures (offline, or an older server) the rows show without numbers; a feature the server has switched off is left out.

Security Notes:
- Builds every row with DOM APIs and text; figures are positive integers checked by the background.
- Links go only to fixed EZFurigana pages; the pricing link names where the view was opened (`placement=extension_header` or `extension_account`) and nothing else.
*/
import { t } from './popup-settings.js';

// The dictionary row is for display languages with translated meanings.
const TRANSLATED_DICTIONARY_LANGUAGES = new Set(['ja', 'ko', 'zh-CN', 'zh-TW']);
const SUPPORTER_VIEW_ENTRIES = new Set(['header', 'account']);

// Each row's text; `free` and `supporter` take the figure as a formatted number.
const SUPPORTER_VIEW_ROWS = [
  {
    perk: 'sentenceAudio',
    title: () => t('supporter_view_audio', undefined, 'Sentence audio'),
    description: () => t('supporter_view_audio_desc', undefined, 'Hear a sentence read aloud by a natural Japanese voice.'),
    free: (n) => t('supporter_view_audio_free', [n], `${n} new sentences a week`),
    supporter: (n) => t('supporter_view_audio_supporter', [n], `About ${n} new sentences a month`),
  },
  {
    perk: 'explain',
    title: () => t('supporter_view_explain', undefined, 'Explain a sentence'),
    description: () => t('supporter_view_explain_desc', undefined, 'A translation into your language, then what each part of the sentence means.'),
    free: (n) => t('supporter_view_explain_free', [n], `${n} a week`),
    supporter: (n) => t('supporter_view_explain_supporter', [n], `${n} a day`),
  },
  {
    perk: 'dictionary',
    title: () => t('supporter_view_dictionary', undefined, 'Dictionary in your language'),
    description: () => t('supporter_view_dictionary_desc', undefined, 'Word meanings in your language instead of English.'),
    free: (n) => t('supporter_view_dictionary_free', [n], `${n} new words a week`),
    supporter: (n) => t('supporter_view_dictionary_supporter', [n], `${n} new words a day`),
    translatedOnly: true,
  },
];

// Figures arrive once per popup opening; until then, wait this long before
// showing the rows without numbers.
const PERKS_WAIT_MS = 600;
let perksRequest = null;
let knownPerks;
let shown = { state: 'none', entry: 'header' };

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function formatCount(count) {
  return count.toLocaleString(TsukeruI18n.language());
}

function requestPerks() {
  if (!perksRequest) {
    perksRequest = Promise.resolve()
      .then(() => chrome.runtime.sendMessage({ action: 'getSupporterPerks' }))
      .then((response) => (response?.success ? response.perks || null : null))
      .catch(() => null)
      .then((perks) => {
        knownPerks = perks;
        return perks;
      });
  }
  return perksRequest;
}

/** Ask for the figures as the popup opens, so the view usually has them at once. */
export function prefetchSupporterPerks() {
  void requestPerks();
}

/** One plan's figure in a row, with its plan named for screen readers. */
function planCell(plan, describe, count) {
  const cell = document.createElement('div');
  cell.className = `supporter-view-value supporter-view-value-${plan}`;
  const name = plan === 'free'
    ? t('supporter_view_col_free', undefined, 'Free account')
    : t('supporter_view_col_supporter', undefined, 'Supporter');
  cell.append(text('span', 'visually-hidden', `${name}: `), text('span', '', describe(formatCount(count))));
  return cell;
}

function renderPlans(perks, state) {
  const host = document.getElementById('supporterViewPlans');
  if (!host) return;
  const supporter = state === 'supporter';
  const translated = TRANSLATED_DICTIONARY_LANGUAGES.has(TsukeruI18n.language());
  const rows = SUPPORTER_VIEW_ROWS.filter((row) => (!row.translatedOnly || translated)
    && (!perks || perks[row.perk]));
  host.dataset.figures = perks ? 'shown' : 'none';
  host.dataset.plan = supporter ? 'supporter' : 'free';
  const nodes = [];
  if (perks) {
    const head = document.createElement('div');
    head.className = 'supporter-view-head';
    head.setAttribute('aria-hidden', 'true');
    if (!supporter) head.append(text('span', 'supporter-view-col', t('supporter_view_col_free', undefined, 'Free account')));
    head.append(text('span', 'supporter-view-col supporter-view-col-supporter', t('supporter_view_col_supporter', undefined, 'Supporter')));
    nodes.push(head);
  }
  for (const row of rows) {
    const item = document.createElement('section');
    item.className = 'supporter-view-row';
    item.append(
      text('h3', 'supporter-view-row-title', row.title()),
      text('p', 'supporter-view-row-desc', row.description()),
    );
    const figures = perks?.[row.perk];
    if (figures) {
      const values = document.createElement('div');
      values.className = 'supporter-view-values';
      if (!supporter) values.append(planCell('free', row.free, figures.free));
      values.append(planCell('supporter', row.supporter, figures.supporter));
      item.append(values);
    }
    nodes.push(item);
  }
  host.replaceChildren(...nodes);
}

function renderSignIn(perks, state) {
  const box = document.getElementById('supporterViewSignIn');
  if (!box) return;
  const signedOut = state !== 'free' && state !== 'supporter';
  box.hidden = !signedOut;
  if (!signedOut) return;
  const audio = perks?.sentenceAudio?.free;
  const explain = perks?.explain?.free;
  document.getElementById('supporterViewSignInText').textContent = audio && audio === explain
    ? t('supporter_view_sign_in_count', [formatCount(audio)], `Sign in for free to start: ${formatCount(audio)} sentences a week to listen to and explain.`)
    : t('supporter_view_sign_in', undefined, 'Sign in for free to start listening to and explaining sentences.');
  document.getElementById('supporterViewSignInLink').href = TsukeruI18n.websiteUrl('/account?tsukeru=connect');
}

function render(perks) {
  const { state, entry } = shown;
  const supporter = state === 'supporter';
  const lede = document.getElementById('supporterViewLede');
  if (lede) {
    lede.textContent = supporter
      ? t('supporter_view_lede_supporter', undefined, "You're a Supporter. Thank you!")
      : t('supporter_view_lede', undefined, 'Supporter keeps Tsukeru free for everyone and raises your limits for everyday study.');
  }
  renderSignIn(perks, state);
  renderPlans(perks, state);
  const solo = document.getElementById('supporterViewSolo');
  if (solo) solo.hidden = supporter;
  const action = document.getElementById('supporterViewAction');
  if (action) {
    action.textContent = supporter
      ? t('supporter_manage', undefined, 'Manage account')
      : t('supporter_view_plans', undefined, 'See plans and prices');
    // `placement` lets the pricing page count the click; the extension reports nothing.
    action.href = supporter
      ? TsukeruI18n.websiteUrl('/account')
      : TsukeruI18n.websiteUrl(`/pricing?from=tsukeru&placement=extension_${entry}`);
  }
}

/**
 * Show the view for a connection state, opened from the header star or the
 * account card. Renders at once, then again when the figures arrive.
 */
export function showSupporterView(state, entry) {
  shown = {
    state: typeof state === 'string' ? state : 'none',
    entry: SUPPORTER_VIEW_ENTRIES.has(entry) ? entry : 'header',
  };
  const current = shown;
  if (knownPerks !== undefined) {
    render(knownPerks);
    return;
  }
  const fallback = setTimeout(() => {
    if (shown === current && knownPerks === undefined) render(null);
  }, PERKS_WAIT_MS);
  requestPerks().then((perks) => {
    clearTimeout(fallback);
    if (shown === current) render(perks);
  });
}
