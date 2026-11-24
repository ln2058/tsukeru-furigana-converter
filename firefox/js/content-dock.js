/*
Module: content-dock
Purpose: Show the page dock at the bottom right of a page with furigana: furigana on/off, Listen and Explain for the text the reader selects, and a collapse button. Collapsed, it is one button showing the extension icon, faint and grey until pointed at; Settings > Page behavior turns it off.

Inputs:
- Furigana state from content-main (`isFuriganaActive`, Tsukeru's ruby on the page), via `syncPageDock()`.
- The page selection, read when it changes while the dock is open: its text without readings (rt, rp, rtc), at most 120 characters with whitespace collapsed, as the server counts.
- `pageDock` in sync storage (default on) and `pageDockCollapsed` in local storage, and their changes.
- The shared i18n catalog, saved UI theme, and the tooltip's account audio, Explain, notice and refusal helpers.

Outputs:
- One fixed dock element on the top-level page, with a panel above it for hints, first-use notices and explanations.
- `toggleFurigana` (the same path as the keyboard shortcut), `playSentence` and `explainSentence` messages to the background.

Side Effects:
- Adds and removes the dock element and one `selectionchange` listener while it is shown.
- Writes `pageDockCollapsed` and the shared first-use notice keys to local storage.
- Keeps explanations shown on this page in the tooltip's bounded map; the background keeps them on this device.

Failure Modes:
- Selections longer than 2,000 characters (readings included) are refused without being read.
- Text that is empty, has no Japanese, or is longer than 120 characters is refused with a hint and never sent.
- A refused or failed request shows the tooltip's refusal toast; a reloaded extension leaves the buttons inert.

Security Notes:
- Buttons act only on trusted (user) clicks; the page cannot press them.
- Selected text is sent only when the reader presses Listen or Explain, after the first-use notice; nothing is logged.
- Explanations render as text through the tooltip's DOM helpers, never as HTML.
*/

const PAGE_DOCK_MAX_CHARS = 120;
const PAGE_DOCK_RAW_SCAN_LIMIT = 2000;
const PAGE_DOCK_SETTING_KEY = 'pageDock';
const PAGE_DOCK_COLLAPSED_KEY = 'pageDockCollapsed';
const PAGE_DOCK_JAPANESE_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
// eslint-disable-next-line no-control-regex
const PAGE_DOCK_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Pixel icons on the website's grid (the account page's feedback icon), 2 px a cell.
// The collapsed dock: the extension's own icon (64 px, shown at 32), inlined so no
// extension file is exposed to pages.
const PAGE_DOCK_LAUNCHER_ICON = 'data:image/png;base64,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';
const PAGE_DOCK_ICONS = {
  // Furigana on/off: an open eye while it shows, a closed eye while hidden.
  furigana: '<svg viewBox="0 0 11 9" shape-rendering="crispEdges" aria-hidden="true">'
    + '<path class="tsukeru-dock-eye-open" d="M4 1h3v1H4zM2 2h2v1H2zM7 2h2v1H7zM1 3h1v1H1zM4 3h3v1H4zM9 3h1v1H9zM0 4h1v1H0zM3 4h5v1H3zM10 4h1v1H10zM1 5h1v1H1zM4 5h3v1H4zM9 5h1v1H9zM2 6h2v1H2zM7 6h2v1H7zM4 7h3v1H4z"/>'
    + '<path class="tsukeru-dock-eye-closed" d="M0 3h1v1H0zM10 3h1v1H10zM1 4h2v1H1zM8 4h2v1H8zM3 5h5v1H3zM2 6h1v1H2zM5 6h1v1H5zM8 6h1v1H8zM1 7h1v1H1zM5 7h1v1H5zM9 7h1v1H9z"/></svg>',
  // The launcher's fallback where a page's image policy blocks the icon: the icon's ふ in even one-cell strokes.
  launcher: '<svg viewBox="0 0 13 11" shape-rendering="crispEdges" aria-hidden="true">'
    + '<path d="M4 0h3v1H4zM7 1h2v1H7zM5 3h1v1H5zM2 4h1v1H2zM6 4h1v1H6zM10 4h1v1H10zM2 5h1v1H2zM6 5h1v1H6zM10 5h1v1H10zM1 6h1v1H1zM7 6h1v1H7zM11 6h1v1H11zM1 7h1v1H1zM7 7h1v1H7zM11 7h1v1H11zM0 8h1v1H0zM7 8h1v1H7zM12 8h1v1H12zM3 9h1v1H3zM7 9h1v1H7zM4 10h3v1H4z"/></svg>',
  listen: '<svg viewBox="0 0 9 8" shape-rendering="crispEdges" aria-hidden="true"><path d="M3 0h1v1H3zM2 1h2v1H2zM6 1h1v1H6zM0 2h4v1H0zM7 2h1v1H7zM0 3h4v1H0zM5 3h1v1H5zM7 3h1v1H7zM0 4h4v1H0zM5 4h1v1H5zM7 4h1v1H7zM0 5h4v1H0zM7 5h1v1H7zM2 6h2v1H2zM6 6h1v1H6zM3 7h1v1H3z"/></svg>',
  // Explain: a solid speech bubble with the question mark cut out of it.
  explain: '<svg viewBox="0 0 11 10" shape-rendering="crispEdges" aria-hidden="true"><path d="M1 0h9v1H1zM0 1h4v1H0zM7 1h4v1H7zM0 2h3v1H0zM4 2h3v1H4zM8 2h3v1H8zM0 3h7v1H0zM8 3h3v1H8zM0 4h6v1H0zM7 4h4v1H7zM0 5h5v1H0zM6 5h5v1H6zM0 6h11v1H0zM0 7h5v1H0zM6 7h5v1H6zM1 8h9v1H1zM1 9h2v1H1z"/></svg>',
  collapse: '<svg viewBox="0 0 9 8" shape-rendering="crispEdges" aria-hidden="true"><path d="M3 1h2v1H3zM4 2h2v1H4zM5 3h2v1H5zM4 4h2v1H4zM3 5h2v1H3z"/></svg>',
};

