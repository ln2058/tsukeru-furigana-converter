// ============================================================================
// content-tooltip.js — Dictionary tooltip, vocabulary saving, TTS, report modal
// Loaded as a plain content script after content-dom.js.
// References shared globals declared as var in content-main.js:
//   dictionaryTooltip, dictionaryEventsBound, definitionCache
// References functions from content-dom.js:
//   escapeHtml, sanitizeHtmlFragment, cleanHTML, buildCenteredSnippet,
//   generateEntryId, sleep
// ============================================================================

// ── Kata-to-Hira conversion ───────────────────────────────────────────────────

function kata2hira(str) {
  return (str || '').replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
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

  document.__tsukeruClickHandler__ = handleDictionaryClick;
  document.__tsukeruDblClickHandler__ = handleRubyDoubleClick;

  document.addEventListener('click', handleDictionaryClick, true);
  document.addEventListener('dblclick', handleRubyDoubleClick, true);
  window.addEventListener('resize', hideDefinitionTooltip, { passive: true });
  // dictionaryEventsBound is a var global from content-main.js
  dictionaryEventsBound = true;
}

function handleDictionaryClick(event) {
  // ORPHAN CHECK: If the extension was reloaded, this script context is dead.
  if (!chrome.runtime?.id) {
    document.removeEventListener('click', handleDictionaryClick, true);
    return;
  }

  if (event.target.closest('#tsukeru-word-tooltip')) {
    return;
  }

  const targetEl = event.target.closest('ruby, span[data-jlpt]');
  if (!targetEl) {
    hideDefinitionTooltip();
    return;
  }

  if (event.target.closest('.alt-indicator')) return;

  const wordInfo = extractWordInfo(targetEl);
  if (!wordInfo.word) return;

  event.preventDefault();
  event.stopPropagation();

  showDefinitionTooltip(targetEl, wordInfo);
}

// ── Word info extraction ──────────────────────────────────────────────────────

function extractWordInfo(ruby) {
  const readingFromAttrs = ruby.dataset.dictReading || ruby.dataset.reading || '';
  const readingFromRt = ruby.querySelector('rt')?.textContent || '';
  const surfaceReading = ruby.dataset.reading || readingFromRt;
  const surface = ruby.dataset.surface || ruby.querySelector('rb')?.textContent || ruby.textContent.replace(readingFromRt, '');
  const word = ruby.dataset.dictForm || ruby.dataset.surface || surface || '';
  const reading = readingFromAttrs || readingFromRt;

  const altReadingsStr = ruby.dataset.altReadings || '';

  return {
    word: (word || '').trim(),
    reading: (reading || '').trim(),
    surface: (surface || '').trim(),
    surfaceReading: (surfaceReading || '').trim(),
    jlpt: ruby.dataset.jlpt || '',
    pos: ruby.dataset.pos || '',
    altReadings: altReadingsStr.split(',').map(r => r.trim()).filter(Boolean)
  };
}

// ── Tooltip lifecycle ─────────────────────────────────────────────────────────

async function showDefinitionTooltip(ruby, wordInfo) {
  const tooltip = ensureDictionaryTooltip();

  tooltip._lookupVersion = (tooltip._lookupVersion || 0) + 1;
  const myToken = tooltip._lookupVersion;

  tooltip.dataset.word = wordInfo.word;
  tooltip._activeRuby = ruby;
  tooltip.innerHTML = getTooltipLoadingHtml(wordInfo.word);

  positionTooltip(ruby, tooltip);
  tooltip.classList.add('show');
  addTooltipInteractionHandlers();

  try {
    const definitionData = await lookupDefinition(wordInfo.word);
    if (tooltip._lookupVersion !== myToken) return;
    renderDefinitionTooltip(tooltip, wordInfo, definitionData);
  } catch (err) {
    if (tooltip._lookupVersion !== myToken) return;
    console.error('Tsukeru: dictionary lookup failed', err);
    tooltip.innerHTML = getTooltipErrorHtml(wordInfo.word, 'Error loading definition');
    addTooltipInteractionHandlers();
  }
}

