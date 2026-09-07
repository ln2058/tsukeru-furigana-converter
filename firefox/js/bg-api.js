/*
Module: bg-api
Purpose: Execute backend workflows for furigana processing, dictionary data, audio proxying, and export.

Inputs:
- Text chunk payloads, settings, tab URLs, and action parameters.
- Network responses from EZFurigana API endpoints.

Outputs:
- Processed furigana HTML, reading-aware dictionary/enrichment payloads, base64 data URLs, and structured error metadata.

Side Effects:
- Performs network fetches, tracks shared cooldown deadlines, and coalesces nonce acquisition/recovery across API requests.
- Persists only validated cooldown metadata through extension-local storage; backend quotas remain authoritative.
- Shares logical dictionary lookups and bounds completed in-memory dictionary results.
- Reads/writes cached furigana fragments through `bg-cache`.

Failure Modes:
- Network/API failures, malformed responses, nonce retry exhaustion, and rate-limit rejections.
- A rejected shared dictionary lookup propagates to all joined callers and can be retried later.
- Missing required payload fields produce thrown errors.

Security Notes:
- Treat all backend responses as untrusted until sanitized by content scripts.
- Redacts non-web tab URLs before sending backend metadata.
- Keep endpoint configuration centralized to avoid host sprawl.
*/
// External network requests, furigana pipeline, and audio for the service worker.
import { sha256Hash, cacheGet, cacheSet, definitionCache, DEFINITION_CACHE_TTL } from './bg-cache.js';
import { kata2hira } from './utils.js';

export const API_BASE_URL = 'https://www.ezfurigana.com';

export const DEFAULT_SETTINGS = {
  jlptLevel: 5,
  furiganaType: 'hiragana',
  firstOccurrenceOnly: false,
  highlightMode: 'off',
  watchDynamic: false,
  removeCustomStyling: false,
};

const BACKGROUND_DEFINITION_CACHE_MAX_ENTRIES = 200;
const definitionInFlightCache = new Map();

const COOLDOWN_OPERATIONS = new Set(['furigana', 'dictionary', 'examples', 'nonce']);
const COOLDOWN_TYPES = new Set([
  'request_count', 'char_rate', 'hourly_chars', 'daily_chars', 'lookup', 'examples', 'nonce',
]);
const LEGACY_RATE_LIMIT_FALLBACK_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 86400;
const MAX_AUDIO_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ANKI_ZIP_RESPONSE_BYTES = 64 * 1024 * 1024;
const MIN_AUDIO_RESPONSE_BYTES = 100;
const AUDIO_RESPONSE_MIME_TYPES = new Set(['audio/mpeg']);
const ANKI_ZIP_RESPONSE_MIME_TYPES = new Set(['application/zip']);
let cooldownState = {};
let cooldownHydrationPromise = null;

function getStorageLocal() {
  return globalThis.chrome?.storage?.local || globalThis.browser?.storage?.local || null;
}

async function readCooldownStorage() {
  const storage = getStorageLocal();
  if (!storage?.get) return {};
  try {
    const result = await storage.get('tsukeruRateLimitCooldowns');
    return result?.tsukeruRateLimitCooldowns && typeof result.tsukeruRateLimitCooldowns === 'object'
      ? result.tsukeruRateLimitCooldowns
      : {};
  } catch (_) {
    return {};
  }
}

async function writeCooldownStorage() {
  const storage = getStorageLocal();
  if (!storage?.set) return;
  try {
    await storage.set({ tsukeruRateLimitCooldowns: cooldownState });
  } catch (_) {
    // The in-memory copy remains authoritative for this worker when storage is unavailable.
  }
}

async function hydrateCooldownState() {
  if (!cooldownHydrationPromise) {
    cooldownHydrationPromise = readCooldownStorage().then((stored) => {
      const now = Date.now();
      cooldownState = Object.fromEntries(
        Object.entries(stored).filter(([, value]) => (
          value && typeof value === 'object'
          && COOLDOWN_OPERATIONS.has(value.operation)
          && Number.isFinite(value.expiresAt)
          && value.expiresAt > now
        ))
      );
      return cooldownState;
    });
  }
  return cooldownHydrationPromise;
}

function normalizeOperation(operation, fallback = 'furigana') {
  return COOLDOWN_OPERATIONS.has(operation) ? operation : fallback;
}

function normalizeRateLimitType(value) {
  return COOLDOWN_TYPES.has(value) ? value : null;
}

