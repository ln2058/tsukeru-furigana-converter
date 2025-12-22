const DEFAULT_SETTINGS = {
  jlptLevel: 5,
  furiganaType: 'hiragana',
  firstOccurrenceOnly: false,
  highlightMode: 'off',
  watchDynamic: false,
};
const DICTIONARY_MAX_SENSES = 3;
const DEFINITION_CACHE_TTL = 5 * 60 * 1000;
const definitionCache = new Map();

document.addEventListener('DOMContentLoaded', () => {
  initSettingsForm();
  initVocabularyTab();
  initVocabModeTab();
  initTabNavigation();
});

function generateEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getEntryId(item) {
  if (item?.id) return item.id;
  return `${item?.word || ''}::${item?.reading || ''}::${item?.timestamp || ''}::${item?.url || ''}`;
}

async function initSettingsForm() {
  const applyBtn = document.getElementById('applyBtn');
  const clearBtn = document.getElementById('clearBtn');
  const jlptSelect = document.getElementById('jlptLevel');
  const furiganaTypeSelect = document.getElementById('furiganaType');
  const firstOccurrenceCheckbox = document.getElementById('firstOccurrenceOnly');
  const watchDynamicCheckbox = document.getElementById('watchDynamic');
  const highlightRadios = document.querySelectorAll('input[name="highlightMode"]');
  const toggleStatus = document.getElementById('toggleStatus');
  const toggleIcon = document.getElementById('toggleIcon');

  // Load settings
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  jlptSelect.value = String(stored.jlptLevel ?? DEFAULT_SETTINGS.jlptLevel);
  furiganaTypeSelect.value = stored.furiganaType || DEFAULT_SETTINGS.furiganaType;
  firstOccurrenceCheckbox.checked = stored.firstOccurrenceOnly ?? DEFAULT_SETTINGS.firstOccurrenceOnly;
  watchDynamicCheckbox.checked = stored.watchDynamic ?? DEFAULT_SETTINGS.watchDynamic;
  const selectedHighlight = stored.highlightMode || DEFAULT_SETTINGS.highlightMode;
  highlightRadios.forEach(radio => {
    radio.checked = radio.value === selectedHighlight;
  });

  // Auto-save settings on change
  const saveSettings = async () => {
    const settings = {
      jlptLevel: Number(jlptSelect.value || DEFAULT_SETTINGS.jlptLevel),
      furiganaType: furiganaTypeSelect.value || DEFAULT_SETTINGS.furiganaType,
      firstOccurrenceOnly: Boolean(firstOccurrenceCheckbox.checked),
      highlightMode: getSelectedHighlightMode(),
      watchDynamic: Boolean(watchDynamicCheckbox.checked),
    };
    await chrome.storage.sync.set(settings);
  };

  jlptSelect.addEventListener('change', saveSettings);
  furiganaTypeSelect.addEventListener('change', saveSettings);
  firstOccurrenceCheckbox.addEventListener('change', saveSettings);
  watchDynamicCheckbox.addEventListener('change', saveSettings);
  highlightRadios.forEach(radio => {
    radio.addEventListener('change', saveSettings);
  });

  // Apply button
  applyBtn.addEventListener('click', async () => {
    await applyFuriganaToPage();
  });

  // Clear button
  clearBtn.addEventListener('click', async () => {
    await clearFuriganaFromPage();
  });

  function updateToggleUI(isActive) {
    if (toggleStatus) toggleStatus.textContent = '';
    if (toggleIcon) toggleIcon.textContent = '';
  }

  async function applyFuriganaToPage() {
    const settings = {
      jlptLevel: Number(jlptSelect.value || DEFAULT_SETTINGS.jlptLevel),
      furiganaType: furiganaTypeSelect.value || DEFAULT_SETTINGS.furiganaType,
      firstOccurrenceOnly: Boolean(firstOccurrenceCheckbox.checked),
      highlightMode: getSelectedHighlightMode(),
      watchDynamic: Boolean(watchDynamicCheckbox.checked),
    };

    await chrome.storage.sync.set(settings);
    const tab = await getActiveTab();
    if (!tab?.id || !isHttpTab(tab.url)) {
      setStatus('Open a normal http/https page and try again.', 'error');
      updateToggleUI(false);
      return;
    }

    try {
      await ensureContentScript(tab.id);
      setStatus('Processing...', 'info');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings });
      if (response?.ok) {
        setStatus('Furigana applied', 'success');
        updateToggleUI(true);
      } else {
        throw new Error(response?.error || 'Unknown error');
      }
    } catch (err) {
      console.error(err);
      setStatus('Failed: ' + (err.message || 'Could not reach page'), 'error');
      updateToggleUI(false);
    }
  }

  async function clearFuriganaFromPage() {
    const tab = await getActiveTab();
    if (!tab?.id || !isHttpTab(tab.url)) {
      setStatus('Open a normal http/https page and try again.', 'error');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'clearFurigana' });
      setStatus('Furigana cleared', 'success');
      updateToggleUI(false);
    } catch (err) {
      console.error(err);
      setStatus('Could not reach the page. Try reloading and retry.', 'error');
    }
  }
}

function setStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = `status ${type === 'error' ? 'error' : 'success'}`;
  el.style.display = 'block';
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0];
}

function isHttpTab(url = '') {
  return /^https?:\/\//i.test(url);
}

function getSelectedHighlightMode() {
  const selected = Array.from(document.querySelectorAll('input[name="highlightMode"]'))
    .find(radio => radio.checked);
  return selected?.value || DEFAULT_SETTINGS.highlightMode;
}

async function ensureContentScript(tabId) {
  // Content script is declared in manifest; still, explicitly inject to handle pages loaded before install.
  if (chrome.scripting) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    } catch (e) {
      console.warn('insertCSS failed (may be fine):', e);
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

// ============================================================================
// TAB NAVIGATION
// ============================================================================

function initTabNavigation() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;

      // Update active states
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`${targetTab}-tab`).classList.add('active');

      // Reload data when switching tabs
      if (targetTab === 'vocabulary') {
        loadVocabulary();
      } else if (targetTab === 'vocabmode') {
        loadVocabMode();
      }
    });
  });
}

// ============================================================================
// VOCABULARY TAB
// ============================================================================

let currentVocabulary = [];
let filteredVocabulary = [];

async function initVocabularyTab() {
  const vocabSearch = document.getElementById('vocabSearch');
  const exportBtn = document.getElementById('exportVocabBtn');
  const clearBtn = document.getElementById('clearVocabBtn');

  // Load vocabulary
  await loadVocabulary();

  // Search functionality
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

  // Export functionality
  exportBtn.addEventListener('click', exportVocabulary);

  // Clear all functionality
  clearBtn.addEventListener('click', async () => {
    if (currentVocabulary.length === 0) return;

    if (confirm(`Clear all ${currentVocabulary.length} vocabulary items?`)) {
      await chrome.storage.local.set({ vocabulary: [] });
      await loadVocabulary();
    }
  });
}

async function loadVocabulary() {
  try {
    const result = await chrome.storage.local.get(['vocabulary']);
    currentVocabulary = result.vocabulary || [];
    filteredVocabulary = currentVocabulary;
    renderVocabulary();
  } catch (err) {
    console.error('Failed to load vocabulary:', err);
  }
}

function renderVocabulary() {
  const vocabList = document.getElementById('vocabList');
  const vocabCount = document.getElementById('vocabCount');

  // Update count
  vocabCount.textContent = `${currentVocabulary.length} word${currentVocabulary.length !== 1 ? 's' : ''} saved`;

  // Clear list
  vocabList.innerHTML = '';

  if (filteredVocabulary.length === 0) {
    if (currentVocabulary.length === 0) {
      // No vocabulary at all
      vocabList.innerHTML = `
        <div class="vocab-empty">
          <div class="vocab-empty-text">No vocabulary saved yet</div>
          <div class="vocab-empty-hint">Double-click any word with furigana to save it</div>
        </div>
      `;
    } else {
      // Search returned no results
      vocabList.innerHTML = `
        <div class="vocab-empty">
          <div class="vocab-empty-text">No results found</div>
        </div>
      `;
    }
    return;
  }

  // Render vocabulary items
  filteredVocabulary.forEach((item, index) => {
    const itemEl = createVocabItem(item, index);
    vocabList.appendChild(itemEl);
  });
}

