/*
Module: popup-vocab
Purpose: Power vocabulary list and vocab-mode workflows, including lookup enrichment, audio, and exports.

Inputs:
- Stored vocabulary data, popup UI events, active-tab word/context responses, and background API responses.

Outputs:
- Rendered vocab lists, saved vocabulary entries, and CSV/ZIP export downloads.

Side Effects:
- Reads/writes `chrome.storage.local` vocabulary.
- Sends runtime/tab messages and triggers browser downloads.

Failure Modes:
- Storage/message/network failures can block lookup, save, or export operations.
- Audio playback can fail and fall back to speech synthesis.

Security Notes:
- Sanitizes/escapes sentence HTML before rendering.
- Avoids storing secrets and limits exported fields to vocabulary data.
*/
// Vocabulary tab, vocab mode tab, dictionary helpers, and audio playback.
import {
  DEFAULT_SETTINGS,
  DICTIONARY_MAX_SENSES,
  DEFINITION_CACHE_TTL,
  getActiveTab,
  isHttpTab,
  openReportModal,
  t,
} from './popup-settings.js';

// ── Shared utilities ──────────────────────────────────────────────────────────

export function generateEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatCountWithNoun(count, singularKey, pluralKey, templateKey, fallbackTemplate) {
  const noun = count === 1
    ? t(singularKey, undefined, 'word')
    : t(pluralKey, undefined, 'words');
  return t(templateKey, [String(count), noun], fallbackTemplate.replace('{count}', String(count)).replace('{noun}', noun));
}

export function getEntryId(item) {
  if (item?.id) return item.id;
  return `${item?.word || ''}::${item?.reading || ''}::${item?.timestamp || ''}::${item?.url || ''}`;
}

export function kata2hira(str) {
  return (str || '').replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function sanitizeExtensionHtml(dirtyHtml) {
  if (!dirtyHtml) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(dirtyHtml, 'text/html');
  const allowedTags = new Set(['ruby', 'rt', 'rp', 'span', 'div']);
  const allowedAttributes = new Set(['class', 'data-surface', 'data-reading', 'data-dict-form', 'data-dict-reading', 'data-jlpt', 'data-pos']);

  function cleanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); return; }
    const tag = node.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      const frag = document.createDocumentFragment();
      while (node.firstChild) { cleanNode(node.firstChild); if (node.firstChild) frag.appendChild(node.firstChild); }
      node.replaceWith(frag);
      return;
    }
    Array.from(node.attributes).forEach(attr => {
      if (!allowedAttributes.has(attr.name.toLowerCase())) node.removeAttribute(attr.name);
    });
    Array.from(node.childNodes).forEach(cleanNode);
  }

  Array.from(doc.body.childNodes).forEach(cleanNode);
  return doc.body.innerHTML;
}

export function convertRubyToParentheses(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  temp.querySelectorAll('ruby').forEach(ruby => {
    const base = ruby.textContent.replace(ruby.querySelector('rt')?.textContent || '', '').trim();
    const reading = ruby.querySelector('rt')?.textContent || '';
    if (base && reading) {
      ruby.replaceWith(document.createTextNode(`${base}(${reading})`));
    }
  });
  return temp.textContent;
}

export function highlightSavedWordInSentence(sentenceHtml, item) {
  const temp = document.createElement('div');
  temp.innerHTML = sanitizeExtensionHtml(sentenceHtml);

  const targetWord = (item?.word || '').trim();
  const targetSurface = (item?.surface || '').trim();
  const targetReading = (item?.reading || '').trim();

  // Prefer ruby element so furigana stays intact
  const rubyElements = Array.from(temp.querySelectorAll('ruby'));
  const rubyMatch = rubyElements.find(ruby => {
    const baseText = (ruby.dataset.dictForm || ruby.dataset.surface || '').trim() ||
      ruby.textContent.replace(ruby.querySelector('rt')?.textContent || '', '').trim();
    const rubyReading = (ruby.dataset.dictReading || ruby.dataset.reading || ruby.querySelector('rt')?.textContent || '').trim();
    return (targetWord && baseText === targetWord) ||
      (targetSurface && baseText === targetSurface) ||
      (targetReading && rubyReading === targetReading);
  });

  if (rubyMatch) {
    rubyMatch.classList.add('saved-word-highlight');
  }

  return temp.innerHTML;
}

