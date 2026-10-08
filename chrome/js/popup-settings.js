/*
Module: popup-settings
Purpose: Manage popup settings and UI theme, the live furigana preview, content-script bootstrapping, and apply/clear actions.

Inputs:
- Settings controls (reading-type segments, level chips, switches, ruby style toolbar) and theme-toggle events, system theme changes, active-tab info, stored sync settings (including UI theme and My Words display settings), and the popup theme cache.

Outputs:
- Updated settings in storage, popup theme and accessible toggle labels, apply/clear command messages, and live Study mode / known-reading updates to content scripts.

Side Effects:
- Reads/writes `chrome.storage.sync` and the popup's localStorage theme cache; listens for theme changes.
- Injects content scripts/CSS in dependency order, mutates popup notices, Apply/Clear state, preview UI, and sends live level and appearance updates.

Failure Modes:
- Unsupported tabs and local files without browser-granted file access reject apply/clear actions.
- Injection/messaging failures return localized errors selected from structured metadata.
- Theme storage failures retain the current appearance; an unavailable cache falls back to system colours on opening.

Security Notes:
- Apply/clear actions require explicit user-triggered popup interactions.
- Stores settings only in extension-owned storage; accepts only light/dark theme choices.
*/
// Settings constants, shared utilities, report modal — imported by all popup modules.
import { hasSupportedLocalFileExtension } from './utils.js';

export const DEFAULT_SETTINGS = {
  // Level filter, as on EZFurigana (see normalizeLevel).
  levelSystem: 'jlpt',
  jlptLevel: 5,
  gradeLevel: 4,
  furiganaType: 'hiragana',
  highlightMode: 'off',
  watchDynamic: false,
  removeCustomStyling: false,
  rubySize: 0.65,
  rubyColor: '#475569',
  rubyWeight: 'normal',
  // Known words lose their readings, as on EZFurigana; Study mode hides all readings until clicked.
  hideKnownFurigana: true,
  studyMode: false,
};

export const DICTIONARY_MAX_SENSES = 3;
export const DEFINITION_CACHE_TTL = 5 * 60 * 1000;

// ── Shared DOM/tab utilities ──────────────────────────────────────────────────

export function t(key, substitutions, fallback = '') {
  const message = chrome.i18n?.getMessage ? chrome.i18n.getMessage(key, substitutions) : '';
  return message || fallback;
}

