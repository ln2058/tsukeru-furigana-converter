/*
Module: bg-api
Purpose: Execute backend workflows for furigana processing, dictionary data, audio proxying, and export.

Inputs:
- Text chunk payloads, settings, tab URLs, and action parameters.
- Network responses from EZFurigana API endpoints.

Outputs:
- Processed furigana HTML, lookup payloads, and base64 data URLs.

Side Effects:
- Performs network fetches and enforces in-memory rate limiting.
- Reads/writes cached furigana fragments through `bg-cache`.

Failure Modes:
- Network/API failures, malformed responses, and rate-limit rejections.
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

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_CHARS = 50_000;
const rateLimitBuckets = [];

function checkCharRateLimit(nextLen) {
  const now = Date.now();
  while (rateLimitBuckets.length && now - rateLimitBuckets[0].timestamp > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.shift();
  }
  const used = rateLimitBuckets.reduce((sum, entry) => sum + entry.len, 0);
  if (used + nextLen > RATE_LIMIT_MAX_CHARS) return false;
  rateLimitBuckets.push({ timestamp: now, len: nextLen });
  return true;
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

  // ── Step 1: Dismantle the payload into per-node chunks ────────────────────
  const chunks = dismantlePayload(textContent);

  // No markers: unusual edge case — rate-check the whole payload and fetch raw.
  if (!chunks.length) {
    if (!checkCharRateLimit(textContent.length)) {
      throw new Error(`Rate limit exceeded: max ${RATE_LIMIT_MAX_CHARS} characters per ${RATE_LIMIT_WINDOW_MS / 1000}s`);
    }
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
    if (!checkCharRateLimit(missingChars)) {
      throw new Error(`Rate limit exceeded: max ${RATE_LIMIT_MAX_CHARS} characters per ${RATE_LIMIT_WINDOW_MS / 1000}s`);
    }

    const missingPayload = missingChunks.map(c => c.marker + c.text).join('');
    const result = await fetchFromAPI(missingPayload, settings, tabUrl);

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
  return { processedHTML: finalHTML };
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
    _nonceLog('nonce-fetch-start', { extSessionId: _EXT_SESSION_ID });
    try {
      const res = await fetch(`${API_BASE_URL}/api/extension/nonce`, {
        method: 'GET',
        headers: { 'x-extension-session-id': _EXT_SESSION_ID },
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
      });
      if (!res.ok) {
        _nonceLog('nonce-fetch-failed', { extSessionId: _EXT_SESSION_ID, status: res.status });
        return null;
      }
      const data = await res.json();
      if (!data?.nonce) {
        _nonceLog('nonce-fetch-failed', { extSessionId: _EXT_SESSION_ID, reason: 'missing_nonce_field' });
        return null;
      }
      _extNonce = data.nonce;
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

// Low-level API fetch — sends raw textContent and returns { processedHTML }.
export async function fetchFromAPI(textContent, settings, tabUrl) {
  const apiUrl = API_BASE_URL;
  const endpoints = [`${apiUrl}/api/extension/furigana`, `${apiUrl}/furigana/html`];
  let lastError = null;
  const backendWebsiteUrl = getBackendWebsiteUrl(tabUrl);

  // let (not const) — nulled out on 403 so the retry fires without a nonce.
  let nonce = await _getExtNonce();

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

      let response = await fetch(endpoint, {
        method: 'POST',
        body: buildFormData(),
        headers: { 'x-extension-session-id': _EXT_SESSION_ID },
        credentials: 'omit',
        mode: 'cors',
      });

      // Nonce self-heal: a 403 on the extension endpoint almost always means the
      // cached nonce is stale (server key rotation, service-worker restart after a
      // redeploy, IP change). Clear the in-memory nonce and retry once without it.
      // EXT_REQUIRE_NONCE=false ensures a nonce-free request is accepted.
      // Only applies to the dedicated extension endpoint — the HTML fallback has no
      // CORS headers so a 403 there would produce a network error, not an HTTP 403.
      if (response.status === 403 && nonce && endpoint.includes('/api/extension/')) {
        _resetExtNonce('furigana-403');
        nonce = await _getExtNonce();
        _nonceLog('nonce-refresh-after-403', {
          extSessionId: _EXT_SESSION_ID,
          refreshed: Boolean(nonce),
        });
        response = await fetch(endpoint, {
          method: 'POST',
          body: buildFormData(),
          headers: { 'x-extension-session-id': _EXT_SESSION_ID },
          credentials: 'omit',
          mode: 'cors',
        });
      }

      if (!response.ok) {
        if (endpoint.includes('/api/extension/') && (response.status === 401 || response.status === 403)) {
          lastError = new Error(`Extension auth failed: ${response.status}`);
          console.error('Tsukeru extension auth failure', endpoint, response.status, response.statusText);
          break;
        }
        lastError = new Error(`API request failed: ${response.status} ${response.statusText}`);
        console.error('Tsukeru backend error', endpoint, response.status, response.statusText);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      let processedHTML = null;
      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (data?.html) processedHTML = data.html;
        else { lastError = new Error('JSON response missing html field'); continue; }
      } else {
        const responseText = await response.text();
        processedHTML = extractProcessedHtml(responseText);
      }

      if (!processedHTML) { lastError = new Error('Could not read processed HTML from backend response.'); continue; }

      return { processedHTML };
    } catch (err) {
      lastError = err;
      console.error('Tsukeru fetch exception', endpoint, err);
      continue;
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

export async function lookupDefinition(word) {
  const term = (word || '').trim();
  if (!term) throw new Error('No word provided');

  const now = Date.now();

  // Evict expired entries to prevent indefinite memory growth
  for (const [key, entry] of definitionCache.entries()) {
    if (now - entry.timestamp >= DEFINITION_CACHE_TTL) {
      definitionCache.delete(key);
    }
  }

  const cached = definitionCache.get(term);
  if (cached && now - cached.timestamp < DEFINITION_CACHE_TTL) {
    return cached.data;
  }

  const endpoints = [
    `${API_BASE_URL}/api/extension/word-definition?word=${encodeURIComponent(term)}`,
    `${API_BASE_URL}/api/word-definition/${encodeURIComponent(term)}`
  ];
  let lastError = null;
  const nonce = await _getExtNonce();

  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      if (nonce) url.searchParams.set('ext_nonce', nonce);
      const hadNonce = url.searchParams.has('ext_nonce');
      const response = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
      });
      if (!response.ok) {
        lastError = new Error(`API request failed: ${response.status} ${response.statusText}`);
        continue;
      }
      const data = await response.json();
      if (hadNonce) {
        definitionCache.set(term, { data, timestamp: now });
      }
      return data;
    } catch (err) {
      lastError = err;
      console.error('Definition fetch exception', endpoint, err);
      continue;
    }
  }

  throw lastError || new Error('Definition lookup failed');
}

export async function fetchExampleSentence(word) {
  const term = (word || '').trim();
  if (!term) throw new Error('No word provided');

  const nonce = await _getExtNonce();
  const url = new URL(`${API_BASE_URL}/api/example-sentence/${encodeURIComponent(term)}`);
  if (nonce) url.searchParams.set('ext_nonce', nonce);
  const response = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'omit',
    mode: 'cors',
  });
  if (!response.ok) throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  return await response.json();
}

export async function fetchKanjiBreakdown(word) {
  const term = (word || '').trim();
  if (!term) throw new Error('No word provided');

  const nonce = await _getExtNonce();
  const url = new URL(`${API_BASE_URL}/api/kanji-breakdown/${encodeURIComponent(term)}`);
  if (nonce) url.searchParams.set('ext_nonce', nonce);
  const response = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'omit',
    mode: 'cors',
  });
  if (!response.ok) throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  return await response.json();
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

  for (const audioUrl of urlsToTry) {
    const response = await fetch(audioUrl);
    if (!response.ok) continue;
    const blob = await response.blob();
    if (blob.size < 100) continue; // reject JP101's 52-byte empty placeholder audio
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
  // Firefox compatibility alias retained for older content-script message paths.
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
  const blob = await response.blob();
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
  if (!response.ok) throw new Error(`Export failed: ${response.status} ${response.statusText}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve({ dataUrl: reader.result });
    reader.onerror = () => reject(new Error('Failed to convert ZIP to Base64'));
    reader.readAsDataURL(blob);
  });
}