export function renderSentenceWithFurigana(sentenceHtml, item) {
  if (!sentenceHtml) return '';
  return highlightSavedWordInSentence(sentenceHtml, item);
}

// ── Dictionary helpers ────────────────────────────────────────────────────────

export function getDefinitionText(item) {
  if (!item) return '';
  if (item.definition) return item.definition;
  if (Array.isArray(item.definitions) && item.definitions.length) {
    const parts = item.definitions
      .slice(0, DICTIONARY_MAX_SENSES)
      .map((sense) => {
        const gloss = (sense.glosses || []).join('; ');
        const pos = (sense.pos || []).join(', ');
        return gloss ? (pos ? `${pos}: ${gloss}` : gloss) : '';
      })
      .filter(Boolean);
    return parts.join(' | ');
  }
  return '';
}

export function normalizeDefinitionData(data) {
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
    senses: trimmed,
    reading: Array.isArray(entry.kana) && entry.kana.length ? entry.kana.join('、') : ''
  };
}

const definitionCache = new Map();

export async function lookupDefinition(word) {
  const term = (word || '').trim();
  if (!term) return null;
  const now = Date.now();
  const cached = definitionCache.get(term);
  if (cached && now - cached.timestamp < DEFINITION_CACHE_TTL) return cached.data;
  const response = await chrome.runtime.sendMessage({ action: 'lookupDefinition', word: term });
  if (!response?.success) throw new Error(response?.error || 'Definition lookup failed');
  const data = response.data;
  definitionCache.set(term, { data, timestamp: now });
  return data;
}

export async function attachDefinitionToEntry(entry) {
  try {
    const data = await lookupDefinition(entry.word);
    const normalized = normalizeDefinitionData(data);
    if (normalized) {
      entry.definition = normalized.senses
        .slice(0, DICTIONARY_MAX_SENSES)
        .map(s => (s.glosses || []).join('; '))
        .filter(Boolean)
        .join(' | ');
      entry.definitions = normalized.senses;
      if (!entry.reading && normalized.reading) entry.reading = normalized.reading;
    }
  } catch (err) {
    console.warn('Could not attach dictionary data to vocab entry', err);
  }
}

// ── Audio — routes through the background proxy, falls back to browser TTS ───

export async function playVocabAudio(word, reading, buttonElement) {
  if (!word) return;
  if (buttonElement) {
    buttonElement.classList.add('speaking');
    buttonElement.style.color = '#3b82f6';
  }
  const resetState = () => {
    if (buttonElement) {
      buttonElement.classList.remove('speaking');
      buttonElement.style.color = '#6b7280';
    }
  };
  try {
    const response = await chrome.runtime.sendMessage({ action: 'playAudio', word, reading });
    if (response?.success && response.dataUrl) {
      const audio = new Audio(response.dataUrl);
      audio.onended = resetState;
      audio.onerror = resetState;
      await audio.play();
    } else {
      throw new Error('No audio data');
    }
  } catch {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = 'ja-JP';
      utterance.onend = resetState;
      utterance.onerror = resetState;
      window.speechSynthesis.speak(utterance);
    } else {
      resetState();
    }
  }
}

// ── Vocabulary tab ────────────────────────────────────────────────────────────

export let currentVocabulary = [];
export let filteredVocabulary = [];

export async function loadVocabulary() {
  try {
    const result = await chrome.storage.local.get(['vocabulary']);
    currentVocabulary = result.vocabulary || [];
    filteredVocabulary = currentVocabulary;
    renderVocabulary();
  } catch (err) {
    console.error('Failed to load vocabulary:', err);
  }
}

