/*
Module: content-main
Purpose: Coordinate eager and viewport-limited furigana apply/clear lifecycles and route content-script message actions.

Inputs:
- Popup/background message actions and persisted settings payloads.
- DOM helper functions, runtime state flags, and the lazy tooltip coordinator dependency.

Outputs:
- Action responses and page furigana state transitions.

Side Effects:
- Toggles page classes/attributes/styles and shared runtime globals.
- Starts/stops observers, long-page block state, dictionary popup behavior, lazy tooltip lookup sessions, and live appearance updates.

Failure Modes:
- Concurrent apply requests are ignored while an operation token is active; stale viewport work is cancelled cooperatively.
- Runtime messaging/API failures surface as logged errors and toast notifications via shared retry helpers.

Security Notes:
- Sends only required text payloads to background processing.
- Relies on sanitized HTML insertion path for all backend output.
*/
// ============================================================================
// content-main.js — Core furigana logic, state initialization, message router
//
// This file is loaded LAST in the content_scripts chain, after:
//   js/content-ui.js        (toast helpers)
//   js/content-rate-limit.js (retry helper)
//   js/content-dom.js       (utilities, observers, HTML processing)
//   js/tooltip-async-state.js (lazy tooltip request coordination)
//   js/content-tooltip.js   (dictionary tooltip, vocab saving)
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

function getUserFacingApplyError(error) {
  const rawMessage = String(error?.message || '').trim();
  if (/(auth|nonce|401|403)/i.test(rawMessage)) {
    return t(
      'content_toast_connection_error',
      undefined,
      'Tsukeru had trouble connecting. Please try again in a moment.'
    );
  }

  return rawMessage || t(
    'content_toast_generic_error',
    undefined,
    'Tsukeru could not finish this page. Please reload and try again.'
  );
}

function invalidateContentLifecycle() {
  activeApplyOperation?.controller.abort();
  lifecycleGeneration += 1;
  cleanupPending = false;
  activeApplyOperation = null;
}

function serializeApplyFailure(error) {
  return {
    ok: false,
    error: error?.message || 'Apply failed',
    ...(error?.status != null && { status: error.status }),
    ...(error?.errorCode && { errorCode: error.errorCode }),
    ...(error?.operation && { operation: error.operation }),
    ...(error?.rateLimitType && { rateLimitType: error.rateLimitType }),
    ...(error?.retryAfter != null && { retryAfter: error.retryAfter }),
    ...(error?.retryAt != null && { retryAt: error.retryAt }),
  };
}

function isCurrentApplyOperation(operation) {
  return Boolean(
    operation &&
    activeApplyOperation === operation &&
    operation.generation === lifecycleGeneration
  );
}

