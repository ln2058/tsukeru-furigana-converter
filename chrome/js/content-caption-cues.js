/*
Module: content-caption-cues
Purpose: Know a video's subtitle lines ahead of time and give them furigana before they show: read the subtitle file (YouTube's json3 or Netflix's TTML from page-captions, a WebVTT file a player loaded, or a video's text tracks), process the next few minutes in the background, and hand the stored results to the caption code when a line appears.

Inputs:
- `tsukeru-page-captions` window messages from page-captions (untrusted page data: shape and size are checked).
- WebVTT text and `TextTrack` cues from content-caption-layer (embedded players and `<track>` videos).
- The playing video's time, seeks, and YouTube's page navigation.
- Whether furigana is on, the caption settings, and the caption allowance (`captionGateOpen`).

Outputs:
- `captionPieceHtml(text)`: processed HTML for a line already processed, or null.
- `applyPrefetchedCaptionNodes(nodes)`: puts stored results onto caption text nodes and returns the nodes still to process live.
- The current cue list (`captionCueTrack`) for the caption layer and the caption tools, and `captionCueTime(video)`, the video's time on the cue list's clock (Netflix's video clock can differ after an ad).

Side Effects:
- Sends caption text to the background (`processFurigana`, marked as caption text), a few minutes ahead of playback, in batches under the usual request size.
- Keeps at most one video's cues and processed lines in memory; both are dropped when the video, the settings, or the page changes, or furigana is cleared.

Failure Modes:
- A file that does not parse, or has no Japanese, is ignored; lines then get furigana as they show.
- A refused or failed batch waits a minute before trying again; the caption allowance's refusal stops processing ahead.

Security Notes:
- Parses subtitle text only as text (TTML through DOMParser as XML, never inserted); author furigana (TTML ruby) is kept as text.
- Processed HTML is stored as the background returns it and sanitized by the caption code at insertion.
- Nothing here is logged; caption text goes only to the background's furigana request, like any page text.
*/

const CAPTION_AHEAD_S = 150;
const CAPTION_REFILL_S = 60;
const CAPTION_CHECK_MS = 3000;
const CAPTION_RETRY_MS = 60 * 1000;
const CAPTION_BATCH_BYTES = 30000;
const CAPTION_MAX_CUES = 12000;
const CAPTION_MAX_PIECE_CHARS = 400;
const CAPTION_MAX_STORED = 6000;
const CAPTION_PAGE_SOURCE = 'tsukeru-page-captions';
const CAPTION_MAX_BODY_CHARS = 4 * 1024 * 1024;

// One video's subtitle lines: { key, source, cues: [{ start, end, text, lines, pieces }] }.
var captionCueTrack = null;
let captionPieceStore = new Map();
let captionPieceSettings = '';
let captionPrefetchBusy = false;
let captionPrefetchPausedUntil = 0;
let captionPrefetchCheckedAt = 0;
let captionPrefetchSerial = 0;
let captionCueListenersBound = false;
// Seconds from the video's clock to the subtitle file's: Netflix restarts its video's clock
// after an ad, so the Netflix layer sets this from the line Netflix itself shows.
let captionClockOffset = 0;
const captionPiecesInFlight = new Set();

/** The same line however its spaces and line breaks were laid out. */
function captionPieceKey(text) {
  return String(text || '').normalize('NFC').replace(/\s+/g, '');
}

/** The video's time on the subtitle file's clock. */
function captionCueTime(video) {
  return (Number(video?.currentTime) || 0) + captionClockOffset;
}

function captionHasJapanese(text) {
  return JAPANESE_CHAR_RE.test(String(text || ''));
}

/** A cue whose lines are plain text: one piece per line, or the joined lines for in-place captions. */
function plainCue(start, end, text, { joined = false } = {}) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length || !captionHasJapanese(lines.join(''))) return null;
  return {
    start,
    end,
    text: lines.join('\n'),
    lines: lines.map((line) => [{ text: line }]),
    pieces: joined ? [lines.join('')] : lines,
  };
}