export function renderVocabulary() {
  const vocabList = document.getElementById('vocabList');
  const vocabCount = document.getElementById('vocabCount');
  vocabCount.textContent = formatCountWithNoun(
    currentVocabulary.length,
    'word_singular',
    'word_plural',
    'vocab_count_saved',
    '{count} {noun} saved'
  );
  vocabList.innerHTML = '';

  if (filteredVocabulary.length === 0) {
    if (currentVocabulary.length === 0) {
      vocabList.innerHTML = `
        <div class="vocab-empty">
          <div class="vocab-empty-text">${escapeHtml(t('vocab_empty_text', undefined, 'No vocabulary saved yet'))}</div>
          <div class="vocab-empty-hint">${escapeHtml(t('vocab_empty_hint', undefined, 'Double-click any word with furigana to save it'))}</div>
        </div>
      `;
    } else {
      vocabList.innerHTML = `
        <div class="vocab-empty">
          <div class="vocab-empty-text">${escapeHtml(t('vocab_no_results', undefined, 'No results found'))}</div>
        </div>
      `;
    }
    return;
  }

  filteredVocabulary.forEach((item, index) => {
    vocabList.appendChild(createVocabItem(item, index));
  });
}

export function createVocabItem(item, index) {
  const div = document.createElement('div');
  div.className = 'vocab-item';
  const entryId = getEntryId(item);

  const jlptText = item.jlpt ? `N${item.jlpt}` : '';
  const jlptClass = item.jlpt ? ` jlpt-${item.jlpt}` : '';
  const posText = item.pos || '';
  const dateStr = new Date(item.timestamp).toLocaleDateString();

  let urlDisplay = '';
  try {
    urlDisplay = new URL(item.url).hostname;
  } catch (e) {
    urlDisplay = t('vocab_unknown_source', undefined, 'Unknown source');
  }

  const definitionText = getDefinitionText(item);
  const definitionHtml = definitionText ? `<div class="vocab-definition">${escapeHtml(definitionText)}</div>` : '';
  const sentenceHtml = renderSentenceWithFurigana(item.sentence, item);
  const tatoebaHtml = item.tatoebaJp ? renderSentenceWithFurigana(item.tatoebaJp, item) : null;

  div.innerHTML = `
    <div class="vocab-item-header" style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
      <div style="display: flex; align-items: baseline; gap: 8px;">
        <div class="vocab-word">${escapeHtml(item.word)}</div>
        <div class="vocab-reading">${escapeHtml(item.reading)}</div>
      </div>
      <button class="vocab-speaker-btn" data-word="${escapeHtml(item.word)}" data-reading="${escapeHtml(item.reading)}" title="${escapeHtml(t('vocab_listen', undefined, 'Listen'))}" style="background: none; border: none; cursor: pointer; color: #6b7280; padding: 4px; display: flex; align-items: center; border-radius: 4px; width: auto; margin-bottom: 0; flex-shrink: 0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      </button>
    </div>
    ${(jlptText || posText) ? `
      <div class="vocab-meta">
        ${jlptText ? `<span class="vocab-badge jlpt${jlptClass}">${jlptText}</span>` : ''}
        ${posText ? `<span class="vocab-badge pos">${escapeHtml(posText)}</span>` : ''}
      </div>
    ` : ''}
    ${definitionHtml}
    <div class="vocab-sentence">${sentenceHtml}</div>
    ${tatoebaHtml ? `
      <div class="vocab-sentence tatoeba-sentence">
        <div class="tatoeba-jp">${tatoebaHtml}</div>
        ${item.tatoebaEn ? `<div class="tatoeba-en">${escapeHtml(item.tatoebaEn)}</div>` : ''}
        <div class="tatoeba-source">${escapeHtml(t('vocab_source_tatoeba', undefined, '(Source: Tatoeba)'))}</div>
      </div>
    ` : ''}
    <div class="vocab-footer">
      <a href="${escapeHtml(item.url)}" class="vocab-url" target="_blank" title="${escapeHtml(item.url)}">${escapeHtml(urlDisplay)} &middot; ${dateStr}</a>
      <div style="display:flex;gap:4px;align-items:center;">
        <button class="vocab-action-btn report-btn" title="${escapeHtml(t('report_button_title', undefined, 'Report Wrong Reading'))}" data-word="${escapeHtml(item.word)}" data-reading="${escapeHtml(item.reading)}" data-context="${escapeHtml((item.sentence || '').replace(/<[^>]+>/g, '').substring(0, 100))}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
        </button>
        <button class="vocab-delete" data-id="${escapeHtml(entryId)}">${escapeHtml(t('vocab_delete', undefined, 'Delete'))}</button>
      </div>
    </div>
  `;

  div.querySelector('.vocab-delete').addEventListener('click', async () => {
    await deleteVocabItem(entryId);
  });

  const speakerBtn = div.querySelector('.vocab-speaker-btn');
  if (speakerBtn) {
    speakerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playVocabAudio(speakerBtn.dataset.word, speakerBtn.dataset.reading, speakerBtn);
    });
    speakerBtn.addEventListener('mouseenter', () => speakerBtn.style.color = '#3b82f6');
    speakerBtn.addEventListener('mouseleave', () => {
      if (!speakerBtn.classList.contains('speaking')) speakerBtn.style.color = '#6b7280';
    });
  }

  const reportBtn = div.querySelector('.report-btn');
  if (reportBtn) {
    reportBtn.addEventListener('click', () => {
      openReportModal(reportBtn.dataset.word, reportBtn.dataset.reading, reportBtn.dataset.context);
    });
  }

  return div;
}

