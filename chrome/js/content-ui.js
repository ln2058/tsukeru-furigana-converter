/*
Module: content-ui
Purpose: Apply the UI language and saved theme to extension-owned surfaces and render non-blocking toast notifications for rate-limit and error feedback.

Inputs:
- Toast message text and rate-limit metadata from content-script callers.
- Shared i18n catalog entries (including the resolved ui_lang) and the shared ui-messages formatter.
- UI theme from sync storage and storage changes; extension-owned surface elements.

Outputs:
- Dismissible, locally styled toast elements (optionally with one EZFurigana link the extension built, or a few small extension-defined action buttons) and structured rate-limit toast IDs.
- Language and light/dark theme attributes on extension-owned UI surfaces only.

Side Effects:
- Mutates the document body to add and remove toast elements; while the page is fullscreen, toasts and other extension surfaces (`mountTsukeruSurface`) go inside the fullscreen element, and move back when it ends.
- Starts and clears toast timers for auto-dismiss and countdown updates.
- Lazily initializes shared UI catalog messaging.
- Reads the saved theme and listens for changes; tracks only the current tooltip, report dialog, and toast, releasing disconnected elements.

Failure Modes:
- Missing document body prevents toast rendering.
- Unknown rate-limit types fall back to a generic warning toast.
- Theme storage failures leave surfaces following system colours.

Security Notes:
- Toast text is assigned via textContent only.
- Toast action buttons run their callback only for trusted (user) clicks, so the page cannot press them.
- Validates light/dark values and never adds theme attributes to the host document.
*/

TsukeruI18n.initContent();

// Only extension-owned surfaces are registered; theme changes never scan the page.
let tsukeruUiTheme = null;
let tsukeruUiThemeRevision = 0;
const tsukeruUiThemeSurfaces = new Set();

function applyTsukeruUiTheme(surface) {
  surface.lang = TsukeruI18n.language();
  for (const existing of tsukeruUiThemeSurfaces) {
    if (!existing.isConnected) tsukeruUiThemeSurfaces.delete(existing);
  }
  tsukeruUiThemeSurfaces.add(surface);
  if (tsukeruUiTheme) surface.dataset.tsukeruTheme = tsukeruUiTheme;
  else surface.removeAttribute('data-tsukeru-theme');
}

function updateTsukeruUiTheme(value) {
  tsukeruUiTheme = value === 'light' || value === 'dark' ? value : null;
  for (const surface of tsukeruUiThemeSurfaces) {
    if (!surface.isConnected) {
      tsukeruUiThemeSurfaces.delete(surface);
      continue;
    }
    if (tsukeruUiTheme) surface.dataset.tsukeruTheme = tsukeruUiTheme;
    else surface.removeAttribute('data-tsukeru-theme');
  }
}

// Start the small storage read before a user can open the dictionary.
// Without an explicit choice, CSS follows live system theme changes.
if (typeof chrome !== 'undefined' && chrome.storage?.sync && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.uiTheme) return;
    tsukeruUiThemeRevision += 1;
    updateTsukeruUiTheme(changes.uiTheme.newValue);
  });
  const loadRevision = tsukeruUiThemeRevision;
  chrome.storage.sync.get('uiTheme').then((stored) => {
    if (tsukeruUiThemeRevision === loadRevision) updateTsukeruUiTheme(stored.uiTheme);
  }).catch(() => console.warn('Tsukeru: could not load the UI theme'));
}

let _toastId = 0;
let _activeToastId = null;
let _activeToastElement = null;
let _activeToastMessageNode = null;
let _activeToastInterval = null;

const RATE_LIMIT_MESSAGE_KEYS = {
  request_count: 'rate_limit_toast_request_count',
  char_rate: 'rate_limit_toast_char_rate',
  hourly_chars: 'rate_limit_toast_hourly',
  daily_chars: 'rate_limit_toast_daily',
  nonce: 'rate_limit_toast_nonce',
  retry_exhausted: 'rate_limit_toast_retry_exhausted',
  service_unavailable: 'rate_limit_service_unavailable',
};

