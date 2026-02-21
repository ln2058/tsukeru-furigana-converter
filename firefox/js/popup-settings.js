// Settings constants, shared utilities, report modal — imported by all popup modules.

export const DEFAULT_SETTINGS = {
  jlptLevel: 5,
  furiganaType: 'hiragana',
  firstOccurrenceOnly: false,
  highlightMode: 'off',
  watchDynamic: false,
  rubySize: 0.65,
  rubyColor: '#475569',
  rubyWeight: 'normal',
};

export const DICTIONARY_MAX_SENSES = 3;
export const DEFINITION_CACHE_TTL = 5 * 60 * 1000;

// ── Shared DOM/tab utilities ──────────────────────────────────────────────────

export function setStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = `status ${type === 'error' ? 'error' : 'success'}`;
  el.style.display = 'block';
}

export async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0];
}

export function isHttpTab(url = '') {
  return /^https?:\/\//i.test(url);
}

export function getSelectedHighlightMode() {
  const selected = Array.from(document.querySelectorAll('input[name="highlightMode"]'))
    .find(radio => radio.checked);
  return selected?.value || DEFAULT_SETTINGS.highlightMode;
}

export async function ensureContentScript(tabId) {
  if (chrome.scripting) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    } catch (e) {
      console.warn('insertCSS failed (may be fine):', e);
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['js/content-dom.js', 'js/content-tooltip.js', 'js/content-main.js']
    });
  }
}

// ── Report modal ──────────────────────────────────────────────────────────────

export function openReportModal(word, reading, context) {
  document.getElementById('extReportWord').value = word || '';
  document.getElementById('extReportReading').value = reading || '';
  document.getElementById('extReportContext').value = context || '';
  document.getElementById('extReportCorrect').value = '';
  document.getElementById('extReportError').classList.add('hidden');
  document.getElementById('extReportSuccess').classList.add('hidden');
  document.getElementById('extReportError').textContent = '';
  document.getElementById('extReportSuccess').textContent = '';
  const submitBtn = document.getElementById('extReportSubmit');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Submit Report';
  const modal = document.getElementById('extReportModal');
  modal.classList.remove('hidden');
  requestAnimationFrame(() => modal.classList.add('show'));
}

export function closeReportModal() {
  const modal = document.getElementById('extReportModal');
  modal.classList.remove('show');
  setTimeout(() => modal.classList.add('hidden'), 200);
}

// ── Settings form ─────────────────────────────────────────────────────────────

