/*
Module: popup-main
Purpose: Bootstrap popup navigation (the This page, My Words and Discover tabs, Settings behind the header gear, and the Supporter view behind the header star and the free account card's button), language/theme settings, and report modal submission behavior.

Inputs:
- Popup DOM events, runtime report responses, resolved display language and sync preferences, and user-agent/platform hints.

Outputs:
- Active tab-pane state changes (This page normally opens first; language changes reopen Settings) and report success/error UI feedback.

Side Effects:
- Mutates popup DOM state, shows the toggle shortcut the browser has set (`commands.getAll`), sets language-specific home/pricing/store-review links, requests coalesced page-word refreshes, and sends `reportReadingError` messages.
- Starts the occasional store-review card (`popup-review`), the Japanese level question (`popup-level`), the Discover tab (`popup-discover`, loaded when first shown), and the occasional word game slip in My Words (`popup-kakurenbo`).

Failure Modes:
- Runtime messaging failures keep the modal open with localized error feedback; raw backend messages are not displayed.
- Missing expected DOM nodes can break event wiring.

Security Notes:
- Sends only explicit user-entered report fields.
- No secret handling or persistent sensitive data storage.
*/
// Entry point: tab navigation, report modal wiring, and bootstrap.
import {
  applyI18nToPopupDom,
  closeReportModal,
  initSettingsForm,
  initThemeToggle,
  initLocaleSelect,
  t,
  userFacingError,
} from './popup-settings.js';
import { initMyWordsTab, initPageTab, loadMyWords, relativeTime, requestPageWordsRefresh } from './popup-vocab.js';
import { initReviewPrompt } from './popup-review.js';
import { initLevelAsk } from './popup-level.js';
import { initDiscover, resetDiscover, showDiscover } from './popup-discover.js';
import { initKakurenboSlip } from './popup-kakurenbo.js';
import { prefetchSupporterPerks, showSupporterView } from './popup-supporter.js';
import { storeReviewUrl } from './review-prompt.js';

// ── Tab navigation ────────────────────────────────────────────────────────────

// Settings and the Supporter view have no tab of their own: the header gear
// and star open them, and pressing the same button again goes back to the tab
// that was open.
const HEADER_VIEWS = new Set(['settings', 'supporter']);
let currentTab = 'page';
let tabBeforeHeaderView = 'page';

function selectTab(targetTab) {
  if (HEADER_VIEWS.has(targetTab) && !HEADER_VIEWS.has(currentTab)) tabBeforeHeaderView = currentTab;
  currentTab = targetTab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === targetTab));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `${targetTab}-tab`));
  document.getElementById('settingsToggle')?.setAttribute('aria-pressed', String(targetTab === 'settings'));
  if (targetTab === 'words') {
    loadMyWords();
  } else if (targetTab === 'page') {
    requestPageWordsRefresh();
  } else if (targetTab === 'discover') {
    showDiscover();
  }
}

function initTabNavigation() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });
  document.getElementById('settingsToggle')?.addEventListener('click', () => {
    selectTab(currentTab === 'settings' ? tabBeforeHeaderView : 'settings');
  });
  // The star keeps its pricing link for opening in a new tab; a plain click opens the view.
  document.getElementById('header-supporter-link')?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (currentTab === 'supporter') {
      selectTab(tabBeforeHeaderView);
      return;
    }
    openSupporterView('header');
  });
  document.getElementById('supporterCardAction')?.addEventListener('click', (event) => {
    if (supporterState !== 'free' || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openSupporterView('account');
  });
}

/** The Supporter view, for this browser's connection, opened from the star or the account card. */
function openSupporterView(entry) {
  supporterEntry = entry;
  showSupporterView(supporterState, entry);
  selectTab('supporter');
  document.getElementById('supporter-tab')?.scrollIntoView({ block: 'start' });
}

/** Open Settings at the reader's level (from Discover's "Choose level"). */
function openLevelSetting() {
  selectTab('settings');
  document.querySelector('[data-level-ask][data-mode="change"]')?.scrollIntoView({ block: 'center' });
}

/** Language changes reopen Settings once; normal openings start on This page. */
function selectInitialTab() {
  selectTab(location.hash === '#settings' ? 'settings' : 'page');
  if (location.hash) history.replaceState(null, '', location.pathname);
}

