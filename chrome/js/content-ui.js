/*
Module: content-ui
Purpose: Render instrument-styled, non-blocking toast notifications for rate-limit and error feedback.

Inputs:
- Toast message text and rate-limit metadata from content-script callers.
- chrome.i18n message catalog entries when available.

Outputs:
- Dismissible, locally styled toast elements and structured rate-limit toast IDs.

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
  service_unavailable: 'rate_limit_service_unavailable',
};

const RATE_LIMIT_FALLBACK_MESSAGES = {
  request_count: 'Processing paused. Retrying in $1.',
  char_rate: 'Processing paused. Retrying in $1.',
  hourly_chars: 'You have processed a lot of text recently. Please try again later.',
  daily_chars: 'Daily text limit reached. Please try again tomorrow.',
  nonce: 'Tsukeru had trouble connecting. Please try again in a moment.',
  retry_exhausted: 'Tsukeru is still busy. Please try again later.',
  service_unavailable: 'Service temporarily unavailable. Please try again.',
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

function _formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds >= 3600) {
    return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
  }
  if (totalSeconds >= 60) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  return `${totalSeconds}s`;
}

function _getToastMount() {
  return document.body || document.documentElement || null;
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
    return 'Tsukeru is still busy. Please try again later.';
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

  toast.dataset.tsukeruToast = String(toastId);
  toast._toastId = toastId;
  toast.className = `tsukeru-toast tsukeru-toast--${type}`;
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
