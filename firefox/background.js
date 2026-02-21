// Background service worker — Chrome message router and command handler.
// All API/cache logic lives in ./js/bg-api.js and ./js/bg-cache.js.
import {
  handleFuriganaRequest, lookupDefinition, fetchExampleSentence, fetchKanjiBreakdown,
  handlePlayAudio, handlePlayAudioDirect, handleFetchProxyAudio, handleExportAnkiAudio,
  API_BASE_URL, DEFAULT_SETTINGS,
} from './js/bg-api.js';


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
      title: 'Apply Furigana to Page',
      contexts: ['page'],
    });

    chrome.contextMenus.create({
      id: 'clearFurigana',
      title: 'Clear Furigana',
      contexts: ['page'],
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'applyFurigana') {
      const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings }).catch(err =>
        console.warn('Tsukeru: Target page cannot receive messages. Reload the page.', err)
      );
    } else if (info.menuItemId === 'clearFurigana') {
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
  if (message.action === 'processFurigana') {
    handleFuriganaRequest(message.payload)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => {
        console.error('Furigana request failed', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for async response
  }

  if (message.action === 'lookupDefinition') {
    lookupDefinition(message.word)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error('Definition lookup failed', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'fetchExampleSentence') {
    fetchExampleSentence(message.word)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error('Example sentence fetch failed', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'fetchKanjiBreakdown') {
    fetchKanjiBreakdown(message.word)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error('Kanji breakdown fetch failed', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'playAudioDirect') {
    handlePlayAudioDirect(message.word, message.reading)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'playAudio') {
    handlePlayAudio(message.word, message.reading)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'fetchProxyAudio') {
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
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'reportReadingError') {
    fetch(`${API_BASE_URL}/api/report-error`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source': 'Chrome-Extension-TSUKERU'
      },
      body: JSON.stringify(message.payload)
    })
      .then(async (response) => {
        if (response.ok) {
          sendResponse({ success: true });
        } else {
          let errMsg = `Server returned ${response.status}`;
          if (response.status === 429) {
            errMsg = 'Rate limit exceeded. Please try again in an hour.';
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
        sendResponse({ success: false, error: 'Network error. Please try again later.' });
      });
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-furigana') return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) return;

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
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch (e) {
    // Ignore if already injected or not permitted.
  }
  // Inject the split content scripts in dependency order.
  // The guard in content-main.js (window.__TSUKERU_LOADED__) prevents
  // double-initialization if the manifest already auto-injected them.
  for (const file of ['js/content-dom.js', 'js/content-tooltip.js', 'js/content-main.js']) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    } catch (e) {
      // Ignore if already injected or not permitted.
    }
  }
}