function ensureDictionaryTooltip() {
  // dictionaryTooltip is a var global from content-main.js
  if (dictionaryTooltip && dictionaryTooltip.isConnected) {
    return dictionaryTooltip;
  }
  const existing = document.getElementById('tsukeru-word-tooltip');
  if (existing) {
    dictionaryTooltip = existing;
    return existing;
  }
  dictionaryTooltip = document.createElement('div');
  dictionaryTooltip.id = 'tsukeru-word-tooltip';
  dictionaryTooltip.className = 'tsukeru-word-tooltip';
  document.body.appendChild(dictionaryTooltip);
  return dictionaryTooltip;
}

function hideDefinitionTooltip() {
  if (dictionaryTooltip) {
    dictionaryTooltip.classList.remove('show');
    dictionaryTooltip.innerHTML = '';
  }
}

function positionTooltip(ruby, tooltip) {
  const rect = ruby.getBoundingClientRect();
  const tooltipWidth = 320;
  const tooltipHeight = 380;
  const padding = 10;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = rect.left + rect.width / 2;
  let transform = 'translateX(-50%)';

  if (left + tooltipWidth / 2 > viewportWidth - padding) {
    left = viewportWidth - tooltipWidth - padding;
    transform = 'translateX(0)';
  } else if (left - tooltipWidth / 2 < padding) {
    left = padding;
    transform = 'translateX(0)';
  }

  let top = rect.bottom + padding;
  if (top + tooltipHeight > viewportHeight - padding && rect.top - tooltipHeight - padding > 0) {
    top = rect.top - padding;
    transform += ' translateY(-100%)';
  }

  tooltip.style.left = `${left + window.scrollX}px`;
  tooltip.style.top = `${top + window.scrollY}px`;
  tooltip.style.transform = transform;
}

// ── Tooltip interaction handlers ──────────────────────────────────────────────

function addTooltipInteractionHandlers() {
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

  const saveBtn = tooltip.querySelector('.tsukeru-tooltip-save');
  if (saveBtn) {
    saveBtn.onclick = async (e) => {
      e.stopPropagation();
      const word = tooltip.dataset.word;
      if (!word) return;

      if (saveBtn.classList.contains('saved')) {
        try {
          await removeFromVocabulary(word);
          saveBtn.classList.remove('saved');
          saveBtn.title = 'Save word';
        } catch (err) {
          console.error('Tsukeru: unsave failed', err);
        }
        return;
      }

      const reading = tooltip.querySelector('.tsukeru-reading-text')?.textContent?.trim() || '';
      const jlptRaw = tooltip.querySelector('.tsukeru-badge-jlpt')?.textContent?.replace('N', '').trim();
      const jlpt = jlptRaw ? Number(jlptRaw) : null;
      const pos = tooltip.querySelector('.tsukeru-badge-pos')?.textContent?.trim() || null;
      let sentence = tooltip._activeRuby ? extractSentenceContext(tooltip._activeRuby) : '';
      if (sentence) {
        const stripped = sentence.replace(/<[^>]*>/gm, '');
        if (stripped.length <= (word + reading).length + 2) sentence = '';
      }
      const tatoebaJpEl = tooltip.querySelector('.tsukeru-example-jp');
      const tatoebaEnEl = tooltip.querySelector('.tsukeru-example-en');
      const entry = {
        id: generateEntryId(),
        word,
        reading,
        surface: word,
        surfaceReading: reading,
        sentence,
        tatoebaJp: tatoebaJpEl ? tatoebaJpEl.innerHTML : null,
        tatoebaEn: tatoebaEnEl ? tatoebaEnEl.textContent.replace(/^- /, '').trim() : null,
        jlpt,
        pos,
        url: window.location.href,
        timestamp: Date.now()
      };
      try {
        await attachDefinitionToEntry(entry);
        await saveToVocabulary(entry);
        saveBtn.classList.add('saved');
        saveBtn.title = 'Saved!';
        showVocabSavedToast(word);
      } catch (err) {
        console.error('Tsukeru: save from tooltip failed', err);
      }
    };

    // Pre-check: mark button as saved immediately if word is already in vocabulary
    (async () => {
      try {
        const word = tooltip.dataset.word;
        if (!word) return;
        const { vocabulary = [] } = await chrome.storage.local.get(['vocabulary']);
        if (vocabulary.some(v => v.word === word)) {
          saveBtn.classList.add('saved');
          saveBtn.title = 'Already saved';
        }
      } catch (_) { }
    })();
  }

  const reportBtn = tooltip.querySelector('.tsukeru-tooltip-report-btn');
  if (reportBtn) {
    reportBtn.onclick = (e) => {
      e.stopPropagation();
      const word = reportBtn.dataset.word;
      const reading = reportBtn.dataset.reading;
      let sentence = tooltip._activeRuby ? extractSentenceContext(tooltip._activeRuby) : '';
      if (sentence) sentence = sentence.replace(/<[^>]*>/gm, '').substring(0, 200);

      const modal = ensureContentReportModal();
      document.getElementById('tsukeru-crm-word').value = word;
      document.getElementById('tsukeru-crm-reading').value = reading;
      document.getElementById('tsukeru-crm-context').value = sentence;
      document.getElementById('tsukeru-crm-correct').value = '';
      document.getElementById('tsukeru-crm-error').classList.add('hidden');
      document.getElementById('tsukeru-crm-success').classList.add('hidden');
      document.getElementById('tsukeru-crm-submit').disabled = false;
      document.getElementById('tsukeru-crm-submit').textContent = 'Submit Report';
      modal.classList.remove('hidden');
    };
  }

  const altToggle = tooltip.querySelector('.tsukeru-alt-readings-toggle');
  if (altToggle) {
    altToggle.onclick = (e) => {
      e.stopPropagation();
      const targetId = altToggle.dataset.target;
      const content = document.getElementById(targetId);
      const arrow = altToggle.querySelector('.tsukeru-alt-arrow');
      if (content) {
        if (content.style.display === 'none') {
          content.style.display = 'flex';
          if (arrow) arrow.style.transform = 'rotate(180deg)';
        } else {
          content.style.display = 'none';
          if (arrow) arrow.style.transform = 'rotate(0deg)';
        }
      }
    };
  }
}

