/*
Module: content-main
Purpose: Coordinate eager and viewport-limited furigana apply/clear lifecycles and route content-script message actions. In an embedded frame, only video captions follow the top page's Apply and Clear.

Inputs:
- Popup/background message actions and persisted settings payloads.
- The background's answer to whether this page's site gets furigana automatically.
- DOM helper functions, runtime state flags, and the lazy tooltip coordinator dependency.

Outputs:
- Action responses and page furigana state transitions.

Side Effects:
- Toggles page classes/attributes/styles and shared runtime globals.
- Starts/stops observers, the video caption allowance's counting and player card (content-captions), long-page block state, dictionary popup behavior, lazy tooltip lookup sessions, live appearance updates, and the page dock (shown while the page has furigana).
- Uses the shared i18n catalog for action-triggered feedback.
- Applies My Words display settings (Study mode, hidden readings on known words) and follows word state changes from `chrome.storage.onChanged`.

Failure Modes:
- Concurrent apply requests are ignored while an operation token is active; stale viewport work is cancelled cooperatively.
- Runtime messaging/API failures surface as localized toast notifications via structured error metadata and shared retry helpers.
- Automatic furigana stays silent on pages without Japanese text, retrying once for pages that render their text late.

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
//   js/word-rules.js        (My Words identity rules)
//   js/content-tooltip.js   (dictionary tooltip, My Words states)
//   js/content-caption-cues.js (subtitle files, lines processed ahead)
//   js/content-caption-layer.js (Tsukeru's caption layer, Netflix, player .vtt files)
//   js/content-caption-tools.js (pause on lookup, line replay, Explain, video words)
//   js/content-captions.js  (video caption allowance, player limit card, frame mode)
//
// Guard pattern: state variables and the message listener are initialized
// only once per page context. Functions (applyFurigana etc.) are defined
// at top level so they can reference the var-declared globals set up below.
// ============================================================================

// ── Core furigana functions ───────────────────────────────────────────────────

function t(key, substitutions, fallback = '') {
  return TsukeruI18n.t(key, substitutions, fallback);
}

function getUserFacingApplyError(error) {
  return TsukeruUiMessages.errorMessage(error, 'apply', t);
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

// Pages that render their text after loading get one more automatic try.
const AUTO_APPLY_RETRY_MS = 2000;

async function applyFurigana(settings, { automatic = false } = {}) {
  if (activeApplyOperation) return;

  const pageRoot = document.body || document.documentElement;

  // Soft-hide bypass: if DOM is intact but hidden, and reprocess-critical settings
  // (furiganaType) haven't changed, just reveal the DOM.
  const softHidden = Boolean(pageRoot?.classList.contains('tsukeru-furigana-disabled'));
  const hasRubyDom = softHidden && document.querySelectorAll('[data-tsukeru-wrapper="1"]').length > 0;
  if (hasRubyDom && lastAppliedSettings) {
    const needsReprocess = settings.furiganaType !== lastAppliedSettings.furiganaType;
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
        setLevelFilter(settings);
        applyWordDisplaySettings(settings);
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
          await refreshWordStates();
          startLongPageProcessing(settings);
        } else if (settings.watchDynamic) {
          refreshWordStates();
          startWatchingDynamicContent(settings);
          const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
          if (siteConfig.useIntersectionObserver) startIntersectionObserver(settings);
        } else {
          refreshWordStates();
        }
        startVideoCaptions(settings);
        return { pending: revealPending };
      } finally {
        if (activeApplyOperation === operation) activeApplyOperation = null;
        refreshPageDock();
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
  setRubyColor(settings?.rubyColor);
  document.documentElement.style.setProperty('--tsukeru-ruby-weight', settings?.rubyWeight || 'normal');
  setLevelFilter(settings);
  applyWordDisplaySettings(settings);

  try {
    await TsukeruI18n.ready();
    if (!isValid()) return;
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
      await refreshWordStates();
      if (!isValid()) return;
      startLongPageProcessing(settings);
      startVideoCaptions(settings);
      return { pending: true };
    }

    const discovery = await collectInitialDiscovery(processingRoot || pageRoot, {
      signal: operation.controller.signal,
      isCurrent: isValid,
      viewportModeKnown: Boolean(siteConfig.useIntersectionObserver),
    });
    const longPagePlan = discovery.plan;
    if (!longPagePlan.blocks.length) {
      throw Object.assign(new Error('No eligible text'), { errorCode: 'no_text' });
    }

    if (shouldUseViewportProcessing(longPagePlan, siteConfig)) {
      installLongPagePlan(longPagePlan, {
        force: Boolean(siteConfig.useIntersectionObserver),
        rootNode: processingRoot || pageRoot,
      });
      isFuriganaActive = true;
      lastAppliedSettings = { ...settings };
      enableDictionaryPopups();
      await refreshWordStates();
      if (!isValid()) return;
      startLongPageProcessing(settings);
      // Long pages (YouTube included) get the caption extras too: tools bar, caption layer, embedded players.
      startVideoCaptions(settings);
      return;
    }

    const textNodes = discovery.textNodes
      .filter((node) => node.isConnected !== false && isProcessableTextNode(node));
    if (!textNodes.length) {
      throw Object.assign(new Error('No eligible text'), { errorCode: 'no_text' });
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
    refreshWordStates();

    if (settings.watchDynamic) {
      startWatchingDynamicContent(settings);

      const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
      if (siteConfig.useIntersectionObserver) {
        startIntersectionObserver(settings);
      }
    }

    startVideoCaptions(settings);

  } catch (error) {
    if (!isValid() || error.cancelled) return;
    // No Japanese text on the page itself, but a video (here or in an embedded player): its captions get furigana.
    if (error.errorCode === 'no_text' && await pageHasVideo()) {
      if (!isValid()) return;
      startCaptionsOnly(settings);
      return { captionsOnly: true };
    }
    console.warn('Tsukeru: apply failed', error?.errorCode || 'unknown');
    if (error.rateLimitType || error.errorCode === 'service_unavailable') {
      // Rate-limit and service-availability toasts are guaranteed by the retry helper.
    } else {
      // Automatic furigana says nothing on a listed site's pages without Japanese text.
      if (!(automatic && error.errorCode === 'no_text')) {
        showToast(getUserFacingApplyError(error), { type: 'error', duration: 8000 });
      }
      setHighlightMode('off');
      clearWordDisplaySettings();
    }
    throw error;
  } finally {
    // Toasts manage their own lifetime; do not dismiss them here.
    if (activeApplyOperation === operation) activeApplyOperation = null;
    refreshPageDock();
  }
}

/** Show or remove the page dock (content-dock.js) after furigana changed. */
function refreshPageDock() {
  if (typeof syncPageDock === 'function') syncPageDock().catch(() => {});
}

