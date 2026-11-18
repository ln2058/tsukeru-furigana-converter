/*
Module: ui-messages
Purpose: Format localized countdowns and select user-facing error messages.

Inputs:
- Duration values, structured error metadata, operation names, and a locale lookup function.

Outputs:
- Localized duration and error strings for popup and content-script UI.
- For sentence audio and Explain refusals, the next step to offer: `connect` (sign in for free) or `pricing` (become a Supporter).

Side Effects:
- Exposes TsukeruUiMessages to both classic content scripts and the popup.

Failure Modes:
- Unknown errors use an operation-specific message; invalid durations become zero seconds.

Security Notes:
- Never displays backend error text, exception messages, or sensitive payloads.
*/
(() => {
  function formatDuration(ms, t) {
    const seconds = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
    if (seconds >= 3600) {
      const hours = String(Math.floor(seconds / 3600));
      const minutes = String(Math.floor((seconds % 3600) / 60));
      return t('duration_hours_minutes', [hours, minutes], `${hours}h ${minutes}m`);
    }
    if (seconds >= 60) {
      const minutes = String(Math.floor(seconds / 60));
      const remainder = String(seconds % 60);
      return t('duration_minutes_seconds', [minutes, remainder], `${minutes}m ${remainder}s`);
    }
    return t('duration_seconds', [String(seconds)], `${seconds}s`);
  }

  function errorMessage(error, operation, t) {
    const status = Number(error?.status || error?.httpStatus);
    const code = error?.errorCode;
    if (code === 'no_text') return t('content_error_no_text_found', undefined, 'No Japanese text found on this page.');
    if (code === 'page_connection') return t('status_reload_and_retry', undefined, 'Could not connect to this page. Reload it and try again.');
    if (code === 'service_unavailable' || status === 503) {
      return t('rate_limit_service_unavailable', undefined, 'The service is temporarily unavailable. Please try again later.');
    }
    if (status === 401 || status === 403 || code === 'nonce' || code === 'auth_error' || error?.rateLimitType === 'nonce') {
      return t('content_toast_connection_error', undefined, 'Tsukeru had trouble connecting. Please try again in a moment.');
    }
    if (error?.rateLimitType || code === 'rate_limited' || status === 429) {
      const retryAt = Number(error?.retryAt);
      const retryAfter = Number(error?.retryAfter);
      const wait = Number.isFinite(retryAt) && retryAt > 0
        ? Math.max(0, retryAt - Date.now())
        : Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
      const type = error?.rateLimitType;
      if (type === 'daily_chars') return t('rate_limit_toast_daily', undefined, 'Daily text limit reached. Please try again tomorrow.');
      if (type === 'hourly_chars') return t('rate_limit_toast_hourly', undefined, 'You have processed a lot of text recently. Please try again later.');
      if (wait !== null) {
        const duration = formatDuration(wait, t);
        return t('error_rate_limited_wait', [duration], `Too many requests. Try again in ${duration}.`);
      }
      return t('error_rate_limited', undefined, 'Too many requests. Please try again later.');
    }
    if (code === 'network_error') return t('error_network', undefined, 'Could not connect. Check your internet connection and try again.');
    if (code === 'timeout' || error?.name === 'TimeoutError') return t('error_timeout', undefined, 'The request timed out. Please try again.');
    if (operation === 'report') return t('report_submit_failed', undefined, 'Could not send your report. Please try again.');
    if (operation === 'export') return t('vocab_export_failed_short', undefined, 'Could not export your words. Please try again.');
    return t('content_toast_generic_error', undefined, 'Could not add furigana. Please try again.');
  }

  // The new translations for this plan are used up (a week for guests and free accounts); Supporter offers more.
  const SUPPORTER_TRANSLATION_REASONS = new Set(['plan_limit', 'anonymous_budget']);

  function dictionaryTranslationOffersSupporter(reason) {
    return SUPPORTER_TRANSLATION_REASONS.has(reason);
  }

  function dictionaryTranslationMessage(reason, t) {
    if (dictionaryTranslationOffersSupporter(reason)) {
      return t('dictionary_translation_supporter', undefined, "You've used this week's free dictionary translations. Supporters get more each day.");
    }
    // Only a Supporter's own spent day says so; busy or service-wide limits are just unavailable.
    if (reason === 'daily_limit') {
      return t('dictionary_translation_limit', undefined, "You've used today's dictionary translations. Showing English until tomorrow.");
    }
    if (reason === 'pending') {
      return t('dictionary_translation_pending', undefined, 'A translation is being prepared. Showing English.');
    }
    return t('dictionary_translation_unavailable', undefined, 'Translation unavailable. Showing English.');
  }

  // The next step a refusal offers: sign in for free, or become a Supporter.
  const OFFERS = {
    account_required: 'connect',
    free_daily_limit: 'pricing',
    free_capacity: 'pricing',
    supporter_required: 'pricing',
  };

  /** `connect`, `pricing`, or null for a sentence audio or Explain refusal code. */
  function refusalOffer(code) {
    return Object.hasOwn(OFFERS, code) ? OFFERS[code] : null;
  }

  // Why sentence audio did not play (the dictionary popup and My Words).
  function sentenceAudioMessage(code, t) {
    if (code === 'account_required') {
      return t('content_sentence_audio_sign_in', undefined, 'Sign in to try sentence audio for free.');
    }
    // free_daily_limit is the code for a free account's spent week.
    if (code === 'free_daily_limit') {
      return t('content_sentence_audio_free_used', undefined, "You've used this week's free sentence audio. Supporters can keep listening.");
    }
    if (code === 'free_capacity') {
      return t('content_sentence_audio_free_pool', undefined, "Today's free sentence audio is used up. Try again tomorrow, or become a Supporter to keep listening.");
    }
    // Only an older backend still answers supporter_required.
    if (code === 'supporter_required') {
      return t('content_sentence_audio_supporter', undefined, 'Sentence audio is a Supporter feature. Sign in on ezfurigana.com as a Supporter to turn it on.');
    }
    if (code === 'monthly_limit') {
      return t('content_sentence_audio_limit', undefined, "You've used this month's sentence audio. It resets at the start of next month.");
    }
    return t('content_sentence_audio_failed', undefined, "Sentence audio isn't available right now. Please try again later.");
  }

  /** Why "Explain" gave no explanation, from its refusal code. */
  function explainMessage(code, t) {
    if (code === 'account_required') {
      return t('content_explain_sign_in', undefined, 'Sign in to try sentence explanations for free.');
    }
    if (code === 'free_daily_limit') {
      return t('content_explain_free_used', undefined, "You've used this week's free explanations. Supporters get more every day.");
    }
    if (code === 'supporter_required') {
      return t('content_explain_supporter', undefined, 'Sentence explanations are a Supporter feature. Sign in on ezfurigana.com as a Supporter to turn them on.');
    }
    if (code === 'daily_limit') {
      return t('content_explain_limit', undefined, "You've used today's explanations. They reset tomorrow.");
    }
    if (code === 'not_available') {
      return t('content_explain_not_available', undefined, "Sentence explanations aren't available for this account.");
    }
    return t('content_explain_failed', undefined, "Explanations aren't available right now. Please try again later.");
  }

  globalThis.TsukeruUiMessages = {
    formatDuration, errorMessage, dictionaryTranslationMessage, dictionaryTranslationOffersSupporter,
    sentenceAudioMessage, explainMessage, refusalOffer,
  };
})();