// ── Tooltip HTML builders ─────────────────────────────────────────────────────

function getTooltipLoadingHtml(word) {
  return `
    <button class="tsukeru-tooltip-close" aria-label="Close">&times;</button>
    <div class="tsukeru-tooltip-word">${escapeHtml(word)}</div>
    <div class="tsukeru-tooltip-loading">Loading...</div>
  `;
}

function getTooltipErrorHtml(word, message) {
  return `
    <button class="tsukeru-tooltip-close" aria-label="Close">&times;</button>
    <div class="tsukeru-tooltip-word">${escapeHtml(word)}</div>
    <div class="tsukeru-tooltip-error">${escapeHtml(message)}</div>
  `;
}

function generateAltReadingsDropdown(alternativeReadings, uniqueId) {
  if (!alternativeReadings || alternativeReadings.length === 0) return '';
  const altId = `tsukeru-alt-${uniqueId}`;
  return `
    <div class="tsukeru-alt-readings-container" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border, #e4e4e7);">
      <button type="button" class="tsukeru-alt-readings-toggle" data-target="${altId}" style="width: 100%; display: flex; align-items: center; justify-content: space-between; text-align: left; font-size: 11px; font-weight: 500; color: var(--text-muted, #71717a); background: none; border: none; cursor: pointer; padding: 0;">
        <span>→ Alt. Readings (${alternativeReadings.length})</span>
        <svg class="tsukeru-alt-arrow" style="width: 10px; height: 10px; transition: transform 0.2s;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
        </svg>
      </button>
      <div id="${altId}" class="tsukeru-alt-readings-content" style="display: none; margin-top: 4px; flex-direction: column; gap: 4px;">
        ${alternativeReadings.map(alt => `
          <div style="font-size: 11px; padding-left: 8px; border-left: 2px solid #3b82f6;">
            <span style="font-weight: 500; color: var(--text, #18181b);">${escapeHtml(alt)}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
}

// ── Definition rendering ──────────────────────────────────────────────────────

function normalizeDefinitionData(data) {
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
    return null;
  }

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
    senses: trimmed,
    reading: Array.isArray(entry.kana) && entry.kana.length ? entry.kana.join('、') : ''
  };
}

