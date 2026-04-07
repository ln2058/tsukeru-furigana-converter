/*
Module: popup-settings
Purpose: Manage settings persistence, content-script bootstrapping, and apply/clear actions from popup.

Inputs:
- Settings form events, active-tab info, and stored sync settings.

Outputs:
- Updated settings in storage and apply/clear command messages to content scripts.

Side Effects:
- Reads/writes `chrome.storage.sync`.
- Injects content scripts/CSS, mutates popup status UI, and sends live appearance updates.

Failure Modes:
- Unsupported tabs and local files without browser-granted file access reject apply/clear actions.
- Injection/messaging failures return status errors.

Security Notes:
- Only acts on explicit user-triggered popup interactions.
- Keeps settings/state local to extension storage APIs.
*/
// Settings constants, shared utilities, report modal — imported by all popup modules.
import { hasSupportedLocalFileExtension } from './utils.js';

export const DEFAULT_SETTINGS = {
  jlptLevel: 5,
  furiganaType: 'hiragana',
  firstOccurrenceOnly: false,
  highlightMode: 'off',
  watchDynamic: false,
  removeCustomStyling: false,
  rubySize: 0.65,
  rubyColor: '#475569',
  rubyWeight: 'normal',
};

export const DICTIONARY_MAX_SENSES = 3;
export const DEFINITION_CACHE_TTL = 5 * 60 * 1000;

// ── Shared DOM/tab utilities ──────────────────────────────────────────────────

export function t(key, substitutions, fallback = '') {
  const message = chrome.i18n?.getMessage ? chrome.i18n.getMessage(key, substitutions) : '';
  return message || fallback;
}

export function applyI18nToPopupDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const message = key ? t(key) : '';
    if (message) el.textContent = message;
  });

  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const message = key ? t(key) : '';
    if (message) el.setAttribute('title', message);
  });

  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const message = key ? t(key) : '';
    if (message) el.setAttribute('placeholder', message);
  });
}

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

export function isFileTab(url = '') {
  return /^file:\/\//i.test(url);
}

export function isSupportedPageTab(url = '') {
  if (!/^(https?|file):\/\//i.test(url)) {
    return false;
  }
  if (isFileTab(url)) {
    return hasSupportedLocalFileExtension(url);
  }
  return true;
}

export async function hasFileSchemeAccess() {
  const isAllowed = chrome.extension?.isAllowedFileSchemeAccess;
  if (typeof isAllowed !== 'function') {
    return false;
  }

  return new Promise((resolve) => {
    try {
      isAllowed.call(chrome.extension, (allowed) => resolve(Boolean(allowed)));
    } catch (error) {
      console.warn('Tsukeru: file access check failed', error);
      resolve(false);
    }
  });
}

export async function getUnsupportedTabMessage(url = '') {
  if (isFileTab(url) && !hasSupportedLocalFileExtension(url)) {
    return t(
      'status_open_supported_page',
      undefined,
      'Open an http/https page or a local HTML/XHTML file and try again.'
    );
  }

  if (!/^(https?|file):\/\//i.test(url)) {
    return t(
      'status_open_supported_page',
      undefined,
      'Open an http/https page or a local HTML/XHTML file and try again.'
    );
  }

  if (isFileTab(url) && !(await hasFileSchemeAccess())) {
    return t(
      'status_enable_file_access',
      undefined,
      "To use Tsukeru on local files, enable 'Allow access to file URLs' in the extension details page."
    );
  }

  return '';
}

export function getSelectedHighlightMode() {
  const selected = Array.from(document.querySelectorAll('input[name="highlightMode"]'))
    .find(radio => radio.checked);
  return selected?.value || DEFAULT_SETTINGS.highlightMode;
}