// ── Report modal event wiring (DOM is ready: module scripts are deferred) ─────

document.getElementById('extReportClose').addEventListener('click', closeReportModal);

document.getElementById('extReportSubmit').addEventListener('click', () => {
  const word = document.getElementById('extReportWord').value;
  const reading = document.getElementById('extReportReading').value;
  const contextSentence = document.getElementById('extReportContext').value;
  const correctReading = document.getElementById('extReportCorrect').value.trim();
  const errorDiv = document.getElementById('extReportError');
  const successDiv = document.getElementById('extReportSuccess');
  const submitBtn = document.getElementById('extReportSubmit');

  submitBtn.disabled = true;
  submitBtn.textContent = t('report_submitting', undefined, 'Submitting...');
  errorDiv.classList.add('hidden');
  successDiv.classList.add('hidden');

  chrome.runtime.sendMessage({
    action: 'reportReadingError',
    payload: {
      word,
      reading,
      context_sentence: contextSentence,
      correct_reading: correctReading,
      consent_given: !!contextSentence
    }
  }, (response) => {
    if (response && response.success) {
      successDiv.textContent = t('report_submit_success', undefined, 'Thank you! Your report has been submitted.');
      successDiv.classList.remove('hidden');
      setTimeout(closeReportModal, 1500);
    } else {
      const errMsg = userFacingError(chrome.runtime.lastError ? {} : response, 'report');
      errorDiv.textContent = errMsg;
      errorDiv.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = t('report_submit_button', undefined, 'Submit Report');
    }
  });
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

function getEzfuriganaHomeUrl() {
  return TsukeruI18n.websiteUrl();
}

// `placement` lets the pricing page count the click (the header star or the
// account card); the extension reports nothing.
function getEzfuriganaPricingUrl(placement = 'extension_account') {
  return TsukeruI18n.websiteUrl(`/pricing?from=tsukeru&placement=${placement}`);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await TsukeruI18n.ready();
    document.documentElement.lang = TsukeruI18n.language();
    applyI18nToPopupDom();
    initLocaleSelect();
    initThemeToggle();

    const reviewStore = navigator.userAgent.toLowerCase().includes('edg/') ? 'edge' : 'firefox';
    const reviewLink = document.getElementById('header-review-link');
    if (reviewLink) {
      reviewLink.href = storeReviewUrl(reviewStore, TsukeruI18n.language());
      reviewLink.title = reviewStore === 'edge'
        ? t('header_title_review_edge', undefined, 'Review on Edge Add-ons Store')
        : t('header_title_review_firefox', undefined, 'Review on Firefox Add-ons');
      reviewLink.setAttribute('aria-label', reviewLink.title);
    }

    const ezfuriganaLink = document.getElementById('header-ezfurigana-link');
    if (ezfuriganaLink) {
      ezfuriganaLink.href = getEzfuriganaHomeUrl();
    }

    const supporterLink = document.getElementById('header-supporter-link');
    if (supporterLink) supporterLink.href = getEzfuriganaPricingUrl('extension_header');
    // Never let the plan check stop the popup from starting.
    initSupporterCard();
    prefetchSupporterPerks();

    const shortcutText = document.getElementById('shortcut-text');
    if (shortcutText) void showToggleShortcut(shortcutText);

    initSettingsForm();
    initMyWordsTab();
    initPageTab();
    // A new level changes how much of each article the reader knows.
    const levelAsk = initLevelAsk({ onChange: () => { requestPageWordsRefresh(); resetDiscover(); } });
    initDiscover({ onChooseLevel: openLevelSetting });
    initTabNavigation();
    selectInitialTab();
    const reviewPrompt = initReviewPrompt({ store: reviewStore, language: TsukeruI18n.language() });
    // The word game slip waits for the level question and review card, so only one card shows.
    void Promise.allSettled([levelAsk, reviewPrompt])
      .then(() => initKakurenboSlip({ language: TsukeruI18n.language() }));
  } finally {
    document.documentElement.removeAttribute('data-i18n-pending');
  }
});