function renderDefinitionTooltip(tooltip, wordInfo, data) {
  if (data?.error) {
    tooltip.innerHTML = getTooltipErrorHtml(wordInfo.word, 'Dictionary not available');
    addTooltipInteractionHandlers();
    return;
  }

  const normalized = normalizeDefinitionData(data);
  if (!normalized || normalized.senses.length === 0) {
    tooltip.innerHTML = getTooltipErrorHtml(wordInfo.word, 'No definition found');
    addTooltipInteractionHandlers();
    return;
  }

  const readingText = wordInfo.reading || normalized.reading;
  const displayWord = wordInfo.word;
  const jlptBadge = wordInfo.jlpt ? `<span class="tsukeru-badge-jlpt tsukeru-bg-jlpt-${wordInfo.jlpt}">N${escapeHtml(wordInfo.jlpt)}</span>` : '';
  const posBadge = wordInfo.pos ? `<span class="tsukeru-badge-pos">${escapeHtml(wordInfo.pos.split(',')[0].trim())}</span>` : '';

  let html = `
      <div class="tooltip-word tsukeru-header-row">
          <div class="tsukeru-header-left">
              <span>${escapeHtml(displayWord)}</span>
              ${jlptBadge}${posBadge}
          </div>
          <div class="tsukeru-header-right">
              <button class="tooltip-save tsukeru-tooltip-save" title="Save word">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                  </svg>
              </button>
              <button class="tooltip-close tsukeru-tooltip-close" aria-label="Close">&times;</button>
          </div>
      </div>`;

  html += `
      <div class="tooltip-reading-row tsukeru-reading-row">
          <div class="tooltip-reading tsukeru-reading-text">${escapeHtml(readingText)}</div>
          <div class="tsukeru-reading-actions">
              <button class="tooltip-audio-btn tsukeru-tooltip-speaker"
                  data-reading="${escapeHtml(readingText)}"
                  data-word="${escapeHtml(displayWord)}"
                  title="Play pronunciation">
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M5 7H3a1 1 0 00-1 1v4a1 1 0 001 1h2l4 3V4L5 7z"/>
                      <path d="M13.5 7.5a3 3 0 010 5"/>
                  </svg>
              </button>
              <button class="tsukeru-tooltip-report-btn"
                  data-reading="${escapeHtml(readingText)}"
                  data-word="${escapeHtml(displayWord)}"
                  title="Report wrong reading">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
                      <line x1="4" y1="22" x2="4" y2="15"></line>
                  </svg>
              </button>
          </div>
      </div>`;

  // DICTIONARY_MAX_SENSES is a const from content-dom.js
  const sensesToShow = normalized.senses.slice(0, DICTIONARY_MAX_SENSES);
  sensesToShow.forEach((sense) => {
    const gloss = (sense.glosses || []).join('; ');
    if (!gloss) return;

    html += `<div class="tooltip-sense tsukeru-sense-row">`;
    if (sense.pos && sense.pos.length) {
      html += `<div class="tooltip-pos tsukeru-sense-pos">${escapeHtml(sense.pos.slice(0, 2).join(', '))}</div>`;
    }
    html += `<div class="tooltip-gloss tsukeru-sense-gloss">${escapeHtml(gloss)}</div>`;
    html += `</div>`;
  });

  if (normalized.senses.length > sensesToShow.length) {
    html += `<div class="tooltip-pos tsukeru-sense-more">+${normalized.senses.length - sensesToShow.length} more</div>`;
  }

  html += generateAltReadingsDropdown(wordInfo.altReadings, Date.now());

  html += `<div id="tsukeru-example-container" class="tsukeru-async-section tsukeru-loading">
             <div class="tsukeru-loader"></div>
           </div>`;
  html += `<div id="tsukeru-kanji-container" class="tsukeru-async-section tsukeru-loading">
             <div class="tsukeru-loader"></div>
           </div>`;

  tooltip.innerHTML = html;
  tooltip.classList.add('show');
  addTooltipInteractionHandlers();

  loadExampleSentence(wordInfo.word);
  loadKanjiBreakdown(wordInfo.word);
}

// ── Dictionary lookup ─────────────────────────────────────────────────────────

