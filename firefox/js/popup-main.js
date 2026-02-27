/*
Module: popup-main
Purpose: Bootstrap popup navigation and wire report modal submission behavior.

Inputs:
- Popup DOM events, runtime report responses, and browser user-agent/platform hints.

Outputs:
- Active tab-pane state changes and report success/error UI feedback.

Side Effects:
- Mutates popup DOM state and sends `reportReadingError` messages.
- Applies Firefox shortcut label defaults in popup UI.

Failure Modes:
- Runtime messaging failures keep modal open with error feedback.
- Missing expected DOM nodes can break event wiring.

Security Notes:
- Sends only explicit user-entered report fields.
- No secret handling or persistent sensitive data storage.
*/
// Entry point: tab navigation, report modal wiring, and bootstrap.
import { initSettingsForm, closeReportModal, applyI18nToPopupDom, t } from './popup-settings.js';
import { initVocabularyTab, initVocabModeTab, loadVocabulary, loadVocabMode } from './popup-vocab.js';

// ── Tab navigation ────────────────────────────────────────────────────────────

function initTabNavigation() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${targetTab}-tab`).classList.add('active');

      if (targetTab === 'vocabulary') {
        loadVocabulary();
      } else if (targetTab === 'vocabmode') {
        loadVocabMode();
      }
    });
  });
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
      const errMsg = (response && response.error) || t('report_submit_failed', undefined, 'Submission failed. Please try again.');
      errorDiv.textContent = errMsg;
      errorDiv.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = t('report_submit_button', undefined, 'Submit Report');
    }
  });
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  applyI18nToPopupDom();

  const reviewLink = document.getElementById('header-review-link');
  if (reviewLink) {
    if (navigator.userAgent.toLowerCase().includes('edg/')) {
      reviewLink.href = 'https://microsoftedge.microsoft.com/addons/detail/tsukeru-for-ezfurigana/cdlcehkdgoaboeapgjdhnklgicmiknia';
      reviewLink.title = t('header_title_review_edge', undefined, 'Review on Edge Add-ons Store');
    } else {
      reviewLink.href = 'https://addons.mozilla.org/en-US/firefox/addon/tsukeru-for-ezfurigana/';
      reviewLink.title = 'Review on Firefox Add-ons';
    }
  }

  const shortcutText = document.getElementById('shortcut-text');
  if (shortcutText) {
    const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
    shortcutText.textContent = isMac
      ? t('shortcut_toggle_mac_f', undefined, '⌘+Shift+F to toggle')
      : t('shortcut_toggle_win_f', undefined, 'Ctrl+Shift+F to toggle');
  }

  initSettingsForm();
  initVocabularyTab();
  initVocabModeTab();
  initTabNavigation();
});