export async function ensureContentScript(tabId) {
  if (!chrome.scripting) return;

  // Manifest already injects content scripts on supported pages.
  // Probe first so popup-driven apply does not double-inject and redeclare consts.
  // ⚠️ This error-message check is fragile: browser wording can change across
  // versions/locales. The guard in content-main.js (window.__TSUKERU_LOADED__)
  // provides a second line of defense if this check misses.
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'getFuriganaState' });
    return;
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    const noReceiver =
      message.includes('receiving end does not exist') ||
      message.includes('could not establish connection');
    if (!noReceiver) {
      throw error;
    }
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch (e) {
    console.warn('insertCSS failed (may be fine):', e);
  }
  for (const file of ['js/content-dom.js', 'js/content-tooltip.js', 'js/content-main.js']) {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
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
  submitBtn.textContent = t('report_submit_button', undefined, 'Submit Report');
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
  const removeCustomStylingCheckbox = document.getElementById('removeCustomStyling');
  const highlightRadios = document.querySelectorAll('input[name="highlightMode"]');
  const rubySizeInput = document.getElementById('rubySize');
  const rubyColorInput = document.getElementById('rubyColor');
  const rubyWeightSelect = document.getElementById('rubyWeight');
  const rubySizeValue = document.getElementById('rubySizeValue');

  // Load stored settings
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  jlptSelect.value = String(stored.jlptLevel ?? DEFAULT_SETTINGS.jlptLevel);
  furiganaTypeSelect.value = stored.furiganaType || DEFAULT_SETTINGS.furiganaType;
  firstOccurrenceCheckbox.checked = stored.firstOccurrenceOnly ?? DEFAULT_SETTINGS.firstOccurrenceOnly;
  watchDynamicCheckbox.checked = stored.watchDynamic ?? DEFAULT_SETTINGS.watchDynamic;
  removeCustomStylingCheckbox.checked = stored.removeCustomStyling ?? DEFAULT_SETTINGS.removeCustomStyling;
  const selectedHighlight = stored.highlightMode || DEFAULT_SETTINGS.highlightMode;
  highlightRadios.forEach(radio => {
    radio.checked = radio.value === selectedHighlight;
  });
  rubySizeInput.value = String(stored.rubySize ?? DEFAULT_SETTINGS.rubySize);
  rubySizeValue.textContent = `${parseFloat(rubySizeInput.value).toFixed(2)}em`;
  rubyColorInput.value = stored.rubyColor || DEFAULT_SETTINGS.rubyColor;
  rubyWeightSelect.value = stored.rubyWeight || DEFAULT_SETTINGS.rubyWeight;

  // Auto-save on any change
  const saveSettings = async () => {
    const settings = {
      jlptLevel: Number(jlptSelect.value || DEFAULT_SETTINGS.jlptLevel),
      furiganaType: furiganaTypeSelect.value || DEFAULT_SETTINGS.furiganaType,
      firstOccurrenceOnly: Boolean(firstOccurrenceCheckbox.checked),
      highlightMode: getSelectedHighlightMode(),
      watchDynamic: Boolean(watchDynamicCheckbox.checked),
      removeCustomStyling: Boolean(removeCustomStylingCheckbox.checked),
      rubySize: parseFloat(rubySizeInput.value) || DEFAULT_SETTINGS.rubySize,
      rubyColor: rubyColorInput.value || DEFAULT_SETTINGS.rubyColor,
      rubyWeight: rubyWeightSelect.value || DEFAULT_SETTINGS.rubyWeight,
    };
    await chrome.storage.sync.set(settings);
    const tab = await getActiveTab();
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'updateAppearance',
        color: settings.rubyColor,
        size: `${settings.rubySize.toFixed(2)}em`,
        weight: settings.rubyWeight,
        removeCustomStyling: settings.removeCustomStyling,
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
  removeCustomStylingCheckbox.addEventListener('change', saveSettings);
  highlightRadios.forEach(radio => {
    radio.addEventListener('change', saveSettings);
  });
  rubySizeInput.addEventListener('input', () => {
    rubySizeValue.textContent = `${parseFloat(rubySizeInput.value).toFixed(2)}em`;
    saveSettings();
  });
  rubyColorInput.addEventListener('input', saveSettings);
  rubyColorInput.addEventListener('change', saveSettings);
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
      removeCustomStyling: Boolean(removeCustomStylingCheckbox.checked),
      rubySize: parseFloat(rubySizeInput.value) || DEFAULT_SETTINGS.rubySize,
      rubyColor: rubyColorInput.value || DEFAULT_SETTINGS.rubyColor,
      rubyWeight: rubyWeightSelect.value || DEFAULT_SETTINGS.rubyWeight,
    };
    await chrome.storage.sync.set(settings);
    const tab = await getActiveTab();
    const unsupportedMessage = await getUnsupportedTabMessage(tab?.url || '');
    if (!tab?.id || unsupportedMessage) {
      setStatus(
        unsupportedMessage || t(
          'status_open_supported_page',
          undefined,
          'Open an http/https page or local HTML file and try again.'
        ),
        'error'
      );
      return;
    }
    try {
      await ensureContentScript(tab.id);
      setStatus(t('status_processing', undefined, 'Processing...'), 'info');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings });
      if (response?.ok) {
        setStatus(t('status_furigana_applied', undefined, 'Furigana applied'), 'success');
      } else {
        throw new Error(response?.error || 'Unknown error');
      }
    } catch (err) {
      console.error(err);
      const reason = err.message || t('status_could_not_reach_page', undefined, 'Could not reach page');
      setStatus(t('status_failed_with_reason', [reason], `Failed: ${reason}`), 'error');
    }
  }

  async function clearFuriganaFromPage() {
    const tab = await getActiveTab();
    const unsupportedMessage = await getUnsupportedTabMessage(tab?.url || '');
    if (!tab?.id || unsupportedMessage) {
      setStatus(
        unsupportedMessage || t(
          'status_open_supported_page',
          undefined,
          'Open an http/https page or local HTML file and try again.'
        ),
        'error'
      );
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'clearFurigana' });
      setStatus(t('status_furigana_cleared', undefined, 'Furigana cleared'), 'success');
    } catch (err) {
      console.error(err);
      setStatus(t('status_reload_and_retry', undefined, 'Could not reach the page. Try reloading and retry.'), 'error');
    }
  }
}