function getActiveCooldown(operation) {
  const normalizedOperation = normalizeOperation(operation);
  const record = cooldownState[normalizedOperation];
  if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
    if (record) {
      delete cooldownState[normalizedOperation];
      void writeCooldownStorage();
    }
    return null;
  }
  return { ...record };
}

function createLocalCooldownError(record) {
  const error = new Error('Rate limit is active. Please wait before retrying.');
  error.status = record.status || 429;
  error.httpStatus = error.status;
  error.errorCode = record.status === 503 ? 'service_unavailable' : 'rate_limited';
  error.operation = record.operation;
  if (record.rateLimitType) error.rateLimitType = record.rateLimitType;
  error.retryAt = record.expiresAt;
  error.expiresAt = record.expiresAt;
  error.retryAfter = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
  return error;
}

async function enforceCooldown(operation) {
  await hydrateCooldownState();
  const active = getActiveCooldown(operation);
  if (active) throw createLocalCooldownError(active);
}

async function recordCooldown(error, expectedOperation) {
  await hydrateCooldownState();
  const delay = Number(error?.retryAfter);
  if (!Number.isFinite(delay) || delay <= 0 || (error?.status !== 429 && error?.status !== 503)) return;
  const operation = normalizeOperation(error.operation, expectedOperation);
  const expiresAt = Date.now() + Math.min(Math.floor(delay), MAX_RETRY_AFTER_SECONDS) * 1000;
  const current = cooldownState[operation];
  if (!current || !Number.isFinite(current.expiresAt) || expiresAt > current.expiresAt) {
    cooldownState[operation] = {
      status: error.status,
      operation,
      expiresAt,
      ...(normalizeRateLimitType(error.rateLimitType) && { rateLimitType: normalizeRateLimitType(error.rateLimitType) }),
    };
    await writeCooldownStorage();
  }
  error.retryAt = cooldownState[operation]?.expiresAt || expiresAt;
  error.expiresAt = error.retryAt;
}

export async function getRateLimitState() {
  await hydrateCooldownState();
  const now = Date.now();
  for (const [operation, record] of Object.entries(cooldownState)) {
    if (!record?.expiresAt || record.expiresAt <= now) delete cooldownState[operation];
  }
  void writeCooldownStorage();
  return { ...cooldownState };
}

function pruneDefinitionCache(now = Date.now()) {
  for (const [key, entry] of definitionCache.entries()) {
    if (now - entry.timestamp >= DEFINITION_CACHE_TTL) definitionCache.delete(key);
  }
  while (definitionCache.size > BACKGROUND_DEFINITION_CACHE_MAX_ENTRIES) {
    const oldestKey = definitionCache.keys().next().value;
    if (oldestKey === undefined) break;
    definitionCache.delete(oldestKey);
  }
}


// Split a marker-embedded string into [{marker, text}] pairs.
// Mirrors the split() strategy used by content.js's applyBatchResult — no lookahead needed.
export function dismantlePayload(text) {
  const chunks = [];
  const prefix = '__TSUKERU_SPLIT_';
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const markerStart = text.indexOf(prefix, searchIndex);
    if (markerStart === -1) break;

    const markerEnd = text.indexOf('__', markerStart + prefix.length) + 2;
    if (markerEnd < 2) break; // malformed marker

    const markerStr = text.substring(markerStart, markerEnd);
    const nextMarkerStart = text.indexOf(prefix, markerEnd);
    const textContent = nextMarkerStart === -1
      ? text.substring(markerEnd)
      : text.substring(markerEnd, nextMarkerStart);

    chunks.push({ marker: markerStr, text: textContent });
    searchIndex = nextMarkerStart === -1 ? text.length : nextMarkerStart;
  }

  return chunks;
}