export async function initSettingsForm() {
  const applyBtn = document.getElementById('applyBtn');
  const clearBtn = document.getElementById('clearBtn');
  const jlptSelect = document.getElementById('jlptLevel');
  const furiganaTypeSelect = document.getElementById('furiganaType');
  const firstOccurrenceCheckbox = document.getElementById('firstOccurrenceOnly');
  const watchDynamicCheckbox = document.getElementById('watchDynamic');
  const highlightRadios = document.querySelectorAll('input[name="highlightMode"]');
  const rubySizeInput = document.getElementById('rubySize');
  const rubyColorPalette = document.getElementById('rubyColorPalette');
  const rubyWeightSelect = document.getElementById('rubyWeight');
  const rubySizeValue = document.getElementById('rubySizeValue');

  // Load stored settings
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  jlptSelect.value = String(stored.jlptLevel ?? DEFAULT_SETTINGS.jlptLevel);
  furiganaTypeSelect.value = stored.furiganaType || DEFAULT_SETTINGS.furiganaType;
  firstOccurrenceCheckbox.checked = stored.firstOccurrenceOnly ?? DEFAULT_SETTINGS.firstOccurrenceOnly;
  watchDynamicCheckbox.checked = stored.watchDynamic ?? DEFAULT_SETTINGS.watchDynamic;
  const selectedHighlight = stored.highlightMode || DEFAULT_SETTINGS.highlightMode;
  highlightRadios.forEach(radio => {
    radio.checked = radio.value === selectedHighlight;
  });
  rubySizeInput.value = String(stored.rubySize ?? DEFAULT_SETTINGS.rubySize);
  rubySizeValue.textContent = `${parseFloat(rubySizeInput.value).toFixed(2)}em`;
  const initialColor = stored.rubyColor || DEFAULT_SETTINGS.rubyColor;
  rubyColorPalette.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.classList.toggle('selected', swatch.dataset.color === initialColor);
  });
  rubyWeightSelect.value = stored.rubyWeight || DEFAULT_SETTINGS.rubyWeight;

  // Auto-save on any change
  const saveSettings = async () => {
    const activeColor = rubyColorPalette.querySelector('.color-swatch.selected')?.dataset.color || DEFAULT_SETTINGS.rubyColor;
    const activeSize = `${parseFloat(rubySizeInput.value).toFixed(2)}em`;
    const activeWeight = rubyWeightSelect.value || DEFAULT_SETTINGS.rubyWeight;
    const settings = {
      jlptLevel: Number(jlptSelect.value || DEFAULT_SETTINGS.jlptLevel),
      furiganaType: furiganaTypeSelect.value || DEFAULT_SETTINGS.furiganaType,
      firstOccurrenceOnly: Boolean(firstOccurrenceCheckbox.checked),
      highlightMode: getSelectedHighlightMode(),
      watchDynamic: Boolean(watchDynamicCheckbox.checked),
      rubySize: parseFloat(rubySizeInput.value) || DEFAULT_SETTINGS.rubySize,
      rubyColor: activeColor,
      rubyWeight: activeWeight,
    };
    await chrome.storage.sync.set(settings);
    const tab = await getActiveTab();
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'updateAppearance',
        color: activeColor,
        size: activeSize,
        weight: activeWeight,
      }).catch(() => {});
    }
  };

  jlptSelect.addEventListener('change', async () => {
    await saveSettings();
    const tab = await getActiveTab();
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'updateJLPT', level: jlptSelect.value }).catch(() => {});
    }
  });
  furiganaTypeSelect.addEventListener('change', saveSettings);
  firstOccurrenceCheckbox.addEventListener('change', saveSettings);
  watchDynamicCheckbox.addEventListener('change', saveSettings);
  highlightRadios.forEach(radio => {
    radio.addEventListener('change', saveSettings);
  });
  rubySizeInput.addEventListener('input', () => {
    rubySizeValue.textContent = `${parseFloat(rubySizeInput.value).toFixed(2)}em`;
    saveSettings();
  });
  rubyColorPalette.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      rubyColorPalette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      saveSettings();
    });
  });
  rubyWeightSelect.addEventListener('change', saveSettings);

  applyBtn.addEventListener('click', async () => {
    await applyFuriganaToPage();
  });
  clearBtn.addEventListener('click', async () => {
    await clearFuriganaFromPage();
  });

  async function applyFuriganaToPage() {
    const settings = {
      jlptLevel: Number(jlptSelect.value || DEFAULT_SETTINGS.jlptLevel),
      furiganaType: furiganaTypeSelect.value || DEFAULT_SETTINGS.furiganaType,
      firstOccurrenceOnly: Boolean(firstOccurrenceCheckbox.checked),
      highlightMode: getSelectedHighlightMode(),
      watchDynamic: Boolean(watchDynamicCheckbox.checked),
      rubySize: parseFloat(rubySizeInput.value) || DEFAULT_SETTINGS.rubySize,
      rubyColor: rubyColorPalette.querySelector('.color-swatch.selected')?.dataset.color || DEFAULT_SETTINGS.rubyColor,
      rubyWeight: rubyWeightSelect.value || DEFAULT_SETTINGS.rubyWeight,
    };
    await chrome.storage.sync.set(settings);
    const tab = await getActiveTab();
    if (!tab?.id || !isHttpTab(tab.url)) {
      setStatus('Open a normal http/https page and try again.', 'error');
      return;
    }
    try {
      await ensureContentScript(tab.id);
      setStatus('Processing...', 'info');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings });
      if (response?.ok) {
        setStatus('Furigana applied', 'success');
      } else {
        throw new Error(response?.error || 'Unknown error');
      }
    } catch (err) {
      console.error(err);
      setStatus('Failed: ' + (err.message || 'Could not reach page'), 'error');
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
    } catch (err) {
      console.error(err);
      setStatus('Could not reach the page. Try reloading and retry.', 'error');
    }
  }
}
