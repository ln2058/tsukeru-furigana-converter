/*
Module: popup-main
Purpose: Bootstrap popup navigation, language/theme settings, and report modal submission behavior.

Inputs:
- Popup DOM events, runtime report responses, resolved display language and sync preferences, and user-agent/platform hints.

Outputs:
- Active tab-pane state changes (This page normally opens first; language changes reopen Settings) and report success/error UI feedback.

Side Effects:
- Mutates popup DOM state, sets language-specific home/pricing/store-review links, requests coalesced page-word refreshes, and sends `reportReadingError` messages.
- Starts the occasional store-review card (`popup-review`).
- Applies Firefox shortcut label defaults in popup UI.

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
import { storeReviewUrl } from './review-prompt.js';

// ── Tab navigation ────────────────────────────────────────────────────────────

function selectTab(targetTab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === targetTab));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `${targetTab}-tab`));
  if (targetTab === 'words') {
    loadMyWords();
  } else if (targetTab === 'page') {
    requestPageWordsRefresh();
  }
}

function initTabNavigation() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });
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

function getEzfuriganaPricingUrl() {
  return TsukeruI18n.websiteUrl('/pricing');
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
    if (supporterLink) supporterLink.href = getEzfuriganaPricingUrl();
    // Never let the plan check stop the popup from starting.
    initSupporterCard();

    const shortcutText = document.getElementById('shortcut-text');
    if (shortcutText) {
      const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
      shortcutText.textContent = isMac
        ? t('shortcut_toggle_mac_f', undefined, '⌘+Shift+F to toggle')
        : t('shortcut_toggle_win_f', undefined, 'Ctrl+Shift+F to toggle');
    }

    initSettingsForm();
    initMyWordsTab();
    initPageTab();
    initTabNavigation();
    selectInitialTab();
    void initReviewPrompt({ store: reviewStore, language: TsukeruI18n.language() });
  } finally {
    document.documentElement.removeAttribute('data-i18n-pending');
  }
});

// ── EZFurigana account card ───────────────────────────────────────────────────

const SUPPORTER_CARD = {
  none: { text: () => t('supporter_state_none', undefined, "Connect your Supporter account to turn on sentence audio and get more dictionary translations each day."), meta: () => t('supporter_connect_hint', undefined, 'Opens ezfurigana.com. Sign in there and Tsukeru connects by itself.'), action: () => t('supporter_connect', undefined, 'Connect account'), path: '/account?tsukeru=connect' },
  free: { text: () => t('supporter_state_free', undefined, 'Connected with a Free account. Sentence audio is a Supporter feature.'), action: () => t('supporter_become', undefined, 'Become a Supporter'), pricing: true },
  supporter: { text: () => t('supporter_state_supporter', undefined, 'Connected as a Supporter'), action: () => t('supporter_manage', undefined, 'Manage account'), path: '/account' },
  expired: { text: () => t('supporter_state_expired', undefined, 'Your Supporter connection expired. Open EZFurigana once to reconnect.'), action: () => t('supporter_reconnect', undefined, 'Reconnect'), path: '/account?tsukeru=connect' },
};

/** Show how this browser is connected; the header star follows the same answer. */
function renderSupporterCard(status) {
  const card = document.getElementById('supporterCard');
  const state = SUPPORTER_CARD[status?.state] ? status.state : 'none';
  const copy = SUPPORTER_CARD[state];
  const supporterLink = document.getElementById('header-supporter-link');
  if (supporterLink) {
    const supporter = state === 'supporter';
    supporterLink.classList.toggle('is-supporter', supporter);
    supporterLink.href = supporter ? new URL('/account', TsukeruI18n.websiteUrl()).href : getEzfuriganaPricingUrl();
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
  action.href = copy.pricing ? getEzfuriganaPricingUrl() : new URL(copy.path, TsukeruI18n.websiteUrl()).href;
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