export async function deleteVocabItem(entryId) {
  try {
    const index = currentVocabulary.findIndex(item => getEntryId(item) === entryId);
    if (index < 0) return;
    currentVocabulary.splice(index, 1);
    await chrome.storage.local.set({ vocabulary: currentVocabulary });
    filteredVocabulary = currentVocabulary;
    renderVocabulary();
  } catch (err) {
    console.error('Failed to delete vocabulary item:', err);
    alert(t('vocab_delete_failed', undefined, 'Failed to delete item'));
  }
}

export function exportVocabulary() {
  if (currentVocabulary.length === 0) {
    alert(t('vocab_no_items_to_export', undefined, 'No vocabulary to export'));
    return;
  }

  const headers = [
    t('csv_header_word', undefined, 'Word'),
    t('csv_header_reading', undefined, 'Reading'),
    t('csv_header_definition', undefined, 'Definition'),
    t('csv_header_sentence_with_furigana', undefined, 'Sentence (with furigana)'),
    t('csv_header_sentence_plain_text', undefined, 'Sentence (plain text)'),
    t('csv_header_tatoeba_with_furigana', undefined, 'Tatoeba (with furigana)'),
    t('csv_header_tatoeba_plain_text', undefined, 'Tatoeba (plain text)'),
    t('csv_header_tatoeba_english', undefined, 'Tatoeba (English translation)'),
    t('csv_header_jlpt', undefined, 'JLPT'),
    t('csv_header_pos', undefined, 'Part of Speech'),
    t('csv_header_url', undefined, 'URL'),
    t('csv_header_date', undefined, 'Date'),
  ];
  const rows = [headers];

  currentVocabulary.forEach(item => {
    const temp = document.createElement('div');
    temp.innerHTML = item.sentence;
    const sentenceWithParens = convertRubyToParentheses(item.sentence);
    const sentencePlain = temp.textContent;

    let tatoebaWithFurigana = '';
    let tatoebaPlainText = '';
    const tatoebaEnglish = item.tatoebaEn || '';
    if (item.tatoebaJp) {
      tatoebaWithFurigana = convertRubyToParentheses(item.tatoebaJp);
      const tempTatoeba = document.createElement('div');
      tempTatoeba.innerHTML = item.tatoebaJp;
      tatoebaPlainText = tempTatoeba.textContent;
    }

    const date = new Date(item.timestamp).toLocaleDateString();
    rows.push([
      item.word,
      item.reading,
      getDefinitionText(item),
      sentenceWithParens,
      sentencePlain,
      tatoebaWithFurigana,
      tatoebaPlainText,
      tatoebaEnglish,
      item.jlpt ? `N${item.jlpt}` : '',
      item.pos || '',
      item.url,
      date
    ]);
  });

  const csv = rows.map(row =>
    row.map(cell => {
      const escaped = String(cell).replace(/"/g, '""');
      return /[",\n]/.test(cell) ? `"${escaped}"` : escaped;
    }).join(',')
  ).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tsukeru-vocabulary-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportAnkiAudio() {
  if (currentVocabulary.length === 0) {
    alert(t('vocab_no_items_to_export', undefined, 'No vocabulary to export'));
    return;
  }
  const btn = document.getElementById('exportAudioBtn');
  btn.textContent = t('vocab_exporting', undefined, 'Exporting...');
  btn.disabled = true;
  try {
    const payload = currentVocabulary.map(w => ({
      word: w.word,
      reading: kata2hira(w.reading || w.word),
      jlptLevel: w.jlpt || 0,
      pos: w.pos || '',
      definition: getDefinitionText(w),
      context: w.sentence ? convertRubyToParentheses(w.sentence) : '',
      savedAt: new Date(w.timestamp).toLocaleDateString(),
      altReadings: ''
    }));
    const result = await chrome.runtime.sendMessage({ action: 'exportAnkiAudio', payload });
    if (!result.success) throw new Error(result.error || t('vocab_export_failed_short', undefined, 'Export failed'));
    const link = document.createElement('a');
    link.href = result.dataUrl;
    link.download = `tsukeru_anki_${Date.now()}.zip`;
    link.click();
  } catch (err) {
    const fallback = t('vocab_export_failed_short', undefined, 'Export failed');
    alert(t('vocab_export_failed_with_reason', [err.message || fallback], `Export failed: ${err.message || fallback}`));
  } finally {
    btn.textContent = t('vocab_export_audio', undefined, '+ Audio');
    btn.disabled = false;
  }
}

export async function initVocabularyTab() {
  const vocabSearch = document.getElementById('vocabSearch');
  const exportBtn = document.getElementById('exportVocabBtn');
  const exportAudioBtn = document.getElementById('exportAudioBtn');
  const clearBtn = document.getElementById('clearVocabBtn');

  await loadVocabulary();

  vocabSearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
      filteredVocabulary = currentVocabulary;
    } else {
      filteredVocabulary = currentVocabulary.filter(item =>
        item.word.toLowerCase().includes(query) ||
        item.reading.toLowerCase().includes(query) ||
        item.sentence.toLowerCase().includes(query) ||
        getDefinitionText(item).toLowerCase().includes(query)
      );
    }
    renderVocabulary();
  });

  exportBtn.addEventListener('click', exportVocabulary);
  exportAudioBtn.addEventListener('click', exportAnkiAudio);

  clearBtn.addEventListener('click', async () => {
    if (currentVocabulary.length === 0) return;
    if (confirm(t('vocab_clear_confirm', [String(currentVocabulary.length)], `Clear all ${currentVocabulary.length} vocabulary items?`))) {
      await chrome.storage.local.set({ vocabulary: [] });
      await loadVocabulary();
    }
  });
}

