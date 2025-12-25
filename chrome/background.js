// Background service worker for the extension
// Default to hosted backend; update if hosting elsewhere
const API_BASE_URL = 'https://www.ezfurigana.com';
const DEFAULT_SETTINGS = {
  jlptLevel: 5,
  furiganaType: 'hiragana',
  firstOccurrenceOnly: false,
  highlightMode: 'off',
  watchDynamic: false,
};
const definitionCache = new Map();
const DEFINITION_CACHE_TTL = 5 * 60 * 1000; // cache definitions for 5 minutes
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_CHARS = 50_000; // maximum chars allowed per window
const rateLimitBuckets = [];

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
      chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings });
    } else if (info.menuItemId === 'clearFurigana') {
      chrome.tabs.sendMessage(tab.id, { action: 'clearFurigana' });
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
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    // Ignore if already injected or not permitted.
  }
}

async function handleFuriganaRequest(payload) {
  const { textContent = '', settings = {}, tabUrl } = payload;
  const apiUrl = API_BASE_URL;

  if (!checkCharRateLimit(textContent.length)) {
    throw new Error(`Rate limit exceeded: max ${RATE_LIMIT_MAX_CHARS} characters per ${RATE_LIMIT_WINDOW_MS / 1000}s`);
  }

  // Try extension-friendly endpoint first
  const endpoints = [`${apiUrl}/api/extension/furigana`, `${apiUrl}/furigana/html`];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const formData = new FormData();
      formData.append('input_mode', endpoint.includes('/extension/') ? 'text' : 'text');
      formData.append('engine', 'sudachi');
      formData.append('jlpt_level', String(settings.jlptLevel ?? DEFAULT_SETTINGS.jlptLevel));
      formData.append('furigana_type', settings.furiganaType || DEFAULT_SETTINGS.furiganaType);
      formData.append('first_occurrence_only', settings.firstOccurrenceOnly ? 'on' : '');
      formData.append('raw_text', textContent);
      formData.append('website_url', tabUrl || '');
      formData.append('csrf_token', '');

      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        mode: 'cors',
      });
      if (!response.ok) {
        lastError = new Error(`API request failed: ${response.status} ${response.statusText}`);
        console.error('Tsukeru backend error', endpoint, response.status, response.statusText);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (data?.html) return { processedHTML: data.html };
        lastError = new Error('JSON response missing html field');
        continue;
      }

      const responseText = await response.text();
      const processedHTML = extractProcessedHtml(responseText);
      if (processedHTML) return { processedHTML };
      lastError = new Error('Could not read processed HTML from backend response.');
    } catch (err) {
      lastError = err;
      console.error('Tsukeru fetch exception', endpoint, err);
      continue;
    }
  }

  throw lastError || new Error('API request failed');
}

async function lookupDefinition(word) {
  const term = (word || '').trim();
  if (!term) {
    throw new Error('No word provided');
  }

  const now = Date.now();
  const cached = definitionCache.get(term);
  if (cached && now - cached.timestamp < DEFINITION_CACHE_TTL) {
    return cached.data;
  }

  const endpoints = [
    `${API_BASE_URL}/api/extension/word-definition?word=${encodeURIComponent(term)}`,
    `${API_BASE_URL}/api/word-definition/${encodeURIComponent(term)}`
  ];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        credentials: 'include',
        mode: 'cors',
      });

      if (!response.ok) {
        lastError = new Error(`API request failed: ${response.status} ${response.statusText}`);
        continue;
      }

      const data = await response.json();
      definitionCache.set(term, { data, timestamp: now });
      return data;
    } catch (err) {
      lastError = err;
      console.error('Definition fetch exception', endpoint, err);
      continue;
    }
  }

  throw lastError || new Error('Definition lookup failed');
}

function extractProcessedHtml(htmlText) {
  try {
    if (typeof DOMParser === 'undefined') {
      return extractViaRegex(htmlText);
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    // Prefer the main preview container used by the FastAPI app
    const preview = doc.querySelector('#normalPreview');
    if (preview && preview.innerHTML.trim()) return preview.innerHTML;

    const resultSection = doc.querySelector('#result');
    if (resultSection && resultSection.innerHTML.trim()) {
      return resultSection.innerHTML;
    }

    const bodyContent = doc.body?.innerHTML?.trim();
    if (bodyContent) return bodyContent;
  } catch (err) {
    console.error('Failed to parse backend response:', err);
  }
  return extractViaRegex(htmlText);
}

function extractViaRegex(htmlText) {
  if (typeof htmlText !== 'string') return null;
  const matchPreview = htmlText.match(/<div[^>]*id=["']normalPreview["'][^>]*>([\s\S]*?)<\/div>/i);
  if (matchPreview && matchPreview[1]) return matchPreview[1];
  const matchResult = htmlText.match(/<section[^>]*id=["']result["'][^>]*>([\s\S]*?)<\/section>/i);
  if (matchResult && matchResult[1]) return matchResult[1];
  return null;
}

function sanitizeFilename(name) {
  return (name || 'page').replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

function checkCharRateLimit(nextLen) {
  const now = Date.now();
  // Remove expired entries
  while (rateLimitBuckets.length && now - rateLimitBuckets[0].timestamp > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.shift();
  }
  const used = rateLimitBuckets.reduce((sum, entry) => sum + entry.len, 0);
  if (used + nextLen > RATE_LIMIT_MAX_CHARS) {
    return false;
  }
  rateLimitBuckets.push({ timestamp: now, len: nextLen });
  return true;
}