const DEFAULT_RUBY_COLOR = '#475569';
const DEFAULT_CAPTION_RUBY_COLOR = '#cbd5e1';

/**
 * Set the furigana colour. Video captions sit on a dark box, so while the
 * colour is the default (made for light pages) they use a light one instead;
 * a colour the reader chose applies to captions too.
 */
function setRubyColor(color) {
  const value = typeof color === 'string' && color ? color : DEFAULT_RUBY_COLOR;
  const root = document.documentElement;
  root.style.setProperty('--tsukeru-ruby-color', value);
  root.style.setProperty('--tsukeru-caption-ruby-color',
    value.toLowerCase() === DEFAULT_RUBY_COLOR ? DEFAULT_CAPTION_RUBY_COLOR : value);
}

/**
 * Follow the popup's live appearance changes (furigana colour, size, weight,
 * highlighting, custom styling). Embedded frames use it too, so a player's
 * caption layer follows the same settings.
 */
function applyAppearanceUpdate(request) {
  const root = document.documentElement;
  if (typeof request.color === 'string' && request.color) setRubyColor(request.color);
  if (typeof request.size === 'string' && request.size) root.style.setProperty('--tsukeru-ruby-size', request.size);
  if (typeof request.weight === 'string' && request.weight) root.style.setProperty('--tsukeru-ruby-weight', request.weight);
  const hasManagedRuby = document.querySelector('[data-tsukeru-wrapper="1"]');
  if (request.highlightMode && (isFuriganaActive || hasManagedRuby)) setHighlightMode(request.highlightMode);
  if (typeof request.removeCustomStyling === 'boolean' && (isFuriganaActive || hasManagedRuby)) {
    root.setAttribute('data-tsukeru-custom-style', request.removeCustomStyling ? 'off' : 'on');
  }
}

/**
 * Apply furigana when the reader listed this site in Settings, or once when the
 * popup opened this tab from Discover. The background decides from the tab's
 * address (or that one-time grant) and answers with the stored settings. A
 * Clear or a manual Apply meanwhile cancels the automatic one.
 */