// ── Vocab mode tab ────────────────────────────────────────────────────────────

export let vocabModeWords = [];
export let filteredVocabModeWords = [];
export let vocabModeSortMode = 'occurrence';
export let vocabModeJlptFilter = 'all';

export const VM_SORT_MODES = [
  { key: 'occurrence', labelKey: 'vm_sort_occurrence', fallbackLabel: '⏱ Appearance' },
  { key: 'frequency', labelKey: 'vm_sort_frequency', fallbackLabel: '📊 Frequency' },
  { key: 'word', labelKey: 'vm_sort_word', fallbackLabel: '🔤 A-Z' },
  { key: 'jlpt', labelKey: 'vm_sort_jlpt', fallbackLabel: '🎓 Difficulty' },
];

export async function initVocabModeTab() {
  const refreshBtn = document.getElementById('refreshVocabmodeBtn');
  const searchInput = document.getElementById('vocabmodeSearch');
  const sortBtn = document.getElementById('vmSortBtn');

  refreshBtn.addEventListener('click', loadVocabMode);
  searchInput.addEventListener('input', filterVocabMode);

  document.querySelectorAll('.vm-jlpt-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.vm-jlpt-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      vocabModeJlptFilter = pill.dataset.jlpt;
      filterVocabMode();
    });
  });

  sortBtn.addEventListener('click', () => {
    const idx = VM_SORT_MODES.findIndex(m => m.key === vocabModeSortMode);
    vocabModeSortMode = VM_SORT_MODES[(idx + 1) % VM_SORT_MODES.length].key;
    updateSortButton();
    sortVocabMode();
    renderVocabMode();
  });
}