let pageDock = null;
let pageDockEnabled = null;
let pageDockCollapsed = false;
let pageDockSelectionFrame = 0;
let pageDockSelection = { text: '', status: 'empty', count: 0 };
let pageDockStorageBound = false;

/**
 * The selected text as it is sent and counted: NFC, whitespace collapsed to
 * single spaces. `status` is ok, empty, not_japanese or too_long.
 */
function pageDockTextStatus(raw, max = PAGE_DOCK_MAX_CHARS) {
  const text = String(raw || '').normalize('NFC').split(/\s+/).filter(Boolean).join(' ');
  const count = Array.from(text).length;
  if (!text) return { text: '', status: 'empty', count: 0 };
  if (!PAGE_DOCK_JAPANESE_RE.test(text) || PAGE_DOCK_CONTROL_RE.test(text)) return { text, status: 'not_japanese', count };
  if (count > max) return { text, status: 'too_long', count };
  return { text, status: 'ok', count };
}

/** The page selection without readings or Tsukeru's own UI, as `pageDockTextStatus` reports it. */
function pageDockReadSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return pageDockTextStatus('');
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container?.nodeType === 1 ? container : container?.parentElement;
  if (element?.closest?.('.tsukeru-page-dock, .tsukeru-word-tooltip, input, textarea')) return pageDockTextStatus('');
  // Large selections are refused before cloning them; readings count here too.
  const raw = selection.toString();
  if (raw.length > PAGE_DOCK_RAW_SCAN_LIMIT) return { text: '', status: 'too_long', count: 0 };
  const box = document.createElement('div');
  box.append(range.cloneContents());
  box.querySelectorAll('rtc, script, style, noscript, template, .tsukeru-page-dock, .tsukeru-word-tooltip')
    .forEach((node) => node.remove());
  return pageDockTextStatus(getPlainTextWithoutReadings(box));
}

