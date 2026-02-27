/*
Module: content-main
Purpose: Coordinate furigana apply/clear lifecycle and route content-script message actions.

Inputs:
- Popup/background message actions and persisted settings payloads.
- DOM helper functions and runtime state flags.

Outputs:
- Action responses and page furigana state transitions.

Side Effects:
- Toggles page classes/attributes/styles and shared runtime globals.
- Starts/stops observers, dictionary popup behavior, and live appearance updates.

Failure Modes:
- Concurrent apply requests are ignored while processing.
- Runtime messaging/API failures surface as logged errors and user alerts.

Security Notes:
- Sends only required text payloads to background processing.
- Relies on sanitized HTML insertion path for all backend output.
*/
// ============================================================================
// content-main.js — Core furigana logic, state initialization, message router
//
// This file is loaded LAST in the content_scripts chain, after:
//   js/content-dom.js      (utilities, observers, HTML processing)
//   js/content-tooltip.js  (dictionary tooltip, vocab saving)
//
// Guard pattern: state variables and the message listener are initialized
// only once per page context. Functions (applyFurigana etc.) are defined
// at top level so they can reference the var-declared globals set up below.
// ============================================================================

// ── Core furigana functions ───────────────────────────────────────────────────

function t(key, substitutions, fallback = '') {
  const message = chrome.i18n?.getMessage ? chrome.i18n.getMessage(key, substitutions) : '';
  return message || fallback;
}