function finishCues(cues) {
  return cues
    .filter((cue) => cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .sort((a, b) => a.start - b.start)
    .slice(0, CAPTION_MAX_CUES);
}

/**
 * YouTube's json3 track: each event with text is a line; `aAppend` events
 * only roll the window. Auto-generated lines are one event too, revealed
 * word by word on screen; the whole line is processed ahead.
 */
function parseYoutubeJson3(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    return [];
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  const cues = [];
  for (const event of events.slice(0, CAPTION_MAX_CUES * 3)) {
    if (!event || event.aAppend || !Array.isArray(event.segs)) continue;
    const start = Number(event.tStartMs) / 1000;
    const duration = Number(event.dDurationMs) / 1000;
    const text = event.segs.map((seg) => (typeof seg?.utf8 === 'string' ? seg.utf8 : '')).join('');
    // YouTube shows a cue's lines side by side in one caption box: process them as one run.
    const cue = plainCue(start, start + (Number.isFinite(duration) ? duration : 0), text, { joined: true });
    if (cue) cues.push(cue);
  }
  return finishCues(cues);
}

function vttTime(value) {
  const match = String(value).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
}

const VTT_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

function stripVttTags(text) {
  // Cue text may carry <c>, <i>, <v Speaker>, timestamps and entities; keep the words.
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
      if (name[0] !== '#') return VTT_ENTITIES[name.toLowerCase()] ?? entity;
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

/** A WebVTT file's cues, lines kept as they are (players show them in place, joined). */
function parseWebVtt(text, { joined = true } = {}) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks.slice(0, CAPTION_MAX_CUES * 2)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) continue;
    const [from, rest] = lines[timing].split('-->');
    const to = String(rest || '').trim().split(/\s+/)[0];
    const cue = plainCue(vttTime(from), vttTime(to), stripVttTags(lines.slice(timing + 1).join('\n')), { joined });
    if (cue) cues.push(cue);
  }
  return finishCues(cues);
}

/** Cues from a video's own text track (already parsed by the browser). */
function cuesFromTextTrack(track, { joined = false } = {}) {
  const cues = [];
  for (const cue of Array.from(track?.cues || []).slice(0, CAPTION_MAX_CUES)) {
    const made = plainCue(cue.startTime, cue.endTime, stripVttTags(cue.text || ''), { joined });
    if (made) cues.push(made);
  }
  return finishCues(cues);
}

function ttmlTime(value, tickRate) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d+(?:\.\d+)?)t$/);
  if (match) return Number(match[1]) / tickRate;
  match = text.match(/^(\d+(?:\.\d+)?)(ms|s)$/);
  if (match) return Number(match[1]) / (match[2] === 'ms' ? 1000 : 1);
  match = text.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return NaN;
}

/**
 * Netflix's IMSC TTML: cues with their region (horizontal or vertical), line
 * breaks, slanted text, emphasis dots, and the author's own furigana
 * (`tts:ruby` container/base/text), which is shown as written and never sent.
 */