async function autoApplyIfListed() {
  if (window.top !== window) return;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ action: 'getAutoApply' });
  } catch (_) {
    return;
  }
  const settings = response?.success ? response.settings : null;
  if (!settings || typeof settings !== 'object') return;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isFuriganaActive || activeApplyOperation) return;
    const generation = lifecycleGeneration;
    try {
      await applyFurigana(settings, { automatic: true });
      return;
    } catch (error) {
      if (error?.errorCode !== 'no_text' || attempt) return;
    }
    await new Promise((resolve) => setTimeout(resolve, AUTO_APPLY_RETRY_MS));
    if (generation !== lifecycleGeneration) return;
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
  stopVideoCaptionsObserver();
  stopCaptionAllowance();
  stopCaptionLayers();
  clearLongPageRuntime({ retainClassification: true });
  setHighlightMode('off');
  clearWordDisplaySettings();
  refreshPageDock();
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
  stopVideoCaptionsObserver();
  stopCaptionAllowance();
  stopCaptionLayers();
  clearCaptionCueTrack();
  clearLongPageRuntime();
  setHighlightMode('off');
  clearWordDisplaySettings();
  refreshPageDock();
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
  var videoCaptionObserver = null;
  var videoCaptionRetryTimer = null;
  var processedNodes = new WeakSet();
  var processingQueue = new Map();
  var videoCaptionTimer = null;
  var videoCaptionProcessingOperation = null;
  var videoCaptionPending = false;
  var videoCaptionContainer = null;
  var videoCaptionSettings = null;
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
  // My Words: word id -> learning/known/ignored, kept current from storage.
  var wordStates = new Map();
  var wordStatesApplied = false;
  var wordStateRefreshFrame = 0;
  // Each word counts as checked at most once per page, like a website result.
  var countedWordIds = new Set();
  // Debounces the notice that tells an open popup to re-list the page's words.
  var pageWordsNoticeTimer = 0;
  var pageWordsChangedAt = 0;
  var pageWordsNoticeStartedAt = 0;

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local') noteWordStateChanges(changes);
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // An embedded frame does captions only, and never answers (content-captions).
    if (window.top !== window) return handleFrameCaptionMessage(request, sendResponse);

    if (request.action === 'applyFurigana') {
      applyFurigana(request.settings)
        .then((result) => sendResponse({ ok: true, pending: Boolean(result?.pending), captionsOnly: Boolean(result?.captionsOnly) }))
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

    // The sign-in tab opened from the caption limit card connected Tsukeru.
    if (request.action === 'captionConnected') {
      handleCaptionConnected();
      sendResponse({ ok: true });
    }

    if (request.action === 'getFuriganaState') {
      sendResponse({ active: isFuriganaActive });
    }

    // The popup's This page tab: the words of the video's subtitles (content-caption-tools),
    // or of a video playing in an embedded frame, which the background asks for.
    if (request.action === 'getVideoWords') {
      getVideoWords()
        .then((answer) => (answer?.available ? answer : askBackground({ action: 'frameVideoWords' })))
        .then((answer) => sendResponse(answer?.available ? answer : { available: false }))
        .catch(() => sendResponse({ available: false }));
      return true;
    }

    if (request.action === 'getPageWords') {
      const words = extractAllPageWords();
      sendResponse({ words });
    }

    if (request.action === 'scrollToWord') {
      const result = scrollToAndHighlightWord(request.word, request.reading);
      sendResponse(result);
    }

    if (request.action === 'openWordTooltip') {
      sendResponse(openTooltipForWord(request.word, request.reading));
    }

    if (request.action === 'getWordContext') {
      const result = getWordContextSentence(request.word, request.reading);
      sendResponse(result);
    }

    if (request.action === 'updateWordDisplay') {
      if (isFuriganaActive) applyWordDisplaySettings(request.settings || {});
      sendResponse({ ok: true });
    }

    if (request.action === 'updateLevel') {
      setLevelFilter(request.settings || {});
      sendResponse({ ok: true });
    }
    if (request.action === 'updateAppearance') {
      applyAppearanceUpdate(request);
      sendResponse({ ok: true });
    }
  });

  listenForPageCaptions();
  if (window.top !== window) watchFrameVideo();
  autoApplyIfListed();
}
