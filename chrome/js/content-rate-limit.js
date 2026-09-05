/*
Module: content-rate-limit
Purpose: Wrap chrome.runtime.sendMessage with rate-limit-aware retry logic.
Guarantees visible toast before every rate-limit throw.

Inputs:
- Furigana payloads from content-script callers.
- Rate-limit metadata returned by the background processFurigana handler.

Outputs:
- Successful background responses after transient retries.
- Thrown errors with rate-limit metadata after retries are exhausted.

Side Effects:
- Shows toast notifications through content-ui.js helpers.
- Waits between retry attempts for transient rate limits.

Failure Modes:
- Messaging failures propagate to the caller.
- A caller-provided validity predicate can cancel stale work before a request or retry.
- Operation-owned AbortSignals cancel retry backoff promptly.
- Unknown rate-limit types surface a generic warning toast before throwing.

Security Notes:
- Relies on content-ui.js for textContent-only toast rendering.
*/

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRetryCancellationError() {
  const error = new Error('Furigana processing cancelled');
  error.cancelled = true;
  return error;
}

function delayWithAbort(ms, signal) {
  if (!signal) return delay(ms);
  if (signal.aborted) return Promise.reject(createRetryCancellationError());
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal.removeEventListener('abort', onAbort);
      reject(createRetryCancellationError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

async function sendFuriganaWithRateLimitRetry(payload, maxRetries = 3, isValid = () => true, signal = null) {
  if (typeof maxRetries === 'function') {
    isValid = maxRetries;
    maxRetries = 3;
  }

  const assertValid = () => {
    if (signal?.aborted || isValid() === false) throw createRetryCancellationError();
  };

  const RETRYABLE_TYPES = ['request_count', 'char_rate'];
  let retries = 0;

  while (true) {
    assertValid();
    const response = await chrome.runtime.sendMessage({
      action: 'processFurigana',
      payload,
    });
    assertValid();

    if (response?.nonceRateLimit) {
      showRateLimitToast(
        response.nonceRateLimit.rateLimitType,
        response.nonceRateLimit.retryAfter
      );
    }

    if (response?.success && response.processedHTML) {
      return response;
    }

    if (
      response?.rateLimitType
      && RETRYABLE_TYPES.includes(response.rateLimitType)
      && retries < maxRetries
    ) {
      retries += 1;
      const retryAfter = response.retryAfter || 60;
      const toastId = showRateLimitToast(response.rateLimitType, retryAfter);
      try {
        await delayWithAbort(retryAfter * 1000, signal);
      } catch (error) {
        dismissToast(toastId);
        throw error;
      }
      assertValid();
      dismissToast(toastId);
      continue;
    }

    if (response?.rateLimitType && RETRYABLE_TYPES.includes(response.rateLimitType)) {
      showRetryExhaustedToast();
    } else if (response?.rateLimitType && ['daily_chars', 'hourly_chars'].includes(response.rateLimitType)) {
      showRateLimitToast(response.rateLimitType, response.retryAfter);
    } else if (response?.rateLimitType) {
      showRateLimitToast(response.rateLimitType, response.retryAfter);
    }

    const err = new Error(response?.error || 'Request failed');
    if (response?.rateLimitType) {
      err.rateLimitType = response.rateLimitType;
      err.retryAfter = response.retryAfter;
    }
    throw err;
  }
}
