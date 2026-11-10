/*
Module: content-tooltip
Purpose: Manage the instrument-styled dictionary tooltip, lazy enrichment, word interactions, reporting, My Words capture with the Learning / Known switch, Study mode reveals, and learning/known word marks on pages.

Inputs:
- Pointer/selection events, wrapper metadata, reading-aware background lookup/audio responses, and the shared lazy-state coordinator.
- Word states from the background store, word storage changes, and My Words display settings (Study mode, hidden readings on known words).
- The shared i18n catalog and content-ui language and theme helper for extension-owned surfaces.
- The dictionary popup size preference (`popupSize` in sync storage) and the clicked point and line boxes of the word.
- Additive wrapper metadata from current backends: `data-inflection` codes, `data-freq` tier, and `data-accent` (`reading:downstep`); kanji-breakdown `grade`, frequency-ordered `examples`, and KanjiVG `strokes`.

Outputs:
- Tooltip rendering updates with Japanese language tags for words/readings/examples, checked-word and Learning/Known requests to the background store, and report payload messages.
- The card layout shared with the EZFurigana website: frequency badge, pitch-marked reading, form line with conjugation labels, Meaning / Kanji tabs, and a Kanji tab that loads on first open with stroke-order diagrams and KanjiVG attribution.
- A "Play sentence" line showing the sentence around the clicked word (Supporter audio), tagged "Supporter" when this browser holds no Supporter token, with "Explain" to its right: the sentence explained in the display language (Supporters), opened below the line.
- A play button, like the word's, at the end of each TKGJE example with a recorded reading (Supporter audio, refused the same way as Play sentence).
- In ja/ko/zh-TW, translation controls at the top of the Meaning tab: View translation with the new translations a guest has left today, an AI translation / English switch once translated, and a Supporter line when none are left. Supporters' translations start without a click.
- `tsukeru-learning`, `tsukeru-known`, and `tsukeru-revealed` classes and Study/known-reading attributes on the page.
- `openTooltipForWord` opens the tooltip on a word named by the extension popup's Words in this text (`openWordTooltip`).
- A `pageWordsChanged` runtime notice once furigana insertions pause (at most every few seconds while they continue), so an open popup re-lists the page's words.

Side Effects:
- Creates/removes tooltip DOM on the root element, scroll/resize/Escape listeners that re-place or close it, and disclosure state.
- Places the tooltip with the placement rules shared with EZFurigana (a bottom sheet at 600 px wide or less) and marks the clicked word with `tsukeru-active-word` while it is open.
- Registers tooltip and report surfaces with content-ui to follow the saved UI theme.
- Opening the dictionary on a kanji word, or revealing it in Study mode, adds it to Learning (a known word stays known).
- Play sentence sends the plain sentence around the open word (at most 120 characters) to the background for Supporter audio and shows a toast when it is refused.
- Explain sends the same sentence and the display language to the background for a Supporter explanation, after a one-time notice that the sentence goes to OpenAI (remembered as `explainNoticeSeen` in local storage); a browser without a Supporter token gets a toast instead and sends nothing.
- Excludes tooltip-owned metadata from word capture and word-state marks.

Failure Modes:
- Lookup/audio/report/enrichment requests can fail with preserved runtime status/rate-limit metadata and trigger fallback/no-op paths; stale or dismissed responses are ignored.
- Missing metadata prevents capture/play actions for a target word; kana-only words are not tracked.
- Completed dictionary results are TTL-bound and size-bounded; shared in-flight requests are retained only until settlement.

Security Notes:
- Escapes/sanitizes rendered content; AI ruby and sentence explanations use DOM text nodes. Only trusted clicks can generate translations: a reader's click on View translation, or, for a Supporter, the trusted click that opened the word.
- Stroke diagrams are built with DOM APIs from paths re-checked against SVG path syntax; tier, accent, and inflection values are matched against fixed allowlists before rendering.
- Report opening/submission requires trusted clicks; word, reading, and context are held in isolated-script state rather than read back from page fields.
- Avoids direct third-party media fetches from page context.
- Checked words carry only the word, reading, JLPT level, part of speech, a short plain-text sentence, and the readings Tsukeru gave that sentence's words (positions and kana only); no page URL.
*/
// ============================================================================
// content-tooltip.js — Dictionary tooltip, My Words states, TTS, report modal
// Loaded as a plain content script after content-dom.js.
// References shared globals declared as var in content-main.js:
//   dictionaryTooltip, dictionaryEventsBound, definitionCache
// References functions from content-dom.js:
//   escapeHtml, sanitizeHtmlFragment, cleanHTML, buildCenteredSnippet,
//   generateEntryId, sleep, resolveAnalysisWordElement, getAnalysisWordData,
//   getAnalysisWordElements
// ============================================================================

// ── Kata-to-Hira conversion ───────────────────────────────────────────────────

function kata2hira(str) {
  return (str || '').replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
function t(key, substitutions, fallback = '') {
  return TsukeruI18n.t(key, substitutions, fallback);
}

function createRuntimeResponseError(response, fallbackMessage) {
  const error = new Error(
    typeof response?.error === 'string' && response.error
      ? response.error
      : fallbackMessage
  );
  for (const field of ['status', 'httpStatus', 'errorCode', 'operation', 'rateLimitType', 'retryAfter', 'retryAt']) {
    if (response?.[field] !== undefined && response?.[field] !== null) {
      error[field] = response[field];
    }
  }
  return error;
}

// ── Dictionary tooltip: enable / click handling ───────────────────────────────

function enableDictionaryPopups() {
  // Remove handlers registered by ANY previous context so we never stack
  // duplicate listeners across repeated script injections.
  if (document.__tsukeruClickHandler__) {
    document.removeEventListener('click', document.__tsukeruClickHandler__, true);
  }
  if (document.__tsukeruDblClickHandler__) {
    document.removeEventListener('dblclick', document.__tsukeruDblClickHandler__, true);
  }
  if (document.__tsukeruScrollHandler__) {
    window.removeEventListener('scroll', document.__tsukeruScrollHandler__, true);
  }
  if (document.__tsukeruResizeHandler__) {
    window.removeEventListener('resize', document.__tsukeruResizeHandler__);
  }
  if (document.__tsukeruKeyHandler__) {
    document.removeEventListener('keydown', document.__tsukeruKeyHandler__, true);
  }

  // Older versions saved words on double-click; checking a word now adds it to Learning.
  document.__tsukeruClickHandler__ = handleDictionaryClick;
  document.__tsukeruDblClickHandler__ = null;

  document.addEventListener('click', handleDictionaryClick, true);
  // The tooltip follows its word through page scrolls and resizes and closes
  // once the word leaves the screen; scrolling inside it never closes it.
  document.__tsukeruScrollHandler__ = (event) => {
    const target = event.target;
    if (dictionaryTooltip && target && typeof target.nodeType === 'number' && dictionaryTooltip.contains(target)) {
      return;
    }
    scheduleTooltipReposition();
  };
  document.__tsukeruResizeHandler__ = scheduleTooltipReposition;
  document.__tsukeruKeyHandler__ = (event) => {
    if (event.key !== 'Escape' || !dictionaryTooltip?.classList.contains('show')) return;
    const reportModal = document.getElementById('tsukeru-content-report-modal');
    if (reportModal && !reportModal.classList.contains('hidden')) return;
    hideDefinitionTooltip();
  };
  window.addEventListener('scroll', document.__tsukeruScrollHandler__, { capture: true, passive: true });
  window.addEventListener('resize', document.__tsukeruResizeHandler__, { passive: true });
  document.addEventListener('keydown', document.__tsukeruKeyHandler__, true);
  loadTooltipSizePreference();
  // dictionaryEventsBound is a var global from content-main.js
  dictionaryEventsBound = true;
}

let tooltipRepositionFrame = 0;

function scheduleTooltipReposition() {
  if (tooltipRepositionFrame || !dictionaryTooltip?.classList.contains('show')) return;
  tooltipRepositionFrame = requestAnimationFrame(() => {
    tooltipRepositionFrame = 0;
    if (dictionaryTooltip?.classList.contains('show')) {
      positionTooltip(dictionaryTooltip._activeRuby, dictionaryTooltip);
    }
  });
}

// ── Tooltip size preference (Small / Medium / Large in the settings panel) ───

const TOOLTIP_SIZES = new Set(['small', 'medium', 'large']);
let tooltipSizePreference = 'medium';

function applyTooltipSizePreference(tooltip) {
  if (tooltip) tooltip.dataset.tsukeruSize = tooltipSizePreference;
}

function loadTooltipSizePreference() {
  if (document.__tsukeruSizeListenerBound__) return;
  document.__tsukeruSizeListenerBound__ = true;
  chrome.storage?.sync?.get({ popupSize: 'medium' })
    .then(({ popupSize }) => {
      tooltipSizePreference = TOOLTIP_SIZES.has(popupSize) ? popupSize : 'medium';
      applyTooltipSizePreference(dictionaryTooltip);
    })
    .catch(() => {});
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.popupSize) return;
    const next = changes.popupSize.newValue;
    tooltipSizePreference = TOOLTIP_SIZES.has(next) ? next : 'medium';
    applyTooltipSizePreference(dictionaryTooltip);
    scheduleTooltipReposition();
  });
}

function handleDictionaryClick(event) {
  // ORPHAN CHECK: If the extension was reloaded, this script context is dead.
  if (!chrome.runtime?.id) {
    document.removeEventListener('click', handleDictionaryClick, true);
    return;
  }

  if (!event.isTrusted) return;

  if (!isFuriganaActive) {
    hideDefinitionTooltip();
    return;
  }

  if (event.target.closest('#tsukeru-word-tooltip')) {
    return;
  }

  const targetEl = resolveAnalysisWordElement(event.target);
  if (!targetEl) {
    hideDefinitionTooltip();
    return;
  }

  if (event.target.closest('.alt-indicator')) return;

  const wordInfo = extractWordInfo(targetEl);
  if (!wordInfo.word) return;

  event.preventDefault();
  event.stopPropagation();

  if (handleStudyReveal(targetEl, wordInfo)) {
    hideDefinitionTooltip();
    return;
  }
  showDefinitionTooltip(targetEl, wordInfo, { x: event.clientX, y: event.clientY }, { trusted: event.isTrusted });
}

/**
 * Open the dictionary popup on a word from the extension popup's This page
 * list, as if the reader had clicked it there.
 */
function openTooltipForWord(word, reading) {
  const target = isFuriganaActive ? findAnalysisWord(word, reading) : null;
  if (!target) return { found: false };
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  const wordInfo = extractWordInfo(target);
  if (!wordInfo.word) return { found: false };
  const rect = target.getBoundingClientRect();
  // The extension popup's own click asked for this word.
  showDefinitionTooltip(target, wordInfo, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { trusted: true });
  return { found: true };
}

// ── Word info extraction ──────────────────────────────────────────────────────

function extractWordInfo(target) {
  const info = getAnalysisWordData(target);
  return {
    word: info.word || '',
    reading: info.reading || '',
    surface: info.surface || '',
    surfaceReading: info.surfaceReading || '',
    lookupReading: info.lookupReading || '',
    lookupReadingType: info.lookupReadingType || '',
    jlpt: info.jlpt || '',
    pos: info.pos || '',
    altReadings: info.altReadings || [],
    inflection: info.inflection || [],
    freq: info.freq || '',
    accent: info.accent || ''
  };
}

// ── Tooltip lifecycle ─────────────────────────────────────────────────────────

async function showDefinitionTooltip(ruby, wordInfo, point = null, { trusted = false } = {}) {
  const tooltip = ensureDictionaryTooltip();

  tooltip._lookupVersion = (tooltip._lookupVersion || 0) + 1;
  const myToken = tooltip._lookupVersion;
  await TsukeruI18n.ready();
  if (tooltip._lookupVersion !== myToken || ruby.isConnected === false) return;
  applyTsukeruUiTheme(tooltip);
  // tooltip-async-state.js registers on globalThis. Firefox content scripts run in a
  // sandbox where globalThis is not window, so read it from globalThis.
  if (!tooltip._asyncCoordinator && globalThis.TsukeruTooltipAsyncState?.createTooltipAsyncCoordinator) {
    tooltip._asyncCoordinator = globalThis.TsukeruTooltipAsyncState.createTooltipAsyncCoordinator();
  }
  tooltip._asyncCoordinator?.reset(wordInfo.word);

  tooltip.dataset.word = wordInfo.word;
  if (tooltip._activeRuby && tooltip._activeRuby !== ruby) {
    tooltip._activeRuby.classList?.remove('tsukeru-active-word');
  }
  tooltip._activeRuby = ruby;
  tooltip._activeWordInfo = wordInfo;
  tooltip._placementSide = '';
  tooltip._anchorIndex = 0;
  ruby.classList?.add('tsukeru-active-word');
  tooltip.innerHTML = getTooltipLoadingHtml(wordInfo);

  positionTooltip(ruby, tooltip, point);
  tooltip.classList.add('show');
  addTooltipInteractionHandlers();
  // Checking a word adds it to Learning, as on the website.
  const recordPromise = captureCheckedWord(ruby, wordInfo, 'lookup');

  try {
    const definitionData = await lookupDefinition(
      wordInfo.word,
      wordInfo.lookupReading,
      wordInfo.lookupReadingType
    );
    if (tooltip._lookupVersion !== myToken || tooltip.dataset.word !== wordInfo.word) return;
    renderDefinitionTooltip(tooltip, wordInfo, definitionData);
    bindTooltipProgress(tooltip, recordPromise, myToken);
    rememberWordDefinition(recordPromise, definitionData);
    startLocalizedTooltip(tooltip, wordInfo, definitionData, recordPromise, myToken, { trusted });
  } catch (err) {
    if (tooltip._lookupVersion !== myToken || tooltip.dataset.word !== wordInfo.word) return;
    console.error('Tsukeru: dictionary lookup failed', err);
    if (err?.rateLimitType || err?.errorCode === 'service_unavailable') {
      showRateLimitToast(err.errorCode === 'service_unavailable' ? 'service_unavailable' : (err.rateLimitType || 'service_unavailable'), err.retryAfter, err.retryAt, err.operation || 'dictionary');
    }
    tooltip.innerHTML = getTooltipErrorHtml(
      wordInfo,
      t('content_error_loading_definition', undefined, 'Error loading definition')
    );
    addTooltipInteractionHandlers();
    bindTooltipProgress(tooltip, recordPromise, myToken);
  }
}

