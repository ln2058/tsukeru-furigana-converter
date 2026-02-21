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

// Low-level API fetch — sends raw textContent and returns { processedHTML }.
export async function fetchFromAPI(textContent, settings, tabUrl) {
  const apiUrl = API_BASE_URL;
  const endpoints = [`${apiUrl}/api/extension/furigana`, `${apiUrl}/furigana/html`];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const formData = new FormData();
      formData.append('input_mode', 'text');
      formData.append('engine', 'sudachi');
      // Always request jlpt_level=5 (max-render: backend annotates all words); JLPT filtering is CSS-driven client-side
      formData.append('jlpt_level', '5');
      formData.append('furigana_type', settings.furiganaType || DEFAULT_SETTINGS.furiganaType);
      formData.append('first_occurrence_only', settings.firstOccurrenceOnly ? 'on' : '');
      formData.append('raw_text', textContent);
      formData.append('website_url', tabUrl || '');
      formData.append('csrf_token', '');

      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
        credentials: 'omit',
        mode: 'cors',
      });
      if (!response.ok) {
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

// Parse the HTML fallback response (used when content-type is not JSON).
// extractViaRegex removed — DOMParser is available in Chrome 96+ service workers.
function extractProcessedHtml(htmlText) {
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
    console.error('Failed to parse backend response:', err);
  }
  return null;
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

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
      });
      if (!response.ok) {
        lastError = new Error(`API request failed: ${response.status} ${response.statusText}`);
        continue;
      }
      const data = await response.json();
      definitionCache.set(term, { data, timestamp: now });
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

  const response = await fetch(`${API_BASE_URL}/api/example-sentence/${encodeURIComponent(term)}`, {
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

  const response = await fetch(`${API_BASE_URL}/api/kanji-breakdown/${encodeURIComponent(term)}`, {
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

export async function handleFetchProxyAudio(url) {
  const response = await fetch(url);
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