async function applyFurigana(settings) {
  if (activeApplyOperation) return;

  const pageRoot = document.body || document.documentElement;

  // Soft-hide bypass: if DOM is intact but hidden, and reprocess-critical settings
  // (furiganaType, firstOccurrenceOnly) haven't changed, just reveal the DOM.
  const softHidden = Boolean(pageRoot?.classList.contains('tsukeru-furigana-disabled'));
  const hasRubyDom = softHidden && document.querySelectorAll('[data-tsukeru-wrapper="1"]').length > 0;
  if (hasRubyDom && lastAppliedSettings) {
    const needsReprocess =
      settings.furiganaType !== lastAppliedSettings.furiganaType ||
      settings.firstOccurrenceOnly !== lastAppliedSettings.firstOccurrenceOnly;
    if (!needsReprocess) {
      const operation = {
        token: Symbol('apply'),
        generation: lifecycleGeneration,
        controller: new AbortController(),
      };
      activeApplyOperation = operation;
      try {
        pageRoot?.classList.remove('tsukeru-furigana-disabled');
        isFuriganaActive = true;
        setHighlightMode(settings?.highlightMode || 'off');
        document.documentElement.setAttribute(
          'data-tsukeru-custom-style',
          settings?.removeCustomStyling ? 'off' : 'on'
        );
        document.documentElement.setAttribute('data-tsukeru-jlpt', String(settings?.jlptLevel ?? 5));
        let revealPending = false;
        if (wasLongPage) {
          const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
          const revealRoot = getConfiguredContainer(siteConfig);
          if (siteConfig.useIntersectionObserver && !revealRoot) {
            longPageMode = true;
            viewportProcessingPending = true;
            longPageFirstWorkState = 'pending';
            revealPending = true;
            startLongPageProcessing(settings);
          } else {
            const plan = collectLongPagePlan(revealRoot || pageRoot);
            installLongPagePlan(plan, { force: true, rootNode: revealRoot || pageRoot });
          }
          await refreshSavedVocabularyHighlights();
          startLongPageProcessing(settings);
        } else if (settings.watchDynamic) {
          refreshSavedVocabularyHighlights();
          startWatchingDynamicContent(settings);
          const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
          if (siteConfig.useIntersectionObserver) startIntersectionObserver(settings);
        } else {
          refreshSavedVocabularyHighlights();
        }
        if (currentSite === 'youtube') startYoutubeCaptionsObserver(settings);
        return { pending: revealPending };
      } finally {
        if (activeApplyOperation === operation) activeApplyOperation = null;
      }
      return;
    }
  }

  if (isFuriganaActive || softHidden) {
    hardClearFurigana();
  }

  const operation = {
    token: Symbol('apply'),
    generation: lifecycleGeneration,
    controller: new AbortController(),
  };
  activeApplyOperation = operation;
  const isValid = () => isCurrentApplyOperation(operation);

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
    const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
    const processingRoot = getConfiguredContainer(siteConfig);
    if (siteConfig.useIntersectionObserver && !processingRoot) {
      isFuriganaActive = true;
      lastAppliedSettings = { ...settings };
      longPageMode = true;
      wasLongPage = true;
      viewportProcessingPending = true;
      longPageFirstWorkState = 'pending';
      enableDictionaryPopups();
      await refreshSavedVocabularyHighlights();
      if (!isValid()) return;
      startLongPageProcessing(settings);
      if (currentSite === 'youtube') startYoutubeCaptionsObserver(settings);
      return { pending: true };
    }

    const discovery = await collectInitialDiscovery(processingRoot || pageRoot, {
      signal: operation.controller.signal,
      isCurrent: isValid,
      viewportModeKnown: Boolean(siteConfig.useIntersectionObserver),
    });
    const longPagePlan = discovery.plan;
    if (!longPagePlan.blocks.length) {
      throw new Error(t('content_error_no_text_found', undefined, 'No text content found on page'));
    }

    if (shouldUseViewportProcessing(longPagePlan, siteConfig)) {
      installLongPagePlan(longPagePlan, {
        force: Boolean(siteConfig.useIntersectionObserver),
        rootNode: processingRoot || pageRoot,
      });
      isFuriganaActive = true;
      lastAppliedSettings = { ...settings };
      enableDictionaryPopups();
      await refreshSavedVocabularyHighlights();
      if (!isValid()) return;
      startLongPageProcessing(settings);
      return;
    }

    const textNodes = discovery.textNodes
      .filter((node) => node.isConnected !== false && isProcessableTextNode(node));
    if (!textNodes.length) {
      throw new Error(t('content_error_no_text_found', undefined, 'No text content found on page'));
    }

    const batches = buildBatches(textNodes);
    for (let i = 0; i < batches.length; i++) {
      if (!isValid()) return;
      const batch = batches[i];
      if (batch.oversizedNode) {
        operation.isCurrent = isValid;
        await processOversizedNode(batch, settings, operation);
      } else {
        const response = await sendFuriganaWithRateLimitRetry({
          textContent: batch.payload,
          settings,
          tabUrl: window.location.href,
        }, 3, isValid, operation.controller.signal);

        if (!isValid()) return;
        await applyBatchResult(
          batch,
          response.processedHTML,
          true,
          false,
          (node, index) => isValid() && isBatchTargetCurrent(batch, index),
          {
            signal: operation.controller.signal,
            operationIsCurrent: isValid,
          }
        );
      }

      if (i < batches.length - 1) {
        await delayWithAbort(batchDelay(batch.byteCount), operation.controller.signal);
      }
    }

    if (!isValid()) return;

    isFuriganaActive = true;
    lastAppliedSettings = { ...settings };

    enableDictionaryPopups();
    refreshSavedVocabularyHighlights();

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
    if (!isValid() || error.cancelled) return;
    console.error('Error applying furigana:', error);
    if (error.rateLimitType || error.errorCode === 'service_unavailable') {
      // Rate-limit and service-availability toasts are guaranteed by the retry helper.
    } else {
      showToast(getUserFacingApplyError(error), { type: 'error', duration: 8000 });
      setHighlightMode('off');
    }
    throw error;
  } finally {
    // Toasts manage their own lifetime; do not dismiss them here.
    if (activeApplyOperation === operation) activeApplyOperation = null;
  }
}