function ensureDictionaryTooltip() {
  // dictionaryTooltip is a var global from content-main.js
  if (dictionaryTooltip && dictionaryTooltip.isConnected) {
    applyTsukeruUiTheme(dictionaryTooltip);
    return dictionaryTooltip;
  }
  const existing = document.getElementById('tsukeru-word-tooltip');
  if (existing) {
    dictionaryTooltip = existing;
    applyTsukeruUiTheme(existing);
    return existing;
  }
  dictionaryTooltip = document.createElement('div');
  dictionaryTooltip.id = 'tsukeru-word-tooltip';
  dictionaryTooltip.className = 'tsukeru-word-tooltip';
  applyTsukeruUiTheme(dictionaryTooltip);
  applyTooltipSizePreference(dictionaryTooltip);
  // Mounted on <html> so a transform or filter on the page's <body> cannot
  // offset or clip the fixed-position tooltip.
  (document.documentElement || document.body).appendChild(dictionaryTooltip);
  if (typeof ResizeObserver === 'function') {
    // Content that loads or expands re-places the tooltip on its chosen side.
    new ResizeObserver(() => scheduleTooltipReposition()).observe(dictionaryTooltip);
  }
  return dictionaryTooltip;
}

function hideDefinitionTooltip() {
  if (dictionaryTooltip) {
    dictionaryTooltip._lookupVersion = (dictionaryTooltip._lookupVersion || 0) + 1;
    dictionaryTooltip._asyncCoordinator?.invalidate();
    dictionaryTooltip.classList.remove('show');
    dictionaryTooltip.innerHTML = '';
    dictionaryTooltip.dataset.word = '';
    dictionaryTooltip._activeRuby?.classList?.remove('tsukeru-active-word');
    dictionaryTooltip._activeRuby = null;
    dictionaryTooltip._activeWordInfo = null;
    dictionaryTooltip._placementSide = '';
  }
}

// ── Tooltip placement ─────────────────────────────────────────────────────────
// Keep identical to computeTooltipPlacement on the EZFurigana website; both run
// scripts/fixtures/tooltip-placement-cases.json (website docs/dictionary-popup.md).

const TOOLTIP_PLACEMENT_STICKY_HEIGHT = 160;

