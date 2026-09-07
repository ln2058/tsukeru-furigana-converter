/*
Module: background
Purpose: Route extension events and messages between popup/content scripts and background API helpers.

Inputs:
- Runtime install, command, and context menu events.
- Message actions and payloads from popup/content scripts.

Outputs:
- Async message responses, reading-aware lookup/rate-limit metadata propagation, and tab-level apply/clear toggles.

Side Effects:
- Seeds and reads `chrome.storage.sync` defaults.
- Creates context menus and injects content scripts/CSS, including tooltip dependencies in order, when needed.
- Routes optional lookup reading fields and API error metadata without persisting them.

Failure Modes:
- Message delivery fails when tabs/content scripts are unavailable.
- Script/CSS injection can fail on restricted pages or local files without user-enabled file access.

Security Notes:
- Delegates external network traffic to `bg-api` only.
- Avoid logging raw user page text in error paths.
*/
// Background service worker — Chrome message router and command handler.
// All API/cache logic lives in ./js/bg-api.js and ./js/bg-cache.js.
import {
  handleFuriganaRequest, lookupDefinition, fetchExampleSentence, fetchKanjiBreakdown,
  handlePlayAudio, handleFetchProxyAudio, handleExportAnkiAudio,
  API_BASE_URL, DEFAULT_SETTINGS, getRateLimitState,
} from './js/bg-api.js';
import { hasSupportedLocalFileExtension } from './js/utils.js';

const runtimeApi = typeof browser !== 'undefined' ? browser : chrome;
const i18nApi = runtimeApi?.i18n;

function t(key, fallback) {
  const message = i18nApi?.getMessage?.(key);
  return message || fallback;
}

function serializeApiError(error) {
  return {
    error: error?.message || 'Request failed',
    ...(error?.status && { status: error.status }),
    ...(error?.errorCode && { errorCode: error.errorCode }),
    ...(error?.operation && { operation: error.operation }),
    ...(error?.rateLimitType && { rateLimitType: error.rateLimitType }),
    ...(error?.retryAfter != null && { retryAfter: error.retryAfter }),
    ...(error?.retryAt != null && { retryAt: error.retryAt }),
  };
}

function isFileTabUrl(url = '') {
  return /^file:\/\//i.test(url);
}

function isSupportedTabUrl(url = '') {
  if (!/^(https?|file):\/\//i.test(url)) {
    return false;
  }
  if (isFileTabUrl(url)) {
    return hasSupportedLocalFileExtension(url);
  }
  return true;
}

async function hasFileSchemeAccess() {
  const isAllowed = chrome.extension?.isAllowedFileSchemeAccess;
  if (typeof isAllowed !== 'function') {
    return false;
  }

  return new Promise((resolve) => {
    try {
      isAllowed.call(chrome.extension, (allowed) => resolve(Boolean(allowed)));
    } catch (error) {
      console.warn('Tsukeru: file access check failed', error);
      resolve(false);
    }
  });
}

async function getTabAccessIssue(tab) {
  const url = tab?.url || '';
  if (!tab?.id || !isSupportedTabUrl(url)) {
    return 'unsupported';
  }

  if (isFileTabUrl(url) && !(await hasFileSchemeAccess())) {
    return 'file-access-disabled';
  }

  return null;
}


chrome.runtime.onInstalled.addListener(() => {
  // Seed defaults without overwriting existing user settings
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    chrome.storage.sync.set({
      jlptLevel: stored.jlptLevel ?? DEFAULT_SETTINGS.jlptLevel,
      furiganaType: stored.furiganaType || DEFAULT_SETTINGS.furiganaType,
      firstOccurrenceOnly: stored.firstOccurrenceOnly ?? DEFAULT_SETTINGS.firstOccurrenceOnly,
      highlightMode: stored.highlightMode || DEFAULT_SETTINGS.highlightMode,
    });
  });
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  // Popup is set in manifest, so this won't trigger unless popup is removed
});

// Optional: Add context menu for quick actions
if (chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: 'applyFurigana',
      title: t('contextMenuApplyFurigana', 'Apply Furigana to Page'),
      contexts: ['page'],
    });

    chrome.contextMenus.create({
      id: 'clearFurigana',
      title: t('contextMenuClearFurigana', 'Clear Furigana'),
      contexts: ['page'],
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const accessIssue = await getTabAccessIssue(tab);
    if (accessIssue) {
      if (accessIssue === 'file-access-disabled') {
        console.warn("Tsukeru: Enable 'Allow access to file URLs' to use Tsukeru on local files.");
      }
      return;
    }

    if (info.menuItemId === 'applyFurigana') {
      const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      await ensureContentScript(tab.id);
      chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings }).catch(err =>
        console.warn('Tsukeru: Target page cannot receive messages. Reload the page.', err)
      );
    } else if (info.menuItemId === 'clearFurigana') {
      await ensureContentScript(tab.id);
      chrome.tabs.sendMessage(tab.id, { action: 'clearFurigana' }).catch(err =>
        console.warn('Tsukeru: Target page cannot receive messages. Reload the page.', err)
      );
    }
  });
} else {
  console.warn('contextMenus API not available (missing permission?)');
}