async function lookupDefinition(word) {
  // definitionCache is a var global from content-main.js
  const key = (word || '').trim();
  if (!key) return null;

  if (definitionCache.has(key)) {
    try {
      return await definitionCache.get(key);
    } catch (err) {
      definitionCache.delete(key);
    }
  }

  const promise = chrome.runtime.sendMessage({ action: 'lookupDefinition', word: key })
    .then((response) => {
      if (response?.success && response.data) {
        return response.data;
      }
      throw new Error(response?.error || 'Lookup failed');
    });

  definitionCache.set(key, promise);
  return promise;
}

// ── Audio / TTS ───────────────────────────────────────────────────────────────

function speakWord(word, reading, buttonElement) {
  if (!word) return;
  if (buttonElement) buttonElement.classList.add('speaking');

  chrome.runtime.sendMessage({ action: 'playAudioDirect', word, reading }, (response) => {
    if (buttonElement) buttonElement.classList.remove('speaking');
    if (!response || !response.success) {
      fallbackTTS(word, buttonElement);
    }
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

async function loadExampleSentence(word) {
  const container = document.getElementById('tsukeru-example-container');
  if (!container) return;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'fetchExampleSentence', word });
    if (response?.success && response.data && response.data.japanese) {
      let html = `
        <div class="tsukeru-dropdown-header">
          <button type="button" class="tsukeru-example-toggle tsukeru-dropdown-toggle">
            <span>→ Example Sentence (1)</span>
            <svg class="tsukeru-dropdown-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
            </svg>
          </button>
          <div class="tsukeru-example-content tsukeru-dropdown-content tsukeru-hidden">
            <div class="tsukeru-example-item">
              <div class="tsukeru-example-jp">${sanitizeHtmlFragment(response.data.japanese_furigana_html)}</div>
              <div class="tsukeru-example-en">- ${escapeHtml(response.data.english)}</div>
            </div>
          </div>
        </div>
      `;
      container.innerHTML = html;
      container.classList.remove('tsukeru-loading');

      const toggleBtn = container.querySelector('.tsukeru-example-toggle');
      const contentDiv = container.querySelector('.tsukeru-example-content');
      const arrowSvg = container.querySelector('.tsukeru-dropdown-arrow');
      if (toggleBtn && contentDiv) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          contentDiv.classList.toggle('tsukeru-hidden');
          if (arrowSvg) arrowSvg.classList.toggle('tsukeru-rotate-180');
        });
        contentDiv.classList.remove('tsukeru-hidden');
        if (arrowSvg) arrowSvg.classList.add('tsukeru-rotate-180');
      }
    } else {
      container.remove();
    }
  } catch (e) {
    container.remove();
  }
}

async function loadKanjiBreakdown(word) {
  const container = document.getElementById('tsukeru-kanji-container');
  if (!container) return;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'fetchKanjiBreakdown', word });
    if (response?.success && response.data && response.data.characters && response.data.characters.length > 0) {
      const data = response.data;
      let html = `
        <div class="tsukeru-dropdown-header">
          <button type="button" class="tsukeru-kanji-toggle tsukeru-dropdown-toggle">
            <span>→ Kanji (${data.characters.length})</span>
            <svg class="tsukeru-dropdown-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
            </svg>
          </button>
          <div class="tsukeru-kanji-content tsukeru-dropdown-content tsukeru-hidden">
      `;

      data.characters.forEach(charInfo => {
        const charJlptBadge = charInfo.jlpt_level && charInfo.jlpt_level > 0
          ? `<span class="tsukeru-badge-inline tsukeru-bg-jlpt-${charInfo.jlpt_level}">N${charInfo.jlpt_level}</span>`
          : '';

        html += `
          <div class="tsukeru-kanji-item">
            <div class="tsukeru-kanji-item-header">
                <span class="tsukeru-kanji-char-large">${escapeHtml(charInfo.character)}</span>
                ${charJlptBadge}
            </div>
            ${charInfo.on_readings && charInfo.on_readings.length ? `<div class="tsukeru-kanji-reading"><span class="tsukeru-on-label">音:</span> ${escapeHtml(charInfo.on_readings.slice(0, 3).join(', '))}</div>` : ''}
            ${charInfo.kun_readings && charInfo.kun_readings.length ? `<div class="tsukeru-kanji-reading"><span class="tsukeru-kun-label">訓:</span> ${escapeHtml(charInfo.kun_readings.slice(0, 3).join(', '))}</div>` : ''}
            ${charInfo.meanings && charInfo.meanings.length ? `<div class="tsukeru-kanji-meaning">${escapeHtml(charInfo.meanings.slice(0, 3).join('; '))}</div>` : ''}
          </div>
        `;
      });
      html += `
          </div>
        </div>
      `;
      container.innerHTML = html;
      container.classList.remove('tsukeru-loading');

      const toggleBtn = container.querySelector('.tsukeru-kanji-toggle');
      const contentDiv = container.querySelector('.tsukeru-kanji-content');
      const arrowSvg = container.querySelector('.tsukeru-dropdown-arrow');
      if (toggleBtn && contentDiv) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          contentDiv.classList.toggle('tsukeru-hidden');
          if (arrowSvg) arrowSvg.classList.toggle('tsukeru-rotate-180');
        });
      }
    } else {
      container.remove();
    }
  } catch (e) {
    container.remove();
  }
}