function pickTooltipAnchorRect(rects, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return 0;
  }
  let bestIndex = 0;
  let bestDistance = Infinity;
  rects.forEach((rect, index) => {
    const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
    const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function chooseTooltipSide(room, sides, needed, previousSide) {
  if (sides.includes(previousSide) && room[previousSide] >= Math.min(needed, TOOLTIP_PLACEMENT_STICKY_HEIGHT)) {
    return previousSide;
  }
  const fitting = sides.find((side) => room[side] >= needed);
  if (fitting) return fitting;
  return room[sides[0]] >= room[sides[1]] ? sides[0] : sides[1];
}

function computeTooltipPlacement(input) {
  const margin = Number.isFinite(input?.margin) ? input.margin : 12;
  const gap = Number.isFinite(input?.gap) ? input.gap : 8;
  const viewport = input?.viewport || { width: 0, height: 0 };
  const size = input?.size || { width: 0, height: 0 };
  const rects = (Array.isArray(input?.anchorRects) ? input.anchorRects : [])
    .filter((rect) => rect && (rect.right - rect.left > 0 || rect.bottom - rect.top > 0));
  if (rects.length === 0) return null;

  const anchorIndex = pickTooltipAnchorRect(rects, input.point);
  const rect = rects[anchorIndex];
  const anchorVisible = rect.bottom > 0 && rect.top < viewport.height
    && rect.right > 0 && rect.left < viewport.width;

  if (input.vertical) {
    const room = {
      right: viewport.width - margin - (rect.right + gap),
      left: rect.left - gap - margin,
    };
    const side = chooseTooltipSide(room, ['right', 'left'], size.width, input.previousSide);
    const maxWidth = Math.max(0, Math.floor(room[side]));
    const width = Math.min(size.width, maxWidth);
    const maxHeight = Math.max(0, viewport.height - margin * 2);
    const height = Math.min(size.height, maxHeight);
    const left = side === 'right' ? rect.right + gap : rect.left - gap - width;
    const top = clampNumber((rect.top + rect.bottom) / 2 - height / 2, margin, viewport.height - margin - height);
    return {
      left: Math.round(left), top: Math.round(top), side, maxHeight, maxWidth, anchorIndex, anchorVisible,
    };
  }

  const room = {
    below: viewport.height - margin - (rect.bottom + gap),
    above: rect.top - gap - margin,
  };
  const side = chooseTooltipSide(room, ['below', 'above'], size.height, input.previousSide);
  const maxHeight = Math.max(0, Math.floor(room[side]));
  const height = Math.min(size.height, maxHeight);
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const width = Math.min(size.width, maxWidth);
  const top = side === 'below' ? rect.bottom + gap : rect.top - gap - height;
  const left = clampNumber((rect.left + rect.right) / 2 - width / 2, margin, viewport.width - margin - width);
  return {
    left: Math.round(left), top: Math.round(top), side, maxHeight, maxWidth, anchorIndex, anchorVisible,
  };
}

function isTooltipSheetLayout() {
  return Boolean(window.matchMedia?.('(max-width: 600px)').matches);
}

function positionTooltip(ruby, tooltip, point = null) {
  if (!ruby || !tooltip) return;
  // Narrow screens show a bottom sheet that CSS places.
  const sheet = isTooltipSheetLayout();
  tooltip.classList.toggle('tsukeru-sheet', sheet);
  if (sheet) {
    tooltip.style.left = '';
    tooltip.style.top = '';
    tooltip.style.removeProperty('--tsukeru-tooltip-max-height');
    tooltip.style.removeProperty('--tsukeru-tooltip-max-width');
    return;
  }
  if (ruby.isConnected === false) {
    hideDefinitionTooltip();
    return;
  }

  const rects = Array.from(ruby.getClientRects()).map((rect) => ({
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
  }));
  const anchorRects = point || rects.length <= 1 ? rects : [rects[tooltip._anchorIndex] || rects[0]];
  tooltip.style.removeProperty('--tsukeru-tooltip-max-height');
  tooltip.style.removeProperty('--tsukeru-tooltip-max-width');
  const measured = tooltip.getBoundingClientRect();
  const placement = computeTooltipPlacement({
    anchorRects,
    point,
    size: { width: measured.width || 320, height: measured.height || 200 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    previousSide: tooltip._placementSide,
    vertical: String(getComputedStyle(ruby).writingMode || '').startsWith('vertical'),
  });
  if (!placement) return;
  if (!placement.anchorVisible) {
    hideDefinitionTooltip();
    return;
  }
  if (point) tooltip._anchorIndex = placement.anchorIndex;
  tooltip._placementSide = placement.side;
  tooltip.style.left = `${placement.left}px`;
  tooltip.style.top = `${placement.top}px`;
  tooltip.style.transform = 'none';
  tooltip.style.setProperty('--tsukeru-tooltip-max-height', `${placement.maxHeight}px`);
  tooltip.style.setProperty('--tsukeru-tooltip-max-width', `${placement.maxWidth}px`);
}

// ── Tooltip interaction handlers ──────────────────────────────────────────────

function addTooltipInteractionHandlers(reportInfo = null) {
  const tooltip = ensureDictionaryTooltip();
  const closeBtn = tooltip.querySelector('.tsukeru-tooltip-close');
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      hideDefinitionTooltip();
    };
  }

  const speakerBtn = tooltip.querySelector('.tsukeru-tooltip-speaker:not(.tsukeru-example-audio)');
  if (speakerBtn) {
    speakerBtn.onclick = (e) => {
      e.stopPropagation();
      speakWord(speakerBtn.dataset.word, speakerBtn.dataset.reading, speakerBtn);
    };
  }

  const sentenceBtn = tooltip.querySelector('.tsukeru-sentence-play');
  if (sentenceBtn) {
    sentenceBtn.onclick = (e) => {
      e.stopPropagation();
      if (!e.isTrusted) return;
      speakSentence(sentenceBtn);
    };
    refreshSupporterTag(tooltip);
  }

  const explainBtn = tooltip.querySelector('.tsukeru-explain-btn');
  if (explainBtn) bindSentenceExplain(tooltip, explainBtn);

  const reportBtn = tooltip.querySelector('.tsukeru-tooltip-report-btn');
  if (reportBtn) {
    reportBtn.onclick = (e) => {
      if (!e.isTrusted || !reportInfo) return;
      e.stopPropagation();
      const { word, reading } = reportInfo;
      let sentence = tooltip._activeRuby ? extractSentenceContext(tooltip._activeRuby) : '';
      if (sentence) sentence = getPlainTextFromHtml(sentence).substring(0, 200);

      const modal = ensureContentReportModal();
      pendingReadingReport = { word, reading, context: sentence };
      document.getElementById('tsukeru-crm-word').value = word;
      document.getElementById('tsukeru-crm-reading').value = reading;
      document.getElementById('tsukeru-crm-context').value = sentence;
      document.getElementById('tsukeru-crm-correct').value = '';
      document.getElementById('tsukeru-crm-error').classList.add('hidden');
      document.getElementById('tsukeru-crm-success').classList.add('hidden');
      document.getElementById('tsukeru-crm-submit').disabled = false;
      document.getElementById('tsukeru-crm-submit').textContent = t('content_report_submit', undefined, 'Submit Report');
      modal.classList.remove('hidden');
    };
  }

  tooltip.querySelectorAll('.tsukeru-alt-readings-toggle').forEach((altToggle) => {
    altToggle.onclick = (e) => {
      e.stopPropagation();
      const targetId = altToggle.dataset.target;
      const content = document.getElementById(targetId);
      const arrow = altToggle.querySelector('.tsukeru-alt-arrow');
      if (content) {
        const expanded = content.classList.contains('tsukeru-hidden');
        content.classList.toggle('tsukeru-hidden', !expanded);
        altToggle.setAttribute('aria-expanded', String(expanded));
        if (arrow) arrow.classList.toggle('tsukeru-rotate-180', expanded);
        requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
      }
    };
  });

  bindTooltipDisclosureHandlers(tooltip);
}

function isCurrentTooltipLookup(tooltip, version, word) {
  return Boolean(
    tooltip &&
    tooltip.classList.contains('show') &&
    tooltip._lookupVersion === version &&
    tooltip.dataset.word === word
  );
}

function setTooltipSectionExpanded(section, expanded) {
  if (!section) return;
  const toggle = section.querySelector('.tsukeru-dropdown-toggle');
  const content = section.querySelector('.tsukeru-dropdown-content');
  const arrow = section.querySelector('.tsukeru-dropdown-arrow');
  section.dataset.expanded = String(expanded);
  if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
  if (content) content.classList.toggle('tsukeru-hidden', !expanded);
  if (arrow) arrow.classList.toggle('tsukeru-rotate-180', expanded);
}

function bindTooltipDisclosureHandlers(tooltip) {
  tooltip.querySelectorAll('.tsukeru-dropdown-toggle').forEach((toggle) => {
    toggle.onclick = (event) => {
      event.stopPropagation();
      const section = toggle.closest('.tsukeru-async-section');
      if (!section) return;
      const expanded = section.dataset.expanded === 'true';
      setTooltipSectionExpanded(section, !expanded);
      if (!expanded && section.dataset.state === 'idle') {
        if (section.dataset.section === 'example') {
          loadExampleSentence(tooltip.dataset.word);
        }
      }
      requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
    };
  });
}

// ── Tooltip HTML builders ─────────────────────────────────────────────────────

function normalizeTooltipWordInfo(wordInfo) {
  if (typeof wordInfo === 'string') return { word: wordInfo, reading: '', jlpt: '', pos: '', altReadings: [] };
  return wordInfo || { word: '', reading: '', jlpt: '', pos: '', altReadings: [] };
}

function getTooltipMetadata(wordInfo) {
  const info = normalizeTooltipWordInfo(wordInfo);
  const rawJlpt = String(info.jlpt || '').trim();
  const jlpt = /^[1-5]$/.test(rawJlpt) ? rawJlpt : '';
  const pos = String(info.pos || '').split(',')[0].trim();
  const posCategory = normalizeTooltipPosCategory(pos);
  return { jlpt, pos, posCategory };
}

function normalizeTooltipPosCategory(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'other';
  if (/\b(auxiliary\s+)?verb\b/.test(normalized)) return 'verb';
  if (/\b(adjective|adj|na-adj|i-adj)\b/.test(normalized)) return 'adjective';
  if (/\b(noun|pronoun)\b/.test(normalized)) return 'noun';
  if (/\bparticle\b/.test(normalized)) return 'particle';
  if (/\badverb\b/.test(normalized)) return 'adverb';
  return 'other';
}

// data-inflection codes from the website's app/services/inflection_codes.py.
// Literal keys so locale validation sees them; read after TsukeruI18n is ready.
function getInflectionLabels() {
  return {
    polite: t('content_inflection_polite', undefined, 'polite'),
    negative: t('content_inflection_negative', undefined, 'negative'),
    past: t('content_inflection_past', undefined, 'past'),
    te: t('content_inflection_te', undefined, 'te-form'),
    want: t('content_inflection_want', undefined, 'want to'),
    causative: t('content_inflection_causative', undefined, 'causative'),
    passive: t('content_inflection_passive', undefined, 'passive'),
    potential: t('content_inflection_potential', undefined, 'potential'),
    passive_potential: t('content_inflection_passive_potential', undefined, 'passive/potential'),
    volitional: t('content_inflection_volitional', undefined, 'volitional'),
    conditional: t('content_inflection_conditional', undefined, 'conditional'),
    imperative: t('content_inflection_imperative', undefined, 'imperative'),
    adverbial: t('content_inflection_adverbial', undefined, 'adverb form'),
  };
}

function formatInflectionLabels(codes) {
  const labels = getInflectionLabels();
  return (Array.isArray(codes) ? codes : [])
    .filter((code) => Object.prototype.hasOwnProperty.call(labels, code))
    .map((code) => labels[code])
    .join(' · ');
}

// data-accent from the website's app/services/pitch_accent.py: "reading:downstep[,downstep]".
const PITCH_ACCENT_RE = /^([ぁ-ゖー]{1,40}):(\d{1,2}(?:,\d{1,2}){0,5})$/;
const SMALL_KANA = 'ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ';

function splitMorae(reading) {
  const morae = [];
  for (const ch of Array.from(reading)) {
    if (SMALL_KANA.includes(ch) && morae.length > 0) morae[morae.length - 1] += ch;
    else morae.push(ch);
  }
  return morae;
}

function moraIsHigh(index, downstep) {
  if (downstep === 0) return index > 0;
  if (downstep === 1) return index === 0;
  return index > 0 && index < downstep;
}

/** Same pitch drawing as the website: a line over high morae and a tick at the drop. */
function renderTooltipReadingWithPitch(reading, accentValue) {
  const match = PITCH_ACCENT_RE.exec(String(accentValue || ''));
  if (!match || kata2hira(reading) !== match[1]) return escapeHtml(reading);
  const positions = match[2].split(',').map(Number);
  const downstep = positions[0];
  const morae = splitMorae(reading);
  if (downstep > morae.length) return escapeHtml(reading);
  const spans = morae.map((mora, index) => {
    const high = moraIsHigh(index, downstep);
    const classes = ['tsukeru-mora', high ? 'tsukeru-mora-high' : 'tsukeru-mora-low'];
    if (high && index > 0 && !moraIsHigh(index - 1, downstep)) classes.push('tsukeru-mora-rise');
    if (downstep > 0 && index === downstep - 1) classes.push('tsukeru-mora-drop');
    return `<span class="${classes.join(' ')}">${escapeHtml(mora)}</span>`;
  }).join('');
  const pattern = positions.map((position) => `[${position}]`).join(' ');
  const title = t('content_pitch_accent_title', [pattern], `Pitch accent ${pattern}`);
  return `<span class="tsukeru-pitch" title="${escapeHtml(title)}" aria-label="${escapeHtml(`${reading} ${title}`)}">${spans}</span>`;
}

// Whether this browser holds a Supporter token (null until asked). It only
// shows or hides the "Supporter" tag; the backend decides who gets audio.
let sentenceAudioSupporter = null;

/** "Play sentence" as the sentence it reads, the clicked word marked; empty without one. */
function renderTooltipSentenceLine(sentence, word) {
  if (!sentence) return '';
  const at = word ? sentence.indexOf(word) : -1;
  // Two lines show about 36 characters: start a long sentence shortly before the word.
  const from = at > 24 ? at - 10 : 0;
  const lead = from > 0 ? '…' : '';
  const text = at < 0
    ? escapeHtml(sentence)
    : `${lead}${escapeHtml(sentence.slice(from, at))}<mark class="tsukeru-sentence-word">${escapeHtml(word)}</mark>${escapeHtml(sentence.slice(at + word.length))}`;
  const label = t('content_play_sentence', undefined, 'Play sentence');
  const tagHidden = sentenceAudioSupporter === false ? '' : ' tsukeru-hidden';
  const explainLabel = t('content_explain_sentence', undefined, 'Explain this sentence');
  return `
      <div class="tsukeru-sentence-row">
      <button type="button" class="tsukeru-sentence-play" data-sentence="${escapeHtml(sentence)}"
          title="${escapeHtml(label)}" aria-label="${escapeHtml(`${label}: ${sentence}`)}">
          <svg class="tsukeru-sentence-icon" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4v12l10-6z" fill="currentColor"/></svg>
          <span class="tsukeru-sentence-text" lang="ja">${text}</span>
          <span class="tsukeru-supporter-tag${tagHidden}">${escapeHtml(t('content_supporter_tag', undefined, 'Supporter'))}</span>
      </button>
      <button type="button" class="tsukeru-explain-btn" title="${escapeHtml(explainLabel)}"
          aria-label="${escapeHtml(explainLabel)}" aria-expanded="false">${escapeHtml(t('content_explain', undefined, 'Explain'))}</button>
      </div>`;
}

function showSupporterTag(tooltip, supporter) {
  sentenceAudioSupporter = supporter;
  tooltip?.querySelector('.tsukeru-supporter-tag')?.classList.toggle('tsukeru-hidden', supporter);
}

/** Below the sentence line: Explain's notice and where the explanation opens. */
function renderTooltipExplainPanel(sentence) {
  if (!sentence) return '';
  return `
      <div class="tsukeru-explain" data-sentence="${escapeHtml(sentence)}">
          <div class="tsukeru-explain-notice tsukeru-hidden" role="status"></div>
          <div class="tsukeru-explain-result tsukeru-hidden" aria-live="polite"></div>
      </div>`;
}

/** Ask the background (local storage only, no request) whether to show the tag. */
function refreshSupporterTag(tooltip) {
  try {
    chrome.runtime.sendMessage({ action: 'hasSupporterToken' }, (response) => {
      if (chrome.runtime.lastError || !response?.success) return;
      showSupporterTag(tooltip, response.supporter === true);
    });
  } catch (_) {
    // Extension reloaded under the page: leave the tag as it is.
  }
}

/** The clicked text when it differs from the headword: [Form] 食べなかった · negative · past. */
function renderTooltipFormLine(wordInfo, headword) {
  const surface = String(wordInfo?.surface || '').trim();
  if (!surface || surface === String(headword || '').trim()) return '';
  const inflectionText = formatInflectionLabels(wordInfo?.inflection);
  return `
      <div class="tsukeru-form-line">
          <span class="tooltip-badge tsukeru-badge-pos">${escapeHtml(t('content_form_label', undefined, 'Form'))}</span>
          <span class="tsukeru-form-surface" lang="ja">${escapeHtml(surface)}</span>${inflectionText ? `
          <span class="tsukeru-form-inflection">· ${escapeHtml(inflectionText)}</span>` : ''}
      </div>`;
}

function renderFrequencyBadge(tier) {
  const labels = {
    common: t('content_frequency_common', undefined, 'Common'),
    uncommon: t('content_frequency_uncommon', undefined, 'Uncommon'),
    rare: t('content_frequency_rare', undefined, 'Rare'),
  };
  if (!Object.prototype.hasOwnProperty.call(labels, tier)) return '';
  return `<span class="tooltip-badge tsukeru-badge-freq" data-freq="${tier}" title="${escapeHtml(t('content_frequency_title', undefined, 'How often this word appears in everyday Japanese'))}">${escapeHtml(labels[tier])}</span>`;
}

function renderTooltipHeaderHtml(wordInfo, controlsHtml = '') {
  const info = normalizeTooltipWordInfo(wordInfo);
  const { jlpt, pos, posCategory } = getTooltipMetadata(info);
  const badges = `${jlpt ? `<span class="tooltip-badge tooltip-jlpt-badge tsukeru-badge-jlpt" data-jlpt="${jlpt}">N${jlpt}</span>` : ''}${renderFrequencyBadge(String(info.freq || ''))}${pos ? `<span class="tooltip-badge tooltip-pos-badge tooltip-pos-${posCategory} tsukeru-badge-pos">${escapeHtml(pos)}</span>` : ''}`;
  const controls = controlsHtml ? `<div class="tsukeru-header-right">${controlsHtml}</div>` : '';
  return `
    <div class="tooltip-word tooltip-word-header tsukeru-header-row">
      <span class="tooltip-word-label" lang="ja">${escapeHtml(String(info.word || ''))}</span>
      ${badges}
      ${controls}
    </div>`;
}

function getTooltipLoadingHtml(wordInfo) {
  const info = normalizeTooltipWordInfo(wordInfo);
  return `
    ${renderTooltipHeaderHtml(info, `<button type="button" class="tsukeru-tooltip-close" aria-label="${escapeHtml(t('content_close', undefined, 'Close'))}">&times;</button>`)}
    <div class="tooltip-loading tooltip-loading-inline tsukeru-tooltip-loading" role="status" aria-live="polite"><span class="tooltip-loading-spinner tsukeru-loader" aria-hidden="true"></span><span>${escapeHtml(t('content_loading', undefined, 'Loading...'))}</span></div>
  `;
}

function getTooltipErrorHtml(wordInfo, message) {
  const info = normalizeTooltipWordInfo(wordInfo);
  return `
    ${renderTooltipHeaderHtml(info, `<button type="button" class="tsukeru-tooltip-close" aria-label="${escapeHtml(t('content_close', undefined, 'Close'))}">&times;</button>`)}
    <div class="tooltip-error tooltip-state-message tsukeru-tooltip-error" role="status" aria-live="polite">${escapeHtml(message)}</div>
  `;
}

function generateAltReadingsDropdown(alternativeReadings, uniqueId) {
  if (!alternativeReadings || alternativeReadings.length === 0) return '';
  const altId = `tsukeru-alt-${uniqueId}`;
  return `
    <div class="tsukeru-alt-readings-container tooltip-learning-section">
      <button type="button" class="tsukeru-alt-readings-toggle tooltip-learning-toggle" data-target="${altId}" aria-expanded="false" aria-controls="${altId}">
        <span>${escapeHtml(t('content_alt_readings_count', [String(alternativeReadings.length)], `Alt. Readings (${alternativeReadings.length})`))}</span>
        <svg class="tsukeru-alt-arrow tooltip-disclosure-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
        </svg>
      </button>
      <div id="${altId}" class="tsukeru-alt-readings-content tsukeru-hidden">
        ${alternativeReadings.map(alt => `
          <div class="tsukeru-alt-reading-item">
            <span lang="ja">${escapeHtml(alt)}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
}

// ── Definition rendering ──────────────────────────────────────────────────────

const JMDICT_SOURCE_URL = 'https://www.edrdg.org/jmdict/j_jmdict.html';

function getTextValues(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
  return [];
}

function getSafeDictionarySourceUrl(source, value) {
  if (source === 'jmdict') return JMDICT_SOURCE_URL;
  if (source !== 'je_dict' || typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.tkgje.jp' || url.username || url.password || url.search || url.hash) return '';
    return /^\/entries\/[^/]+\/[^/]+\.html$/.test(url.pathname) ? url.href : '';
  } catch (_) {
    return '';
  }
}

const EXAMPLE_ID_RE = /^[0-9]{5}_[A-Za-z0-9_-]{1,100}$/;
const SPEAKER_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7H3a1 1 0 00-1 1v4a1 1 0 001 1h2l4 3V4L5 7z"/><path d="M13.5 7.5a3 3 0 010 5"/></svg>';

function normalizeTkgjeExamples(examples, senses, definitionLang = 'en') {
  if (!Array.isArray(examples)) return;
  const valid = examples.map((example) => {
    if (!example || typeof example !== 'object') return null;
    const japanese = typeof example.japanese_ruby_html === 'string' && example.japanese_ruby_html
      ? { html: example.japanese_ruby_html }
      : typeof example.japanese_furigana_html === 'string' && example.japanese_furigana_html
        ? { html: example.japanese_furigana_html }
        : typeof example.japanese === 'string' && example.japanese.trim()
          ? { text: example.japanese }
          : null;
    const translated = definitionLang !== 'en' && typeof example.translation === 'string' ? example.translation.trim() : '';
    const english = translated || (typeof example.english === 'string' ? example.english.trim() : '');
    const translationLang = translated ? definitionLang : 'en';
    if (!japanese || (!english && definitionLang !== 'ja')) return null;
    const senseNumbers = Array.isArray(example.sense_numbers)
      ? example.sense_numbers.map(Number).filter(Number.isFinite)
      : [];
    // A recorded reading plays by example id (bg-api checks the id again).
    const id = typeof example.id === 'string' && EXAMPLE_ID_RE.test(example.id) ? example.id : '';
    return { japanese, english, translationLang, senseNumbers, audioId: example.audio === true ? id : '' };
  }).filter(Boolean);
  const unnumbered = valid.filter(example => example.senseNumbers.length === 0);
  let unnumberedIndex = 0;

  senses.forEach((sense) => {
    const forSense = Number.isFinite(sense.senseNumber)
      ? valid.filter(example => example.senseNumbers.includes(sense.senseNumber))
      : [];
    // Localized entries translate one example per sense; show that one so the
    // reader gets their own language instead of the English fallback.
    const numbered = forSense.find(example => example.translationLang !== 'en') || forSense[0] || null;
    sense.example = numbered || unnumbered[unnumberedIndex++] || null;
  });
}

function normalizeDefinitionData(data) {
  const localized = ['je_localized_cache', 'je_localized_generated'].includes(data?.source);
  const definitionLang = localized ? ({ ja: 'ja', ko: 'ko', 'zh-Hant': 'zh-TW' }[data.locale] || 'en') : 'en';
  const richEntry = (data?.source === 'je_dict' || localized) && data.entry && typeof data.entry === 'object'
    ? data.entry
    : null;
  if (richEntry) {
    const senses = [];
    const byGloss = new Map();
    const addSense = (gloss, explanation = '', senseNumber = null) => {
      const cleanedGloss = String(gloss || '').trim();
      if (!cleanedGloss) return;
      const key = cleanedGloss.toLocaleLowerCase();
      const existing = byGloss.get(key);
      if (existing) {
        if (!existing.explanation && explanation) existing.explanation = explanation;
        if (!Number.isFinite(existing.senseNumber) && Number.isFinite(senseNumber)) existing.senseNumber = senseNumber;
        return;
      }
      const sense = { glosses: [cleanedGloss], pos: [], explanation: String(explanation || '').trim(), senseNumber };
      byGloss.set(key, sense);
      senses.push(sense);
    };
    getTextValues(richEntry.gloss).forEach(gloss => addSense(gloss));
    if (Array.isArray(richEntry.definitions)) {
      richEntry.definitions.forEach((definition) => {
        if (!definition || typeof definition !== 'object') return;
        const explanation = getTextValues(definition.explanation)[0] || '';
        const senseNumber = Number(definition.sense_number);
        getTextValues(definition.gloss).forEach(gloss => addSense(gloss, explanation, Number.isFinite(senseNumber) ? senseNumber : null));
      });
    }
    const trimmed = senses.slice(0, 6);
    if (trimmed.length > 0) {
      normalizeTkgjeExamples(richEntry.examples, trimmed, definitionLang);
      return {
        source: 'je_dict',
        definitionLang,
        localized,
        senses: trimmed,
        reading: String(richEntry.reading || '').trim(),
        headerPos: String((localized && Array.isArray(richEntry.pos) ? richEntry.pos.join(', ') : '') || richEntry.part_of_speech || (Array.isArray(richEntry.pos_tags) ? richEntry.pos_tags.join(', ') : '')).trim(),
        sourceUrl: getSafeDictionarySourceUrl('je_dict', richEntry.source_url),
        hasAttachedExamples: trimmed.some(sense => Boolean(sense.example))
      };
    }
  }

  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return null;
  const entry = data.entries[0];
  const senses = Array.isArray(entry.senses) ? entry.senses : [];
  const trimmed = [];
  for (const sense of senses) {
    const glosses = Array.isArray(sense.glosses) ? sense.glosses.filter(Boolean) : [];
    if (!glosses.length) continue;
    trimmed.push({
      glosses: glosses.slice(0, 3),
      pos: Array.isArray(sense.pos) ? sense.pos.slice(0, 3) : []
    });
    if (trimmed.length >= 6) break;
  }
  return {
    source: 'jmdict',
    senses: trimmed,
    reading: Array.isArray(entry.kana) && entry.kana.length ? entry.kana.join('、') : '',
    sourceUrl: getSafeDictionarySourceUrl('jmdict')
  };
}

function appendAttachedExamples(tooltip, senses) {
  if (!tooltip || !Array.isArray(senses) || typeof document === 'undefined') return;
  tooltip.querySelectorAll('.tsukeru-sense-attached-example').forEach((container) => {
    const index = Number(container.dataset.senseIndex);
    const example = senses[index]?.example;
    if (!example) return;
    const item = document.createElement('div');
    item.className = 'tsukeru-example-item';
    const japanese = document.createElement('div');
    japanese.className = 'tsukeru-example-jp';
    japanese.lang = 'ja';
    if (example.japanese.html) japanese.appendChild(sanitizeHtmlFragment(example.japanese.html));
    else japanese.textContent = example.japanese.text || '';
    if (example.audioId) {
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'tooltip-audio-btn tsukeru-tooltip-speaker tsukeru-example-audio';
      play.dataset.exampleId = example.audioId;
      const label = t('content_play_example', undefined, 'Play example sentence');
      play.title = label;
      play.setAttribute('aria-label', label);
      play.innerHTML = SPEAKER_ICON_SVG;
      play.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!event.isTrusted) return;
        playSupporterAudio(play, { action: 'playExample', exampleId: play.dataset.exampleId });
      });
      japanese.append(play);
    }
    const english = document.createElement('div');
    english.className = 'tsukeru-example-en';
    english.lang = example.translationLang || 'en';
    if (example.translationLang && example.translationLang !== 'en') appendDictionaryRubyText(english, `- ${example.english}`);
    else english.textContent = `- ${example.english}`;
    item.append(japanese);
    if (example.english) item.append(english);
    container.replaceChildren(item);
  });
}