export async function handleFuriganaRequest(payload) {
  const { textContent = '', settings = {}, tabUrl } = payload;

  // Settings suffix shared by all chunks (JLPT excluded — filtered client-side via CSS)
  const settingsSuffix = `|${settings.furiganaType || 'hiragana'}|${settings.firstOccurrenceOnly ? '1' : '0'}`;
  let nonceRateLimit = null;

  // ── Step 1: Dismantle the payload into per-node chunks ────────────────────
  const chunks = dismantlePayload(textContent);

  // No markers: unusual edge case — rate-check the whole payload and fetch raw.
  if (!chunks.length) {
    return fetchFromAPI(textContent, settings, tabUrl);
  }

  // ── Step 2: Check cache per chunk (trim for key; re-inject whitespace on hit) ─
  const missingChunks = [];
  for (const chunk of chunks) {
    const trimmed = chunk.text.trim();

    // Blank/whitespace-only segments: pass through as-is, nothing to annotate.
    if (!trimmed) {
      chunk.processedHtml = chunk.text;
      continue;
    }

    const secureHash = await sha256Hash(trimmed);
    const key = secureHash + settingsSuffix;
    const hit = await cacheGet(key);
    if (hit !== null) {
      chunk.processedHtml = chunk.text.replace(trimmed, () => hit);
    } else {
      missingChunks.push(chunk);
    }
  }

  // ── Step 3: Fetch only missing chunks from the backend ───────────────────
  if (missingChunks.length > 0) {
    const missingChars = missingChunks.reduce((sum, c) => sum + c.text.length, 0);

    const missingPayload = missingChunks.map(c => c.marker + c.text).join('');
    const result = await fetchFromAPI(missingPayload, settings, tabUrl);
    if (result.nonceRateLimit) nonceRateLimit = result.nonceRateLimit;

    const parsedChunks = dismantlePayload(result.processedHTML);
    const parsedMap = new Map(parsedChunks.map(c => [c.marker, c.text]));

    for (const chunk of missingChunks) {
      const rawHtml = parsedMap.get(chunk.marker) ?? chunk.text;
      chunk.processedHtml = rawHtml;
      const trimmed = chunk.text.trim();
      if (trimmed) {
        await cacheSet(await sha256Hash(trimmed) + settingsSuffix, rawHtml.trim());
      }
    }
  }

  // ── Step 4: Reassemble with the exact current markers ────────────────────
  const finalHTML = chunks.map(c => c.marker + (c.processedHtml ?? c.text)).join('');
  return { processedHTML: finalHTML, ...(nonceRateLimit && { nonceRateLimit }) };
}

// ── Extension nonce ───────────────────────────────────────────────────────────
// A short-lived HMAC token issued by the backend that proves the caller went
// through the proper nonce-fetch flow. Included in every furigana request so
// the backend can distinguish genuine extension traffic from raw curl scrapers.
//
// Fail-open: if the nonce endpoint is unreachable, _extNonce stays null and
// requests proceed without a nonce until EXT_REQUIRE_NONCE=true is deployed.

let _extNonce = null;
let _extNonceExpiry = 0;
let _getExtNoncePromise = null; // coalesces concurrent callers to a single in-flight fetch
let _nonceRateLimitState = null;
let _nonceLastError = null;
const _EXT_NONCE_REFRESH_BEFORE_MS = 30_000; // refresh 30s before expiry
const _EXT_SESSION_ID = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function _nonceLog(event, detail = {}) {
  console.info('[tsukeru][nonce]', event, detail);
}

function _resetExtNonce(reason) {
  _extNonce = null;
  _extNonceExpiry = 0;
  _nonceLog('nonce-reset', { reason, extSessionId: _EXT_SESSION_ID });
}

_resetExtNonce('service-worker-start');

async function _getExtNonce() {
  const now = Date.now();
  if (_extNonce && now < _extNonceExpiry - _EXT_NONCE_REFRESH_BEFORE_MS) {
    return _extNonce;
  }
  // Coalesce concurrent callers: if a fetch is already in-flight, await it.
  if (_getExtNoncePromise) return _getExtNoncePromise;

  _getExtNoncePromise = (async () => {
    _resetExtNonce('nonce-refresh-start');
    _nonceLastError = null;
    _nonceLog('nonce-fetch-start', { extSessionId: _EXT_SESSION_ID });
    try {
      const res = await fetchWithCooldown(`${API_BASE_URL}/api/extension/nonce`, {
        method: 'GET',
        headers: { 'x-extension-session-id': _EXT_SESSION_ID },
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
      }, 'nonce');
      const data = await res.json();
      if (!data?.nonce) {
        _nonceLastError = new Error('Extension nonce response was missing a nonce');
        _nonceLog('nonce-fetch-failed', { extSessionId: _EXT_SESSION_ID, reason: 'missing_nonce_field' });
        return null;
      }
      _extNonce = data.nonce;
      _nonceLastError = null;
      _nonceRateLimitState = null;
      const expiresIn = Number(data.expires_in);
      _extNonceExpiry = Number.isFinite(expiresIn) && expiresIn > 0
        ? now + (expiresIn * 1000)
        : now + 60_000;
      _nonceLog('nonce-fetch-success', {
        extSessionId: _EXT_SESSION_ID,
        expiresInMs: Math.max(_extNonceExpiry - now, 0),
      });
      return _extNonce;
    } catch (err) {
      _nonceLastError = err instanceof Error ? err : new Error('Extension nonce request failed');
      if (_nonceLastError.status === 429 || _nonceLastError.status === 503) {
        _nonceRateLimitState = {
          rateLimitType: _nonceLastError.rateLimitType || 'nonce',
          retryAfter: _nonceLastError.retryAfter,
          retryAt: _nonceLastError.retryAt,
        };
      }
      _nonceLog('nonce-fetch-failed', {
        extSessionId: _EXT_SESSION_ID,
        reason: 'network_exception',
        errorType: err?.name || 'error',
      });
      return null;
    } finally {
      _getExtNoncePromise = null;
    }
  })();

  return _getExtNoncePromise;
}