function parseTtml(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
  } catch (_) {
    return [];
  }
  const root = doc?.documentElement;
  if (!root || root.localName !== 'tt' || doc.getElementsByTagName('parsererror').length) return [];
  const attr = (element, name) => {
    for (const item of Array.from(element?.attributes || [])) {
      if (item.localName === name) return item.value;
    }
    return '';
  };
  const tickRate = Number(attr(root, 'tickRate')) || 10000000;
  const styles = new Map();
  for (const style of Array.from(doc.getElementsByTagNameNS('*', 'style'))) {
    styles.set(attr(style, 'id'), {
      ruby: attr(style, 'ruby'),
      shear: Boolean(attr(style, 'shear')) && attr(style, 'shear') !== '0%',
      emphasis: Boolean(attr(style, 'textEmphasis')) && attr(style, 'textEmphasis') !== 'none',
      align: attr(style, 'textAlign'),
    });
  }
  const regions = new Map();
  for (const region of Array.from(doc.getElementsByTagNameNS('*', 'region'))) {
    regions.set(attr(region, 'id'), {
      vertical: /^tb/.test(attr(region, 'writingMode')),
      top: attr(region, 'displayAlign') === 'before',
    });
  }
  const styleOf = (element) => styles.get(attr(element, 'style')) || {};
  const cues = [];
  for (const p of Array.from(doc.getElementsByTagNameNS('*', 'p')).slice(0, CAPTION_MAX_CUES)) {
    const lines = [[]];
    const pStyle = styleOf(p);
    const walk = (node, inherited) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const value = child.nodeValue.replace(/\s+/g, ' ');
          if (value.trim()) lines[lines.length - 1].push({ text: value, ...inherited });
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (child.localName === 'br') {
          lines.push([]);
          continue;
        }
        const style = styleOf(child);
        const look = { slanted: inherited.slanted || style.shear, emphasis: inherited.emphasis || style.emphasis };
        if (style.ruby === 'container') {
          let base = '';
          let reading = '';
          for (const part of Array.from(child.children)) {
            const role = styleOf(part).ruby;
            if (role === 'base') base += part.textContent;
            else if (role === 'text') reading += part.textContent;
          }
          if (base.trim()) lines[lines.length - 1].push({ base: base.trim(), ruby: reading.trim(), ...look });
          continue;
        }
        walk(child, look);
      }
    };
    walk(p, { slanted: Boolean(pStyle.shear), emphasis: Boolean(pStyle.emphasis) });
    const kept = lines.filter((line) => line.length);
    const plain = kept.flat().filter((part) => typeof part.text === 'string').map((part) => part.text.trim()).filter(Boolean);
    const allText = kept.flat().map((part) => part.text ?? part.base).join('');
    if (!kept.length || !captionHasJapanese(allText)) continue;
    const region = regions.get(attr(p, 'region')) || {};
    cues.push({
      start: ttmlTime(attr(p, 'begin'), tickRate),
      end: ttmlTime(attr(p, 'end'), tickRate),
      text: kept.map((line) => line.map((part) => part.text ?? part.base).join('')).join('\n'),
      lines: kept,
      pieces: plain.filter(captionHasJapanese),
      vertical: Boolean(region.vertical),
      top: Boolean(region.top),
      align: pStyle.align || '',
    });
  }
  return finishCues(cues);
}

// ── The current video's cues and their stored results ───────────────────────

function captionSettingsKey(settings) {
  return String(settings?.furiganaType || 'hiragana');
}

function captionActiveSettings() {
  return videoCaptionSettings || lastAppliedSettings || null;
}

/** Use these cues for the video playing now; a different key starts over. */
function setCaptionCueTrack(key, source, cues) {
  if (!Array.isArray(cues) || !cues.length) return;
  if (captionCueTrack?.key !== key) {
    captionPrefetchPausedUntil = 0;
    captionPieceStore = new Map();
    captionClockOffset = 0;
  }
  captionCueTrack = { key, source, cues };
  bindCaptionCueListeners();
  captionPrefetchCheck(true);
  if (typeof refreshVideoWords === 'function') refreshVideoWords();
}

function clearCaptionCueTrack() {
  captionCueTrack = null;
  captionPieceStore = new Map();
  captionClockOffset = 0;
  captionPiecesInFlight.clear();
  captionPrefetchPausedUntil = 0;
}

/** Stored processed HTML for a line, for the current settings. */
function captionPieceHtml(text) {
  const settings = captionActiveSettings();
  if (!settings || captionSettingsKey(settings) !== captionPieceSettings) return null;
  return captionPieceStore.get(captionPieceKey(text)) ?? null;
}