function renderDefinitionTooltip(tooltip, wordInfo, data) {
  if (data?.error) {
    tooltip.innerHTML = getTooltipErrorHtml(
      wordInfo,
      t('content_dictionary_unavailable', undefined, 'Dictionary not available')
    );
    addTooltipInteractionHandlers();
    return;
  }

  const normalized = normalizeDefinitionData(data);
  if (!normalized || normalized.senses.length === 0) {
    tooltip.innerHTML = getTooltipErrorHtml(
      wordInfo,
      t('content_no_definition_found', undefined, 'No definition found')
    );
    addTooltipInteractionHandlers();
    return;
  }

  const headerWordInfo = normalized.headerPos ? { ...wordInfo, pos: normalized.headerPos } : wordInfo;
  const readingText = String(wordInfo.reading || normalized.reading || '');
  const displayWord = wordInfo.word;
  let html = renderTooltipHeaderHtml(headerWordInfo, `
    <button type="button" class="tooltip-close tsukeru-tooltip-close" aria-label="${escapeHtml(t('content_close', undefined, 'Close'))}">&times;</button>
  `);

  html += `
      <div class="tooltip-reading-row tsukeru-reading-row">
          <div class="tooltip-reading tsukeru-reading-text" lang="ja">${renderTooltipReadingWithPitch(readingText, wordInfo.accent)}</div>
          <div class="tooltip-reading-actions tsukeru-reading-actions">
              <button type="button" class="tooltip-audio-btn tsukeru-tooltip-speaker"
                  aria-label="${escapeHtml(t('content_play_pronunciation', undefined, 'Play pronunciation'))}"
                  data-reading="${escapeHtml(readingText)}"
                  data-word="${escapeHtml(displayWord)}"
                  title="${escapeHtml(t('content_play_pronunciation', undefined, 'Play pronunciation'))}">
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M5 7H3a1 1 0 00-1 1v4a1 1 0 001 1h2l4 3V4L5 7z"/>
                      <path d="M13.5 7.5a3 3 0 010 5"/>
                  </svg>
              </button>
              <button type="button" class="tooltip-report-btn tsukeru-tooltip-report-btn"
                  aria-label="${escapeHtml(t('content_report_wrong_reading', undefined, 'Report wrong reading'))}"
                  data-reading="${escapeHtml(readingText)}"
                  data-word="${escapeHtml(displayWord)}"
                  title="${escapeHtml(t('content_report_wrong_reading', undefined, 'Report wrong reading'))}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
                      <line x1="4" y1="22" x2="4" y2="15"></line>
                  </svg>
              </button>
          </div>
      </div>`;

  html += renderTooltipFormLine(wordInfo, displayWord);
  const sentenceWord = String(wordInfo.surface || displayWord || '');
  const tooltipSentence = tooltip._activeRuby ? plainWordSentence(tooltip._activeRuby, sentenceWord) : '';
  html += renderTooltipSentenceLine(tooltipSentence, sentenceWord);
  html += renderTooltipExplainPanel(tooltipSentence);

  const kanjiCount = countTooltipKanji(displayWord);
  if (kanjiCount > 0) html += renderTooltipTabsHtml(kanjiCount);
  html += `<div class="tsukeru-tab-panel" role="tabpanel" data-tab-panel="meaning">`;

  // DICTIONARY_MAX_SENSES is a const from content-dom.js; the rest sit behind "+N more".
  const senses = normalized.senses;
  senses.forEach((sense, index) => {
    const gloss = (sense.glosses || []).join('; ');
    if (!gloss) return;

    const extraClass = index >= DICTIONARY_MAX_SENSES ? ' tsukeru-hidden tsukeru-extra-sense' : '';
    html += `<div class="tooltip-sense tooltip-definition-sense tsukeru-sense-row${extraClass}" lang="${normalized.definitionLang || 'en'}">`;
    if (sense.pos && sense.pos.length) {
      html += `<div class="tooltip-pos tsukeru-sense-pos">${escapeHtml(sense.pos.slice(0, 2).join(', '))}</div>`;
    }
    html += `<div class="tooltip-gloss tooltip-definition-gloss tsukeru-sense-gloss">${escapeHtml(gloss)}</div>`;
    if (sense.explanation) {
      html += `<div class="tsukeru-sense-explanation">${escapeHtml(sense.explanation)}</div>`;
    }
    if (sense.example) {
      html += `<div class="tsukeru-sense-attached-example" data-sense-index="${index}"></div>`;
    }
    html += `</div>`;
  });

  if (senses.length > DICTIONARY_MAX_SENSES) {
    const moreCount = String(senses.length - DICTIONARY_MAX_SENSES);
    html += `<button type="button" class="tsukeru-sense-more-toggle" aria-expanded="false">${escapeHtml(t('content_more_count', [moreCount], `+${moreCount} more`))}</button>`;
  }

  // Same order as the website card (docs/dictionary-popup.md in the website repo).
  if (!normalized.hasAttachedExamples) {
    html += getAsyncSectionHtml('example', 'tsukeru-example-container', t('content_example_section', undefined, 'Example sentence'));
  }

  html += generateAltReadingsDropdown(wordInfo.altReadings, Date.now());

  if (normalized.sourceUrl) {
    const sourceName = normalized.source === 'je_dict' ? 'TKGJE' : 'JMdict';
    html += `<div class="tsukeru-dictionary-source"><span>${escapeHtml(t('utility_source', undefined, 'Source'))}: </span><a href="${escapeHtml(normalized.sourceUrl)}" target="_blank" rel="noopener noreferrer">${sourceName}</a></div>`;
  }
  html += `</div>`;
  if (kanjiCount > 0) {
    html += `<div id="tsukeru-kanji-container" class="tsukeru-tab-panel tsukeru-kanji-panel tsukeru-hidden" role="tabpanel" data-tab-panel="kanji" data-section="kanji" data-state="idle" aria-live="polite"></div>`;
  }

  tooltip.innerHTML = html;
  if (normalized.localized) {
    tooltip.querySelectorAll('.tsukeru-sense-gloss, .tsukeru-sense-explanation').forEach(element => {
      appendDictionaryRubyText(element, element.textContent);
    });
  }
  appendAttachedExamples(tooltip, senses);
  const moreToggle = tooltip.querySelector('.tsukeru-sense-more-toggle');
  if (moreToggle) {
    moreToggle.onclick = (event) => {
      event.stopPropagation();
      tooltip.querySelectorAll('.tsukeru-extra-sense').forEach((row) => row.classList.remove('tsukeru-hidden'));
      moreToggle.remove();
    };
  }
  bindTooltipTabs(tooltip);
  tooltip.classList.add('show');
  addTooltipInteractionHandlers({ word: displayWord, reading: readingText });
  requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
}

const TOOLTIP_KANJI_RE = /[㐀-䶿一-鿿豈-﫿]/;

function countTooltipKanji(text) {
  return Array.from(String(text || '')).filter((ch) => TOOLTIP_KANJI_RE.test(ch)).length;
}

function renderTooltipTabsHtml(kanjiCount) {
  return `
      <div class="tsukeru-tabs" role="tablist">
          <button type="button" class="tsukeru-tab" role="tab" data-tab="meaning" aria-selected="true">${escapeHtml(t('content_tab_meaning', undefined, 'Meaning'))}</button>
          <button type="button" class="tsukeru-tab" role="tab" data-tab="kanji" aria-selected="false" tabindex="-1">${escapeHtml(t('content_tab_kanji', undefined, 'Kanji'))} <span class="tsukeru-tab-count">${kanjiCount}</span></button>
      </div>`;
}

function selectTooltipTab(tooltip, name) {
  tooltip.querySelectorAll('.tsukeru-tab').forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  tooltip.querySelectorAll('.tsukeru-tab-panel').forEach((panel) => {
    panel.classList.toggle('tsukeru-hidden', panel.dataset.tabPanel !== name);
  });
  const kanjiPanel = tooltip.querySelector('.tsukeru-kanji-panel');
  if (name === 'kanji' && kanjiPanel?.dataset.state === 'idle') {
    loadKanjiBreakdown(tooltip.dataset.word);
  }
  requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
}

function bindTooltipTabs(tooltip) {
  const tabs = Array.from(tooltip.querySelectorAll('.tsukeru-tab'));
  tabs.forEach((tab, index) => {
    tab.onclick = (event) => {
      event.stopPropagation();
      selectTooltipTab(tooltip, tab.dataset.tab);
    };
    tab.onkeydown = (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTooltipTab(tooltip, next.dataset.tab);
      next.focus();
    };
  });
}

function getAsyncSectionHtml(sectionName, containerId, label) {
  const toggleClass = 'tsukeru-example-toggle';
  const contentClass = 'tsukeru-example-content';
  return `
    <div id="${containerId}" class="tsukeru-async-section tooltip-learning-section" data-section="${sectionName}" data-state="idle" data-expanded="false">
      <button type="button" class="${toggleClass} tsukeru-dropdown-toggle tooltip-learning-toggle" aria-expanded="false" aria-controls="${containerId}-content">
        <span>${escapeHtml(label)}</span>
        <svg class="tsukeru-dropdown-arrow tooltip-disclosure-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
      </button>
      <div id="${containerId}-content" class="${contentClass} tsukeru-dropdown-content tsukeru-hidden" role="region" aria-live="polite"></div>
    </div>`;
}