async function _getExtNonceForFurigana() {
  _nonceRateLimitState = null;
  const nonce = await _getExtNonce();
  const rateLimit = _nonceRateLimitState;
  _nonceRateLimitState = null;
  return { nonce, rateLimit };
}

// Low-level API fetch — sends raw textContent and returns { processedHTML }.
export async function fetchFromAPI(textContent, settings, tabUrl) {
  const apiUrl = API_BASE_URL;
  const endpoints = [`${apiUrl}/api/extension/furigana`, `${apiUrl}/furigana/html`];
  let lastError = null;
  const backendWebsiteUrl = getBackendWebsiteUrl(tabUrl);

  let nonceResult = await _getExtNonceForFurigana();
  let nonce = nonceResult.nonce;
  let nonceRateLimit = nonceResult.rateLimit;
  let nonceRetryUsed = false;

  for (const endpoint of endpoints) {
    try {
      // Build FormData as a closure so the retry below can re-invoke it after
      // nonce is cleared, without duplicating the field list.
      const buildFormData = () => {
        const fd = new FormData();
        fd.append('input_mode', 'text');
        fd.append('engine', 'sudachi');
        // Always request jlpt_level=5 (max-render: backend annotates all words); JLPT filtering is CSS-driven client-side
        fd.append('jlpt_level', '5');
        fd.append('furigana_type', settings.furiganaType || DEFAULT_SETTINGS.furiganaType);
        fd.append('first_occurrence_only', settings.firstOccurrenceOnly ? 'on' : '');
        fd.append('raw_text', textContent);
        // Never leak local filesystem paths or other non-web URLs to the backend.
        fd.append('website_url', backendWebsiteUrl);
        fd.append('csrf_token', '');
        // Include nonce when available; backend verifies if present, ignores if absent
        // until EXT_REQUIRE_NONCE=true is deployed server-side.
        if (nonce) fd.append('ext_nonce', nonce);
        return fd;
      };

      let response;
      try {
        response = await fetchWithCooldown(endpoint, {
        method: 'POST',
        body: buildFormData(),
        headers: { 'x-extension-session-id': _EXT_SESSION_ID },
        credentials: 'omit',
        mode: 'cors',
        }, 'furigana');
      } catch (error) {
        if (
          error?.status === 403
          && nonce
          && endpoint.includes('/api/extension/')
          && !nonceRetryUsed
          && isRecognizedNonceFailure(error.body)
        ) {
          nonceRetryUsed = true;
          _resetExtNonce('furigana-403');
          nonceResult = await _getExtNonceForFurigana();
          nonce = nonceResult.nonce;
          if (nonceResult.rateLimit) nonceRateLimit = nonceResult.rateLimit;
          response = await fetchWithCooldown(endpoint, {
            method: 'POST',
            body: buildFormData(),
            headers: { 'x-extension-session-id': _EXT_SESSION_ID },
            credentials: 'omit',
            mode: 'cors',
          }, 'furigana');
        } else {
          throw error;
        }
      }

      const contentType = response.headers.get('content-type') || '';
      let processedHTML = null;
      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (data?.html) processedHTML = data.html;
        else {
          const malformed = new Error('JSON response missing html field');
          malformed.status = 502;
          throw malformed;
        }
      } else {
        const responseText = await response.text();
        processedHTML = extractProcessedHtml(responseText);
      }

      if (!processedHTML) {
        const malformed = new Error('Could not read processed HTML from backend response.');
        malformed.status = 502;
        throw malformed;
      }

      return { processedHTML, ...(nonceRateLimit && { nonceRateLimit }) };
    } catch (err) {
      lastError = err;
      console.error('Tsukeru fetch exception', endpoint, err);
      if (err?.status === 404 || err?.status === 405) continue;
      throw err;
    }
  }

  throw lastError || new Error('API request failed');
}