const RATE_LIMIT_FALLBACK_MESSAGES = {
  request_count: 'Processing paused. Retrying in $1.',
  char_rate: 'Processing paused. Retrying in $1.',
  hourly_chars: 'You have processed a lot of text recently. Please try again later.',
  daily_chars: 'Daily text limit reached. Please try again tomorrow.',
  nonce: 'Tsukeru had trouble connecting. Please try again in a moment.',
  retry_exhausted: 'Tsukeru is still busy. Please try again later.',
  service_unavailable: 'The service is temporarily unavailable. Please try again later.',
};

function _getMessage(key, substitutions, fallback) {
  return TsukeruI18n.t(key, substitutions, fallback);
}

function _normalizeRetryAfter(retryAfter) {
  const value = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 60;
}

function _formatRemaining(ms) {
  return TsukeruUiMessages.formatDuration(ms, _getMessage);
}

// ── Fullscreen ───────────────────────────────────────────────────────────────
// In fullscreen the browser draws only the fullscreen element, so Tsukeru's
// popups, notices and dialogs are attached inside it meanwhile, and moved
// back (to <html> or <body>) when fullscreen ends.
const tsukeruFullscreenSurfaces = new Map(); // element -> 'html' | 'body'
let tsukeruFullscreenBound = false;

function tsukeruSurfaceParent(home = 'body') {
  const fullscreen = document.fullscreenElement;
  // A video that is fullscreen by itself cannot hold other elements.
  if (fullscreen && !(fullscreen instanceof HTMLMediaElement) && !(fullscreen instanceof HTMLIFrameElement)) return fullscreen;
  return home === 'html'
    ? (document.documentElement || document.body)
    : (document.body || document.documentElement);
}

/** Attach an extension surface where it can be seen, following fullscreen changes. */
function mountTsukeruSurface(element, home = 'body') {
  if (!element) return;
  tsukeruFullscreenSurfaces.set(element, home);
  const parent = tsukeruSurfaceParent(home);
  if (parent && element.parentNode !== parent) parent.appendChild(element);
  if (!tsukeruFullscreenBound) {
    tsukeruFullscreenBound = true;
    document.addEventListener('fullscreenchange', () => {
      for (const [surface, surfaceHome] of tsukeruFullscreenSurfaces) {
        if (!surface.isConnected) {
          tsukeruFullscreenSurfaces.delete(surface);
          continue;
        }
        const target = tsukeruSurfaceParent(surfaceHome);
        if (target && surface.parentNode !== target) target.appendChild(surface);
      }
    });
  }
}

function _getToastMount() {
  return tsukeruSurfaceParent('body');
}

function _applyToastStyles(toast) {
  const style = toast.style;

  style.setProperty('position', 'fixed', 'important');
  style.setProperty('top', '16px', 'important');
  style.setProperty('left', '50%', 'important');
  style.setProperty('transform', 'translateX(-50%)', 'important');
  style.setProperty('z-index', '2147483647', 'important');
  style.setProperty('display', 'flex', 'important');
  style.setProperty('align-items', 'center', 'important');
  style.setProperty('gap', '10px');
  style.setProperty('max-width', 'min(92vw, 420px)');
  style.setProperty('padding', '9px 12px');
  style.setProperty('border-radius', '3px');
  style.setProperty('box-sizing', 'border-box');
  style.setProperty('pointer-events', 'auto');
}

function _buildToastMessage(type, retryAfter) {
  const key = RATE_LIMIT_MESSAGE_KEYS[type];
  const fallback = RATE_LIMIT_FALLBACK_MESSAGES[type];
  if (!key || !fallback) {
    return _getMessage('rate_limit_toast_retry_exhausted', undefined, 'Tsukeru is still busy. Please try again later.');
  }
  if (type === 'request_count' || type === 'char_rate') {
    return _getMessage(key, [retryAfter], fallback);
  }
  return _getMessage(key, undefined, fallback);
}

