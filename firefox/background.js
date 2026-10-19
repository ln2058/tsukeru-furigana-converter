/*
Module: background
Purpose: Route extension events and messages between popup/content scripts and background API helpers.

Inputs:
- Shared UI catalogs, uiLocale storage changes, runtime install, command, and context menu events.
- Message actions and payloads from popup/content scripts, including My Words and EZFurigana sync actions.
- Browser startup and tab activation, which refresh the review badge.

Outputs:
- Async message responses, structured API/report error metadata, and tab-level apply/clear toggles.
- Toolbar badge with the number of words due for review (via `bg-words`).

Side Effects:
- Serves private UI catalogs to this extension and updates localized menu titles.
- Seeds and reads `chrome.storage.sync` defaults.
- Creates context menus, injects content scripts/CSS including tooltip dependencies in order, and handles Firefox direct-audio actions.
- Routes optional lookup reading fields and API error metadata without persisting them.

Failure Modes:
- Message delivery fails when tabs/content scripts are unavailable.
- Script/CSS injection can fail on restricted pages.

Security Notes:
- Delegates external network traffic to `bg-api` only.
- Audio proxy messages accept only HTTPS www.ezfurigana.com URLs on the default port.
- Avoid logging raw user page text in error paths.
*/
// Background script — Firefox message router and command handler.
// All API/cache logic lives in ./js/bg-api.js and ./js/bg-cache.js.
import {
  handleFuriganaRequest, lookupDefinition, fetchExampleSentence, fetchKanjiBreakdown,
  handlePlayAudio, handlePlayAudioDirect, handleFetchProxyAudio, handleReportReadingError,
  DEFAULT_SETTINGS, getRateLimitState,
} from './js/bg-api.js';
import { handleWordsMessage, isWordsAction, refreshWordBadge } from './js/bg-words.js';
import { hasSupportedLocalFileExtension } from './js/utils.js';
import './js/i18n.js';

function t(key, fallback) {
  return TsukeruI18n.t(key, undefined, fallback);
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

function isSupportedTabUrl(url = '') {
  if (!/^(https?|file):\/\//i.test(url)) {
    return false;
  }
  if (/^file:\/\//i.test(url)) {
    return hasSupportedLocalFileExtension(url);
  }
  return true;
}


chrome.runtime.onInstalled.addListener(() => {
  // Seed defaults without overwriting existing user settings
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    chrome.storage.sync.set({
      jlptLevel: stored.jlptLevel ?? DEFAULT_SETTINGS.jlptLevel,
      furiganaType: stored.furiganaType || DEFAULT_SETTINGS.furiganaType,
      highlightMode: stored.highlightMode || DEFAULT_SETTINGS.highlightMode,
    });
  });
  // "First occurrence only" was retired; drop the stored flag.
  chrome.storage.sync.remove('firstOccurrenceOnly');
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  // Popup is set in manifest, so this won't trigger unless popup is removed
});

// Register listeners synchronously; catalog loading must not delay worker routing.
function updateUiMenuTitles() {
  if (!chrome.contextMenus) return;
  for (const [id, key, fallback] of [
    ['applyFurigana', 'contextMenuApplyFurigana', 'Apply Furigana to Page'],
    ['clearFurigana', 'contextMenuClearFurigana', 'Clear Furigana'],
  ]) {
    chrome.contextMenus.update(id, { title: t(key, fallback) }, () => {
      // Menus may not exist until the install event creates them.
      void chrome.runtime.lastError;
    });
  }
}
TsukeruI18n.subscribe(updateUiMenuTitles);
void TsukeruI18n.ready();

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
    void TsukeruI18n.ready().then(updateUiMenuTitles);
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const url = tab?.url || '';
    if (!tab?.id || !isSupportedTabUrl(url)) {
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

// The review badge counts words that fall due over time, so refresh it when
// the browser starts and whenever the reader switches tabs.
refreshWordBadge();
chrome.runtime.onStartup.addListener(() => {
  refreshWordBadge();
});
chrome.tabs.onActivated.addListener(() => {
  refreshWordBadge();
});

// Process furigana requests coming from the content script so we can bypass site CORS
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'getUiCatalog') {
    if (sender.id !== chrome.runtime.id) return false;
    TsukeruI18n.getCatalog()
      .then(catalog => sendResponse({ success: true, catalog }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (isWordsAction(message?.action)) {
    handleWordsMessage(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.warn('Tsukeru: word storage failed', error?.message);
        sendResponse({ success: false, error: 'Word storage failed' });
      });
    return true;
  }

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

  if (message.action === 'playAudioDirect') {
    // Firefox compatibility alias: preserved for older content-script contexts.
    handlePlayAudioDirect(message.word, message.reading)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'fetchProxyAudio') {
    try {
      const parsed = new URL(message.url);
      if (parsed.protocol !== 'https:') {
        sendResponse({ success: false, error: 'Disallowed audio protocol' });
        return true;
      }
      if (parsed.hostname !== 'www.ezfurigana.com') {
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

  if (message.action === 'reportReadingError') {
    // Preserve the backend's browser-specific report source label.
    handleReportReadingError(message.payload, 'Firefox-Extension-TSUKERU')
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, ...serializeApiError(error) }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-furigana') return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (!tab?.id || !isSupportedTabUrl(url)) {
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
  // avoid reinjecting to prevent duplicate CSS insertion.
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
    'js/i18n.js',
    'js/ui-messages.js',
    'js/content-ui.js',
    'js/content-rate-limit.js',
    'js/content-dom.js',
    'js/tooltip-async-state.js',
    'js/word-rules.js',
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