async function applyFurigana(settings) {
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  // Soft-hide bypass: if DOM is intact but hidden, and reprocess-critical settings
  // (furiganaType, firstOccurrenceOnly) haven't changed, just reveal the DOM.
  const softHidden = document.body.classList.contains('tsukeru-furigana-disabled');
  const hasRubyDom = softHidden && document.querySelectorAll('[data-tsukeru-wrapper="1"]').length > 0;
  if (hasRubyDom && lastAppliedSettings) {
    const needsReprocess =
      settings.furiganaType !== lastAppliedSettings.furiganaType ||
      settings.firstOccurrenceOnly !== lastAppliedSettings.firstOccurrenceOnly;
    if (!needsReprocess) {
      document.body.classList.remove('tsukeru-furigana-disabled');
      isFuriganaActive = true;
      setHighlightMode(settings?.highlightMode || 'off');
      document.documentElement.setAttribute(
        'data-tsukeru-custom-style',
        settings?.removeCustomStyling ? 'off' : 'on'
      );
      document.documentElement.setAttribute('data-tsukeru-jlpt', String(settings?.jlptLevel ?? 5));
      isProcessing = false;
      return;
    }
  }

  if (isFuriganaActive || softHidden) {
    hardClearFurigana();
  }
  setHighlightMode(settings?.highlightMode || 'off');
  document.documentElement.setAttribute(
    'data-tsukeru-custom-style',
    settings?.removeCustomStyling ? 'off' : 'on'
  );
  document.documentElement.style.setProperty('--tsukeru-ruby-size', `${settings?.rubySize ?? 0.65}em`);
  document.documentElement.style.setProperty('--tsukeru-ruby-color', settings?.rubyColor || '#475569');
  document.documentElement.style.setProperty('--tsukeru-ruby-weight', settings?.rubyWeight || 'normal');
  document.documentElement.setAttribute('data-tsukeru-jlpt', String(settings?.jlptLevel ?? 5));

  try {
    const textNodes = collectTextNodes();
    if (!textNodes.length) {
      throw new Error(t('content_error_no_text_found', undefined, 'No text content found on page'));
    }

    const batches = buildBatches(textNodes);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const response = await chrome.runtime.sendMessage({
        action: 'processFurigana',
        payload: {
          textContent: batch.payload,
          settings,
          tabUrl: window.location.href,
        },
      });

      if (!response || !response.success || !response.processedHTML) {
        throw new Error(response?.error || t('content_error_backend_empty', undefined, 'Backend returned an empty response'));
      }

      applyBatchResult(batch, response.processedHTML);

      if (i < batches.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    isFuriganaActive = true;
    lastAppliedSettings = { ...settings };

    enableDictionaryPopups();

    if (settings.watchDynamic) {
      startWatchingDynamicContent(settings);

      const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
      if (siteConfig.useIntersectionObserver) {
        startIntersectionObserver(settings);
      }
    }

    if (currentSite === 'youtube') {
      startYoutubeCaptionsObserver(settings);
    }

  } catch (error) {
    console.error('Error applying furigana:', error);
    alert(t('content_apply_failed_with_reason', [error.message], `Failed to apply furigana: ${error.message}`));
    setHighlightMode('off');
  } finally {
    isProcessing = false;
  }
}

// Soft-hide: preserve the ruby DOM, just visually hide via CSS class.
// Re-enabling is instant (zero API calls) when settings haven't changed.
function clearFurigana() {
  document.body.classList.add('tsukeru-furigana-disabled');
  document.documentElement.removeAttribute('data-tsukeru-custom-style');
  hideDefinitionTooltip();
  isFuriganaActive = false;
  stopWatchingDynamicContent();
  stopIntersectionObserver();
  stopYoutubeCaptionsObserver();
  setHighlightMode('off');
}

// Full DOM teardown — used before re-applying with changed settings.
function hardClearFurigana() {
  const wrappers = document.querySelectorAll('[data-tsukeru-wrapper="1"]');
  wrappers.forEach((wrapper) => {
    const originalText = originalTextMap.get(wrapper)
      ?? wrapper.getAttribute('data-tsukeru-original')
      ?? wrapper.textContent
      ?? '';
    wrapper.replaceWith(document.createTextNode(originalText));
  });
  document.querySelectorAll('[data-tsukeru-processed]').forEach(el => {
    el.removeAttribute('data-tsukeru-processed');
  });
  document.querySelectorAll('[data-tsukeru-caption-processed]').forEach(el => {
    el.removeAttribute('data-tsukeru-caption-processed');
  });
  document.querySelectorAll('[data-tsukeru-observed]').forEach(el => {
    el.removeAttribute('data-tsukeru-observed');
  });
  document.body.classList.remove('tsukeru-furigana-disabled');
  document.documentElement.removeAttribute('data-tsukeru-custom-style');
  originalTextMap = new WeakMap();
  hideDefinitionTooltip();
  isFuriganaActive = false;
  lastAppliedSettings = null;
  processedNodes = new WeakSet();
  processingQueue.clear();
  stopWatchingDynamicContent();
  stopIntersectionObserver();
  stopYoutubeCaptionsObserver();
  setHighlightMode('off');
}

// ── Initialization guard ──────────────────────────────────────────────────────
// Runs only once per page context. Prevents double-init on re-injection via
// ensureContentScript. State variables are declared as var so they hoist to
// the global scope and are accessible from content-dom.js / content-tooltip.js.

if (!window.__TSUKERU_LOADED__) {
  window.__TSUKERU_LOADED__ = true;

  // Shared state — var declarations hoist to global scope in plain scripts
  var isProcessing = false;
  var isFuriganaActive = false;
  var lastAppliedSettings = null;
  var mutationObserver = null;
  var intersectionObserver = null;
  var intersectionObserverInterval = null;
  var youtubeCaptionObserver = null;
  var youtubeCaptionRetryTimer = null;
  var processedNodes = new WeakSet();
  var debounceTimer = null;
  var processingQueue = new Set();
  var currentSite = detectSite();        // detectSite() defined in content-dom.js
  var currentHighlightMode = 'off';
  var dictionaryTooltip = null;
  var dictionaryEventsBound = false;
  var definitionCache = new Map();
  var originalTextMap = new WeakMap();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'applyFurigana') {
      applyFurigana(request.settings)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (request.action === 'clearFurigana') {
      clearFurigana();
      sendResponse({ ok: true });
    }

    if (request.action === 'getFuriganaState') {
      sendResponse({ active: isFuriganaActive });
    }

    if (request.action === 'getPageWords') {
      const words = extractAllPageWords();
      sendResponse({ words });
    }

    if (request.action === 'scrollToWord') {
      const result = scrollToAndHighlightWord(request.word, request.reading);
      sendResponse(result);
    }

    if (request.action === 'getWordContext') {
      const result = getWordContextSentence(request.word, request.reading);
      sendResponse(result);
    }

    if (request.action === 'updateJLPT') {
      document.documentElement.setAttribute('data-tsukeru-jlpt', String(request.level ?? 5));
      sendResponse({ ok: true });
    }

    if (request.action === 'updateAppearance') {
      if (request.color) document.documentElement.style.setProperty('--tsukeru-ruby-color', request.color);
      if (request.size) document.documentElement.style.setProperty('--tsukeru-ruby-size', request.size);
      if (request.weight) document.documentElement.style.setProperty('--tsukeru-ruby-weight', request.weight);
      const hasManagedRuby = document.querySelector('[data-tsukeru-wrapper="1"]');
      if (typeof request.removeCustomStyling === 'boolean' && (isFuriganaActive || hasManagedRuby)) {
        document.documentElement.setAttribute(
          'data-tsukeru-custom-style',
          request.removeCustomStyling ? 'off' : 'on'
        );
      }
      sendResponse({ ok: true });
    }
  });
}