function storeCaptionPiece(text, html) {
  captionPieceStore.delete(captionPieceKey(text));
  captionPieceStore.set(captionPieceKey(text), html);
  while (captionPieceStore.size > CAPTION_MAX_STORED) captionPieceStore.delete(captionPieceStore.keys().next().value);
}

function keepWhitespace(source, html) {
  const trimmed = source.trim();
  return trimmed ? source.replace(trimmed, () => html) : source;
}

/**
 * Put stored results onto caption text nodes: the nodes' joined text as one
 * line (split back onto the nodes), or each node on its own. Returns the
 * nodes that still need processing.
 */
function applyPrefetchedCaptionNodes(nodes) {
  if (!captionPieceStore.size || !nodes.length) return nodes;
  const texts = nodes.map((node) => node.textContent || '');
  const insert = (node, index, html) => replaceTextNodeWithHtml(node, keepWhitespace(texts[index], html), {
    markCaption: true,
    expectedText: texts[index],
  });
  const whole = captionPieceHtml(texts.join(''));
  if (whole !== null) {
    const pieces = nodes.length === 1 ? [whole.trim()] : splitRunHtml(whole, texts.map((text) => text.trim()));
    if (pieces) {
      nodes.forEach((node, index) => insert(node, index, pieces[index]));
      return [];
    }
  }
  return nodes.filter((node, index) => {
    const html = captionPieceHtml(texts[index]);
    if (html === null) return true;
    insert(node, index, html);
    return false;
  });
}

// ── Processing ahead ─────────────────────────────────────────────────────────

function captionVideo() {
  if (currentSite === 'youtube') return document.querySelector('video.html5-main-video') || document.querySelector('video');
  return captionPlayingVideo?.() || document.querySelector('video');
}

/** The lines from `time` up to a few minutes ahead that have no result yet. */
function captionPiecesAhead(time) {
  const pieces = [];
  const seen = new Set();
  for (const cue of captionCueTrack?.cues || []) {
    if (cue.end <= time) continue;
    if (cue.start > time + CAPTION_AHEAD_S) break;
    for (const piece of cue.pieces) {
      const key = captionPieceKey(piece);
      if (!key || seen.has(key) || captionPieceStore.has(key) || captionPiecesInFlight.has(key)) continue;
      if (piece.length > CAPTION_MAX_PIECE_CHARS) continue;
      seen.add(key);
      pieces.push({ text: piece, start: cue.start });
    }
  }
  return pieces;
}

/** Check whether the next few minutes need processing (at most every few seconds unless forced). */
function captionPrefetchCheck(force = false) {
  const now = Date.now();
  if (!force && now - captionPrefetchCheckedAt < CAPTION_CHECK_MS) return;
  captionPrefetchCheckedAt = now;
  if (!captionCueTrack || captionPrefetchBusy || now < captionPrefetchPausedUntil) return;
  if (!isFuriganaActive || !captionGateOpen()) return;
  const settings = captionActiveSettings();
  if (!settings) return;
  const video = captionVideo();
  const time = captionCueTime(video);
  const pending = captionPiecesAhead(time);
  // Plenty is ready: wait until less than a minute ahead is left.
  if (!pending.length || (!force && pending[0].start > time + CAPTION_REFILL_S)) return;
  requestCaptionPieces(pending.map((piece) => piece.text), settings);
}