function _withCountdown(type, remaining) {
  const message = _buildToastMessage(type, remaining);
  if (type === 'request_count' || type === 'char_rate') return message;
  return `${message} ${_getMessage('rate_limit_countdown_suffix', [remaining], `Try again in ${remaining}.`)}`;
}

function _clearToastInterval() {
  if (_activeToastInterval != null) {
    clearInterval(_activeToastInterval);
    _activeToastInterval = null;
  }
}

function dismissToast(toastId) {
  if (toastId != null && toastId !== _activeToastId) {
    return;
  }

  _clearToastInterval();

  tsukeruUiThemeSurfaces.delete(_activeToastElement);
  if (_activeToastElement && typeof _activeToastElement.remove === 'function') {
    _activeToastElement.remove();
  } else if (_activeToastElement?.parentNode) {
    _activeToastElement.parentNode.removeChild(_activeToastElement);
  }

  _activeToastId = null;
  _activeToastElement = null;
  _activeToastMessageNode = null;
}

function showToast(message, options = {}) {
  dismissToast();

  const {
    type = 'error',
    duration = 5000,
    persistent = false,
    // { href, label }: an EZFurigana link built by the extension, never page input.
    link = null,
    // [{ icon: { path, viewBox, flip }, text, label, onClick }]: small buttons defined by the extension (a pixel
    // icon from extension constants, or short text); a click runs onClick, then closes the toast.
    actions = [],
  } = options;

  const toastId = ++_toastId;
  const mount = _getToastMount();
  const toast = document.createElement('div');
  const messageNode = document.createElement('span');
  const closeButton = document.createElement('button');

  toast.dataset.tsukeruToast = String(toastId);
  toast._toastId = toastId;
  toast.className = `tsukeru-toast tsukeru-toast--${type}`;
  applyTsukeruUiTheme(toast);
  _applyToastStyles(toast);

  messageNode.className = 'tsukeru-toast__message';
  messageNode.textContent = String(message ?? '');
  messageNode.style.setProperty('white-space', 'pre-wrap');
  messageNode.style.setProperty('word-break', 'break-word');
  messageNode.style.setProperty('flex', '1 1 auto');

  closeButton.type = 'button';
  closeButton.className = 'tsukeru-toast__dismiss';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
  closeButton.addEventListener('click', () => dismissToast(toastId));

  toast.appendChild(messageNode);
  if (link?.href && link?.label) {
    const anchor = document.createElement('a');
    anchor.className = 'tsukeru-toast__link';
    anchor.href = String(link.href);
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = String(link.label);
    anchor.style.setProperty('flex', '0 0 auto', 'important');
    anchor.style.setProperty('color', 'inherit', 'important');
    anchor.style.setProperty('font-weight', '600', 'important');
    anchor.style.setProperty('text-decoration', 'underline', 'important');
    anchor.style.setProperty('white-space', 'nowrap', 'important');
    toast.appendChild(anchor);
  }
  for (const action of Array.isArray(actions) ? actions.slice(0, 3) : []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tsukeru-toast__action';
    if (action?.icon?.path) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', String(action.icon.viewBox || '0 0 9 8'));
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('shape-rendering', 'crispEdges');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', String(action.icon.path));
      if (action.icon.flip) path.setAttribute('transform', String(action.icon.flip));
      svg.appendChild(path);
      button.appendChild(svg);
    } else {
      button.textContent = String(action?.text ?? '');
    }
    button.title = String(action?.label ?? '');
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (typeof action?.onClick === 'function') action.onClick();
      dismissToast(toastId);
    });
    toast.appendChild(button);
  }
  toast.appendChild(closeButton);

  if (mount) {
    mountTsukeruSurface(toast, 'body');
  }

  _activeToastId = toastId;
  _activeToastElement = toast;
  _activeToastMessageNode = messageNode;

  if (!persistent) {
    setTimeout(() => dismissToast(toastId), Math.max(0, Number(duration) || 0));
  }

  return toastId;
}