// ── Report modal (in-page) ────────────────────────────────────────────────────

function ensureContentReportModal() {
  let modal = document.getElementById('tsukeru-content-report-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'tsukeru-content-report-modal';
  modal.className = 'tsukeru-content-report-modal hidden';

  modal.innerHTML = `
    <div class="tsukeru-crm-content">
      <div class="tsukeru-crm-header">
        <span>Report Reading</span>
        <button id="tsukeru-crm-close">&times;</button>
      </div>
      <div class="tsukeru-crm-body">
        <div id="tsukeru-crm-error" class="tsukeru-crm-msg tsukeru-crm-error hidden"></div>
        <div id="tsukeru-crm-success" class="tsukeru-crm-msg tsukeru-crm-success hidden"></div>
        <label class="tsukeru-crm-label">Word:</label>
        <input type="text" id="tsukeru-crm-word" class="tsukeru-crm-input" readonly>
        <label class="tsukeru-crm-label">Wrong Reading:</label>
        <input type="text" id="tsukeru-crm-reading" class="tsukeru-crm-input" readonly>
        <label class="tsukeru-crm-label">Context:</label>
        <textarea id="tsukeru-crm-context" class="tsukeru-crm-textarea" rows="2" readonly></textarea>
        <label class="tsukeru-crm-label">Correction (Optional):</label>
        <input type="text" id="tsukeru-crm-correct" class="tsukeru-crm-input">
        <button id="tsukeru-crm-submit" class="tsukeru-crm-submit">Submit Report</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('tsukeru-crm-close').onclick = () => {
    modal.classList.add('hidden');
  };

  document.getElementById('tsukeru-crm-submit').onclick = () => {
    const word = document.getElementById('tsukeru-crm-word').value;
    const reading = document.getElementById('tsukeru-crm-reading').value;
    const context = document.getElementById('tsukeru-crm-context').value;
    const correction = document.getElementById('tsukeru-crm-correct').value.trim();
    const errorDiv = document.getElementById('tsukeru-crm-error');
    const successDiv = document.getElementById('tsukeru-crm-success');
    const submitBtn = document.getElementById('tsukeru-crm-submit');

    errorDiv.classList.add('hidden');
    successDiv.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    chrome.runtime.sendMessage({
      action: 'reportReadingError',
      payload: {
        word,
        reading,
        context_sentence: context,
        suggested_reading: correction || null,
        consent_given: !!context
      }
    }, (response) => {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
      if (response && response.success) {
        successDiv.textContent = 'Thanks for your report!';
        successDiv.classList.remove('hidden');
        setTimeout(() => modal.classList.add('hidden'), 2000);
      } else {
        const msg = (response && response.error) ? response.error : 'Submission failed. Please try again.';
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
    container = element.closest('div, li, td, span');
  }
  if (!container) container = element.parentElement;
  if (!container) return element.textContent;

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

// ── Double-click save ─────────────────────────────────────────────────────────

async function handleRubyDoubleClick(event) {
  // ORPHAN CHECK: If the extension was reloaded, this script context is dead.
  if (!chrome.runtime?.id) {
    document.removeEventListener('dblclick', handleRubyDoubleClick, true);
    return;
  }

  const targetEl = event.target.closest('ruby, span[data-jlpt]');
  if (!targetEl) return;

  event.preventDefault();
  event.stopPropagation();

  const wordInfo = extractWordInfo(targetEl);
  if (!wordInfo.word) return;

  let sentenceContext = extractSentenceContext(targetEl);
  const strippedCtx = sentenceContext.replace(/<[^>]*>/gm, '');
  if (strippedCtx.length <= (wordInfo.word + (wordInfo.reading || '')).length + 2) sentenceContext = '';

  const entry = {
    id: generateEntryId(),
    word: wordInfo.word,
    reading: wordInfo.reading || wordInfo.surfaceReading || wordInfo.surface,
    surface: wordInfo.surface || wordInfo.word,
    surfaceReading: wordInfo.surfaceReading || wordInfo.reading || '',
    sentence: sentenceContext,
    jlpt: wordInfo.jlpt,
    pos: wordInfo.pos,
    url: window.location.href,
    timestamp: Date.now()
  };

  try {
    await attachDefinitionToEntry(entry);
    await saveToVocabulary(entry);
    showVocabSavedToast(wordInfo.surface || wordInfo.word);
    targetEl.classList.add('vocab-saved');
    setTimeout(() => targetEl.classList.remove('vocab-saved'), 2000);
  } catch (err) {
    console.error('Tsukeru: failed to save vocabulary entry', err);
  }
}

// ── Vocabulary storage ────────────────────────────────────────────────────────

async function attachDefinitionToEntry(entry) {
  try {
    const data = await lookupDefinition(entry.word);
    const normalized = normalizeDefinitionData(data);
    if (normalized) {
      entry.definition = normalized.senses.slice(0, DICTIONARY_MAX_SENSES).map(s => (s.glosses || []).join('; ')).filter(Boolean).join(' | ');
      entry.definitions = normalized.senses;
      if (!entry.reading && normalized.reading) {
        entry.reading = normalized.reading;
      }
    }
  } catch (err) {
    console.warn('Tsukeru: could not attach dictionary data to vocab entry', err);
  }
}

async function saveToVocabulary(entry) {
  try {
    if (!entry.id) {
      entry.id = generateEntryId();
    }
    const result = await chrome.storage.local.get(['vocabulary']);
    const vocabulary = result.vocabulary || [];

    const existingIndex = vocabulary.findIndex(v => v.word === entry.word && v.reading === entry.reading);

    if (existingIndex >= 0) {
      vocabulary[existingIndex] = {
        ...vocabulary[existingIndex],
        ...entry,
        timestamp: Date.now()
      };
    } else {
      vocabulary.unshift(entry);
    }

    if (vocabulary.length > 50) {
      vocabulary.length = 50;
    }

    await chrome.storage.local.set({ vocabulary });
  } catch (err) {
    console.error('Failed to save vocabulary:', err);
  }
}

async function removeFromVocabulary(wordToRemove) {
  try {
    const result = await chrome.storage.local.get(['vocabulary']);
    let vocabulary = result.vocabulary || [];
    const initialLength = vocabulary.length;
    vocabulary = vocabulary.filter(v => v.word !== wordToRemove);
    if (vocabulary.length !== initialLength) {
      await chrome.storage.local.set({ vocabulary });
    }
  } catch (err) {
    console.error('Tsukeru: Failed to remove vocabulary:', err);
    throw err;
  }
}

// ── Toast notifications ───────────────────────────────────────────────────────

function showVocabSavedToast(word) {
  const toast = document.createElement('div');
  toast.textContent = `Saved: ${word}`;
  toast.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    background: #10b981;
    color: white;
    padding: 10px 16px;
    border-radius: 6px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    z-index: 2147483647;
    animation: slideInRight 0.2s ease;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  `;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.2s ease reverse';
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    background: #1e293b;
    color: white;
    padding: 10px 16px;
    border-radius: 6px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    z-index: 2147483647;
    animation: slideInRight 0.2s ease;
  `;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.2s ease reverse';
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}