/** Process lines now (ahead of time, or a line on screen the layer needs). */
async function requestCaptionPieces(texts, settings = captionActiveSettings()) {
  if (!settings || !captionGateOpen()) return;
  const encoder = new TextEncoder();
  const batch = [];
  let bytes = 0;
  for (const text of texts) {
    const key = captionPieceKey(text);
    if (!key || captionPieceStore.has(key) || captionPiecesInFlight.has(key)) continue;
    const size = encoder.encode(text).length + 32;
    if (batch.length && bytes + size > CAPTION_BATCH_BYTES) break;
    batch.push({ text, key, marker: `${TOKEN_PREFIX}q${captionPrefetchSerial}x${batch.length}__` });
    bytes += size;
  }
  if (!batch.length) return;
  captionPrefetchSerial += 1;
  const settingsKey = captionSettingsKey(settings);
  batch.forEach((piece) => captionPiecesInFlight.add(piece.key));
  captionPrefetchBusy = true;
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'processFurigana',
      payload: { textContent: batch.map((piece) => piece.marker + piece.text).join(''), settings, caption: true },
    });
    if (response?.errorCode === 'caption_limit') {
      noteCaptionRefused(response.allowance);
      return;
    }
    if (!response?.success || !response.processedHTML) {
      // Rate limits and outages: lines still get furigana as they show; try again later.
      captionPrefetchPausedUntil = Date.now() + CAPTION_RETRY_MS;
      return;
    }
    if (captionPieceSettings !== settingsKey) {
      captionPieceStore = new Map();
      captionPieceSettings = settingsKey;
    }
    const chunks = extractMarkedChunks({ markers: batch.map((piece) => piece.marker) }, response.processedHTML);
    batch.forEach((piece, index) => {
      const html = chunks.get(index);
      if (html !== undefined) storeCaptionPiece(piece.text, html.trim());
    });
    if (typeof onCaptionPiecesStored === 'function') onCaptionPiecesStored();
  } catch (_) {
    captionPrefetchPausedUntil = Date.now() + CAPTION_RETRY_MS; // Extension reloaded under the page.
  } finally {
    batch.forEach((piece) => captionPiecesInFlight.delete(piece.key));
    captionPrefetchBusy = false;
  }
}

// ── Subtitle files from the page (page-captions) ─────────────────────────────

function currentYoutubeVideoId() {
  try {
    const url = new URL(location.href);
    return url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1] || '';
  } catch (_) {
    return '';
  }
}

function onPageCaptionsMessage(event) {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== CAPTION_PAGE_SOURCE || typeof data.body !== 'string') return;
  if (data.body.length > CAPTION_MAX_BODY_CHARS || !data.track || typeof data.track !== 'object') return;
  const video = typeof data.track.video === 'string' ? data.track.video.slice(0, 64) : '';
  const lang = typeof data.track.lang === 'string' ? data.track.lang.slice(0, 16) : '';
  if (data.kind === 'youtube-json3' && currentSite === 'youtube') {
    // Only the video on screen: YouTube also loads tracks for previews.
    if (video && video !== currentYoutubeVideoId()) return;
    setCaptionCueTrack(`youtube:${video}:${lang}:${data.track.auto === true ? 'auto' : 'manual'}`, 'youtube', parseYoutubeJson3(data.body));
  } else if (data.kind === 'netflix-ttml' && /(^|\.)netflix\.com$/.test(location.hostname)) {
    if (typeof startNetflixCaptions === 'function') startNetflixCaptions(`netflix:${video}`, parseTtml(data.body));
  }
}

function onCaptionCueTime(event) {
  if (event.target instanceof HTMLVideoElement && captionCueTrack) captionPrefetchCheck(event.type === 'seeked');
}

function bindCaptionCueListeners() {
  if (captionCueListenersBound) return;
  captionCueListenersBound = true;
  document.addEventListener('timeupdate', onCaptionCueTime, true);
  document.addEventListener('seeked', onCaptionCueTime, true);
  // YouTube changes videos without loading a page.
  document.addEventListener('yt-navigate-finish', () => {
    if (captionCueTrack?.source === 'youtube' && !captionCueTrack.key.startsWith(`youtube:${currentYoutubeVideoId()}:`)) {
      clearCaptionCueTrack();
    }
  });
}

/** Start listening for subtitle files the page's player loads (once per page). */
function listenForPageCaptions() {
  if (window.__tsukeruPageCaptionsListening) return;
  window.__tsukeruPageCaptionsListening = true;
  window.addEventListener('message', onPageCaptionsMessage);
}