export function userFacingError(error, operation) {
  return TsukeruUiMessages.errorMessage(error, operation, t);
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

// The synchronous head script supplies the first paint; sync storage is authoritative.
export function initThemeToggle() {
  const button = document.getElementById('themeToggle');
  if (!button) return;
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const normalizeTheme = (value) => value === 'light' || value === 'dark' ? value : null;
  let preference = normalizeTheme(root.dataset.theme);
  let revision = 0;
  let pendingWrites = 0;
  let saveQueue = Promise.resolve();

  function render() {
    const dark = preference ? preference === 'dark' : systemTheme.matches;
    const label = dark
      ? t('theme_switch_to_light', undefined, 'Switch to light mode')
      : t('theme_switch_to_dark', undefined, 'Switch to dark mode');
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function applyPreference(value) {
    preference = normalizeTheme(value);
    if (preference) root.dataset.theme = preference;
    else root.removeAttribute('data-theme');
    try {
      if (preference) localStorage.setItem('tsukeru.uiTheme', preference);
      else localStorage.removeItem('tsukeru.uiTheme');
    } catch (_) {
      console.warn('Tsukeru: popup theme cache is unavailable');
    }
    render();
  }

  systemTheme.addEventListener('change', () => {
    if (!preference) render();
  });

  button.addEventListener('click', () => {
    const dark = preference ? preference === 'dark' : systemTheme.matches;
    const nextTheme = dark ? 'light' : 'dark';
    revision += 1;
    applyPreference(nextTheme);
    // Serialize rapid clicks and ignore intermediate storage echoes.
    pendingWrites += 1;
    saveQueue = saveQueue.then(() => chrome.storage.sync.set({ uiTheme: nextTheme }))
      .catch(() => console.warn('Tsukeru: could not save the UI theme'))
      .finally(() => { pendingWrites -= 1; });
  });

  function onThemeChanged(changes, area) {
    if (area !== 'sync' || !changes.uiTheme || pendingWrites) return;
    revision += 1;
    applyPreference(changes.uiTheme.newValue);
  }
  chrome.storage.onChanged.addListener(onThemeChanged);
  window.addEventListener('pagehide', () => {
    chrome.storage.onChanged.removeListener(onThemeChanged);
  }, { once: true });

  render();
  const loadRevision = revision;
  chrome.storage.sync.get('uiTheme').then((stored) => {
    // A click or a storage event during the read wins over its older snapshot.
    if (revision === loadRevision) applyPreference(stored.uiTheme);
  }).catch(() => console.warn('Tsukeru: could not load the UI theme'));
}

// Errors and limits appear just above Apply / Clear in EZFurigana's status-register style.
// Success is shown by the buttons themselves and only announced to screen readers.
let dismissedNoticeKind = '';

export function showNotice(message, kind = 'error', { refresh = false } = {}) {
  const notice = document.getElementById('status');
  if (!notice) return;
  const noticeKind = kind === 'limit' ? 'limit' : 'error';
  // A closed countdown stays closed while it keeps ticking.
  if (refresh && dismissedNoticeKind === noticeKind) return;
  dismissedNoticeKind = '';
  const label = notice.querySelector('.popup-notice-label');
  const text = notice.querySelector('.popup-notice-message');
  if (label) {
    label.textContent = noticeKind === 'limit'
      ? t('notice_label_limit', undefined, 'Limit')
      : t('notice_label_error', undefined, 'Error');
  }
  if (text) text.textContent = message;
  notice.dataset.status = noticeKind;
  notice.setAttribute('role', noticeKind === 'error' ? 'alert' : 'status');
  notice.hidden = false;
}

export function hideNotice({ dismissed = false, kind = '' } = {}) {
  const notice = document.getElementById('status');
  if (!notice || notice.hidden) return;
  if (kind && notice.dataset.status !== kind) return;
  if (dismissed) dismissedNoticeKind = notice.dataset.status || '';
  notice.hidden = true;
}

export function announce(message) {
  const region = document.getElementById('statusAnnounce');
  if (!region) return;
  region.textContent = '';
  // Re-set on the next frame so a repeated message is read again.
  requestAnimationFrame(() => { region.textContent = message; });
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
  // Inject the split content scripts in manifest dependency order.
  for (const file of [
    'js/ui-messages.js',
    'js/content-ui.js',
    'js/content-rate-limit.js',
    'js/content-dom.js',
    'js/tooltip-async-state.js',
    'js/word-rules.js',
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

// ── My Words display settings ─────────────────────────────────────────────────

/** Send Study mode and the known-reading setting to the page, so they apply without re-applying furigana. */
export async function sendWordDisplaySettings() {
  const { hideKnownFurigana, studyMode } = await chrome.storage.sync.get({
    hideKnownFurigana: DEFAULT_SETTINGS.hideKnownFurigana,
    studyMode: DEFAULT_SETTINGS.studyMode,
  });
  const tab = await getActiveTab();
  if (!tab?.id || !isSupportedPageTab(tab.url)) return;
  chrome.tabs.sendMessage(tab.id, {
    action: 'updateWordDisplay',
    settings: { hideKnownFurigana: hideKnownFurigana !== false, studyMode: studyMode === true },
  }).catch(() => {});
}

// ── Level filter and ruby size ────────────────────────────────────────────────

// As on EZFurigana: JLPT 5 is "All kanji", 6 is "Beyond N1"; school grades run 2-8,
// where 7 is junior high and 8 is non-jōyō only.
const ALL_KANJI_LEVEL = 5;
const BEYOND_N1_LEVEL = 6;
const JUNIOR_HIGH_GRADE = 7;
const NON_JOYO_GRADE = 8;
const RUBY_SIZE_MIN = 0.4;
const RUBY_SIZE_MAX = 1;
const RUBY_SIZE_STEP = 0.05;

/** Stored level settings with out-of-range values replaced; content-dom's setLevelFilter applies the same rule. */
export function normalizeLevel(stored = {}) {
  const jlpt = Number(stored.jlptLevel);
  const grade = Number(stored.gradeLevel);
  return {
    levelSystem: stored.levelSystem === 'grade' ? 'grade' : 'jlpt',
    jlptLevel: Number.isInteger(jlpt) && jlpt >= 1 && jlpt <= BEYOND_N1_LEVEL ? jlpt : ALL_KANJI_LEVEL,
    gradeLevel: Number.isInteger(grade) && grade >= 2 && grade <= NON_JOYO_GRADE ? grade : DEFAULT_SETTINGS.gradeLevel,
  };
}

function gradeLabel(grade) {
  if (grade === JUNIOR_HIGH_GRADE) return t('settings_level_junior_high', undefined, 'Junior high');
  if (grade === NON_JOYO_GRADE) return t('settings_level_non_joyo', undefined, 'Non-jōyō only');
  return t('settings_level_grade_n', [String(grade)], `Gr. ${grade}`);
}

/** The sentence under the level chips, worded as on EZFurigana. */
export function describeLevel(level) {
  if (level.levelSystem === 'grade') {
    if (level.gradeLevel >= NON_JOYO_GRADE) {
      return t(
        'settings_level_desc_non_joyo',
        undefined,
        'Furigana only on non-jōyō kanji, special readings, and words with more than one reading.'
      );
    }
    const grade = gradeLabel(level.gradeLevel);
    return t(
      'settings_level_desc_grade',
      [grade],
      `Furigana on kanji from ${grade} up, plus special readings and words with more than one reading.`
    );
  }
  if (level.jlptLevel === ALL_KANJI_LEVEL) {
    return t('settings_level_desc_all', undefined, 'Furigana on every word with kanji.');
  }
  if (level.jlptLevel === BEYOND_N1_LEVEL) {
    return t('settings_level_desc_beyond_n1', undefined, 'Furigana only on words outside the JLPT lists.');
  }
  const levels = [];
  for (let n = level.jlptLevel; n >= 1; n -= 1) levels.push(`N${n}`);
  const list = levels.join(', ');
  return t('settings_level_desc_jlpt', [list], `Furigana on words in ${list} and words outside the JLPT lists.`);
}

function clampRubySize(value) {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.rubySize;
  const stepped = Number((Math.round(value / RUBY_SIZE_STEP) * RUBY_SIZE_STEP).toFixed(2));
  return Math.min(RUBY_SIZE_MAX, Math.max(RUBY_SIZE_MIN, stepped));
}

// ── Settings form ─────────────────────────────────────────────────────────────

export async function initSettingsForm() {
  const applyBtn = document.getElementById('applyBtn');
  const clearBtn = document.getElementById('clearBtn');
  const furiganaTypeGroup = document.getElementById('furiganaType');
  const levelRows = document.getElementById('levelRows');
  const levelDescription = document.getElementById('levelDescription');
  const watchDynamicCheckbox = document.getElementById('watchDynamic');
  const customStylingCheckbox = document.getElementById('customRubyStyling');
  const appearanceControls = document.getElementById('appearanceControls');
  const hideKnownCheckbox = document.getElementById('hideKnownFurigana');
  const highlightGroup = document.getElementById('highlightMode');
  const highlightKeys = {
    jlpt: document.getElementById('highlightKeyJlpt'),
    pos: document.getElementById('highlightKeyPos'),
  };
  const rubySizeDown = document.getElementById('rubySizeDown');
  const rubySizeUp = document.getElementById('rubySizeUp');
  const rubySizeValue = document.getElementById('rubySizeValue');
  const rubyBoldButton = document.getElementById('rubyBold');
  const rubyStyleReset = document.getElementById('rubyStyleReset');
  const rubyColorSwatch = document.getElementById('rubyColorSwatch');
  const rubyColorInput = document.getElementById('rubyColor');
  const preview = document.getElementById('rubyPreview');
  const previewReading = document.getElementById('rubyPreviewReading');
  let rateLimitInterval = null;
  let pageApplied = false;
  let level = normalizeLevel(DEFAULT_SETTINGS);
  let furiganaType = DEFAULT_SETTINGS.furiganaType;
  let highlightMode = DEFAULT_SETTINGS.highlightMode;
  let rubySize = DEFAULT_SETTINGS.rubySize;
  let rubyColor = DEFAULT_SETTINGS.rubyColor;
  let rubyWeight = DEFAULT_SETTINGS.rubyWeight;

  // The buttons show whether this page has furigana: Applied / Clear once applied, Apply / Clear otherwise.
  function showPageState(applied) {
    pageApplied = applied;
    applyBtn.classList.toggle('secondary', applied);
    applyBtn.classList.toggle('is-done', applied);
    clearBtn.classList.toggle('secondary', !applied);
    applyBtn.textContent = applied
      ? t('actions_applied', undefined, 'Applied')
      : t('actions_apply', undefined, 'Apply');
    applyBtn.title = applied ? t('actions_apply_again', undefined, 'Apply again with the current settings') : '';
  }

  function setApplyBusy(busy) {
    if (busy) {
      applyBtn.setAttribute('aria-busy', 'true');
      applyBtn.classList.remove('is-done');
      applyBtn.textContent = t('actions_applying', undefined, 'Adding...');
      return;
    }
    if (!applyBtn.hasAttribute('aria-busy')) return;
    applyBtn.removeAttribute('aria-busy');
    showPageState(pageApplied);
  }

  async function refreshPageState() {
    let applied = false;
    try {
      const tab = await getActiveTab();
      if (tab?.id && isSupportedPageTab(tab.url || '')) {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getFuriganaState' });
        applied = response?.active === true;
      }
    } catch (_) {
      // No content script on this page yet: it has no furigana.
    }
    if (!applyBtn.hasAttribute('aria-busy')) showPageState(applied);
  }

  function formatCooldown(ms) {
    return TsukeruUiMessages.formatDuration(ms, t);
  }

  async function refreshRateLimitState() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getRateLimitState' });
      const record = response?.state?.furigana;
      const expiresAt = Number(record?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        applyBtn.disabled = false;
        hideNotice({ kind: 'limit' });
        if (rateLimitInterval) clearInterval(rateLimitInterval);
        rateLimitInterval = null;
        return false;
      }
      const render = (refresh) => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          applyBtn.disabled = false;
          hideNotice({ kind: 'limit' });
          announce(t('rate_limit_ready', undefined, 'Ready to retry.'));
          if (rateLimitInterval) clearInterval(rateLimitInterval);
          rateLimitInterval = null;
          return;
        }
        applyBtn.disabled = true;
        showNotice(
          t('rate_limit_wait', [formatCooldown(remaining)], `Furigana paused. Try again in ${formatCooldown(remaining)}.`),
          'limit',
          { refresh },
        );
      };
      render(false);
      if (rateLimitInterval) clearInterval(rateLimitInterval);
      rateLimitInterval = setInterval(() => render(true), 1000);
      return true;
    } catch (_) {
      applyBtn.disabled = false;
      return false;
    }
  }

  function setPressed(group, value) {
    group.querySelectorAll('button[data-value]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
    });
  }

  function onSegment(group, handler) {
    group.querySelectorAll('button[data-value]').forEach((button) => {
      button.addEventListener('click', () => {
        setPressed(group, button.dataset.value);
        handler(button.dataset.value);
      });
    });
  }

  function isLevelChipActive(chip) {
    const system = chip.dataset.levelSystem;
    if (system === 'all') return level.levelSystem === 'jlpt' && level.jlptLevel === ALL_KANJI_LEVEL;
    const value = Number(chip.dataset.level);
    return system === level.levelSystem && value === (system === 'grade' ? level.gradeLevel : level.jlptLevel);
  }

  function renderLevel() {
    levelRows.querySelectorAll('.level-chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(isLevelChipActive(chip)));
    });
    levelDescription.textContent = describeLevel(level);
  }

  // Size, colour, weight and highlights only apply with Tsukeru's ruby styling, so they dim without it.
  function renderAppearance() {
    const custom = customStylingCheckbox.checked;
    appearanceControls.disabled = !custom;
    rubySizeValue.textContent = `${Math.round(rubySize * 100)}%`;
    rubySizeDown.disabled = rubySize <= RUBY_SIZE_MIN;
    rubySizeUp.disabled = rubySize >= RUBY_SIZE_MAX;
    rubyBoldButton.setAttribute('aria-pressed', String(rubyWeight === 'bold'));
    rubyColorSwatch.style.background = rubyColor;
    rubyColorInput.value = rubyColor;
    setPressed(highlightGroup, highlightMode);
    Object.entries(highlightKeys).forEach(([mode, key]) => {
      key.hidden = mode !== highlightMode;
    });
    preview.style.setProperty('--preview-ruby-size', `${rubySize}em`);
    preview.style.setProperty('--preview-ruby-color', rubyColor);
    preview.style.setProperty('--preview-ruby-weight', rubyWeight);
    preview.dataset.customStyle = custom ? 'on' : 'off';
    preview.dataset.highlight = highlightMode;
    previewReading.textContent = furiganaType === 'katakana'
      ? 'カンジ'
      : furiganaType === 'romaji'
        ? 'kanji'
        : 'かんじ';
  }

  function collectSettings() {
    return {
      ...level,
      furiganaType,
      highlightMode,
      watchDynamic: watchDynamicCheckbox.checked,
      removeCustomStyling: !customStylingCheckbox.checked,
      hideKnownFurigana: hideKnownCheckbox.checked,
      rubySize,
      rubyColor,
      rubyWeight,
    };
  }

  // Load stored settings
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  level = normalizeLevel(stored);
  furiganaType = ['hiragana', 'katakana', 'romaji'].includes(stored.furiganaType)
    ? stored.furiganaType
    : DEFAULT_SETTINGS.furiganaType;
  highlightMode = ['off', 'jlpt', 'pos'].includes(stored.highlightMode)
    ? stored.highlightMode
    : DEFAULT_SETTINGS.highlightMode;
  rubySize = clampRubySize(Number(stored.rubySize));
  rubyColor = /^#[0-9a-f]{6}$/i.test(stored.rubyColor || '') ? stored.rubyColor : DEFAULT_SETTINGS.rubyColor;
  rubyWeight = stored.rubyWeight === 'bold' ? 'bold' : 'normal';
  watchDynamicCheckbox.checked = stored.watchDynamic === true;
  customStylingCheckbox.checked = stored.removeCustomStyling !== true;
  hideKnownCheckbox.checked = stored.hideKnownFurigana !== false;
  setPressed(furiganaTypeGroup, furiganaType);
  levelRows.querySelectorAll('.level-chip[data-level-system="grade"]').forEach((chip) => {
    const grade = Number(chip.dataset.level);
    if (grade < JUNIOR_HIGH_GRADE) chip.textContent = gradeLabel(grade);
  });
  // Japanese readers think in school grades first, as on EZFurigana.
  if ((chrome.i18n?.getUILanguage?.() || '').toLowerCase().startsWith('ja')) {
    levelRows.insertBefore(
      levelRows.querySelector('[data-level-row="grade"]'),
      levelRows.querySelector('[data-level-row="jlpt"]')
    );
  }
  renderLevel();
  renderAppearance();
  await refreshRateLimitState();
  refreshPageState();

  // Auto-save on any change
  const saveSettings = async () => {
    const settings = collectSettings();
    await chrome.storage.sync.set(settings);
    const tab = await getActiveTab();
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'updateAppearance',
        color: settings.rubyColor,
        size: `${settings.rubySize.toFixed(2)}em`,
        weight: settings.rubyWeight,
        highlightMode: settings.highlightMode,
        removeCustomStyling: settings.removeCustomStyling,
      }).catch(() => {});
    }
  };

  onSegment(furiganaTypeGroup, (value) => {
    furiganaType = value;
    renderAppearance();
    saveSettings();
  });
  levelRows.querySelectorAll('.level-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const system = chip.dataset.levelSystem;
      const value = Number(chip.dataset.level);
      if (system === 'grade') level = { ...level, levelSystem: 'grade', gradeLevel: value };
      else level = { ...level, levelSystem: 'jlpt', jlptLevel: system === 'all' ? ALL_KANJI_LEVEL : value };
      renderLevel();
      await saveSettings();
      const tab = await getActiveTab();
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'updateLevel', settings: level }).catch(() => {});
      }
    });
  });
  watchDynamicCheckbox.addEventListener('change', saveSettings);
  customStylingCheckbox.addEventListener('change', () => {
    renderAppearance();
    saveSettings();
  });
  hideKnownCheckbox.addEventListener('change', async () => {
    await saveSettings();
    await sendWordDisplaySettings();
  });
  onSegment(highlightGroup, (value) => {
    highlightMode = value;
    renderAppearance();
    saveSettings();
  });
  const stepRubySize = (direction) => {
    rubySize = clampRubySize(rubySize + direction * RUBY_SIZE_STEP);
    renderAppearance();
    saveSettings();
  };
  rubySizeDown.addEventListener('click', () => stepRubySize(-1));
  rubySizeUp.addEventListener('click', () => stepRubySize(1));
  rubyBoldButton.addEventListener('click', () => {
    rubyWeight = rubyWeight === 'bold' ? 'normal' : 'bold';
    renderAppearance();
    saveSettings();
  });
  rubyStyleReset.addEventListener('click', () => {
    rubySize = DEFAULT_SETTINGS.rubySize;
    rubyColor = DEFAULT_SETTINGS.rubyColor;
    rubyWeight = DEFAULT_SETTINGS.rubyWeight;
    renderAppearance();
    saveSettings();
  });
  rubyColorInput.addEventListener('input', () => {
    rubyColor = rubyColorInput.value || DEFAULT_SETTINGS.rubyColor;
    renderAppearance();
    saveSettings();
  });

  applyBtn.addEventListener('click', async () => {
    await applyFuriganaToPage();
  });
  clearBtn.addEventListener('click', async () => {
    await clearFuriganaFromPage();
  });
  document.getElementById('statusClose')?.addEventListener('click', () => {
    hideNotice({ dismissed: true });
    (applyBtn.disabled ? clearBtn : applyBtn).focus();
  });

  async function applyFuriganaToPage() {
    hideNotice();
    await refreshRateLimitState();
    if (applyBtn.disabled) return;
    const settings = collectSettings();
    await chrome.storage.sync.set(settings);
    // Study mode is switched on the This page tab; carry its stored value.
    const { studyMode } = await chrome.storage.sync.get({ studyMode: DEFAULT_SETTINGS.studyMode });
    settings.studyMode = Boolean(studyMode);
    const tab = await getActiveTab();
    const unsupportedMessage = await getUnsupportedTabMessage(tab?.url || '');
    if (!tab?.id || unsupportedMessage) {
      showNotice(
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
      setApplyBusy(true);
      try {
        await ensureContentScript(tab.id);
      } catch (_) {
        throw Object.assign(new Error('Page connection failed'), { errorCode: 'page_connection' });
      }
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'applyFurigana', settings });
      } catch (_) {
        throw Object.assign(new Error('Page connection failed'), { errorCode: 'page_connection' });
      }
      if (response?.ok) {
        pageApplied = true;
        announce(response.pending
          ? t('status_waiting_for_content', undefined, 'Waiting for page content...')
          : t('status_furigana_applied', undefined, 'Furigana applied'));
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
            showNotice(
              t('rate_limit_wait', [formatCooldown(retryAt - Date.now())], `Furigana paused. Try again in ${formatCooldown(retryAt - Date.now())}.`),
              'limit',
            );
            return;
          }
          if (response?.errorCode === 'service_unavailable') {
            showNotice(
              t('rate_limit_service_unavailable', undefined, 'The service is temporarily unavailable. Please try again later.'),
              'error',
            );
            return;
          }
        }
        throw response || {}; // Preserve structured metadata; never render raw error text.
      }
    } catch (err) {
      console.warn('Tsukeru: apply failed', err?.errorCode || 'unknown');
      showNotice(userFacingError(err, 'apply'), 'error');
    } finally {
      setApplyBusy(false);
    }
  }

  async function clearFuriganaFromPage() {
    hideNotice();
    const tab = await getActiveTab();
    const unsupportedMessage = await getUnsupportedTabMessage(tab?.url || '');
    if (!tab?.id || unsupportedMessage) {
      showNotice(
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
      showPageState(false);
      announce(t('status_furigana_cleared', undefined, 'Furigana cleared'));
    } catch (err) {
      console.error(err);
      showNotice(t('status_reload_and_retry', undefined, 'Could not connect to this page. Reload it and try again.'), 'error');
    }
  }
}