// ── Dictionary lookup ─────────────────────────────────────────────────────────

function getDefinitionCacheKey(word, lookupReading = '', readingType = '') {
  return JSON.stringify([
    String(word || '').trim(),
    String(lookupReading || '').trim(),
    String(readingType || '').trim().toLowerCase()
  ]);
}

const CONTENT_DEFINITION_CACHE_MAX_ENTRIES = 100;
const CONTENT_DEFINITION_CACHE_TTL = 5 * 60 * 1000;

function clearDefinitionCaches() {
  definitionCacheGeneration += 1;
  definitionCache.clear();
  definitionPendingCache.clear();
}

function evictCompletedDefinitionCacheEntries() {
  const now = Date.now();
  for (const [key, entry] of definitionCache.entries()) {
    if (now - entry.timestamp >= CONTENT_DEFINITION_CACHE_TTL) definitionCache.delete(key);
  }
  while (definitionCache.size > CONTENT_DEFINITION_CACHE_MAX_ENTRIES) {
    const oldestKey = definitionCache.keys().next().value;
    if (oldestKey === undefined) break;
    definitionCache.delete(oldestKey);
  }
}

async function lookupDefinition(word, lookupReading = '', readingType = '') {
  // definitionCache is a var global from content-main.js
  const key = (word || '').trim();
  if (!key) return null;
  const normalizedReading = String(lookupReading || '').trim();
  const normalizedReadingType = String(readingType || '').trim().toLowerCase();
  const cacheKey = getDefinitionCacheKey(key, normalizedReading, normalizedReadingType);

  const cached = definitionCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.timestamp < CONTENT_DEFINITION_CACHE_TTL) return cached.data;
    definitionCache.delete(cacheKey);
  }

  const sharedRequest = definitionPendingCache.get(cacheKey);
  if (sharedRequest) return sharedRequest;

  const message = { action: 'lookupDefinition', word: key };
  if (normalizedReading) message.reading = normalizedReading;
  if (normalizedReadingType) message.readingType = normalizedReadingType;
  const cacheGeneration = definitionCacheGeneration;
  const promise = chrome.runtime.sendMessage(message)
    .then((response) => {
      if (response?.success && response.data) {
        if (definitionCacheGeneration === cacheGeneration) {
          definitionCache.set(cacheKey, { data: response.data, timestamp: Date.now() });
          evictCompletedDefinitionCacheEntries();
        }
        if (definitionPendingCache.get(cacheKey) === promise) definitionPendingCache.delete(cacheKey);
        return response.data;
      }
      throw createRuntimeResponseError(response, 'Lookup failed');
    })
    .catch((error) => {
      if (definitionPendingCache.get(cacheKey) === promise) definitionPendingCache.delete(cacheKey);
      throw error;
    });

  definitionPendingCache.set(cacheKey, promise);
  return promise;
}

// ── Audio / TTS ───────────────────────────────────────────────────────────────

function speakWord(word, reading, buttonElement) {
  if (!word) return;
  if (buttonElement) buttonElement.classList.add('speaking');

  chrome.runtime.sendMessage({ action: 'playAudio', word, reading }, (response) => {
    if (!response?.success || !response.dataUrl) {
      if (buttonElement) buttonElement.classList.remove('speaking');
      fallbackTTS(word, buttonElement);
      return;
    }
    // Reject non-audio data URLs to prevent polyglot injection via compromised backend.
    if (!response.dataUrl.startsWith('data:audio/')) {
      if (buttonElement) buttonElement.classList.remove('speaking');
      fallbackTTS(word, buttonElement);
      return;
    }
    const audio = new Audio(response.dataUrl);
    audio.onended = () => { if (buttonElement) buttonElement.classList.remove('speaking'); };
    audio.onerror = () => {
      if (buttonElement) buttonElement.classList.remove('speaking');
      fallbackTTS(word, buttonElement);
    };
    audio.play().catch(() => {
      if (buttonElement) buttonElement.classList.remove('speaking');
      fallbackTTS(word, buttonElement);
    });
  });
}

function sentenceAudioMessage(code) {
  return TsukeruUiMessages.sentenceAudioMessage(code, t);
}

/** Read the sentence shown on the "Play sentence" line with Supporter audio. */
function speakSentence(buttonElement) {
  const sentence = buttonElement.dataset.sentence || '';
  if (!sentence) return;
  playSupporterAudio(buttonElement, { action: 'playSentence', text: sentence });
}

/** Play a Supporter clip (a sentence, or a recorded example) and explain a refusal. */
function playSupporterAudio(buttonElement, message) {
  if (buttonElement.classList.contains('speaking')) return;
  buttonElement.classList.add('speaking');
  const done = () => buttonElement.classList.remove('speaking');
  chrome.runtime.sendMessage(message, (response) => {
    // Reject non-audio data URLs to prevent polyglot injection via compromised backend.
    if (!response?.success || typeof response.dataUrl !== 'string' || !response.dataUrl.startsWith('data:audio/')) {
      done();
      if (response?.error === 'supporter_required') showSupporterTag(dictionaryTooltip, false);
      showToast(sentenceAudioMessage(response?.error), { type: response?.error === 'supporter_required' ? 'info' : 'error' });
      return;
    }
    showSupporterTag(dictionaryTooltip, true);
    const audio = new Audio(response.dataUrl);
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

// ── Explain (Supporters) ──────────────────────────────────────────────────────

const EXPLAIN_NOTICE_KEY = 'explainNoticeSeen';
const MAX_SHOWN_EXPLANATIONS = 30;
// Explanations shown on this page, by language and sentence, so reopening a word does not ask again.
const shownExplanations = new Map();

function askBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? null : response));
    } catch (_) {
      // Extension reloaded under the page.
      resolve(null);
    }
  });
}

function explainTextElement(tag, className, text, lang) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  if (lang) node.setAttribute('lang', lang);
  return node;
}

/** Fill `box` with an explanation: the translation, the points, the note, and the AI line. */
function renderTooltipExplanation(box, explanation, language) {
  box.setAttribute('lang', language);
  box.replaceChildren(explainTextElement('p', 'tsukeru-explain-translation', explanation.translation));
  if (explanation.points.length) {
    const list = document.createElement('ul');
    list.className = 'tsukeru-explain-points';
    explanation.points.forEach((point) => {
      const item = document.createElement('li');
      item.append(
        explainTextElement('span', 'tsukeru-explain-piece', point.japanese, 'ja'),
        explainTextElement('span', 'tsukeru-explain-text', point.explanation),
      );
      list.append(item);
    });
    box.append(list);
  }
  if (explanation.note) box.append(explainTextElement('p', 'tsukeru-explain-note', explanation.note));
  box.append(explainTextElement('p', 'tsukeru-explain-ai', t('content_explain_ai_note', undefined, 'Written by AI. It can contain mistakes.')));
  box.classList.remove('tsukeru-hidden');
}

async function explainNoticeSeen() {
  try {
    const stored = await chrome.storage.local.get({ [EXPLAIN_NOTICE_KEY]: false });
    return stored[EXPLAIN_NOTICE_KEY] === true;
  } catch (_) {
    return false;
  }
}

/** The first-use notice with its Continue button; resolves when it is pressed. */
function confirmExplainNotice(notice) {
  return new Promise((resolve) => {
    const proceed = explainTextElement('button', 'tsukeru-explain-continue', t('content_explain_continue', undefined, 'Continue'));
    proceed.type = 'button';
    proceed.onclick = (event) => {
      event.stopPropagation();
      if (!event.isTrusted) return;
      chrome.storage.local.set({ [EXPLAIN_NOTICE_KEY]: true }).catch(() => {});
      notice.classList.add('tsukeru-hidden');
      resolve();
    };
    notice.replaceChildren(
      explainTextElement('p', '', t(
        'content_explain_notice',
        undefined,
        'This sentence will be sent to OpenAI to write the explanation, and OpenAI may use it to improve its models.'
      )),
      proceed,
    );
    notice.classList.remove('tsukeru-hidden');
  });
}

/** Wire "Explain" for a freshly rendered tooltip: toggle a shown explanation, or ask for one. */
function bindSentenceExplain(tooltip, button) {
  const panel = tooltip.querySelector('.tsukeru-explain');
  const notice = panel?.querySelector('.tsukeru-explain-notice');
  const result = panel?.querySelector('.tsukeru-explain-result');
  if (!panel || !notice || !result) return;
  const sentence = panel.dataset.sentence || '';
  const language = TsukeruI18n.language();
  const key = `${language}\n${sentence}`;
  const open = (box, toggle, explanation) => {
    renderTooltipExplanation(box, explanation, language);
    toggle.setAttribute('aria-expanded', 'true');
  };
  if (shownExplanations.has(key)) open(result, button, shownExplanations.get(key));

  button.onclick = async (event) => {
    event.stopPropagation();
    if (!event.isTrusted || button.disabled) return;
    notice.classList.add('tsukeru-hidden');
    if (!result.classList.contains('tsukeru-hidden')) {
      result.classList.add('tsukeru-hidden');
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    if (result.childElementCount) {
      result.classList.remove('tsukeru-hidden');
      button.setAttribute('aria-expanded', 'true');
      return;
    }
    const refuse = (code) => {
      if (code === 'supporter_required') showSupporterTag(dictionaryTooltip, false);
      showToast(TsukeruUiMessages.explainMessage(code, t), { type: code === 'supporter_required' ? 'info' : 'error' });
    };
    // Without a Supporter token nothing is sent, so the notice is not shown either.
    const token = await askBackground({ action: 'hasSupporterToken' });
    if (token?.success && token.supporter !== true) {
      refuse('supporter_required');
      return;
    }
    if (!(await explainNoticeSeen())) await confirmExplainNotice(notice);
    button.disabled = true;
    const idle = button.textContent;
    button.textContent = t('content_explain_working', undefined, 'Explaining…');
    const response = await askBackground({ action: 'explainSentence', text: sentence, language });
    button.disabled = false;
    button.textContent = idle;
    if (!response?.success || !response.explanation) {
      refuse(response?.error);
      return;
    }
    shownExplanations.delete(key);
    shownExplanations.set(key, response.explanation);
    while (shownExplanations.size > MAX_SHOWN_EXPLANATIONS) shownExplanations.delete(shownExplanations.keys().next().value);
    showSupporterTag(dictionaryTooltip, true);
    if (panel.isConnected) {
      open(result, button, response.explanation);
      return;
    }
    // The tooltip re-rendered while waiting: show it in the panel that replaced this one.
    const live = [...(dictionaryTooltip?.querySelectorAll('.tsukeru-explain') || [])]
      .find((candidate) => candidate.dataset.sentence === sentence);
    const box = live?.querySelector('.tsukeru-explain-result');
    const toggle = dictionaryTooltip?.querySelector('.tsukeru-explain-btn');
    if (box && toggle) open(box, toggle, response.explanation);
  };
}

function fallbackTTS(word, buttonElement) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'ja-JP';
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.onend = () => { if (buttonElement) buttonElement.classList.remove('speaking'); };
    utterance.onerror = () => { if (buttonElement) buttonElement.classList.remove('speaking'); };
    window.speechSynthesis.speak(utterance);
  } else {
    if (buttonElement) buttonElement.classList.remove('speaking');
  }
}

// ── Async tooltip sections ────────────────────────────────────────────────────

function getAsyncSectionLabel() {
  return t('content_example_section', undefined, 'Example sentence');
}

function renderAsyncLoading(container) {
  const content = container?.querySelector('.tsukeru-dropdown-content');
  if (!content) return;
  container.dataset.state = 'loading';
  content.innerHTML = `<div class="tooltip-loading tooltip-loading-inline tsukeru-async-loading" role="status" aria-live="polite"><span class="tooltip-loading-spinner tsukeru-loader" aria-hidden="true"></span><span>${escapeHtml(t('content_loading', undefined, 'Loading...'))}</span></div>`;
  content.classList.toggle('tsukeru-hidden', container.dataset.expanded !== 'true');
}

function updateAsyncSectionContent(tooltip, container, state, label, contentValue) {
  if (!container || !container.isConnected) return;
  const toggle = container.querySelector('.tsukeru-dropdown-toggle');
  const content = container.querySelector('.tsukeru-dropdown-content');
  if (!toggle || !content) return;

  const labelElement = toggle.querySelector('span');
  if (labelElement) labelElement.textContent = label;
  container.dataset.state = state;
  if (typeof contentValue === 'string') {
    content.innerHTML = contentValue;
  } else {
    content.replaceChildren();
    if (contentValue?.nodeType) content.appendChild(contentValue);
  }
  setTooltipSectionExpanded(container, container.dataset.expanded === 'true');
  requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
}

function createExampleSentenceContent(data) {
  const fragment = document.createDocumentFragment();
  const item = document.createElement('div');
  item.className = 'tsukeru-example-item';

  const japanese = document.createElement('div');
  japanese.className = 'tsukeru-example-jp';
  japanese.lang = 'ja';
  japanese.appendChild(sanitizeHtmlFragment(data?.japanese_furigana_html || ''));

  const english = document.createElement('div');
  english.className = 'tsukeru-example-en';
  english.lang = 'en';
  english.textContent = `- ${String(data?.english || '')}`;

  item.append(japanese, english);
  fragment.appendChild(item);
  return fragment;
}