export async function loadVocabMode() {
  const tab = await getActiveTab();
  if (!tab?.id || !isHttpTab(tab.url)) {
    vocabModeWords = [];
    filteredVocabModeWords = [];
    renderVocabMode();
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageWords' });
    if (response?.words) {
      vocabModeWords = response.words;
      filterVocabMode();
    } else {
      vocabModeWords = [];
      filteredVocabModeWords = [];
      renderVocabMode();
    }
  } catch (err) {
    console.error('Failed to get page words:', err);
    vocabModeWords = [];
    filteredVocabModeWords = [];
    renderVocabMode();
  }
}

export function filterVocabMode() {
  const searchQuery = document.getElementById('vocabmodeSearch').value.toLowerCase().trim();
  filteredVocabModeWords = vocabModeWords.filter(word => {
    if (vocabModeJlptFilter !== 'all' && String(word.jlpt) !== vocabModeJlptFilter) return false;
    if (searchQuery && !word.word.toLowerCase().includes(searchQuery) &&
        !(word.reading || '').toLowerCase().includes(searchQuery) &&
        !(word.altReadings || '').toLowerCase().includes(searchQuery)) return false;
    return true;
  });
  sortVocabMode();
  renderVocabMode();
}

export function sortVocabMode() {
  filteredVocabModeWords.sort((a, b) => {
    switch (vocabModeSortMode) {
      case 'frequency':
        return (b.frequency || 0) - (a.frequency || 0);
      case 'word': {
        const wordA = a.word || '';
        const wordB = b.word || '';
        const isNumA = /^[0-9０-９]/.test(wordA);
        const isNumB = /^[0-9０-９]/.test(wordB);
        if (isNumA && !isNumB) return 1;
        if (!isNumA && isNumB) return -1;
        return wordA.localeCompare(wordB, 'ja');
      }
      case 'jlpt': {
        const aJ = a.jlpt ? parseInt(a.jlpt) : 99;
        const bJ = b.jlpt ? parseInt(b.jlpt) : 99;
        return aJ - bJ;
      }
      case 'occurrence':
      default:
        return (a.occurrenceIndex ?? 0) - (b.occurrenceIndex ?? 0);
    }
  });
}

export function updateSortButton() {
  const btn = document.getElementById('vmSortBtn');
  if (!btn) return;
  const mode = VM_SORT_MODES.find(m => m.key === vocabModeSortMode);
  if (mode) btn.textContent = t(mode.labelKey, undefined, mode.fallbackLabel);
}