function createVocabItem(item, index) {
  const div = document.createElement('div');
  div.className = 'vocab-item';
  const entryId = getEntryId(item);

  // Format JLPT level
  const jlptText = item.jlpt ? `N${item.jlpt}` : '';
  const jlptClass = item.jlpt ? ` jlpt-${item.jlpt}` : '';

  // Format part of speech
  const posText = item.pos || '';

  // Format date
  const date = new Date(item.timestamp);
  const dateStr = date.toLocaleDateString();

  // Extract domain from URL
  let urlDisplay = '';
  try {
    const url = new URL(item.url);
    urlDisplay = url.hostname;
  } catch (e) {
    urlDisplay = 'Unknown source';
  }

  const definitionText = getDefinitionText(item);
  const definitionHtml = definitionText ? `<div class="vocab-definition">${escapeHtml(definitionText)}</div>` : '';

  // IMPORTANT: Render the sentence with proper furigana
  // The sentence is stored as HTML with ruby tags, so we use innerHTML
  // Also provide a parentheses fallback in case ruby tags don't render
  const sentenceHtml = renderSentenceWithFurigana(item.sentence, item);

  div.innerHTML = `
    <div class="vocab-item-header">
      <div class="vocab-word">${escapeHtml(item.word)}</div>
      <div class="vocab-reading">${escapeHtml(item.reading)}</div>
    </div>
    ${(jlptText || posText) ? `
      <div class="vocab-meta">
        ${jlptText ? `<span class="vocab-badge jlpt${jlptClass}">${jlptText}</span>` : ''}
        ${posText ? `<span class="vocab-badge pos">${escapeHtml(posText)}</span>` : ''}
      </div>
    ` : ''}
    ${definitionHtml}
    <div class="vocab-sentence">${sentenceHtml}</div>
    <div class="vocab-footer">
      <a href="${escapeHtml(item.url)}" class="vocab-url" target="_blank" title="${escapeHtml(item.url)}">${escapeHtml(urlDisplay)} &middot; ${dateStr}</a>
      <button class="vocab-delete" data-id="${escapeHtml(entryId)}">Delete</button>
    </div>
  `;

  // Add delete handler
  const deleteBtn = div.querySelector('.vocab-delete');
  deleteBtn.addEventListener('click', async () => {
    const id = deleteBtn.dataset.id;
    await deleteVocabItem(id);
  });

  return div;
}

function renderSentenceWithFurigana(sentenceHtml, item) {
  if (!sentenceHtml) return '';
  return highlightSavedWordInSentence(sentenceHtml, item);
}

function highlightSavedWordInSentence(sentenceHtml, item) {
  const temp = document.createElement('div');
  temp.innerHTML = sentenceHtml;

  const targetWord = (item?.word || '').trim();
  const targetSurface = (item?.surface || '').trim();
  const targetReading = (item?.reading || '').trim();

  // Prefer highlighting ruby entries so furigana stays intact
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
    return temp.innerHTML;
  }

  // Fallback: wrap the first plain-text occurrence
  const targets = [targetWord, targetSurface].filter(Boolean);
  if (targets.length === 0) return temp.innerHTML;

  const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT);
  let node;

  while ((node = walker.nextNode())) {
    const parentTag = node.parentElement?.tagName?.toLowerCase();
    if (parentTag === 'rt') continue; // don't break readings

    const content = node.textContent || '';
    const matchTarget = targets.find(t => t && content.includes(t));
    if (!matchTarget) continue;

    const idx = content.indexOf(matchTarget);
    const frag = document.createDocumentFragment();
    if (idx > 0) {
      frag.appendChild(document.createTextNode(content.slice(0, idx)));
    }

    const highlight = document.createElement('span');
    highlight.className = 'saved-word-highlight';
    highlight.textContent = matchTarget;
    frag.appendChild(highlight);

    const tail = content.slice(idx + matchTarget.length);
    if (tail) {
      frag.appendChild(document.createTextNode(tail));
    }

    node.parentNode.replaceChild(frag, node);
    break;
  }

  return temp.innerHTML;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getDefinitionText(item) {
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

async function lookupDefinition(word) {
  const term = (word || '').trim();
  if (!term) return null;

  const now = Date.now();
  const cached = definitionCache.get(term);
  if (cached && now - cached.timestamp < DEFINITION_CACHE_TTL) {
    return cached.data;
  }

  const response = await chrome.runtime.sendMessage({ action: 'lookupDefinition', word: term });
  if (!response?.success) {
    throw new Error(response?.error || 'Definition lookup failed');
  }

  const data = response.data;
  definitionCache.set(term, { data, timestamp: now });
  return data;
}

async function attachDefinitionToEntry(entry) {
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
      if (!entry.reading && normalized.reading) {
        entry.reading = normalized.reading;
      }
    }
  } catch (err) {
    console.warn('Could not attach dictionary data to vocab entry', err);
  }
}