function renderAsyncUnavailable(tooltip, container, message) {
  if (!container || !container.isConnected) return;
  const label = getAsyncSectionLabel(container.dataset.section);
  updateAsyncSectionContent(
    tooltip,
    container,
    message ? 'error' : 'empty',
    label,
    `<div class="tsukeru-async-unavailable">${escapeHtml(t('content_section_unavailable', undefined, 'Not available right now'))}</div>`
  );
}

async function loadExampleSentence(word) {
  const tooltip = ensureDictionaryTooltip();
  const container = document.getElementById('tsukeru-example-container');
  const coordinator = tooltip._asyncCoordinator;
  if (!container || !coordinator || !word) return;
  renderAsyncLoading(container);
  const requestVersion = tooltip._lookupVersion;
  return coordinator.open('example', async () => {
    const response = await chrome.runtime.sendMessage({ action: 'fetchExampleSentence', word });
    if (!response?.success) {
      throw createRuntimeResponseError(response, 'Example sentence lookup failed');
    }
    return response?.success && response.data?.japanese ? response.data : null;
  }, {
    onSuccess: (data) => {
      if (!isCurrentTooltipLookup(tooltip, requestVersion, word)) return;
      if (!data) {
        renderAsyncUnavailable(tooltip, container, false);
        return;
      }
      updateAsyncSectionContent(
        tooltip,
        container,
        'loaded',
        t('content_example_sentence_count', ['1'], 'Example Sentence (1)'),
        createExampleSentenceContent(data)
      );
    },
    onError: (error) => {
      if (!isCurrentTooltipLookup(tooltip, requestVersion, word)) return;
      console.warn('Tsukeru: example enrichment failed', error);
      if (error?.rateLimitType || error?.errorCode === 'service_unavailable') {
        showRateLimitToast(error.errorCode === 'service_unavailable' ? 'service_unavailable' : (error.rateLimitType || 'service_unavailable'), error.retryAfter, error.retryAt, 'examples');
      }
      renderAsyncUnavailable(tooltip, container, true);
    }
  });
}

function renderTooltipPanelLoading() {
  return `<div class="tooltip-loading tooltip-loading-inline tsukeru-async-loading" role="status" aria-live="polite"><span class="tooltip-loading-spinner tsukeru-loader" aria-hidden="true"></span><span>${escapeHtml(t('content_loading_kanji', undefined, 'Loading kanji...'))}</span></div>`;
}

function formatTooltipKanjiGrade(grade) {
  const value = Number.parseInt(grade, 10);
  if (value >= 1 && value <= 6) return t('content_kanji_grade', [String(value)], `Grade ${value}`);
  if (value === 7) return t('content_kanji_junior_high', undefined, 'Junior high');
  return '';
}

/** Kanji tab content, matching the website's renderKanjiPanel. */
function renderKanjiPanelHtml(data) {
  const characters = (Array.isArray(data?.characters) ? data.characters : [])
    .filter((item) => item && typeof item.character === 'string' && item.character);
  const chips = characters.length > 1 ? `
      <div class="tsukeru-kanji-chips">${characters.map((item, index) => `
          <button type="button" class="tsukeru-kanji-chip" data-kanji-index="${index}" aria-pressed="${index === 0}" lang="ja">${escapeHtml(item.character)}</button>`).join('')}
      </div>` : '';
  const details = characters.map((item, index) => {
    const level = Number(item.jlpt_level) || 0;
    const strokes = Number.parseInt(item.stroke_count, 10);
    const facts = [
      level >= 1 && level <= 5 ? `N${level}` : '',
      formatTooltipKanjiGrade(item.grade),
      strokes > 0 ? t('content_kanji_strokes', [String(strokes)], `${strokes} strokes`) : '',
    ].filter(Boolean);
    const onReadings = Array.isArray(item.on_readings) ? item.on_readings.slice(0, 4).join('、') : '';
    const kunReadings = Array.isArray(item.kun_readings) ? item.kun_readings.slice(0, 4).join('、') : '';
    const meanings = Array.isArray(item.meanings) ? item.meanings.slice(0, 4).join('; ') : '';
    const examples = (Array.isArray(item.examples) ? item.examples : [])
      .filter((example) => example && example.word)
      .slice(0, 3);
    return `
      <section class="tsukeru-kanji-detail${index === 0 ? '' : ' tsukeru-hidden'}" data-kanji-index="${index}">
          <div class="tsukeru-kanji-main">
              <div class="tsukeru-kanji-figure"><span class="tsukeru-kanji-glyph" lang="ja">${escapeHtml(item.character)}</span></div>
              <div class="tsukeru-kanji-facts">
                  ${facts.length ? `<div class="tsukeru-kanji-meta">${escapeHtml(facts.join(' · '))}</div>` : ''}
                  ${onReadings ? `<div class="tsukeru-kanji-reading" lang="ja"><span class="tsukeru-on-label">音</span> ${escapeHtml(onReadings)}</div>` : ''}
                  ${kunReadings ? `<div class="tsukeru-kanji-reading" lang="ja"><span class="tsukeru-kun-label">訓</span> ${escapeHtml(kunReadings)}</div>` : ''}
                  ${meanings ? `<div class="tsukeru-kanji-meaning" lang="en">${escapeHtml(meanings)}</div>` : ''}
              </div>
          </div>
          ${examples.length ? `
          <ul class="tsukeru-kanji-examples">${examples.map((example) => `
              <li><span class="tsukeru-kanji-example-word" lang="ja">${escapeHtml(example.word)}</span>${example.reading ? ` <span class="tsukeru-kanji-example-reading" lang="ja">${escapeHtml(example.reading)}</span>` : ''}${example.meaning ? ` <span class="tsukeru-kanji-example-meaning" lang="en">${escapeHtml(example.meaning)}</span>` : ''}</li>`).join('')}
          </ul>` : ''}
      </section>`;
  }).join('');
  const attribution = characters.some((item) => tooltipStrokePaths(item).length > 0)
    ? `
      <div class="tsukeru-stroke-attribution">${escapeHtml(t('content_stroke_order_data', undefined, 'Stroke order data:'))} <a href="${KANJIVG_URL}" target="_blank" rel="noopener noreferrer">KanjiVG</a> (CC BY-SA 3.0)</div>`
    : '';
  return chips + details + attribution;
}

// KanjiVG stroke paths from the website's kanji-breakdown: 109×109 canvas, stroke order.
const STROKE_PATH_RE = /^[MmCcSsLlHhVvZzQqTt0-9.,\- ]{1,4000}$/;
const STROKE_START_RE = /^M\s*(-?[\d.]+)[\s,]*(-?[\d.]+)/;
const SVG_NS = 'http://www.w3.org/2000/svg';
const KANJIVG_URL = 'https://kanjivg.tagaini.net';

function tooltipStrokePaths(item) {
  const strokes = Array.isArray(item?.strokes) ? item.strokes : [];
  if (strokes.length === 0 || strokes.length > 64) return [];
  return strokes.every((path) => typeof path === 'string' && STROKE_PATH_RE.test(path)) ? strokes : [];
}

function createSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function tooltipPrefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

/** Same diagram and controls as the website's mountStrokeDiagrams, built with DOM APIs. */
function buildStrokeDiagram(item) {
  const paths = tooltipStrokePaths(item);
  const svg = createSvgElement('svg', {
    class: 'tsukeru-stroke-svg',
    viewBox: '0 0 109 109',
    role: 'img',
    'aria-label': t('content_stroke_order_of', [item.character], `Stroke order of ${item.character}`),
  });
  svg.append(
    createSvgElement('line', { class: 'tsukeru-stroke-grid', x1: 54.5, y1: 0, x2: 54.5, y2: 109 }),
    createSvgElement('line', { class: 'tsukeru-stroke-grid', x1: 0, y1: 54.5, x2: 109, y2: 54.5 }),
  );
  const strokes = paths.map((d) => {
    const path = createSvgElement('path', { class: 'tsukeru-stroke', d });
    svg.append(path);
    return path;
  });
  const number = createSvgElement('text', { class: 'tsukeru-stroke-number' });
  svg.append(number);

  const controls = document.createElement('div');
  controls.className = 'tsukeru-stroke-controls';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'tsukeru-stroke-btn';
  const step = document.createElement('button');
  step.type = 'button';
  step.className = 'tsukeru-stroke-btn';
  const nextLabel = t('content_next_stroke', undefined, 'Next stroke');
  step.setAttribute('aria-label', nextLabel);
  step.title = nextLabel;
  step.textContent = '→';
  const counter = document.createElement('span');
  counter.className = 'tsukeru-stroke-counter';
  controls.append(play, step, counter);

  let shown = strokes.length;
  let timer = null;

  const draw = (current) => {
    strokes.forEach((path, index) => {
      path.classList.toggle('tsukeru-stroke-drawn', index < shown);
      path.classList.toggle('tsukeru-stroke-current', index === current);
    });
    const start = current >= 0 ? STROKE_START_RE.exec(paths[current]) : null;
    number.textContent = start ? String(current + 1) : '';
    if (start) {
      number.setAttribute('x', String(Math.max(4, Number(start[1]) - 7)));
      number.setAttribute('y', String(Math.max(9, Number(start[2]) - 3)));
    }
    counter.textContent = `${shown} / ${strokes.length}`;
  };
  const setPlaying = (playing) => {
    play.textContent = playing ? '❚❚' : '▶';
    const label = playing
      ? t('content_pause_strokes', undefined, 'Pause')
      : t('content_play_strokes', undefined, 'Play stroke order');
    play.setAttribute('aria-label', label);
    play.title = label;
  };
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    setPlaying(false);
  };
  const clearDashes = () => strokes.forEach((path) => {
    path.style.strokeDasharray = '';
    path.style.strokeDashoffset = '';
  });
  const animateStroke = (path) => {
    if (tooltipPrefersReducedMotion() || typeof path.getTotalLength !== 'function') return;
    const length = path.getTotalLength();
    path.style.transition = 'none';
    path.style.strokeDasharray = String(length);
    path.style.strokeDashoffset = String(length);
    path.getBoundingClientRect();
    path.style.transition = '';
    path.style.strokeDashoffset = '0';
  };
  const playNext = () => {
    if (!svg.isConnected || shown >= strokes.length) {
      stop();
      draw(-1);
      return;
    }
    shown += 1;
    draw(shown - 1);
    animateStroke(strokes[shown - 1]);
    timer = setTimeout(playNext, tooltipPrefersReducedMotion() ? 350 : 650);
  };

  play.addEventListener('click', (event) => {
    event.stopPropagation();
    if (timer !== null) {
      stop();
      return;
    }
    clearDashes();
    shown = 0;
    setPlaying(true);
    playNext();
  });
  step.addEventListener('click', (event) => {
    event.stopPropagation();
    stop();
    clearDashes();
    shown = shown >= strokes.length ? 1 : shown + 1;
    draw(shown - 1);
  });

  setPlaying(false);
  draw(-1);
  return { svg, controls };
}

function mountStrokeDiagrams(panel, data) {
  const characters = (Array.isArray(data?.characters) ? data.characters : [])
    .filter((item) => item && typeof item.character === 'string' && item.character);
  panel.querySelectorAll('.tsukeru-kanji-detail').forEach((detail) => {
    const item = characters[Number(detail.dataset.kanjiIndex)];
    const figure = detail.querySelector('.tsukeru-kanji-figure');
    if (!item || !figure || tooltipStrokePaths(item).length === 0) return;
    const { svg, controls } = buildStrokeDiagram(item);
    figure.replaceChildren(svg, controls);
  });
}

function bindKanjiChips(tooltip, panel) {
  panel.querySelectorAll('.tsukeru-kanji-chip').forEach((chip) => {
    chip.onclick = (event) => {
      event.stopPropagation();
      const index = chip.dataset.kanjiIndex;
      panel.querySelectorAll('.tsukeru-kanji-chip').forEach((other) => {
        other.setAttribute('aria-pressed', String(other === chip));
      });
      panel.querySelectorAll('.tsukeru-kanji-detail').forEach((detail) => {
        detail.classList.toggle('tsukeru-hidden', detail.dataset.kanjiIndex !== index);
      });
      requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
    };
  });
}

function setKanjiPanelContent(tooltip, panel, state, html) {
  if (!panel || !panel.isConnected) return;
  panel.dataset.state = state;
  panel.innerHTML = html;
  if (state === 'loaded') bindKanjiChips(tooltip, panel);
  requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
}

async function loadKanjiBreakdown(word) {
  const tooltip = ensureDictionaryTooltip();
  const panel = document.getElementById('tsukeru-kanji-container');
  const coordinator = tooltip._asyncCoordinator;
  if (!panel || !coordinator || !word) return;
  setKanjiPanelContent(tooltip, panel, 'loading', renderTooltipPanelLoading());
  const requestVersion = tooltip._lookupVersion;
  const unavailableHtml = `<div class="tsukeru-async-unavailable">${escapeHtml(t('content_kanji_unavailable', undefined, 'Kanji details are not available right now.'))}</div>`;
  return coordinator.open('kanji', async () => {
    const response = await chrome.runtime.sendMessage({ action: 'fetchKanjiBreakdown', word });
    if (!response?.success) {
      throw createRuntimeResponseError(response, 'Kanji breakdown lookup failed');
    }
    return response?.success && Array.isArray(response.data?.characters) && response.data.characters.length
      ? response.data
      : null;
  }, {
    onSuccess: (data) => {
      if (!isCurrentTooltipLookup(tooltip, requestVersion, word)) return;
      if (!data) {
        setKanjiPanelContent(tooltip, panel, 'empty', unavailableHtml);
        return;
      }
      setKanjiPanelContent(tooltip, panel, 'loaded', renderKanjiPanelHtml(data));
      mountStrokeDiagrams(panel, data);
    },
    onError: (error) => {
      if (!isCurrentTooltipLookup(tooltip, requestVersion, word)) return;
      console.warn('Tsukeru: kanji enrichment failed', error);
      if (error?.rateLimitType || error?.errorCode === 'service_unavailable') {
        showRateLimitToast(error.errorCode === 'service_unavailable' ? 'service_unavailable' : (error.rateLimitType || 'service_unavailable'), error.retryAfter, error.retryAt, 'dictionary');
      }
      setKanjiPanelContent(tooltip, panel, 'error', unavailableHtml);
    }
  });
}