export async function renderVocabMode() {
  const list = document.getElementById('vocabmodeList');
  const countEl = document.getElementById('vocabmodeCount');
  const emptyEl = document.getElementById('vocabmodeEmpty');

  countEl.textContent = formatCountWithNoun(
    filteredVocabModeWords.length,
    'word_singular',
    'word_plural',
    'vocabmode_count_on_page',
    '{count} {noun} on page'
  );

  if (filteredVocabModeWords.length === 0) {
    list.innerHTML = '';
    emptyEl.classList.add('show');
    return;
  }

  emptyEl.classList.remove('show');

  let savedSet = new Set();
  try {
    const { vocabulary = [] } = await chrome.storage.local.get(['vocabulary']);
    savedSet = new Set(vocabulary.map(v => `${v.word}|${v.reading}`));
  } catch (e) { /* ignore */ }

  list.innerHTML = '';

  filteredVocabModeWords.forEach((word, index) => {
    const isSaved = savedSet.has(`${word.word}|${word.reading}`);
    const freqBadge = (word.frequency > 1)
      ? `<span class="vm-freq-badge">${word.frequency}×</span>` : '';
    const jlptTag = word.jlpt
      ? `<span class="vm-jlpt-tag jlpt-${word.jlpt}">N${word.jlpt}</span>` : '';
    const snippetHtml = word.snippet
      ? `<span class="vm-snippet">${escapeHtml(word.snippet)}</span>` : '';

    const row = document.createElement('div');
    row.className = 'vm-row';
    row.dataset.index = index;
    row.innerHTML = `
      <div class="vm-row-left">
        <div class="vm-word-line">
          <span class="vm-word">${escapeHtml(word.word)}</span>
          <span class="vm-reading">${escapeHtml(word.reading)}</span>
        </div>
        ${snippetHtml}
      </div>
      <div class="vm-row-right">
        ${freqBadge}
        ${jlptTag}
        <div class="vm-actions">
          <button class="vm-action-btn save-btn${isSaved ? ' saved' : ''}" title="${escapeHtml(isSaved ? t('vm_saved', undefined, 'Saved') : t('vm_save_word', undefined, 'Save word'))}">${isSaved ? '✓' : '+'}</button>
          <button class="vm-action-btn play-btn" title="${escapeHtml(t('vm_play_pronunciation', undefined, 'Play pronunciation'))}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
          </button>
          <button class="vm-action-btn jump-btn" title="${escapeHtml(t('vm_jump_to_word', undefined, 'Jump to word on page'))}">↗</button>
          <button class="vm-action-btn report-btn" title="${escapeHtml(t('report_button_title', undefined, 'Report Wrong Reading'))}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
          </button>
        </div>
      </div>
    `;

    row.addEventListener('click', async (e) => {
      if (e.target.closest('.vm-action-btn')) return;
      await scrollToWordOnPage(word);
    });

    row.querySelector('.save-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await addToVocabularyFromVocabMode(word, e.currentTarget);
    });

    row.querySelector('.play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playVocabAudio(word.word, word.reading, e.currentTarget);
    });

    row.querySelector('.jump-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await scrollToWordOnPage(word);
    });

    row.querySelector('.report-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openReportModal(word.word, word.reading, word.snippet || '');
    });

    list.appendChild(row);
  });
}

export async function scrollToWordOnPage(word) {
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isHttpTab(tab.url)) return;
    await chrome.tabs.sendMessage(tab.id, {
      action: 'scrollToWord',
      word: word.word,
      reading: word.reading
    });
  } catch (err) {
    console.error('Failed to scroll to word:', err);
  }
}

export async function addToVocabularyFromVocabMode(word, btn) {
  if (btn.classList.contains('saved')) return;
  try {
    const tab = await getActiveTab();
    let sentence = '';
    if (tab?.id && isHttpTab(tab.url)) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'getWordContext',
          word: word.word,
          reading: word.reading
        });
        if (response?.found && response.sentence) sentence = response.sentence;
      } catch (e) {
        console.warn('Could not get word context:', e);
      }
    }

    const entry = {
      id: generateEntryId(),
      word: word.word,
      reading: word.reading,
      surface: word.surface || word.word,
      surfaceReading: word.reading,
      sentence,
      jlpt: word.jlpt,
      pos: word.pos,
      url: tab?.url || '',
      timestamp: Date.now()
    };

    const result = await chrome.storage.local.get(['vocabulary']);
    const vocabulary = result.vocabulary || [];
    const existingIndex = vocabulary.findIndex(v => v.word === entry.word && v.reading === entry.reading);
    if (existingIndex >= 0) {
      btn.textContent = '✓';
      btn.classList.add('saved');
      btn.title = t('vm_already_saved', undefined, 'Already saved');
      return;
    }

    await attachDefinitionToEntry(entry);
    vocabulary.unshift(entry);
    if (vocabulary.length > 1000) vocabulary.length = 1000;
    await chrome.storage.local.set({ vocabulary });

    btn.textContent = '✓';
    btn.classList.add('saved');
    btn.title = t('vm_saved', undefined, 'Saved');
  } catch (err) {
    console.error('Failed to save word:', err);
    btn.textContent = '!';
  }
}
