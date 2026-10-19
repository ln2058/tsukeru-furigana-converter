/*
Module: content-tooltip
Purpose: Manage the instrument-styled dictionary tooltip, lazy enrichment, word interactions, reporting, My Words capture with the Learning / Known switch, Study mode reveals, and learning/known word marks on pages.

Inputs:
- Pointer/selection events, wrapper metadata, reading-aware background lookup/audio responses, and the shared lazy-state coordinator.
- Word states from the background store, word storage changes, and My Words display settings (Study mode, hidden readings on known words).
- The shared i18n catalog and content-ui language and theme helper for extension-owned surfaces.

Outputs:
- Tooltip rendering updates with Japanese language tags for words/readings/examples, checked-word and Learning/Known requests to the background store, and report payload messages.
- `tsukeru-learning`, `tsukeru-known`, and `tsukeru-revealed` classes and Study/known-reading attributes on the page.
- A throttled `pageWordsChanged` runtime notice when furigana is applied or cleared, so an open popup re-lists the page's words.

Side Effects:
- Creates/removes tooltip DOM, fixed-position listeners, and disclosure state.
- Registers tooltip and report surfaces with content-ui to follow the saved UI theme.
- Opening the dictionary on a kanji word, or revealing it in Study mode, adds it to Learning (a known word stays known).
- Excludes tooltip-owned metadata from word capture and word-state marks.

Failure Modes:
- Lookup/audio/report/enrichment requests can fail with preserved runtime status/rate-limit metadata and trigger fallback/no-op paths; stale or dismissed responses are ignored.
- Missing metadata prevents capture/play actions for a target word; kana-only words are not tracked.
- Audio playback failures fall back to speech synthesis.
- Completed dictionary results are TTL-bound and size-bounded; shared in-flight requests are retained only until settlement.

Security Notes:
- Escapes/sanitizes rendered content before DOM injection; report failures use localized messages from structured metadata.
- Report opening/submission requires trusted clicks; word, reading, and context are held in isolated-script state rather than read back from page fields.
- Avoids direct third-party media fetches from page context.
- Checked words carry only the word, reading, JLPT level, part of speech, and a short plain-text sentence; no page URL.
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

  // Older versions saved words on double-click; checking a word now adds it to Learning.
  document.__tsukeruClickHandler__ = handleDictionaryClick;
  document.__tsukeruDblClickHandler__ = null;

  document.addEventListener('click', handleDictionaryClick, true);
  document.__tsukeruScrollHandler__ = (event) => {
    const target = event.target;
    if (dictionaryTooltip && target && typeof target.nodeType === 'number' && dictionaryTooltip.contains(target)) {
      return;
    }
    hideDefinitionTooltip();
  };
  document.__tsukeruResizeHandler__ = hideDefinitionTooltip;
  window.addEventListener('scroll', document.__tsukeruScrollHandler__, { capture: true, passive: true });
  window.addEventListener('resize', document.__tsukeruResizeHandler__, { passive: true });
  // dictionaryEventsBound is a var global from content-main.js
  dictionaryEventsBound = true;
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
  showDefinitionTooltip(targetEl, wordInfo);
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
    altReadings: info.altReadings || []
  };
}

// ── Tooltip lifecycle ─────────────────────────────────────────────────────────

async function showDefinitionTooltip(ruby, wordInfo) {
  const tooltip = ensureDictionaryTooltip();

  tooltip._lookupVersion = (tooltip._lookupVersion || 0) + 1;
  const myToken = tooltip._lookupVersion;
  await TsukeruI18n.ready();
  if (tooltip._lookupVersion !== myToken || ruby.isConnected === false) return;
  applyTsukeruUiTheme(tooltip);
  if (!tooltip._asyncCoordinator && window.TsukeruTooltipAsyncState?.createTooltipAsyncCoordinator) {
    tooltip._asyncCoordinator = window.TsukeruTooltipAsyncState.createTooltipAsyncCoordinator();
  }
  tooltip._asyncCoordinator?.reset(wordInfo.word);

  tooltip.dataset.word = wordInfo.word;
  tooltip._activeRuby = ruby;
  tooltip._activeWordInfo = wordInfo;
  tooltip.innerHTML = getTooltipLoadingHtml(wordInfo);

  positionTooltip(ruby, tooltip);
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
  document.body.appendChild(dictionaryTooltip);
  return dictionaryTooltip;
}

function hideDefinitionTooltip() {
  if (dictionaryTooltip) {
    dictionaryTooltip._lookupVersion = (dictionaryTooltip._lookupVersion || 0) + 1;
    dictionaryTooltip._asyncCoordinator?.invalidate();
    dictionaryTooltip.classList.remove('show');
    dictionaryTooltip.innerHTML = '';
    dictionaryTooltip.dataset.word = '';
    dictionaryTooltip._activeRuby = null;
    dictionaryTooltip._activeWordInfo = null;
  }
}

function positionTooltip(ruby, tooltip) {
  if (!ruby || !tooltip) return;
  const rect = ruby.getBoundingClientRect();
  const padding = 12;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxWidth = Math.max(0, viewportWidth - padding * 2);
  tooltip.style.maxWidth = `${maxWidth}px`;
  tooltip.style.left = `${padding}px`;
  tooltip.style.top = `${padding}px`;
  tooltip.style.transform = 'none';

  const measured = tooltip.getBoundingClientRect();
  const tooltipWidth = Math.min(measured.width || 320, maxWidth);
  const tooltipHeight = Math.min(measured.height || 200, Math.max(0, viewportHeight - padding * 2));
  const anchorCenter = rect.left + rect.width / 2;
  const left = Math.min(
    Math.max(anchorCenter - tooltipWidth / 2, padding),
    Math.max(padding, viewportWidth - tooltipWidth - padding)
  );
  const roomBelow = viewportHeight - rect.bottom - padding;
  const roomAbove = rect.top - padding;
  const placeAbove = roomBelow < tooltipHeight && roomAbove >= tooltipHeight;
  const top = placeAbove
    ? rect.top - padding
    : Math.min(Math.max(rect.bottom + padding, padding), Math.max(padding, viewportHeight - tooltipHeight - padding));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.transform = placeAbove ? 'translateY(-100%)' : 'none';
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

  const speakerBtn = tooltip.querySelector('.tsukeru-tooltip-speaker');
  if (speakerBtn) {
    speakerBtn.onclick = (e) => {
      e.stopPropagation();
      speakWord(speakerBtn.dataset.word, speakerBtn.dataset.reading, speakerBtn);
    };
  }

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
        } else if (section.dataset.section === 'kanji') {
          loadKanjiBreakdown(tooltip.dataset.word);
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

function renderTooltipHeaderHtml(wordInfo, controlsHtml = '') {
  const info = normalizeTooltipWordInfo(wordInfo);
  const { jlpt, pos, posCategory } = getTooltipMetadata(info);
  const badges = `${jlpt ? `<span class="tooltip-badge tooltip-jlpt-badge tsukeru-badge-jlpt" data-jlpt="${jlpt}">N${jlpt}</span>` : ''}${pos ? `<span class="tooltip-badge tooltip-pos-badge tooltip-pos-${posCategory} tsukeru-badge-pos">${escapeHtml(pos)}</span>` : ''}`;
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

function normalizeTkgjeExamples(examples, senses) {
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
    const english = typeof example.english === 'string' ? example.english.trim() : '';
    if (!japanese || !english) return null;
    const senseNumbers = Array.isArray(example.sense_numbers)
      ? example.sense_numbers.map(Number).filter(Number.isFinite)
      : [];
    return { japanese, english, senseNumbers };
  }).filter(Boolean);
  const unnumbered = valid.filter(example => example.senseNumbers.length === 0);
  let unnumberedIndex = 0;

  senses.forEach((sense) => {
    const numbered = Number.isFinite(sense.senseNumber)
      ? valid.find(example => example.senseNumbers.includes(sense.senseNumber))
      : null;
    sense.example = numbered || unnumbered[unnumberedIndex++] || null;
  });
}

function normalizeDefinitionData(data) {
  const richEntry = data?.source === 'je_dict' && data.entry && typeof data.entry === 'object'
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
      normalizeTkgjeExamples(richEntry.examples, trimmed);
      return {
        source: 'je_dict',
        senses: trimmed,
        reading: String(richEntry.reading || '').trim(),
        headerPos: String(richEntry.part_of_speech || (Array.isArray(richEntry.pos_tags) ? richEntry.pos_tags.join(', ') : '')).trim(),
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
    const english = document.createElement('div');
    english.className = 'tsukeru-example-en';
    english.lang = 'en';
    english.textContent = `- ${example.english}`;
    item.append(japanese, english);
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
          <div class="tooltip-reading tsukeru-reading-text" lang="ja">${escapeHtml(readingText)}</div>
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

  // DICTIONARY_MAX_SENSES is a const from content-dom.js
  const sensesToShow = normalized.senses.slice(0, DICTIONARY_MAX_SENSES);
  sensesToShow.forEach((sense, index) => {
    const gloss = (sense.glosses || []).join('; ');
    if (!gloss) return;

    html += `<div class="tooltip-sense tooltip-definition-sense tsukeru-sense-row">`;
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

  if (normalized.senses.length > sensesToShow.length) {
    const moreCount = String(normalized.senses.length - sensesToShow.length);
    html += `<div class="tooltip-pos tsukeru-sense-more">${escapeHtml(t('content_more_count', [moreCount], `+${moreCount} more`))}</div>`;
  }

  html += generateAltReadingsDropdown(wordInfo.altReadings, Date.now());

  if (normalized.sourceUrl) {
    const sourceName = normalized.source === 'je_dict' ? 'TKGJE' : 'JMdict';
    html += `<div class="tsukeru-dictionary-source"><span>${escapeHtml(t('utility_source', undefined, 'Source'))}: </span><a href="${escapeHtml(normalized.sourceUrl)}" target="_blank" rel="noopener noreferrer">${sourceName}</a></div>`;
  }

  if (!normalized.hasAttachedExamples) {
    html += getAsyncSectionHtml('example', 'tsukeru-example-container', t('content_example_section', undefined, 'Example sentence'));
  }
  html += getAsyncSectionHtml('kanji', 'tsukeru-kanji-container', t('content_kanji_section', undefined, 'Kanji details'));

  tooltip.innerHTML = html;
  appendAttachedExamples(tooltip, sensesToShow);
  tooltip.classList.add('show');
  addTooltipInteractionHandlers({ word: displayWord, reading: readingText });
  requestAnimationFrame(() => positionTooltip(tooltip._activeRuby, tooltip));
}

function getAsyncSectionHtml(sectionName, containerId, label) {
  const toggleClass = sectionName === 'example' ? 'tsukeru-example-toggle' : 'tsukeru-kanji-toggle';
  const contentClass = sectionName === 'example' ? 'tsukeru-example-content' : 'tsukeru-kanji-content';
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

function getAsyncSectionLabel(sectionName) {
  return sectionName === 'example'
    ? t('content_example_section', undefined, 'Example sentence')
    : t('content_kanji_section', undefined, 'Kanji details');
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

async function loadKanjiBreakdown(word) {
  const tooltip = ensureDictionaryTooltip();
  const container = document.getElementById('tsukeru-kanji-container');
  const coordinator = tooltip._asyncCoordinator;
  if (!container || !coordinator || !word) return;
  renderAsyncLoading(container);
  const requestVersion = tooltip._lookupVersion;
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
        renderAsyncUnavailable(tooltip, container, false);
        return;
      }
      const characters = data.characters;
      updateAsyncSectionContent(
        tooltip,
        container,
        'loaded',
        t('content_kanji_count', [String(characters.length)], `Kanji (${characters.length})`),
        `<div class="tsukeru-kanji-grid">
          ${characters.map((charInfo = {}) => {
            const level = Number(charInfo.jlpt_level) || 0;
            const charJlptBadge = level > 0 ? `<span class="tsukeru-badge-inline tsukeru-bg-jlpt-${level}">N${level}</span>` : '';
            const onReadings = Array.isArray(charInfo.on_readings) ? charInfo.on_readings.slice(0, 3).join(', ') : '';
            const kunReadings = Array.isArray(charInfo.kun_readings) ? charInfo.kun_readings.slice(0, 3).join(', ') : '';
            const meanings = Array.isArray(charInfo.meanings) ? charInfo.meanings.slice(0, 3).join('; ') : '';
            return `<div class="tsukeru-kanji-item"><div class="tsukeru-kanji-item-header"><span class="tsukeru-kanji-char-large" lang="ja">${escapeHtml(charInfo.character || '')}</span>${charJlptBadge}</div>${onReadings ? `<div class="tsukeru-kanji-reading" lang="ja"><span class="tsukeru-on-label">音:</span> ${escapeHtml(onReadings)}</div>` : ''}${kunReadings ? `<div class="tsukeru-kanji-reading" lang="ja"><span class="tsukeru-kun-label">訓:</span> ${escapeHtml(kunReadings)}</div>` : ''}${meanings ? `<div class="tsukeru-kanji-meaning">${escapeHtml(meanings)}</div>` : ''}</div>`;
          }).join('')}
        </div>`
      );
    },
    onError: (error) => {
      if (!isCurrentTooltipLookup(tooltip, requestVersion, word)) return;
      console.warn('Tsukeru: kanji enrichment failed', error);
      if (error?.rateLimitType || error?.errorCode === 'service_unavailable') {
        showRateLimitToast(error.errorCode === 'service_unavailable' ? 'service_unavailable' : (error.rateLimitType || 'service_unavailable'), error.retryAfter, error.retryAt, 'dictionary');
      }
      renderAsyncUnavailable(tooltip, container, true);
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
  try {
    return wordRules()?.fitSentence(getPlainTextFromHtml(extractSentenceContext(element)), word) || '';
  } catch (_) {
    return '';
  }
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
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'wordsCapture',
      word: identity.word,
      reading: identity.reading,
      sentence: plainWordSentence(element, wordInfo?.surface || identity.word),
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
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'wordsSetState',
      word: record.word,
      reading: record.reading,
      state,
      sentence: element ? plainWordSentence(element, record.word) : '',
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

/** Tell an open popup that furigana was added or removed, so Words in this text re-lists the page. */
function notePageWordsChanged() {
  if (pageWordsNoticeTimer) return;
  pageWordsNoticeTimer = setTimeout(() => {
    pageWordsNoticeTimer = 0;
    // No listener when the popup is closed; that is expected.
    chrome.runtime.sendMessage({ action: 'pageWordsChanged' })?.catch?.(() => {});
  }, 400);
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