// ── Report modal (in-page) ────────────────────────────────────────────────────

// Content-script lexical state is inaccessible to the page's scripts.
let pendingReadingReport = null;

function ensureContentReportModal() {
  let modal = document.getElementById('tsukeru-content-report-modal');
  if (modal) {
    applyTsukeruUiTheme(modal);
    return modal;
  }

  modal = document.createElement('div');
  modal.id = 'tsukeru-content-report-modal';
  modal.className = 'tsukeru-content-report-modal hidden';
  applyTsukeruUiTheme(modal);

  modal.innerHTML = `
    <div class="tsukeru-crm-content">
      <div class="tsukeru-crm-header">
        <span>${escapeHtml(t('content_report_title', undefined, 'Report an incorrect reading'))}</span>
        <button type="button" id="tsukeru-crm-close" aria-label="${escapeHtml(t('content_close', undefined, 'Close'))}">&times;</button>
      </div>
      <div class="tsukeru-crm-body">
        <div id="tsukeru-crm-error" class="tsukeru-crm-msg tsukeru-crm-error hidden"></div>
        <div id="tsukeru-crm-success" class="tsukeru-crm-msg tsukeru-crm-success hidden"></div>
        <label class="tsukeru-crm-label">${escapeHtml(t('content_report_label_word', undefined, 'Word:'))}</label>
        <input type="text" id="tsukeru-crm-word" lang="ja" class="tsukeru-crm-input" readonly>
        <label class="tsukeru-crm-label">${escapeHtml(t('content_report_label_wrong_reading', undefined, 'Incorrect reading:'))}</label>
        <input type="text" id="tsukeru-crm-reading" lang="ja" class="tsukeru-crm-input" readonly>
        <label class="tsukeru-crm-label">${escapeHtml(t('content_report_label_context', undefined, 'Context:'))}</label>
        <textarea id="tsukeru-crm-context" lang="ja" class="tsukeru-crm-textarea" rows="2" readonly></textarea>
        <label class="tsukeru-crm-label">${escapeHtml(t('content_report_label_correction_optional', undefined, 'Correct reading (optional):'))}</label>
        <input type="text" id="tsukeru-crm-correct" lang="ja" class="tsukeru-crm-input">
        <button type="button" id="tsukeru-crm-submit" class="tsukeru-crm-submit">${escapeHtml(t('content_report_submit', undefined, 'Submit Report'))}</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('tsukeru-crm-close').onclick = () => {
    pendingReadingReport = null;
    modal.classList.add('hidden');
  };

  document.getElementById('tsukeru-crm-submit').onclick = (event) => {
    if (!event.isTrusted || !pendingReadingReport) return;
    const { word, reading, context } = pendingReadingReport;
    const correction = document.getElementById('tsukeru-crm-correct').value.trim();
    const errorDiv = document.getElementById('tsukeru-crm-error');
    const successDiv = document.getElementById('tsukeru-crm-success');
    const submitBtn = document.getElementById('tsukeru-crm-submit');

    errorDiv.classList.add('hidden');
    successDiv.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = t('content_report_submitting', undefined, 'Submitting...');

    chrome.runtime.sendMessage({
      action: 'reportReadingError',
      payload: {
        word,
        reading,
        context_sentence: context,
        correct_reading: correction || null,
        consent_given: !!context
      }
    }, (response) => {
      submitBtn.disabled = false;
      submitBtn.textContent = t('content_report_submit', undefined, 'Submit Report');
      if (response && response.success) {
        successDiv.textContent = t('content_report_success', undefined, 'Thanks for your report!');
        successDiv.classList.remove('hidden');
        setTimeout(() => modal.classList.add('hidden'), 2000);
      } else {
        const failure = chrome.runtime.lastError ? {} : response;
        const msg = TsukeruUiMessages.errorMessage(failure, 'report', t);
        errorDiv.textContent = msg;
        errorDiv.classList.remove('hidden');
      }
    });
  };

  return modal;
}

// ── Sentence context extraction ───────────────────────────────────────────────

function extractSentenceContext(element) {
  let container = element.closest('p, article, section, blockquote');
  if (!container || container.textContent.trim().length < 20) {
    // The complete analysis wrapper may itself be a span. Start from its
    // parent so the fallback includes surrounding sentence context.
    container = element.parentElement?.closest('div, li, td, span');
  }
  if (!container) container = element.parentElement;
  if (!container) return getPlainTextWithoutReadings(element);

  const markerAttr = 'data-tsukeru-target';
  const hadMarker = element.hasAttribute(markerAttr);
  element.setAttribute(markerAttr, '1');

  const clone = container.cloneNode(true);

  if (!hadMarker) {
    element.removeAttribute(markerAttr);
  }

  // cleanHTML and buildCenteredSnippet are defined in content-dom.js
  const cleanedHTML = cleanHTML(clone);

  const centered = buildCenteredSnippet(cleanedHTML, markerAttr, 40, 80);
  if (centered) return centered;

  if (cleanedHTML.length > 1000) {
    let cutPoint = cleanedHTML.lastIndexOf('。', 1000);
    if (cutPoint === -1 || cutPoint < 300) {
      cutPoint = cleanedHTML.lastIndexOf('、', 1000);
    }
    if (cutPoint === -1 || cutPoint < 300) {
      cutPoint = 1000;
    }
    return cleanedHTML.substring(0, cutPoint + 1) + (cutPoint < cleanedHTML.length - 1 ? '...' : '');
  }

  return cleanedHTML;
}

// ── My Words: checked words, Learning / Known, Study mode ─────────────────────
// Word rules come from word-rules.js (globalThis.TsukeruWords). The background
// store is the only writer; this file sends it requests and follows storage
// changes to mark words on the page.

function wordRules() {
  return globalThis.TsukeruWords || null;
}

function wordIdentityOf(element) {
  const rules = wordRules();
  return rules && element ? rules.identityForWordInfo(getAnalysisWordData(element)) : null;
}

/** The plain sentence around a word, without readings, at most 120 characters. */
function plainWordSentence(element, word) {
  return wordSentenceWithReadings(element, word).sentence;
}

/**
 * The plain sentence around a word and the readings Tsukeru gave the words
 * in it, as [start, length, reading, word id] spans (as on EZFurigana).
 */
function wordSentenceWithReadings(element, word) {
  try {
    const around = blockTextAround(element);
    const found = around
      ? wordRules()?.sentenceWithReadingsAt(around.text, around.start, around.end, word, around.words)
      : null;
    if (found?.sentence) return found;
    const sentence = wordRules()?.fitSentence(getPlainTextFromHtml(extractSentenceContext(element)), word) || '';
    return { sentence, readings: [] };
  } catch (_) {
    return { sentence: '', readings: [] };
  }
}

/** A page word's reading and identity for its sentence span, or null for words without one. */
function sentenceWordOf(node) {
  if (!isAnalysisWordElement(node) || resolveAnalysisWordElement(node) !== node) return null;
  const info = getAnalysisWordData(node);
  const reading = String(info.surfaceReading || '').trim();
  if (!reading) return null;
  return { reading, id: wordRules()?.identityForWordInfo(info)?.id || '' };
}

// Elements that start a new line of text; their edges and <br> end a sentence.
const SENTENCE_BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const SENTENCE_SKIP_TAGS = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON']);
const SENTENCE_SCAN_LIMIT = 20000;

/**
 * Text of the word's nearest block, without readings, with a line break at
 * every nested block and <br>, where the word sits in it, and where each
 * page word with a reading sits in it (`words`, in order). Bounded: a word
 * further than SENTENCE_SCAN_LIMIT characters into its block gives null.
 */
function blockTextAround(element) {
  if (!element?.parentElement) return null;
  let container = element.parentElement;
  while (container && !SENTENCE_BLOCK_TAGS.has(container.tagName)) container = container.parentElement;
  container = container || element.parentElement;
  let text = '';
  let start = -1;
  let end = -1;
  const words = [];
  const visit = (node) => {
    if (text.length > SENTENCE_SCAN_LIMIT) return;
    if (node.nodeType === 3) {
      text += node.nodeValue || '';
      return;
    }
    if (node.nodeType !== 1 || SENTENCE_SKIP_TAGS.has(node.tagName)) return;
    if (node.getAttribute?.('data-tsukeru-reading-only') === 'true') return;
    const block = node !== container && SENTENCE_BLOCK_TAGS.has(node.tagName);
    if (block || node.tagName === 'BR') text += '\n';
    if (node === element) start = text.length;
    const unit = sentenceWordOf(node);
    const from = text.length;
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    if (unit && text.length > from) words.push({ from, to: text.length, ...unit });
    if (node === element) end = text.length;
    if (block) text += '\n';
  };
  visit(container);
  return start >= 0 && end >= start ? { text, start, end, words } : null;
}

function noteLocalWordState(record) {
  if (!record?.id) return;
  if (record.state) wordStates.set(record.id, record.state);
  else wordStates.delete(record.id);
  scheduleWordStateRefresh();
}

/**
 * Record that the reader checked a word on this page (dictionary lookup or
 * Study reveal). A new word starts learning; a known word stays known.
 * Resolves to {id, word, reading, state}, or null for kana-only words.
 */
async function captureCheckedWord(element, wordInfo, source) {
  const identity = wordIdentityOf(element);
  if (!identity || !chrome.runtime?.id) return null;
  const countCheck = !countedWordIds.has(identity.id);
  countedWordIds.add(identity.id);
  const context = wordSentenceWithReadings(element, wordInfo?.surface || identity.word);
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'wordsCapture',
      word: identity.word,
      reading: identity.reading,
      sentence: context.sentence,
      readings: context.readings,
      level: wordInfo?.jlpt || '',
      pos: wordInfo?.pos || '',
      countCheck,
      source,
    });
    const record = response?.success ? response.record : null;
    if (record) noteLocalWordState(record);
    return record;
  } catch (error) {
    console.warn('Tsukeru: could not record the checked word', error?.message);
    return null;
  }
}

async function setCheckedWordState(record, state, element) {
  const context = element ? wordSentenceWithReadings(element, record.word) : { sentence: '', readings: [] };
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'wordsSetState',
      word: record.word,
      reading: record.reading,
      state,
      sentence: context.sentence,
      readings: context.readings,
    });
    const updated = response?.success ? response.record : null;
    if (updated) noteLocalWordState(updated);
    return updated;
  } catch (error) {
    console.warn('Tsukeru: could not change the word state', error?.message);
    return null;
  }
}

/** Keep the first definition the reader saw with the word, for My Words exports. */
async function rememberWordDefinition(recordPromise, data) {
  const record = await recordPromise;
  if (!record) return;
  const normalized = normalizeDefinitionData(data);
  const definition = (normalized?.senses || [])
    .slice(0, 2)
    .map((sense) => (sense.glosses || []).join('; '))
    .filter(Boolean)
    .join('; ');
  if (!definition) return;
  chrome.runtime.sendMessage({
    action: 'wordsSetDefinition',
    word: record.word,
    reading: record.reading,
    definition,
  }).catch(() => {});
}

/** The Learning / Known switch, the same two-state control as the website popup. */
function renderTooltipProgress(tooltip, record) {
  tooltip.querySelectorAll('.tooltip-progress').forEach((node) => node.remove());
  if (!record) return;
  const host = tooltip.querySelector('.tsukeru-reading-actions');
  const header = tooltip.querySelector('.tsukeru-header-row');
  if (!host && !header) return;
  const group = document.createElement('div');
  group.className = 'tooltip-progress';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('content_word_state_for', [record.word], `Status of ${record.word}`));
  const options = [
    ['learning', t('content_state_learning', undefined, 'Learning')],
    ['known', t('content_state_known', undefined, 'Known')],
  ].map(([state, label]) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'tooltip-progress-option';
    option.dataset.state = state;
    option.textContent = label;
    option.setAttribute('aria-pressed', record.state === state ? 'true' : 'false');
    option.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (option.getAttribute('aria-pressed') === 'true') return;
      const updated = await setCheckedWordState(record, state, tooltip._activeRuby);
      if (!updated) return;
      options.forEach((other) => {
        other.setAttribute('aria-pressed', other.dataset.state === updated.state ? 'true' : 'false');
      });
    });
    return option;
  });
  group.append(...options);
  if (host) {
    host.prepend(group);
  } else {
    group.classList.add('tooltip-progress-row');
    header.insertAdjacentElement('afterend', group);
  }
}

async function bindTooltipProgress(tooltip, recordPromise, token) {
  const record = await recordPromise;
  if (tooltip._lookupVersion !== token || !tooltip.classList.contains('show')) return;
  renderTooltipProgress(tooltip, record);
  requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
}

function isStudyModeOn() {
  return document.documentElement.getAttribute('data-tsukeru-study') === 'on';
}

function hasVisibleReading(element) {
  const reading = element.querySelector?.('rt');
  if (!reading) return false;
  try {
    return window.getComputedStyle(reading).display !== 'none';
  } catch (_) {
    return true;
  }
}

/**
 * Study mode: the first click on a word with a reading reveals it and counts
 * as a check; the next click opens the dictionary as usual.
 */
function handleStudyReveal(element, wordInfo) {
  if (!isStudyModeOn() || element.classList.contains('tsukeru-revealed') || !hasVisibleReading(element)) return false;
  element.classList.add('tsukeru-revealed');
  captureCheckedWord(element, wordInfo, 'study');
  return true;
}

function clearStudyReveals() {
  document.querySelectorAll('.tsukeru-revealed').forEach((element) => element.classList.remove('tsukeru-revealed'));
}

/** Study mode and hidden readings on known words; both come from settings. */
function applyWordDisplaySettings(settings = {}) {
  const root = document.documentElement;
  const study = settings.studyMode === true ? 'on' : 'off';
  if (root.getAttribute('data-tsukeru-study') !== study) clearStudyReveals();
  root.setAttribute('data-tsukeru-study', study);
  root.setAttribute('data-tsukeru-hide-known', settings.hideKnownFurigana === false ? 'off' : 'on');
}

function clearWordDisplaySettings() {
  clearStudyReveals();
  document.documentElement.removeAttribute('data-tsukeru-study');
  document.documentElement.removeAttribute('data-tsukeru-hide-known');
  notePageWordsChanged();
}

// While furigana is still being added, the popup re-lists the page once
// insertions pause, and at least this often while they continue.
const PAGE_WORDS_NOTICE_QUIET_MS = 1200;
const PAGE_WORDS_NOTICE_MAX_WAIT_MS = 5000;

/**
 * Tell an open popup that furigana was added or removed, so Words in this
 * text re-lists the page: once changes pause, not after every inserted batch.
 */
function notePageWordsChanged() {
  const now = Date.now();
  pageWordsChangedAt = now;
  if (pageWordsNoticeTimer) return;
  pageWordsNoticeStartedAt = now;
  const settle = () => {
    const current = Date.now();
    const quiet = current - pageWordsChangedAt;
    const waited = current - pageWordsNoticeStartedAt;
    if (quiet < PAGE_WORDS_NOTICE_QUIET_MS && waited < PAGE_WORDS_NOTICE_MAX_WAIT_MS) {
      pageWordsNoticeTimer = setTimeout(settle, Math.min(
        PAGE_WORDS_NOTICE_QUIET_MS - quiet,
        PAGE_WORDS_NOTICE_MAX_WAIT_MS - waited
      ));
      return;
    }
    pageWordsNoticeTimer = 0;
    // No listener when the popup is closed; that is expected.
    chrome.runtime.sendMessage({ action: 'pageWordsChanged' })?.catch?.(() => {});
  };
  pageWordsNoticeTimer = setTimeout(settle, PAGE_WORDS_NOTICE_QUIET_MS);
}

/** Mark learning and known words: known words lose their readings, learning words keep them. */
function applyWordStatesTo(root) {
  notePageWordsChanged();
  const whole = root === document;
  if (!root || (!wordStates.size && !(whole && wordStatesApplied))) return;
  if (whole) wordStatesApplied = wordStates.size > 0;
  getAnalysisWordElements(root).forEach((element) => {
    const identity = wordIdentityOf(element);
    const state = identity ? wordStates.get(identity.id) : undefined;
    element.classList.toggle('tsukeru-learning', state === 'learning');
    element.classList.toggle('tsukeru-known', state === 'known');
  });
}

function scheduleWordStateRefresh() {
  if (!isFuriganaActive || wordStateRefreshFrame) return;
  wordStateRefreshFrame = requestAnimationFrame(() => {
    wordStateRefreshFrame = 0;
    applyWordStatesTo(document);
  });
}

async function refreshWordStates() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'wordsGetStates' });
    if (response?.success && response.states && typeof response.states === 'object') {
      wordStates = new Map(Object.entries(response.states));
    }
  } catch (error) {
    console.warn('Tsukeru: could not read word states', error?.message);
  }
  applyWordStatesTo(document);
}

/** Follow word changes made anywhere (other tabs, the popup, EZFurigana sync). */
function noteWordStateChanges(changes) {
  let touched = false;
  Object.entries(changes || {}).forEach(([key, change]) => {
    if (!key.startsWith('w:')) return;
    let id;
    try {
      id = decodeURIComponent(key.slice(2));
    } catch (_) {
      return;
    }
    const state = change?.newValue?.state;
    if (state) wordStates.set(id, state);
    else wordStates.delete(id);
    touched = true;
  });
  if (touched) scheduleWordStateRefresh();
}


/** Ruby tokens are text syntax, never trusted markup. Invalid braces stay literal. */
function appendDictionaryRubyText(element, value) {
  const text = String(value || '');
  const fragment = document.createDocumentFragment();
  const parts = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;
    if (index > start) parts.push(text.slice(start, index));
    const tokenStart = index;
    let depth = 1;
    while (++index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') depth -= 1;
    }
    // index points just after the closing brace (or the end of invalid text).
    parts.push(text.slice(tokenStart, index));
    start = index;
    index -= 1;
  }
  if (start < text.length) parts.push(text.slice(start));
  for (const part of parts) {
    const match = /^\{([^{}|<>\r\n]+)\|([\u3041-\u3096\u30fc]+)\}$/u.exec(part);
    if (!match) { fragment.append(document.createTextNode(part)); continue; }
    const ruby = document.createElement('ruby');
    ruby.lang = 'ja';
    const rt = document.createElement('rt');
    rt.textContent = match[2];
    ruby.append(document.createTextNode(match[1]), rt);
    fragment.append(ruby);
  }
  element.replaceChildren(fragment);
}

function isCurrentTranslation(state) {
  return state.tooltip._translationState === state
    && state.tooltip._lookupVersion === state.token
    && state.tooltip.dataset.word === state.wordInfo.word
    && state.tooltip.classList.contains('show')
    && TsukeruI18n.language() === state.locale;
}

/** New translations a guest has left today; Supporters never see a count. */
function translationsLeft(state) {
  return !state.supporter && Number.isInteger(state.remaining) && state.remaining >= 0 ? state.remaining : null;
}

function translationNote(text, upsell) {
  const note = document.createElement('div');
  note.className = 'tsukeru-translation-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  note.textContent = text;
  if (upsell) {
    const link = document.createElement('a');
    link.className = 'tsukeru-translation-upsell';
    link.href = TsukeruI18n.websiteUrl('/pricing?from=tsukeru');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('header_title_become_supporter', undefined, 'Become a Supporter');
    note.append(document.createTextNode(' '), link);
  }
  return note;
}

function translationsLeftLabel(count) {
  const left = document.createElement('span');
  left.className = 'tsukeru-translation-left';
  left.textContent = t('dictionary_translations_left', [String(count)], `${count} left today`);
  return left;
}

/** AI translation / English, the same two-state look as Learning / Known. */
function translationSwitch(state) {
  const group = document.createElement('div');
  group.className = 'tsukeru-translation-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('dictionary_ai_translation', undefined, 'AI translation'));
  let pressed = null;
  [
    [true, t('dictionary_ai_translation', undefined, 'AI translation')],
    [false, t('dictionary_english_option', undefined, 'English')],
  ].forEach(([translation, label]) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'tsukeru-translation-option';
    option.dataset.view = translation ? 'translation' : 'english';
    const on = translation === state.showingTranslation;
    option.setAttribute('aria-pressed', on ? 'true' : 'false');
    option.textContent = label;
    option.addEventListener('click', event => handleTranslationView(event, state, translation));
    if (on) pressed = option;
    group.append(option);
  });
  return { group, focus: pressed };
}

/** The controls sit at the top of the Meaning tab, above the first sense. */
function placeTranslationControls(tooltip, controls) {
  const panel = tooltip.querySelector('.tsukeru-tab-panel');
  if (panel) panel.prepend(controls);
  else tooltip.append(controls);
}

function drawTranslationControls(state) {
  if (!isCurrentTranslation(state)) return;
  const { tooltip } = state;
  const previous = tooltip.querySelector('.tsukeru-translation-controls');
  state.restoreFocus ||= previous?.contains?.(document.activeElement) || false;
  previous?.remove();
  const controls = document.createElement('div');
  controls.className = 'tsukeru-translation-controls';
  const left = translationsLeft(state);
  let focus = null;
  if (state.translated) {
    const view = translationSwitch(state);
    controls.append(view.group);
    focus = view.focus;
  } else if (left === 0) {
    // The day's free translations are used up: no button, just what Supporter adds.
    const text = state.supporterDaily
      ? t('dictionary_translation_supporter_daily', [String(state.supporterDaily)], `Supporters get ${state.supporterDaily} new translations a day.`)
      : TsukeruUiMessages.dictionaryTranslationMessage('plan_limit', t);
    controls.append(translationsLeftLabel(0), translationNote(text, true));
  } else if (!state.supporter && TsukeruUiMessages.dictionaryTranslationOffersSupporter(state.reason)) {
    controls.append(translationNote(TsukeruUiMessages.dictionaryTranslationMessage(state.reason, t), true));
  } else {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tsukeru-translation-button';
    button.disabled = state.busy;
    if (state.busy) button.setAttribute('aria-busy', 'true');
    button.textContent = state.checking ? t('content_loading', undefined, 'Loading...')
      : state.busy ? t('dictionary_translation_loading', undefined, 'Translating…')
        : t('dictionary_translate', undefined, 'View translation');
    button.addEventListener('click', event => handleTranslationClick(event, state));
    controls.append(button);
    if (left !== null && !state.busy) controls.append(translationsLeftLabel(left));
    if (state.reason) controls.append(translationNote(TsukeruUiMessages.dictionaryTranslationMessage(state.reason, t), false));
    if (!button.disabled) focus = button;
  }
  placeTranslationControls(tooltip, controls);
  if (state.restoreFocus && focus) { focus.focus?.({ preventScroll: true }); state.restoreFocus = false; }
  requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
}

function drawTranslationEntry(state) {
  if (!isCurrentTranslation(state)) return;
  state.tooltip._asyncCoordinator?.reset(state.wordInfo.word);
  renderDefinitionTooltip(state.tooltip, state.wordInfo,
    state.showingTranslation ? state.translated : state.english);
  bindTooltipProgress(state.tooltip, state.recordPromise, state.token);
  drawTranslationControls(state);
}

async function requestTooltipTranslation(state, cacheOnly) {
  const reply = await new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({
        action: 'lookupLocalizedDefinition', word: state.wordInfo.word,
        reading: state.wordInfo.lookupReading || '', readingType: state.wordInfo.lookupReadingType || '',
        uiLocale: state.locale, cacheOnly,
      }, response => {
        if (chrome.runtime.lastError || !response?.success) resolve(null);
        else resolve(response);
      });
    } catch (_) { resolve(null); }
  });
  if (!isCurrentTranslation(state)) return;
  const result = reply?.data || null;
  if (typeof reply?.supporter === 'boolean') state.supporter = reply.supporter;
  if (Number.isInteger(result?.remaining) && result.remaining >= 0) state.remaining = result.remaining;
  if (Number.isInteger(result?.supporter_daily) && result.supporter_daily > 0) state.supporterDaily = result.supporter_daily;
  state.busy = false;
  state.checking = false;
  if (result && ['je_localized_cache', 'je_localized_generated'].includes(result.source)
      && result.locale === ({ ja: 'ja', ko: 'ko', 'zh-TW': 'zh-Hant' }[state.locale])
      && result.entry && typeof result.entry === 'object') {
    state.translated = result;
    state.showingTranslation = true;
    state.reason = '';
    drawTranslationEntry(state);
    return;
  }
  const reason = result?.reason || 'service_unavailable';
  // A disabled feature, missing route or failed passive check leaves the English tooltip unchanged.
  if (reason === 'disabled' || (cacheOnly && !result)) {
    state.tooltip.querySelector('.tsukeru-translation-controls')?.remove();
    return;
  }
  // Supporters get a new translation without asking, started by the click that opened the word.
  if (cacheOnly && reason === 'not_cached' && state.supporter && state.trusted) {
    state.busy = true;
    state.reason = '';
    drawTranslationControls(state);
    void requestTooltipTranslation(state, false);
    return;
  }
  // Notes explain a reader's own request; the passive cache check only offers the button.
  state.reason = cacheOnly ? '' : reason;
  drawTranslationControls(state);
}

function handleTranslationView(event, state, translation) {
  if (!event.isTrusted || !state.translated || !isCurrentTranslation(state)) return;
  event.stopPropagation();
  if (state.showingTranslation === translation) return;
  state.restoreFocus = true;
  state.showingTranslation = translation;
  drawTranslationEntry(state);
}

function handleTranslationClick(event, state) {
  if (!event.isTrusted || state.busy || !isCurrentTranslation(state)) return;
  event.stopPropagation();
  state.restoreFocus = true;
  state.busy = true;
  state.reason = '';
  drawTranslationControls(state);
  void requestTooltipTranslation(state, false);
}

/**
 * Localized tooltips start in English and look for a stored translation.
 * `trusted` is true when a reader's own click opened the word; only then may
 * a Supporter's popup start a new translation by itself.
 */
function startLocalizedTooltip(tooltip, wordInfo, english, recordPromise, token, { trusted = false } = {}) {
  const locale = TsukeruI18n.language();
  if (!['ja', 'ko', 'zh-TW'].includes(locale) || english?.source !== 'je_dict' || !english.entry) return;
  const state = { tooltip, wordInfo, english, recordPromise, token, locale, trusted: trusted === true,
    translated: null, showingTranslation: false, busy: true, checking: true, reason: '',
    supporter: false, remaining: null, supporterDaily: 0 };
  tooltip._translationState = state;
  // Controls appear only after the cache check shows translations are available.
  void requestTooltipTranslation(state, true);
}
