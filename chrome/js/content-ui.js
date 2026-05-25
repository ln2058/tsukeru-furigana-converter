/*
Module: content-ui
Purpose: Render non-blocking toast notifications for rate-limit and error feedback.

Inputs:
- Toast message text and rate-limit metadata from content-script callers.
- chrome.i18n message catalog entries when available.

Outputs:
- Dismissible toast elements and structured rate-limit toast IDs.

Side Effects:
- Mutates the document body to add and remove toast elements.
- Starts and clears toast timers for auto-dismiss and countdown updates.

Failure Modes:
- Missing document body prevents toast rendering.
- Unknown rate-limit types fall back to a generic warning toast.

Security Notes:
- Toast text is assigned via textContent only.
*/

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
};

const RATE_LIMIT_FALLBACK_MESSAGES = {
  request_count: 'Processing paused. Retrying in $1s.',
  char_rate: 'Processing paused. Retrying in $1s.',
  hourly_chars: 'You have processed a lot of text recently. Please try again later.',
  daily_chars: 'Daily text limit reached. Please try again tomorrow.',
  nonce: 'Tsukeru had trouble connecting. Please try again in a moment.',
  retry_exhausted: 'Tsukeru is still busy. Please try again later.',
};

function _hasChromeI18n() {
  return typeof chrome !== 'undefined' && Boolean(chrome?.i18n?.getMessage);
}

function _formatFallbackMessage(template, substitutions) {
  if (!template) {
    return '';
  }

  const values = Array.isArray(substitutions)
    ? substitutions
    : substitutions == null
      ? []
      : [substitutions];

  return values.reduce((text, value, index) => {
    return text.replace(new RegExp(`\\$${index + 1}`, 'g'), String(value));
  }, template);
}

function _getMessage(key, substitutions, fallback) {
  const localized = _hasChromeI18n() ? chrome.i18n.getMessage(key, substitutions) : '';
  if (localized) {
    return localized;
  }
  return _formatFallbackMessage(fallback, substitutions);
}

function _normalizeRetryAfter(retryAfter) {
  const value = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 60;
}

function _getToastMount() {
  return document.body || document.documentElement || null;
}

function _applyToastStyles(toast, type) {
  const palette = {
    error: '#dc2626',
    warning: '#d97706',
    info: '#4f46e5',
  };
  const accent = palette[type] || palette.warning;
  const style = toast.style;

  style.setProperty('position', 'fixed', 'important');
  style.setProperty('top', '16px', 'important');
  style.setProperty('left', '50%', 'important');
  style.setProperty('transform', 'translateX(-50%)', 'important');
  style.setProperty('z-index', '2147483647', 'important');
  style.setProperty('display', 'flex', 'important');
  style.setProperty('align-items', 'center', 'important');
  style.setProperty('gap', '8px');
  style.setProperty('max-width', 'min(92vw, 420px)');
  style.setProperty('padding', '8px 10px');
  style.setProperty('border-radius', '4px');
  style.setProperty('border', '1px solid #e4e4e7');
  style.setProperty('background', '#ffffff');
  style.setProperty('color', '#18181b');
  style.setProperty('box-shadow', '0 6px 18px rgba(24, 24, 27, 0.14)');
  style.setProperty('font-family', 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
  style.setProperty('font-size', '12px');
  style.setProperty('line-height', '1.4');
  style.setProperty('box-sizing', 'border-box');
  style.setProperty('pointer-events', 'auto');
  style.setProperty('--tsukeru-toast-accent', accent);
}

function _buildToastMessage(type, retryAfter) {
  const key = RATE_LIMIT_MESSAGE_KEYS[type];
  const fallback = RATE_LIMIT_FALLBACK_MESSAGES[type];
  if (!key || !fallback) {
    return 'Tsukeru is still busy. Please try again later.';
  }
  if (type === 'request_count' || type === 'char_rate') {
    return _getMessage(key, [retryAfter], fallback);
  }
  return _getMessage(key, undefined, fallback);
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
  } = options;

  const toastId = ++_toastId;
  const mount = _getToastMount();
  const toast = document.createElement('div');
  const messageNode = document.createElement('span');
  const closeButton = document.createElement('button');
  const indicator = document.createElement('span');

  toast.dataset.tsukeruToast = String(toastId);
  toast._toastId = toastId;
  toast.className = `tsukeru-toast tsukeru-toast--${type}`;
  _applyToastStyles(toast, type);

  indicator.className = 'tsukeru-toast__indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.style.setProperty('width', '6px');
  indicator.style.setProperty('height', '6px');
  indicator.style.setProperty('border-radius', '999px');
  indicator.style.setProperty('background', 'var(--tsukeru-toast-accent)');
  indicator.style.setProperty('flex', '0 0 auto');

  messageNode.className = 'tsukeru-toast__message';
  messageNode.textContent = String(message ?? '');
  messageNode.style.setProperty('white-space', 'pre-wrap');
  messageNode.style.setProperty('word-break', 'break-word');
  messageNode.style.setProperty('flex', '1 1 auto');

  closeButton.type = 'button';
  closeButton.className = 'tsukeru-toast__dismiss';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
  closeButton.style.setProperty('all', 'unset');
  closeButton.style.setProperty('cursor', 'pointer');
  closeButton.style.setProperty('color', '#71717a');
  closeButton.style.setProperty('font-size', '16px');
  closeButton.style.setProperty('line-height', '1');
  closeButton.style.setProperty('font-weight', '500');
  closeButton.style.setProperty('flex', '0 0 auto');
  closeButton.addEventListener('click', () => dismissToast(toastId));

  toast.appendChild(indicator);
  toast.appendChild(messageNode);
  toast.appendChild(closeButton);

  if (mount) {
    mount.appendChild(toast);
  }

  _activeToastId = toastId;
  _activeToastElement = toast;
  _activeToastMessageNode = messageNode;

  if (!persistent) {
    setTimeout(() => dismissToast(toastId), Math.max(0, Number(duration) || 0));
  }

  return toastId;
}

function showRateLimitToast(rateLimitType, retryAfter) {
  const normalizedRetryAfter = _normalizeRetryAfter(retryAfter);

  if (rateLimitType === 'request_count' || rateLimitType === 'char_rate') {
    const message = _buildToastMessage(rateLimitType, normalizedRetryAfter);
    const toastId = showToast(message, {
      type: 'warning',
      duration: normalizedRetryAfter * 1000 + 1000,
      persistent: false,
    });

    let remaining = normalizedRetryAfter - 1;
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

      _activeToastMessageNode.textContent = _buildToastMessage(rateLimitType, remaining);
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

  return showToast(_buildToastMessage('retry_exhausted'), {
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