// Soft-hide: preserve the ruby DOM, just visually hide via CSS class.
// Re-enabling is instant (zero API calls) when settings haven't changed.
function clearFurigana() {
  const interruptedApply = Boolean(activeApplyOperation);
  invalidateContentLifecycle();
  if (interruptedApply) lastAppliedSettings = null;
  const pageRoot = document.body || document.documentElement;
  pageRoot?.classList.add('tsukeru-furigana-disabled');
  document.documentElement.removeAttribute('data-tsukeru-custom-style');
  hideDefinitionTooltip();
  isFuriganaActive = false;
  stopWatchingDynamicContent();
  stopIntersectionObserver();
  stopYoutubeCaptionsObserver();
  clearLongPageRuntime({ retainClassification: true });
  setHighlightMode('off');
}

// Full DOM teardown — used before re-applying with changed settings.
function hardClearFurigana() {
  invalidateContentLifecycle();
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
  const pageRoot = document.body || document.documentElement;
  pageRoot?.classList.remove('tsukeru-furigana-disabled');
  document.documentElement.removeAttribute('data-tsukeru-custom-style');
  originalTextMap = new WeakMap();
  hideDefinitionTooltip();
  isFuriganaActive = false;
  lastAppliedSettings = null;
  processedNodes = new WeakSet();
  processingQueue.clear();
  clearDefinitionCaches();
  stopWatchingDynamicContent();
  stopIntersectionObserver();
  stopYoutubeCaptionsObserver();
  clearLongPageRuntime();
  setHighlightMode('off');
}

// ── Initialization guard ──────────────────────────────────────────────────────
// Runs only once per page context. Prevents double-init on re-injection via
// ensureContentScript. State variables are declared as var so they hoist to
// the global scope and are accessible from content-dom.js / content-tooltip.js.

if (!window.__TSUKERU_LOADED__) {
  window.__TSUKERU_LOADED__ = true;

  // Shared state — var declarations hoist to global scope in plain scripts
  var lifecycleGeneration = 0;
  var activeApplyOperation = null;
  var isFuriganaActive = false;
  var lastAppliedSettings = null;
  var mutationObserver = null;
  var intersectionObserver = null;
  var containerDiscoveryPollTimer = null;
  var containerDiscoveryObserver = null;
  var dynamicContainer = null;
  var dynamicPendingTargets = new Set();
  var dynamicDrainTimer = null;
  var dynamicDrainContainer = null;
  var dynamicProcessingOperation = null;
  var dynamicSettings = null;
  var observedIntersectionElements = new Set();
  var youtubeCaptionObserver = null;
  var youtubeCaptionRetryTimer = null;
  var processedNodes = new WeakSet();
  var processingQueue = new Map();
  var youtubeCaptionTimer = null;
  var youtubeCaptionProcessingOperation = null;
  var youtubeCaptionPending = false;
  var youtubeCaptionContainer = null;
  var youtubeCaptionSettings = null;
  var currentSite = detectSite();        // detectSite() defined in content-dom.js
  var currentHighlightMode = 'off';
  var dictionaryTooltip = null;
  var dictionaryEventsBound = false;
  var definitionCache = new Map();
  var definitionPendingCache = new Map();
  var definitionCacheGeneration = 0;
  var originalTextMap = new WeakMap();
  var longPageMode = false;
  var wasLongPage = false;
  var longPageBlocks = [];
  var longPageBlockByElement = new WeakMap();
  var longPagePlanRoot = null;
  var viewportVisibleBlocks = new Set();
  var viewportNearbyBlocks = new Set();
  var longPageFirstWorkState = 'idle';
  var longPageBatchSerial = 0;
  var cleanupPending = false;
  var viewportProcessingPending = false;
  var savedVocabularyWords = new Set();
  var savedVocabularyPairs = new Set();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'applyFurigana') {
      applyFurigana(request.settings)
        .then((result) => sendResponse({ ok: true, pending: Boolean(result?.pending) }))
        .catch(async (error) => {
          const failure = serializeApplyFailure(error);
          if (failure.rateLimitType || failure.errorCode === 'service_unavailable') {
            try {
              const stateResponse = await chrome.runtime.sendMessage({ action: 'getRateLimitState' });
              const cooldown = stateResponse?.state?.furigana;
              if (Number(cooldown?.expiresAt) > Date.now()) {
                failure.status = cooldown.status ?? failure.status;
                failure.errorCode = cooldown.status === 503
                  ? 'service_unavailable'
                  : (failure.errorCode || 'rate_limited');
                failure.operation = cooldown.operation || failure.operation || 'furigana';
                failure.rateLimitType = cooldown.rateLimitType || failure.rateLimitType;
                failure.retryAt = Number(cooldown.expiresAt);
                failure.retryAfter = Math.max(1, Math.ceil((failure.retryAt - Date.now()) / 1000));
              }
            } catch (_) {
              // Preserve the original structured failure when state refresh is unavailable.
            }
          }
          sendResponse(failure);
        });
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