async function deleteVocabItem(entryId) {
  try {
    const index = currentVocabulary.findIndex(item => getEntryId(item) === entryId);
    if (index < 0) return;

    // Remove item from current vocabulary
    currentVocabulary.splice(index, 1);

    // Save back to storage
    await chrome.storage.local.set({ vocabulary: currentVocabulary });

    // Reload display
    filteredVocabulary = currentVocabulary;
    renderVocabulary();
  } catch (err) {
    console.error('Failed to delete vocabulary item:', err);
    alert('Failed to delete item');
  }
}

function exportVocabulary() {
  if (currentVocabulary.length === 0) {
    alert('No vocabulary to export');
    return;
  }

  // Create CSV with proper ruby tag handling
  const headers = ['Word', 'Reading', 'Definition', 'Sentence (with furigana)', 'Sentence (plain text)', 'JLPT', 'Part of Speech', 'URL', 'Date'];
  const rows = [headers];

  currentVocabulary.forEach(item => {
    // Convert sentence HTML to plain text for one column
    const temp = document.createElement('div');
    temp.innerHTML = item.sentence;

    // Plain text version with parentheses
    const sentenceWithParens = convertRubyToParentheses(item.sentence);
    const sentencePlain = temp.textContent;

    const date = new Date(item.timestamp).toLocaleDateString();
    rows.push([
      item.word,
      item.reading,
      getDefinitionText(item),
      sentenceWithParens, // Sentence with readings in parentheses
      sentencePlain, // Plain text without readings
      item.jlpt ? `N${item.jlpt}` : '',
      item.pos || '',
      item.url,
      date
    ]);
  });

  // Convert to CSV
  const csv = rows.map(row =>
    row.map(cell => {
      // Escape quotes and wrap in quotes if contains comma/quote/newline
      const escaped = String(cell).replace(/"/g, '""');
      return /[",\n]/.test(cell) ? `"${escaped}"` : escaped;
    }).join(',')
  ).join('\n');

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tsukeru-vocabulary-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function convertRubyToParentheses(html) {
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

// ============================================================================
// VOCAB MODE TAB
// ============================================================================

let vocabModeWords = [];
let filteredVocabModeWords = [];
let vocabModeSortColumn = 'word';
let vocabModeSortDirection = 'asc';

async function initVocabModeTab() {
  const refreshBtn = document.getElementById('refreshVocabmodeBtn');
  const jlptFilter = document.getElementById('vocabmodeJlptFilter');
  const posFilter = document.getElementById('vocabmodePosFilter');
  const searchInput = document.getElementById('vocabmodeSearch');

  // Refresh button
  refreshBtn.addEventListener('click', loadVocabMode);

  // Filters
  jlptFilter.addEventListener('change', filterVocabMode);
  posFilter.addEventListener('change', filterVocabMode);
  searchInput.addEventListener('input', filterVocabMode);

  // Sortable headers
  document.querySelectorAll('.vocabmode-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const column = th.dataset.sort;
      if (vocabModeSortColumn === column) {
        vocabModeSortDirection = vocabModeSortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        vocabModeSortColumn = column;
        vocabModeSortDirection = 'asc';
      }
      sortVocabMode();
      renderVocabMode();
      updateSortIndicators();
    });
  });
}

async function loadVocabMode() {
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

function filterVocabMode() {
  const jlptFilter = document.getElementById('vocabmodeJlptFilter').value;
  const posFilter = document.getElementById('vocabmodePosFilter').value;
  const searchQuery = document.getElementById('vocabmodeSearch').value.toLowerCase().trim();

  filteredVocabModeWords = vocabModeWords.filter(word => {
    // JLPT filter
    if (jlptFilter !== 'all' && word.jlpt !== jlptFilter) {
      return false;
    }
    // POS filter
    if (posFilter !== 'all' && word.pos !== posFilter) {
      return false;
    }
    // Search filter
    if (searchQuery && !word.word.toLowerCase().includes(searchQuery) &&
        !word.reading.toLowerCase().includes(searchQuery)) {
      return false;
    }
    return true;
  });

  sortVocabMode();
  renderVocabMode();
}

function sortVocabMode() {
  filteredVocabModeWords.sort((a, b) => {
    let aVal = a[vocabModeSortColumn] || '';
    let bVal = b[vocabModeSortColumn] || '';

    // Handle JLPT sorting numerically
    if (vocabModeSortColumn === 'jlpt') {
      aVal = aVal ? parseInt(aVal) : 6;
      bVal = bVal ? parseInt(bVal) : 6;
    } else if (vocabModeSortColumn === 'frequency') {
      aVal = typeof aVal === 'number' ? aVal : parseInt(aVal || 0, 10) || 0;
      bVal = typeof bVal === 'number' ? bVal : parseInt(bVal || 0, 10) || 0;
    }

    if (aVal < bVal) return vocabModeSortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return vocabModeSortDirection === 'asc' ? 1 : -1;
    return 0;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('.vocabmode-table th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === vocabModeSortColumn) {
      th.classList.add(vocabModeSortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function renderVocabMode() {
  const tbody = document.getElementById('vocabmodeBody');
  const countEl = document.getElementById('vocabmodeCount');
  const emptyEl = document.getElementById('vocabmodeEmpty');

  // Update count
  countEl.textContent = `${filteredVocabModeWords.length} word${filteredVocabModeWords.length !== 1 ? 's' : ''} on page`;

  // Clear table
  tbody.innerHTML = '';

  if (filteredVocabModeWords.length === 0) {
    emptyEl.classList.add('show');
    return;
  }

  emptyEl.classList.remove('show');

  // Render rows
  filteredVocabModeWords.forEach((word, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="word-cell">${escapeHtml(word.word)}</td>
      <td class="reading-cell">${escapeHtml(word.reading)}</td>
      <td class="jlpt-cell">${word.jlpt ? `<span class="jlpt-tag jlpt-${word.jlpt}">N${word.jlpt}</span>` : '-'}</td>
      <td class="pos-cell">${escapeHtml(word.pos || '-')}</td>
      <td class="freq-cell">${word.frequency ?? '-'}</td>
      <td><button class="vocabmode-add-btn" data-index="${index}">+ Save</button></td>
    `;

    // Add click handler for row to scroll and highlight on page
    tr.addEventListener('click', async (e) => {
      // Don't trigger if clicking the save button
      if (e.target.closest('.vocabmode-add-btn')) return;
      await scrollToWordOnPage(word);
    });

    // Add click handler for save button
    const addBtn = tr.querySelector('.vocabmode-add-btn');
    addBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await addToVocabularyFromVocabMode(word, addBtn);
    });

    tbody.appendChild(tr);
  });

  updateSortIndicators();
}

async function scrollToWordOnPage(word) {
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isHttpTab(tab.url)) return;

    // Send message to content script to scroll and highlight
    await chrome.tabs.sendMessage(tab.id, {
      action: 'scrollToWord',
      word: word.word,
      reading: word.reading
    });
  } catch (err) {
    console.error('Failed to scroll to word:', err);
  }
}

async function addToVocabularyFromVocabMode(word, btn) {
  if (btn.classList.contains('added')) return;

  try {
    const tab = await getActiveTab();
    let sentence = '';

    // Try to get the context sentence from the page
    if (tab?.id && isHttpTab(tab.url)) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'getWordContext',
          word: word.word,
          reading: word.reading
        });
        if (response?.found && response.sentence) {
          sentence = response.sentence;
        }
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
      sentence: sentence,
      jlpt: word.jlpt,
      pos: word.pos,
      url: tab?.url || '',
      timestamp: Date.now()
    };

    // Get existing vocabulary
    const result = await chrome.storage.local.get(['vocabulary']);
    const vocabulary = result.vocabulary || [];

    // Check if already exists
    const existingIndex = vocabulary.findIndex(v => v.word === entry.word && v.reading === entry.reading);
    if (existingIndex >= 0) {
      btn.textContent = 'Exists';
      btn.classList.add('added');
      return;
    }

    await attachDefinitionToEntry(entry);

    // Add to vocabulary
    vocabulary.unshift(entry);
    if (vocabulary.length > 1000) vocabulary.length = 1000;

    await chrome.storage.local.set({ vocabulary });

    btn.textContent = 'Saved';
    btn.classList.add('added');
  } catch (err) {
    console.error('Failed to save word:', err);
    btn.textContent = 'Error';
  }
}