function getBackendWebsiteUrl(tabUrl = '') {
  return /^https?:\/\//i.test(tabUrl) ? tabUrl : '';
}

function extractElementInnerHtmlById(htmlText, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<([a-zA-Z0-9:-]+)\\b[^>]*\\bid=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i'
  );
  const match = htmlText.match(pattern);
  return match?.[2]?.trim() || '';
}

// Parse HTML fallback responses when backend does not return JSON.
// Service-worker environments can lack DOMParser, so include a regex fallback.
function extractProcessedHtml(htmlText) {
  if (typeof htmlText !== 'string' || !htmlText.trim()) return null;

  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');
      const preview = doc.querySelector('#normalPreview');
      if (preview && preview.innerHTML.trim()) return preview.innerHTML;
      const resultSection = doc.querySelector('#result');
      if (resultSection && resultSection.innerHTML.trim()) return resultSection.innerHTML;
      const bodyContent = doc.body?.innerHTML?.trim();
      if (bodyContent) return bodyContent;
    } catch (err) {
      console.error('Failed to parse backend response via DOMParser:', err);
    }
  }

  const preview = extractElementInnerHtmlById(htmlText, 'normalPreview');
  if (preview) return preview;

  const resultSection = extractElementInnerHtmlById(htmlText, 'result');
  if (resultSection) return resultSection;

  const bodyMatch = htmlText.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch?.[1]?.trim();
  if (bodyContent) return bodyContent;

  const trimmed = htmlText.trim();
  return trimmed || null;
}

const MAX_API_ERROR_TEXT_LENGTH = 300;
const SUPPORTED_LOOKUP_READING_TYPES = new Set(['hiragana', 'katakana', 'romaji']);

function safeErrorText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_API_ERROR_TEXT_LENGTH);
}