function pageDockButton(className, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tsukeru-dock-button ${className}`;
  button.innerHTML = PAGE_DOCK_ICONS[icon];
  return button;
}

/** The collapsed dock's button: the extension icon, or the pixel ふ if the page blocks the image. */
function pageDockLauncher() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tsukeru-dock-button tsukeru-dock-launcher';
  const icon = document.createElement('img');
  icon.className = 'tsukeru-dock-launcher-icon';
  icon.alt = '';
  icon.draggable = false;
  icon.addEventListener('error', () => {
    button.dataset.fallback = 'true';
    button.innerHTML = PAGE_DOCK_ICONS.launcher;
  }, { once: true });
  icon.src = PAGE_DOCK_LAUNCHER_ICON;
  button.append(icon);
  return button;
}

function pageDockLabel(button, label) {
  button.setAttribute('aria-label', label);
  button.title = label;
}

function createPageDock() {
  const root = document.createElement('div');
  root.className = 'tsukeru-page-dock';

  const panel = document.createElement('div');
  panel.className = 'tsukeru-dock-panel tsukeru-hidden';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tsukeru-dock-panel-close';
  close.textContent = '×';
  pageDockLabel(close, t('content_close', undefined, 'Close'));
  const quote = document.createElement('p');
  quote.className = 'tsukeru-dock-quote tsukeru-hidden';
  quote.setAttribute('lang', 'ja');
  const hint = document.createElement('p');
  hint.className = 'tsukeru-dock-hint tsukeru-hidden';
  hint.setAttribute('role', 'status');
  const notice = document.createElement('div');
  notice.className = 'tsukeru-explain-notice tsukeru-hidden';
  notice.setAttribute('role', 'status');
  const result = document.createElement('div');
  result.className = 'tsukeru-explain-result tsukeru-hidden';
  result.setAttribute('aria-live', 'polite');
  panel.append(close, quote, hint, notice, result);

  const bar = document.createElement('div');
  bar.className = 'tsukeru-dock-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Tsukeru');
  const count = document.createElement('span');
  count.className = 'tsukeru-dock-count tsukeru-hidden';
  const furigana = pageDockButton('tsukeru-dock-furigana', 'furigana');
  const listen = pageDockButton('tsukeru-dock-listen', 'listen');
  const explain = pageDockButton('tsukeru-dock-explain', 'explain');
  explain.setAttribute('aria-expanded', 'false');
  const collapse = pageDockButton('tsukeru-dock-collapse', 'collapse');
  bar.append(count, furigana, listen, explain, collapse);

  const launcher = pageDockLauncher();

  root.append(panel, bar, launcher);
  // Pressing a dock button must not clear the reader's selection.
  root.addEventListener('mousedown', (event) => {
    if (event.target?.closest?.('button')) event.preventDefault();
  });
  // The page's own click handlers never see dock clicks.
  root.addEventListener('click', (event) => event.stopPropagation());

  const dock = { root, panel, close, quote, hint, notice, result, bar, count, furigana, listen, explain, collapse, launcher, panelFor: null };
  close.addEventListener('click', (event) => { if (event.isTrusted) hidePageDockPanel(dock); });
  furigana.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    hidePageDockPanel(dock);
    chrome.runtime.sendMessage({ action: 'toggleFurigana' })?.catch?.(() => {});
  });
  listen.addEventListener('click', (event) => { if (event.isTrusted) pageDockListen(dock); });
  explain.addEventListener('click', (event) => { if (event.isTrusted) pageDockExplain(dock); });
  collapse.addEventListener('click', (event) => { if (event.isTrusted) setPageDockCollapsed(true); });
  launcher.addEventListener('click', (event) => { if (event.isTrusted) setPageDockCollapsed(false); });
  return dock;
}

function renderPageDockLabels(dock) {
  const on = Boolean(isFuriganaActive);
  dock.furigana.setAttribute('aria-pressed', on ? 'true' : 'false');
  pageDockLabel(dock.furigana, on
    ? t('content_dock_furigana_hide', undefined, 'Hide furigana')
    : t('content_dock_furigana_show', undefined, 'Show furigana'));
  pageDockLabel(dock.listen, t('content_dock_listen', undefined, 'Listen to the selected text'));
  pageDockLabel(dock.explain, t('content_dock_explain', undefined, 'Explain the selected text'));
  pageDockLabel(dock.collapse, t('content_dock_collapse', undefined, 'Hide these buttons'));
  pageDockLabel(dock.launcher, t('content_dock_expand', undefined, 'Show Tsukeru buttons'));
  dock.root.dataset.collapsed = pageDockCollapsed ? 'true' : 'false';
}

function renderPageDockSelection(dock) {
  const { status, count } = pageDockSelection;
  const ready = status === 'ok';
  dock.root.dataset.selection = ready ? 'ready' : status;
  dock.listen.dataset.ready = ready ? 'true' : 'false';
  dock.explain.dataset.ready = ready ? 'true' : 'false';
  const shown = status === 'ok' || status === 'too_long';
  dock.count.classList.toggle('tsukeru-hidden', !shown);
  dock.count.dataset.over = status === 'too_long' ? 'true' : 'false';
  dock.count.textContent = !shown ? '' : count ? `${count}/${PAGE_DOCK_MAX_CHARS}` : `>${PAGE_DOCK_MAX_CHARS}`;
}

function schedulePageDockSelection() {
  if (pageDockSelectionFrame || !pageDock || pageDockCollapsed) return;
  pageDockSelectionFrame = requestAnimationFrame(() => {
    pageDockSelectionFrame = 0;
    if (!pageDock || pageDockCollapsed) return;
    pageDockSelection = pageDockReadSelection();
    renderPageDockSelection(pageDock);
  });
}

function hidePageDockPanel(dock) {
  dock.panel.classList.add('tsukeru-hidden');
  dock.notice.classList.add('tsukeru-hidden');
  dock.explain.setAttribute('aria-expanded', 'false');
  dock.panelFor = null;
}

/** Open the panel with only `hint`, or with the quoted text and its explanation. */
function showPageDockPanel(dock, { hint = '', quote = '', explanation = null, language = '' } = {}) {
  dock.hint.textContent = hint;
  dock.hint.classList.toggle('tsukeru-hidden', !hint);
  dock.quote.textContent = quote;
  dock.quote.classList.toggle('tsukeru-hidden', !quote);
  if (explanation) {
    renderTooltipExplanation(dock.result, explanation, language);
  } else {
    dock.result.replaceChildren();
    dock.result.classList.add('tsukeru-hidden');
  }
  dock.panel.classList.remove('tsukeru-hidden');
}

/** Why Listen or Explain cannot use the selection, or '' when it can. */
function pageDockSelectionHint(selection) {
  const max = String(PAGE_DOCK_MAX_CHARS);
  if (selection.status === 'too_long') {
    return t('content_dock_too_long', [max], `That selection is too long. Select up to ${max} characters.`);
  }
  if (selection.status !== 'ok') {
    return t('content_dock_select_hint', [max], `Select Japanese text on the page first, up to ${max} characters.`);
  }
  return '';
}

/** The first-use notice in the dock panel, unless no account is connected (then nothing is sent). */
async function pageDockNotice(dock, key, message) {
  if (await noticeSeen(key)) return true;
  const token = await askBackground({ action: 'hasSupporterToken' });
  if (token?.success && token.account !== true) return true;
  showPageDockPanel(dock);
  await confirmNotice(dock.notice, key, message);
  hidePageDockPanel(dock);
  return true;
}

async function pageDockListen(dock) {
  const selection = pageDockReadSelection();
  pageDockSelection = selection;
  renderPageDockSelection(dock);
  const hint = pageDockSelectionHint(selection);
  if (hint) {
    showPageDockPanel(dock, { hint });
    dock.panelFor = null;
    return;
  }
  if (dock.panelFor === null) hidePageDockPanel(dock);
  if (dock.listen.classList.contains('speaking')) return;
  await pageDockNotice(dock, SENTENCE_AUDIO_NOTICE_KEY, t(
    'content_sentence_audio_notice',
    undefined,
    'This sentence will be sent to ElevenLabs to make the audio.'
  ));
  playSupporterAudio(dock.listen, { action: 'playSentence', text: selection.text });
}

async function pageDockExplain(dock) {
  const selection = pageDockReadSelection();
  pageDockSelection = selection;
  renderPageDockSelection(dock);
  const language = TsukeruI18n.language();
  const key = `${language}\n${selection.text}`;
  // A second press on the same text closes its explanation.
  if (dock.panelFor && (selection.status !== 'ok' || dock.panelFor === key)) {
    hidePageDockPanel(dock);
    return;
  }
  const hint = pageDockSelectionHint(selection);
  if (hint) {
    showPageDockPanel(dock, { hint });
    return;
  }
  const open = (explanation) => {
    showPageDockPanel(dock, { quote: selection.text, explanation, language });
    dock.explain.setAttribute('aria-expanded', 'true');
    dock.panelFor = key;
  };
  if (shownExplanations.has(key)) {
    open(shownExplanations.get(key));
    return;
  }
  if (dock.explain.getAttribute('aria-busy') === 'true') return;
  const refuse = (code) => showRefusal(TsukeruUiMessages.explainMessage(code, t), code, 'extension_explain');
  // Without an account token nothing is sent, so the notice is not shown either.
  const token = await askBackground({ action: 'hasSupporterToken' });
  if (token?.success && token.account !== true) {
    refuse('account_required');
    return;
  }
  hidePageDockPanel(dock);
  await pageDockNotice(dock, EXPLAIN_NOTICE_KEY, t(
    'content_explain_notice',
    undefined,
    'This sentence will be sent to OpenAI to write the explanation, and OpenAI may use it to improve its models.'
  ));
  dock.explain.setAttribute('aria-busy', 'true');
  showPageDockPanel(dock, { quote: selection.text, hint: t('content_explain_working', undefined, 'Explaining…') });
  const response = await askBackground({ action: 'explainSentence', text: selection.text, language });
  dock.explain.removeAttribute('aria-busy');
  if (!response?.success || !response.explanation) {
    hidePageDockPanel(dock);
    refuse(response?.error);
    return;
  }
  shownExplanations.delete(key);
  shownExplanations.set(key, response.explanation);
  while (shownExplanations.size > MAX_SHOWN_EXPLANATIONS) shownExplanations.delete(shownExplanations.keys().next().value);
  if (pageDock === dock && dock.root.isConnected) open(response.explanation);
}

function setPageDockCollapsed(collapsed) {
  pageDockCollapsed = collapsed;
  try {
    chrome.storage.local.set({ [PAGE_DOCK_COLLAPSED_KEY]: collapsed })?.catch?.(() => {});
  } catch (_) {
    // Extension reloaded under the page.
  }
  if (!pageDock) return;
  if (collapsed) hidePageDockPanel(pageDock);
  renderPageDockLabels(pageDock);
  if (!collapsed) schedulePageDockSelection();
}

function bindPageDockStorage() {
  if (pageDockStorageBound) return;
  pageDockStorageBound = true;
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'sync' && changes[PAGE_DOCK_SETTING_KEY]) {
      pageDockEnabled = changes[PAGE_DOCK_SETTING_KEY].newValue !== false;
      syncPageDock();
    }
    if (area === 'local' && changes[PAGE_DOCK_COLLAPSED_KEY]) {
      pageDockCollapsed = changes[PAGE_DOCK_COLLAPSED_KEY].newValue === true;
      if (pageDock) {
        if (pageDockCollapsed) hidePageDockPanel(pageDock);
        renderPageDockLabels(pageDock);
      }
    }
  });
}

async function loadPageDockPreferences() {
  try {
    const [synced, local] = await Promise.all([
      chrome.storage.sync.get({ [PAGE_DOCK_SETTING_KEY]: true }),
      chrome.storage.local.get({ [PAGE_DOCK_COLLAPSED_KEY]: false }),
    ]);
    pageDockEnabled = synced[PAGE_DOCK_SETTING_KEY] !== false;
    pageDockCollapsed = local[PAGE_DOCK_COLLAPSED_KEY] === true;
  } catch (_) {
    pageDockEnabled = false;
  }
}

function removePageDock() {
  if (!pageDock) return;
  document.removeEventListener('selectionchange', schedulePageDockSelection);
  if (pageDockSelectionFrame) cancelAnimationFrame(pageDockSelectionFrame);
  pageDockSelectionFrame = 0;
  pageDock.root.remove();
  pageDock = null;
}

/**
 * Show the dock while this top-level page has Tsukeru's furigana (shown, or
 * hidden with the toggle), and remove it otherwise or when Settings turns it off.
 */
async function syncPageDock() {
  if (window.top !== window) return;
  bindPageDockStorage();
  if (pageDockEnabled === null) await loadPageDockPreferences();
  const hasFurigana = Boolean(isFuriganaActive)
    || Boolean(document.querySelector('[data-tsukeru-wrapper="1"]'));
  if (!pageDockEnabled || !hasFurigana || !document.body) {
    removePageDock();
    return;
  }
  if (!pageDock) {
    pageDock = createPageDock();
    applyTsukeruUiTheme(pageDock.root);
    document.body.appendChild(pageDock.root);
    document.addEventListener('selectionchange', schedulePageDockSelection);
  }
  renderPageDockLabels(pageDock);
  schedulePageDockSelection();
}