// Show the toggle key the browser has, since a reader can change it or leave
// it unset (and Firefox for Android has no commands API); hidden without one.
async function showToggleShortcut(element) {
  try {
    const commands = await chrome.commands?.getAll?.();
    const shortcut = commands?.find((command) => command.name === 'toggle-furigana')?.shortcut || '';
    if (!shortcut) return;
    element.textContent = t('shortcut_toggle', [shortcut.replace(/MacCtrl/g, 'Ctrl')], '$1 to toggle');
    element.hidden = false;
  } catch {
    // Leave the hint hidden.
  }
}

// ── EZFurigana account card ───────────────────────────────────────────────────

const SUPPORTER_CARD = {
  none: { text: () => t('supporter_state_none', undefined, 'Connect a free account to try sentence audio and explanations. Supporters get much more.'), meta: () => t('supporter_connect_hint', undefined, 'Opens ezfurigana.com. Sign in there and Tsukeru connects by itself.'), action: () => t('supporter_connect', undefined, 'Connect account'), path: '/account?tsukeru=connect' },
  free: { text: () => t('supporter_state_free', undefined, 'Connected with a free account. You can try sentence audio and explanations a few times a week.'), action: () => t('supporter_become', undefined, 'Become a Supporter'), pricing: true },
  supporter: { text: () => t('supporter_state_supporter', undefined, 'Connected as a Supporter'), action: () => t('supporter_manage', undefined, 'Manage account'), path: '/account' },
  disconnected: { text: () => t('supporter_state_disconnected', undefined, 'Disconnected from your EZFurigana account. Connect again to use your account in Tsukeru.'), action: () => t('supporter_connect', undefined, 'Connect account'), path: '/account?tsukeru=connect' },
  expired: { text: () => t('supporter_state_expired', undefined, 'Your Supporter connection expired. Open EZFurigana once to reconnect.'), action: () => t('supporter_reconnect', undefined, 'Reconnect'), path: '/account?tsukeru=connect' },
};

// The connection the account card shows, and where the Supporter view was opened.
let supporterState = 'none';
let supporterEntry = 'header';

/** Show how this browser is connected; the header star follows the same answer. */
function renderSupporterCard(status) {
  const card = document.getElementById('supporterCard');
  const state = SUPPORTER_CARD[status?.state] ? status.state : 'none';
  supporterState = state;
  // An open Supporter view follows a connection that finishes meanwhile.
  if (currentTab === 'supporter') showSupporterView(state, supporterEntry);
  const copy = SUPPORTER_CARD[state];
  const supporterLink = document.getElementById('header-supporter-link');
  if (supporterLink) {
    const supporter = state === 'supporter';
    supporterLink.classList.toggle('is-supporter', supporter);
    // websiteUrl keeps the display language's prefix (/zh/account); new URL('/account', …) would drop it.
    supporterLink.href = supporter ? TsukeruI18n.websiteUrl('/account') : getEzfuriganaPricingUrl('extension_header');
    supporterLink.title = supporter
      ? t('header_title_supporter_active', undefined, "You're a Supporter")
      : t('header_title_become_supporter', undefined, 'Become a Supporter');
    supporterLink.setAttribute('aria-label', supporterLink.title);
  }
  if (!card) return;
  // Re-rendering the same state must not replay the check animation.
  if (card.dataset.state !== state) card.dataset.state = state;
  document.getElementById('supporterCardText').textContent = copy.text();
  const meta = document.getElementById('supporterCardMeta');
  if (state === 'supporter' && Number.isFinite(status.checkedAt)) {
    meta.textContent = t('supporter_checked', [relativeTime(status.checkedAt)], `Checked ${relativeTime(status.checkedAt)}`);
  } else {
    meta.textContent = copy.meta ? copy.meta() : '';
  }
  meta.hidden = !meta.textContent;
  const action = document.getElementById('supporterCardAction');
  action.textContent = copy.action();
  action.href = copy.pricing ? getEzfuriganaPricingUrl() : TsukeruI18n.websiteUrl(copy.path);
  action.hidden = false;
}

function initSupporterCard() {
  const refresh = () => Promise.resolve()
    .then(() => chrome.runtime.sendMessage({ action: 'getSupporterStatus' }))
    .then((status) => { if (status?.success) renderSupporterCard(status); })
    .catch(() => { /* Keep the card as it is. */ });
  refresh();
  // Connecting finishes on the website; update while the popup stays open.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.tsukeruSupporter) refresh();
  });
}