export function normalizeResponseMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function getResponseContentLength(response) {
  const value = String(response?.headers?.get?.('Content-Length') || '').trim();
  if (!/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function responseTooLargeError() {
  const error = new Error('Downloaded response exceeds the permitted size');
  error.code = 'response_too_large';
  return error;
}

export async function readBoundedResponseBlob(response, { maxBytes, allowedMimeTypes }) {
  const mimeType = normalizeResponseMimeType(response?.headers?.get?.('Content-Type'));
  const allowed = new Set(Array.from(allowedMimeTypes || [], normalizeResponseMimeType));
  if (!allowed.has(mimeType)) {
    throw new Error('Unexpected response content type');
  }

  const contentLength = getResponseContentLength(response);
  if (contentLength != null && contentLength > maxBytes) {
    throw responseTooLargeError();
  }

  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch (_) {
            // The size rejection remains the useful failure even if cancellation fails.
          }
          throw responseTooLargeError();
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return new Blob(chunks, { type: mimeType });
  }

  const blob = await response.blob();
  if (blob.size > maxBytes) throw responseTooLargeError();
  return new Blob([blob], { type: mimeType });
}

function getErrorBodyText(body) {
  if (!body || typeof body !== 'object') return '';
  for (const key of ['error', 'detail', 'message']) {
    const value = safeErrorText(body[key]);
    if (value) return value;
  }
  return '';
}

async function parseErrorBody(response) {
  try {
    const body = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch (_) {
    return {};
  }
}

function getRetryAfter(response, body) {
  const headerText = String(response?.headers?.get?.('Retry-After') || '').trim();
  const headerValue = /^\d+$/.test(headerText) ? Number(headerText) : NaN;
  const bodyValue = Number(body?.retry_after ?? body?.retryAfter);
  if (Number.isFinite(headerValue) && headerValue > 0) {
    return Math.min(Math.floor(headerValue), MAX_RETRY_AFTER_SECONDS);
  }
  if (Number.isFinite(bodyValue) && bodyValue > 0) {
    return Math.min(Math.floor(bodyValue), MAX_RETRY_AFTER_SECONDS);
  }
  const retryAtSeconds = Number(body?.retry_at ?? body?.retryAt);
  if (Number.isFinite(retryAtSeconds) && retryAtSeconds > Math.floor(Date.now() / 1000)) {
    return Math.min(
      MAX_RETRY_AFTER_SECONDS,
      Math.max(1, Math.ceil(retryAtSeconds - (Date.now() / 1000))),
    );
  }
  return null;
}

function createApiError(response, body = {}, fallbackMessage = 'API request failed', expectedOperation = 'furigana') {
  const status = Number(response?.status) || 0;
  const backendText = getErrorBodyText(body);
  const statusText = safeErrorText(response?.statusText);
  const message = backendText || (status ? `${fallbackMessage}: ${status}${statusText ? ` ${statusText}` : ''}` : fallbackMessage);
  const error = new Error(message);
  error.status = status;
  error.httpStatus = status;
  if (backendText) error.backendError = backendText;
  const rawOperation = safeErrorText(body?.operation);
  const operation = normalizeOperation(rawOperation, expectedOperation);
  const rawRateLimitType = safeErrorText(body?.rate_limit_type || body?.rateLimitType);
  const fallbackRateLimitType = operation === 'furigana'
    ? 'char_rate'
    : operation === 'nonce'
      ? 'nonce'
      : operation === 'examples'
        ? 'examples'
        : 'lookup';
  const rateLimitType = normalizeRateLimitType(rawRateLimitType)
    || (status === 429 ? fallbackRateLimitType : null);
  const retryAfter = getRetryAfter(response, body);
  error.operation = operation;
  error.errorCode = safeErrorText(body?.error_code || body?.errorCode)
    || (status === 503 ? 'service_unavailable' : status === 429 ? 'rate_limited' : 'api_error');
  if (rateLimitType) error.rateLimitType = rateLimitType;
  if (retryAfter != null) {
    error.retryAfter = retryAfter;
    error.retryAt = Date.now() + retryAfter * 1000;
    error.expiresAt = error.retryAt;
  } else if (status === 429) {
    error.retryAfter = LEGACY_RATE_LIMIT_FALLBACK_SECONDS;
    error.retryAt = Date.now() + LEGACY_RATE_LIMIT_FALLBACK_SECONDS * 1000;
    error.expiresAt = error.retryAt;
  }
  error.body = body;
  return error;
}

export async function fetchWithCooldown(url, options = {}, operation = 'furigana') {
  await enforceCooldown(operation);
  const Controller = globalThis.AbortController;
  const controller = typeof Controller === 'function'
    ? new Controller()
    : { signal: options.signal, abort() {} };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20_000;
  const timeoutId = typeof globalThis.setTimeout === 'function'
    ? globalThis.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const { timeoutMs: _ignoredTimeout, signal: _ignoredSignal, ...requestOptions } = options;
  try {
    const response = await fetch(url, { ...requestOptions, signal: controller.signal });
    if (response.ok) return response;
    const body = await parseErrorBody(response);
    const error = createApiError(response, body, 'API request failed', operation);
    await recordCooldown(error, operation);
    throw error;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('API request timed out');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error instanceof Error ? error : new Error('API request failed');
  } finally {
    if (timeoutId !== null && typeof globalThis.clearTimeout === 'function') {
      globalThis.clearTimeout(timeoutId);
    }
    callerSignal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function isRecognizedNonceFailure(body) {
  const text = ['error', 'detail', 'message']
    .map((key) => safeErrorText(body?.[key]))
    .filter(Boolean)
    .join(' ');
  return text.includes('Invalid or expired nonce') || text.includes('Nonce required');
}

function normalizeLookupValue(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  if (Array.from(trimmed).length > 64) throw new Error(`${label} is too long`);
  return trimmed;
}

export function normalizeDefinitionLookupArgs(word, reading, readingType) {
  const term = normalizeLookupValue(word, 'Word');
  if (reading !== undefined && typeof reading !== 'string') throw new Error('Reading must be a string');
  if (readingType !== undefined && typeof readingType !== 'string') throw new Error('Reading type must be a string');
  const normalizedReading = (reading || '').trim();
  if (Array.from(normalizedReading).length > 64) throw new Error('Reading is too long');
  const normalizedReadingType = (readingType || '').trim().toLowerCase();
  if (normalizedReadingType && !SUPPORTED_LOOKUP_READING_TYPES.has(normalizedReadingType)) {
    throw new Error('Unsupported reading type');
  }
  return {
    word: term,
    reading: normalizedReading,
    readingType: normalizedReading ? normalizedReadingType : ''
  };
}

export function getDefinitionCacheKey(word, reading = '', readingType = '') {
  return JSON.stringify([
    String(word || '').trim(),
    String(reading || '').trim(),
    String(readingType || '').trim().toLowerCase()
  ]);
}

function buildDefinitionUrl(path, args) {
  const url = new URL(`${API_BASE_URL}${path}`);
  url.searchParams.set('word', args.word);
  if (args.reading) url.searchParams.set('reading', args.reading);
  if (args.reading && args.readingType) url.searchParams.set('reading_type', args.readingType);
  return url;
}

function buildLegacyDefinitionUrl(args) {
  const url = new URL(`${API_BASE_URL}/api/word-definition/${encodeURIComponent(args.word)}`);
  if (args.reading) url.searchParams.set('reading', args.reading);
  if (args.reading && args.readingType) url.searchParams.set('reading_type', args.readingType);
  return url;
}

async function getNonceForApiRequest() {
  // Nonces remain optional during the compatibility rollout. A nonce
  // cooldown suppresses acquisition but does not block nonce-free endpoints.
  return _getExtNonce();
}

async function refreshNonceForApiRequest(staleNonce) {
  // A concurrent caller may already have installed a newer nonce. Reuse it
  // instead of clearing valid state or starting another refresh.
  if (_extNonce && _extNonce !== staleNonce) return _extNonce;
  if (_extNonce === staleNonce) _resetExtNonce('api-nonce-403');
  const nonce = await _getExtNonce();
  if (!nonce) throw _nonceLastError || new Error('Extension nonce refresh failed');
  return nonce;
}

async function requestExtensionJsonWithNonce(url, nonce, retryState, operation = 'dictionary') {
  const requestUrl = new URL(url.toString());
  if (nonce) requestUrl.searchParams.set('ext_nonce', nonce);

  try {
    const response = await fetchWithCooldown(requestUrl.toString(), {
      method: 'GET',
      headers: { 'x-extension-session-id': _EXT_SESSION_ID },
      credentials: 'omit',
      mode: 'cors',
    }, operation);
    try {
      return await response.json();
    } catch (_) {
      throw createApiError(response, {}, 'API response was not valid JSON', operation);
    }
  } catch (error) {
    if (error?.status === 403 && nonce && !retryState.nonceRetryUsed && isRecognizedNonceFailure(error.body)) {
      retryState.nonceRetryUsed = true;
      const refreshedNonce = await refreshNonceForApiRequest(nonce);
      return requestExtensionJsonWithNonce(url, refreshedNonce, retryState, operation);
    }
    throw error instanceof Error ? error : new Error('API request failed');
  }
}

export async function requestExtensionJson(url, options = {}) {
  const retryState = options.retryState || { nonceRetryUsed: false };
  const nonce = await getNonceForApiRequest();
  return requestExtensionJsonWithNonce(
    new URL(url.toString()),
    nonce,
    retryState,
    normalizeOperation(options.operation, 'dictionary'),
  );
}

function assertDefinitionPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.entries)) {
    throw new Error('Definition response was malformed');
  }
  return data;
}

function assertJsonObject(data, label) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} response was malformed`);
  }
  return data;
}

export async function lookupDefinition(word, reading, readingType) {
  const args = normalizeDefinitionLookupArgs(word, reading, readingType);
  const cacheKey = getDefinitionCacheKey(args.word, args.reading, args.readingType);
  pruneDefinitionCache();

  const cached = definitionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DEFINITION_CACHE_TTL) return cached.data;

  const sharedRequest = definitionInFlightCache.get(cacheKey);
  if (sharedRequest) return sharedRequest;

  const request = (async () => {
    const retryState = { nonceRetryUsed: false };
    let data;
    try {
      data = assertDefinitionPayload(await requestExtensionJson(buildDefinitionUrl('/api/extension/word-definition', args), { retryState, operation: 'dictionary' }));
    } catch (error) {
      if (error.status !== 404 && error.status !== 405) throw error;
      data = assertDefinitionPayload(await requestExtensionJson(buildLegacyDefinitionUrl(args), { retryState, operation: 'dictionary' }));
    }
    definitionCache.set(cacheKey, { data, timestamp: Date.now() });
    pruneDefinitionCache();
    return data;
  })();

  definitionInFlightCache.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (definitionInFlightCache.get(cacheKey) === request) definitionInFlightCache.delete(cacheKey);
  }
}

export async function fetchExampleSentence(word) {
  const term = normalizeLookupValue(word, 'Word');
  const url = new URL(`${API_BASE_URL}/api/example-sentence/${encodeURIComponent(term)}`);
  return assertJsonObject(await requestExtensionJson(url, { operation: 'examples' }), 'Example sentence');
}

export async function fetchKanjiBreakdown(word) {
  const term = normalizeLookupValue(word, 'Word');
  const url = new URL(`${API_BASE_URL}/api/kanji-breakdown/${encodeURIComponent(term)}`);
  return assertJsonObject(await requestExtensionJson(url, { operation: 'dictionary' }), 'Kanji breakdown');
}

export async function handlePlayAudio(word, reading) {
  const normalizedReading = kata2hira(reading || word || '');
  const enc = encodeURIComponent;
  const base = `${API_BASE_URL}/api/proxy-audio`;

  const urlsToTry = [];
  // 1. Standard kanji + kana (only when they differ — avoids duplicate for pure-kana words)
  if (word && normalizedReading && word !== normalizedReading) {
    urlsToTry.push(`${base}?kana=${enc(normalizedReading)}&kanji=${enc(word)}`);
  }
  // 2. Kana-only (fixes pure-kana words where JP101 leaves the kanji field blank)
  if (normalizedReading) {
    urlsToTry.push(`${base}?kana=${enc(normalizedReading)}&kanji=`);
  }
  // 3. Kanji-only fallback
  if (word) {
    urlsToTry.push(`${base}?kana=&kanji=${enc(word)}`);
  }

  let waitedOnRateLimit = false;
  for (const audioUrl of urlsToTry) {
    const response = await fetch(audioUrl);
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const retryAfterHeader = Number.parseInt(response.headers.get('Retry-After') || '', 10);
      const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? Math.min(retryAfterHeader, 86400)
        : 1;
      const rateLimitType = body?.rate_limit_type || 'audio_cold_fetch';
      const err = new Error(body?.error || 'Audio rate limited');
      err.rateLimitType = rateLimitType;
      err.retryAfter = retryAfter;
      // Wait at most 1 second once for a cold-fetch slot; beyond that, fall back to TTS.
      if (!waitedOnRateLimit && retryAfter <= 1) {
        waitedOnRateLimit = true;
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
    if (!response.ok) continue;
    const blob = await readBoundedResponseBlob(response, {
      maxBytes: MAX_AUDIO_RESPONSE_BYTES,
      allowedMimeTypes: AUDIO_RESPONSE_MIME_TYPES,
    });
    if (blob.size < MIN_AUDIO_RESPONSE_BYTES) continue; // reject JP101's 52-byte empty placeholder audio
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
    return { dataUrl };
  }
  throw new Error('Audio not found');
}

export async function handlePlayAudioDirect(word, reading) {
  return handlePlayAudio(word, reading);
}

export async function handleFetchProxyAudio(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsedUrl.protocol !== 'https:') throw new Error('Disallowed audio protocol');
  if (parsedUrl.hostname !== 'www.ezfurigana.com' && !parsedUrl.hostname.endsWith('.ezfurigana.com')) {
    throw new Error('Disallowed audio host');
  }
  if (parsedUrl.port !== '' && parsedUrl.port !== '443') throw new Error('Disallowed audio port');

  const response = await fetch(parsedUrl.toString());
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await readBoundedResponseBlob(response, {
    maxBytes: MAX_AUDIO_RESPONSE_BYTES,
    allowedMimeTypes: AUDIO_RESPONSE_MIME_TYPES,
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve({ dataUrl: reader.result });
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

export async function handleExportAnkiAudio(payload) {
  const response = await fetch(`${API_BASE_URL}/api/export-anki-zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words: payload }),
    credentials: 'omit',
    mode: 'cors',
  });
  if (!response.ok) {
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const retryAfterHeader = Number.parseInt(response.headers.get('Retry-After') || '', 10);
      const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? Math.min(retryAfterHeader, 86400)
        : 60;
      const err = new Error(body?.error || 'Export rate limited');
      err.rateLimitType = body?.rate_limit_type || 'audio_export';
      err.retryAfter = retryAfter;
      throw err;
    }
    throw new Error(`Export failed: ${response.status} ${response.statusText}`);
  }
  const blob = await readBoundedResponseBlob(response, {
    maxBytes: MAX_ANKI_ZIP_RESPONSE_BYTES,
    allowedMimeTypes: ANKI_ZIP_RESPONSE_MIME_TYPES,
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve({ dataUrl: reader.result });
    reader.onerror = () => reject(new Error('Failed to convert ZIP to Base64'));
    reader.readAsDataURL(blob);
  });
}
