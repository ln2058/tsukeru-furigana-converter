/*
Module: popup-settings
Purpose: Manage instrument-styled popup settings, the live furigana preview, content-script bootstrapping, and apply/clear actions.

Inputs:
- Settings form events, active-tab info, stored sync settings, and browser-specific colour controls.

Outputs:
- Updated settings in storage and apply/clear command messages to content scripts.

Side Effects:
- Reads/writes `chrome.storage.sync`.
- Injects content scripts/CSS in dependency order, updates popup status/preview UI, and sends live appearance updates.

Failure Modes:
- Unsupported tabs reject apply/clear actions.
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

  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria-label');
    const message = key ? t(key) : '';
    if (message) el.setAttribute('aria-label', message);
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
  const statusType = ['info', 'success', 'error'].includes(type) ? type : 'info';
  el.className = `status ${statusType}`;
  el.setAttribute('aria-live', statusType === 'error' ? 'assertive' : 'polite');
  el.style.display = 'block';
}

export async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0];
}

// Compatibility export for popup modules that still import the older helper name.
export function isHttpTab(url = '') {
  return isSupportedPageTab(url);
}

export function isSupportedPageTab(url = '') {
  if (!/^(https?|file):\/\//i.test(url)) {
    return false;
  }
  if (/^file:\/\//i.test(url)) {
    return hasSupportedLocalFileExtension(url);
  }
  return true;
}

export function getUnsupportedTabMessage(url = '') {
  if (/^file:\/\//i.test(url) && !hasSupportedLocalFileExtension(url)) {
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

  return '';
}

export function getSelectedHighlightMode() {
  const selected = Array.from(document.querySelectorAll('input[name="highlightMode"]'))
    .find(radio => radio.checked);
  return selected?.value || DEFAULT_SETTINGS.highlightMode;
}

export async function ensureContentScript(tabId) {
  if (!chrome.scripting) return;

  // Manifest auto-injects content scripts on supported pages.
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
  // Inject the split content scripts in manifest dependency order.
  for (const file of [
    'js/content-ui.js',
    'js/content-rate-limit.js',
    'js/content-dom.js',
    'js/tooltip-async-state.js',
    'js/content-tooltip.js',
    'js/content-main.js',
  ]) {
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
  const rubyColorPalette = document.getElementById('rubyColorPalette');
  const rubyWeightSelect = document.getElementById('rubyWeight');
  const rubySizeValue = document.getElementById('rubySizeValue');
  const preview = document.getElementById('rubyPreview');
  const previewReading = document.getElementById('rubyPreviewReading');
  let rateLimitInterval = null;

  function formatCooldown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  async function refreshRateLimitState() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getRateLimitState' });
      const record = response?.state?.furigana;
      const expiresAt = Number(record?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        applyBtn.disabled = false;
        if (rateLimitInterval) clearInterval(rateLimitInterval);
        rateLimitInterval = null;
        return false;
      }
      const render = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          applyBtn.disabled = false;
          setStatus(t('rate_limit_ready', undefined, 'Ready to retry.'), 'success');
          if (rateLimitInterval) clearInterval(rateLimitInterval);
          rateLimitInterval = null;
          return;
        }
        applyBtn.disabled = true;
        setStatus(t('rate_limit_wait', [formatCooldown(remaining)], `Furigana paused. Try again in ${formatCooldown(remaining)}.`), 'info');
      };
      render();
      if (rateLimitInterval) clearInterval(rateLimitInterval);
      rateLimitInterval = setInterval(render, 1000);
      return true;
    } catch (_) {
      applyBtn.disabled = false;
      return false;
    }
  }

  function updateColorSwatchSelection(activeColor) {
    rubyColorPalette.querySelectorAll('.color-swatch').forEach(swatch => {
      const selected = swatch.dataset.color === activeColor;
      swatch.classList.toggle('selected', selected);
      swatch.setAttribute('aria-pressed', String(selected));
    });
  }

  function updateAppearancePreview() {
    if (!preview) return;
    const size = parseFloat(rubySizeInput.value) || DEFAULT_SETTINGS.rubySize;
    const color = rubyColorPalette.querySelector('.color-swatch.selected')?.dataset.color || DEFAULT_SETTINGS.rubyColor;
    const weight = rubyWeightSelect.value || DEFAULT_SETTINGS.rubyWeight;
    preview.style.setProperty('--preview-ruby-size', `${size}em`);
    preview.style.setProperty('--preview-ruby-color', color);
    preview.style.setProperty('--preview-ruby-weight', weight);
    if (previewReading) {
      previewReading.textContent = furiganaTypeSelect.value === 'katakana'
        ? 'カンジ'
        : furiganaTypeSelect.value === 'romaji'
          ? 'kanji'
          : 'かんじ';
    }
  }

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
  const initialColor = stored.rubyColor || DEFAULT_SETTINGS.rubyColor;
  updateColorSwatchSelection(initialColor);
  rubyWeightSelect.value = stored.rubyWeight || DEFAULT_SETTINGS.rubyWeight;
  updateAppearancePreview();
  await refreshRateLimitState();

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
      removeCustomStyling: Boolean(removeCustomStylingCheckbox.checked),
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
  furiganaTypeSelect.addEventListener('change', () => {
    updateAppearancePreview();
    saveSettings();
  });
  firstOccurrenceCheckbox.addEventListener('change', saveSettings);
  watchDynamicCheckbox.addEventListener('change', saveSettings);
  removeCustomStylingCheckbox.addEventListener('change', saveSettings);
  highlightRadios.forEach(radio => {
    radio.addEventListener('change', saveSettings);
  });
  rubySizeInput.addEventListener('input', () => {
    rubySizeValue.textContent = `${parseFloat(rubySizeInput.value).toFixed(2)}em`;
    updateAppearancePreview();
    saveSettings();
  });
  rubyColorPalette.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      updateColorSwatchSelection(swatch.dataset.color);
      updateAppearancePreview();
      saveSettings();
    });
  });
  rubyWeightSelect.addEventListener('change', () => {
    updateAppearancePreview();
    saveSettings();
  });

  applyBtn.addEventListener('click', async () => {
    await applyFuriganaToPage();
  });
  clearBtn.addEventListener('click', async () => {
    await clearFuriganaFromPage();
  });

  async function applyFuriganaToPage() {
    await refreshRateLimitState();
    if (applyBtn.disabled) return;
    const settings = {
      jlptLevel: Number(jlptSelect.value || DEFAULT_SETTINGS.jlptLevel),
      furiganaType: furiganaTypeSelect.value || DEFAULT_SETTINGS.furiganaType,
      firstOccurrenceOnly: Boolean(firstOccurrenceCheckbox.checked),
      highlightMode: getSelectedHighlightMode(),
      watchDynamic: Boolean(watchDynamicCheckbox.checked),
      removeCustomStyling: Boolean(removeCustomStylingCheckbox.checked),
      rubySize: parseFloat(rubySizeInput.value) || DEFAULT_SETTINGS.rubySize,
      rubyColor: rubyColorPalette.querySelector('.color-swatch.selected')?.dataset.color || DEFAULT_SETTINGS.rubyColor,
      rubyWeight: rubyWeightSelect.value || DEFAULT_SETTINGS.rubyWeight,
    };
    await chrome.storage.sync.set(settings);
    const tab = await getActiveTab();
    const unsupportedMessage = getUnsupportedTabMessage(tab?.url || '');
    if (!tab?.id || unsupportedMessage) {
      setStatus(
        unsupportedMessage || t('status_open_supported_page', undefined, 'Open an http/https page or local HTML file and try again.'),
        'error'
      );
      return;
    }
    try {
      await ensureContentScript(tab.id);
      setStatus(t('status_processing', undefined, 'Processing...'), 'info');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings });
      if (response?.ok) {
        setStatus(
          response.pending
            ? t('status_waiting_for_content', undefined, 'Waiting for page content...')
            : t('status_furigana_applied', undefined, 'Furigana applied'),
          response.pending ? 'info' : 'success'
        );
      } else {
        const structuredFailure = response?.rateLimitType
          || response?.errorCode === 'service_unavailable'
          || response?.status === 429
          || response?.status === 503;
        if (structuredFailure) {
          const hasSharedCooldown = await refreshRateLimitState();
          if (hasSharedCooldown) return;

          const retryAt = Number(response?.retryAt);
          if (Number.isFinite(retryAt) && retryAt > Date.now()) {
            applyBtn.disabled = true;
            setStatus(
              t('rate_limit_wait', [formatCooldown(retryAt - Date.now())], `Furigana paused. Try again in ${formatCooldown(retryAt - Date.now())}.`),
              'info',
            );
            return;
          }
          if (response?.errorCode === 'service_unavailable') {
            setStatus(
              t('rate_limit_service_unavailable', undefined, 'Service temporarily unavailable. Please try again.'),
              'error',
            );
            return;
          }
        }
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
    const unsupportedMessage = getUnsupportedTabMessage(tab?.url || '');
    if (!tab?.id || unsupportedMessage) {
      setStatus(
        unsupportedMessage || t('status_open_supported_page', undefined, 'Open an http/https page or local HTML file and try again.'),
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