function showRateLimitToast(rateLimitType, retryAfter, retryAt = null, operation = 'furigana') {
  const retryAfterNumber = Number(retryAfter);
  const hasRetryAfter = Number.isFinite(retryAfterNumber) && retryAfterNumber > 0;
  const normalizedRetryAfter = hasRetryAfter ? _normalizeRetryAfter(retryAfterNumber) : 0;
  const retryAtNumber = Number(retryAt);
  const hasRetryAt = Number.isFinite(retryAtNumber) && retryAtNumber > Date.now();
  const canUseFallbackDeadline = retryAt == null && hasRetryAfter;
  const absoluteRetryAt = hasRetryAt
    ? retryAtNumber
    : (canUseFallbackDeadline ? Date.now() + normalizedRetryAfter * 1000 : null);

  if (absoluteRetryAt && rateLimitType !== 'nonce') {
    const toastId = showToast(_withCountdown(rateLimitType, _formatRemaining(absoluteRetryAt - Date.now())), {
      type: 'warning',
      duration: Math.max(1000, absoluteRetryAt - Date.now() + 1000),
      persistent: false,
    });
    _clearToastInterval();
    _activeToastInterval = setInterval(() => {
      if (_activeToastId !== toastId || !_activeToastMessageNode) {
        _clearToastInterval();
        return;
      }
      const remainingMs = absoluteRetryAt - Date.now();
      if (remainingMs <= 0) {
        _activeToastMessageNode.textContent = _getMessage('rate_limit_ready', undefined, 'Ready to retry.');
        _clearToastInterval();
        return;
      }
      _activeToastMessageNode.textContent = _withCountdown(
        rateLimitType,
        _formatRemaining(remainingMs),
      );
    }, 1000);
    return toastId;
  }

  if (rateLimitType === 'request_count' || rateLimitType === 'char_rate') {
    const effectiveRetryAfter = normalizedRetryAfter || _normalizeRetryAfter(null);
    const message = _buildToastMessage(rateLimitType, _formatRemaining(effectiveRetryAfter * 1000));
    const toastId = showToast(message, {
      type: 'warning',
      duration: effectiveRetryAfter * 1000 + 1000,
      persistent: false,
    });

    let remaining = effectiveRetryAfter - 1;
    _clearToastInterval();
    _activeToastInterval = setInterval(() => {
      if (_activeToastId !== toastId || !_activeToastMessageNode) {
        _clearToastInterval();
        return;
      }

      if (remaining <= 0) {
        _clearToastInterval();
        return;
      }

      _activeToastMessageNode.textContent = _buildToastMessage(rateLimitType, _formatRemaining(remaining * 1000));
      remaining -= 1;
    }, 1000);

    return toastId;
  }

  if (rateLimitType === 'hourly_chars' || rateLimitType === 'daily_chars') {
    return showToast(_buildToastMessage(rateLimitType), {
      type: 'warning',
      persistent: true,
    });
  }

  if (rateLimitType === 'nonce') {
    return showToast(_buildToastMessage(rateLimitType), {
      type: 'info',
      duration: 8000,
      persistent: false,
    });
  }

  const fallbackType = RATE_LIMIT_MESSAGE_KEYS[rateLimitType] ? rateLimitType : 'retry_exhausted';
  return showToast(_buildToastMessage(fallbackType), {
    type: 'warning',
    duration: 8000,
    persistent: false,
  });
}

function showRetryExhaustedToast() {
  return showToast(_buildToastMessage('retry_exhausted'), {
    type: 'warning',
    duration: 30000,
  });
}