// Process furigana requests coming from the content script so we can bypass site CORS
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getRateLimitState') {
    getRateLimitState()
      .then((state) => sendResponse({ success: true, state }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Could not read rate-limit state' }));
    return true;
  }

  if (message.action === 'processFurigana') {
    handleFuriganaRequest(message.payload)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => {
        console.error('Furigana request failed', error);
        sendResponse({ success: false, ...serializeApiError(error) });
      });
    return true; // Keep the message channel open for async response
  }

  if (message.action === 'lookupDefinition') {
    lookupDefinition(message.word, message.reading, message.readingType)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error('Definition lookup failed', error);
        sendResponse({ success: false, ...serializeApiError(error) });
      });
    return true;
  }

  if (message.action === 'fetchExampleSentence') {
    fetchExampleSentence(message.word)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error('Example sentence fetch failed', error);
        sendResponse({ success: false, ...serializeApiError(error) });
      });
    return true;
  }

  if (message.action === 'fetchKanjiBreakdown') {
    fetchKanjiBreakdown(message.word)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error('Kanji breakdown fetch failed', error);
        sendResponse({ success: false, ...serializeApiError(error) });
      });
    return true;
  }

  if (message.action === 'playAudio') {
    handlePlayAudio(message.word, message.reading)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({
        success: false,
        error: error.message,
        ...(error.rateLimitType && { rateLimitType: error.rateLimitType }),
        ...(error.retryAfter != null && { retryAfter: error.retryAfter }),
      }));
    return true;
  }

  if (message.action === 'fetchProxyAudio') {
    try {
      const parsed = new URL(message.url);
      if (parsed.protocol !== 'https:') {
        sendResponse({ success: false, error: 'Disallowed audio protocol' });
        return true;
      }
      if (parsed.hostname !== 'www.ezfurigana.com' && !parsed.hostname.endsWith('.ezfurigana.com')) {
        sendResponse({ success: false, error: 'Disallowed audio host' });
        return true;
      }
      // Port '' means the URL uses the scheme's default (443 for https).
      // Reject any explicit non-default port to prevent port-scanning SSRF.
      if (parsed.port !== '' && parsed.port !== '443') {
        sendResponse({ success: false, error: 'Disallowed audio port' });
        return true;
      }
    } catch {
      sendResponse({ success: false, error: 'Invalid URL' });
      return true;
    }
    handleFetchProxyAudio(message.url)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'exportAnkiAudio') {
    handleExportAnkiAudio(message.payload)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => {
        console.error('Anki audio export failed', error);
        sendResponse({
          success: false,
          error: error.message,
          ...(error.rateLimitType && { rateLimitType: error.rateLimitType }),
          ...(error.retryAfter != null && { retryAfter: error.retryAfter }),
        });
      });
    return true;
  }

  if (message.action === 'reportReadingError') {
    const {
      word,
      reading,
      context_sentence,
      correct_reading,
      suggested_reading,
      consent_given
    } = message.payload ?? {};
    const normalizedCorrectReading = correct_reading || suggested_reading || null;
    fetch(`${API_BASE_URL}/api/report-error`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source': 'Chrome-Extension-TSUKERU'
      },
      credentials: 'omit',
      body: JSON.stringify({
        word,
        reading,
        context_sentence,
        correct_reading: normalizedCorrectReading,
        consent_given
      })
    })
      .then(async (response) => {
        if (response.ok) {
          sendResponse({ success: true });
        } else {
          let errMsg = t('errorUnexpectedShort', 'Unexpected error. Please try again.');
          if (response.status === 429) {
            errMsg = t('errorRateLimitShort', 'Rate limit exceeded. Please try again in an hour.');
          } else {
            try {
              const errData = await response.json();
              if (errData.error) errMsg = errData.error;
            } catch (e) {}
          }
          sendResponse({ success: false, error: errMsg });
        }
      })
      .catch(() => {
        sendResponse({
          success: false,
          error: t('errorNetworkShort', 'Network error. Please try again later.')
        });
      });
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-furigana') return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const accessIssue = await getTabAccessIssue(tab);
    if (accessIssue) {
      if (accessIssue === 'file-access-disabled') {
        console.warn("Tsukeru: Enable 'Allow access to file URLs' to use Tsukeru on local files.");
      }
      return;
    }

    await ensureContentScript(tab.id);
    const state = await chrome.tabs.sendMessage(tab.id, { action: 'getFuriganaState' })
      .catch(() => null);

    if (state?.active) {
      await chrome.tabs.sendMessage(tab.id, { action: 'clearFurigana' });
    } else {
      const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      await chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings });
    }
  } catch (err) {
    console.error('Tsukeru: command handler failed', err);
  }
});

async function ensureContentScript(tabId) {
  if (!chrome.scripting) return;

  // If the content script is already present (manifest auto-injection path),
  // avoid reinjecting to prevent top-level const redeclaration errors.
  // ⚠️ This error-message check is fragile: browser wording can change across
  // versions/locales. The guard in content-main.js (window.__TSUKERU_LOADED__)
  // provides a second line of defense if this check misses.
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'getFuriganaState' });
    return;
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    const noReceiver =
      message.includes('receiving end does not exist') ||
      message.includes('could not establish connection');
    if (!noReceiver) {
      throw error;
    }
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch (e) {
    // Ignore if already injected or not permitted.
  }
  // Inject the split content scripts in manifest dependency order.
  // The guard in content-main.js (window.__TSUKERU_LOADED__) prevents
  // double-initialization if the manifest already auto-injected them.
  for (const file of [
    'js/content-ui.js',
    'js/content-rate-limit.js',
    'js/content-dom.js',
    'js/tooltip-async-state.js',
    'js/content-tooltip.js',
    'js/content-main.js',
  ]) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    } catch (e) {
      // Ignore if already injected or not permitted.
    }
  }
}
