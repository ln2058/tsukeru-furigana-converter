/*
Module: content-caption-layer
Purpose: Show Japanese subtitles with furigana in Tsukeru's own caption layer over a video, where the site's captions cannot hold furigana: videos whose subtitle track the browser draws itself (`<track>`, hls.js and similar players), and Netflix. Also finds the WebVTT file an embedded player drew its own captions from, so they can be processed ahead.

Inputs:
- The page's `<video>` elements and their text tracks (only a track the reader turned on and that is Japanese).
- Netflix subtitle cues from content-caption-cues (parsed TTML), and Netflix's own caption box (`.player-timedtext`), whose line tells which cues to show (Netflix restarts its video's clock after an ad, so the clock offset is set from it).
- Resource timing entries for `.vtt` files the page already loaded.
- Processed lines from content-caption-cues and the caption allowance from content-captions.

Outputs:
- One caption layer element per video (inside the player box, above its overlays, or in its fullscreen element) with the active cue's lines: furigana where processed, plain text otherwise, and the author's own furigana kept as written.
- For players that draw captions as page text (JW Player, Video.js, Plyr, ...), the same layer shows the text of the player's caption box, which is hidden meanwhile (`data-tsukeru-player-captions` on the page); the player's own box is never changed, since such players redraw it at will.
- Cue lists handed to content-caption-cues for processing ahead.

Side Effects:
- Sets a Japanese text track the reader turned on to `hidden` while the layer shows it (the browser stops drawing it but keeps its cues), and back to `showing` when furigana is cleared or the video itself goes fullscreen.
- On Netflix, marks the page (`data-tsukeru-netflix-captions`) so content.css hides Netflix's own caption box, only while the layer shows the same line; sets content-caption-cues' clock offset.
- Gives a static player box `position: relative` so the layer can sit over the video.
- Fetches at most a few `.vtt` files the page already loaded (normally from the browser's cache).

Failure Modes:
- A video that goes fullscreen by itself cannot show a layer; its track is shown again by the browser, without furigana, until fullscreen ends.
- A Netflix line that is not in the cue list (or not matched to it) shows in Netflix's own captions, without furigana.
- Subtitles drawn as pictures (burned in, or styled ASS subtitles on a canvas) have no text: nothing is shown, and a styled-subtitle player gets a one-time hint.

Security Notes:
- Cue text is set as text; processed HTML goes through the shared sanitizer (sanitizeHtmlFragment) before insertion.
- `.vtt` fetches go only to addresses the page itself loaded, are bounded in size and count, and carry no extension data.
*/

const CAPTION_LAYER_CLASS = 'tsukeru-caption-layer';
const CAPTION_LAYER_TICK_MS = 250;
const CAPTION_VTT_MAX = 6;
const CAPTION_VTT_MAX_CHARS = 2 * 1024 * 1024;
// Caption boxes that players draw as page text; content-dom adds furigana to them in place.
const CAPTION_PLAYER_CONTAINERS = [
  '.jw-captions', '.vjs-text-track-display', '.plyr__captions', '.art-subtitle', '.dplayer-subtitle',
  '.shaka-text-container', '.mejs__captions-layer', '.fp-captions',
];
const CAPTION_JAPANESE_LANG_RE = /^ja\b|^jpn?$/i;
const CAPTION_JAPANESE_LABEL_RE = /japanese|日本語|にほんご|일본어|日语|日語/i;
const CAPTION_STYLED_RENDERER_RE = /jassub|libass|octopus|subtitles?-?canvas|ass-?render/i;

const captionLayers = new Map(); // video -> { root, track, kind }
let captionLayerTimer = 0;
let captionVttLookedUp = false;
let captionStyledHintShown = false;
let netflixCaptionObserver = null;

// Player boxes: the layer goes in the player itself, above its own overlays, so its words can be clicked.
const CAPTION_LAYER_PLAYER_BOXES = '.jwplayer, .video-js, .plyr, .art-video-player, .dplayer, .shaka-video-container, .mejs__container, .flowplayer';

function captionLayerVideoHost(video) {
  const fullscreen = document.fullscreenElement;
  if (fullscreen && fullscreen !== video && fullscreen.contains(video)) return fullscreen;
  // Netflix's click and controls overlays are later siblings of the video's own box and cover it:
  // the layer goes after them in the whole player (also its fullscreen element).
  if (isNetflixPage()) return video.closest('.watch-video') || video.parentElement;
  return video.closest(CAPTION_LAYER_PLAYER_BOXES) || video.parentElement;
}

function mountCaptionLayer(entry, video) {
  if (document.fullscreenElement === video) {
    // A layer cannot show over a video that is fullscreen by itself: let the browser draw the track.
    if (entry.track) entry.track.mode = 'showing';
    entry.root.remove();
    return false;
  }
  if (entry.track && entry.track.mode !== 'hidden') entry.track.mode = 'hidden';
  const host = captionLayerVideoHost(video);
  if (!host) return false;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  if (entry.root.parentNode !== host) host.appendChild(entry.root);
  return true;
}

function createCaptionLayer(kind) {
  const root = document.createElement('div');
  root.className = CAPTION_LAYER_CLASS;
  root.dataset.kind = kind;
  // Tsukeru's own text: never processed as page text, but its words open the dictionary.
  root.setAttribute('data-no-furigana', 'true');
  root.setAttribute('lang', 'ja');
  root.setAttribute('aria-live', 'off');
  return root;
}

function appendCaptionPart(line, part, gateOpen) {
  const wrap = (node) => {
    if (!part.slanted && !part.emphasis) return node;
    const span = document.createElement('span');
    if (part.slanted) span.classList.add('tsukeru-caption-slanted');
    if (part.emphasis) span.classList.add('tsukeru-caption-emphasis');
    span.append(node);
    return span;
  };
  if (typeof part.base === 'string') {
    // The author's own furigana, shown as written.
    const ruby = document.createElement('ruby');
    const rt = document.createElement('rt');
    ruby.append(document.createTextNode(part.base));
    rt.textContent = part.ruby || '';
    ruby.append(rt);
    line.append(wrap(ruby));
    return null;
  }
  const html = gateOpen ? captionPieceHtml(part.text) : null;
  if (html !== null) {
    const span = document.createElement('span');
    span.setAttribute('data-tsukeru-wrapper', '1');
    span.append(sanitizeHtmlFragment(html));
    line.append(wrap(span));
    return null;
  }
  line.append(wrap(document.createTextNode(part.text)));
  return gateOpen && captionHasJapanese(part.text) ? part.text : null;
}

/** Draw the given cues in a layer; returns lines still waiting for processing. */
function renderCaptionCues(root, cues) {
  const signature = cues.map((cue) => `${cue.start}|${cue.text}`).join('\n');
  const gateOpen = captionGateOpen();
  const waiting = [];
  if (root.dataset.signature === signature && root.dataset.ready === 'true' && root.dataset.gate === String(gateOpen)) return waiting;
  root.dataset.signature = signature;
  root.dataset.gate = String(gateOpen);
  const boxes = [];
  for (const cue of cues) {
    const box = document.createElement('p');
    box.className = 'tsukeru-caption-cue';
    if (cue.vertical) box.dataset.vertical = 'true';
    if (cue.top) box.dataset.top = 'true';
    if (cue.align === 'start' || cue.align === 'left') box.dataset.align = 'start';
    for (const parts of cue.lines) {
      const line = document.createElement('span');
      line.className = 'tsukeru-caption-line';
      for (const part of parts) {
        const missing = appendCaptionPart(line, part, gateOpen);
        if (missing) waiting.push(missing);
      }
      box.append(line);
    }
    boxes.push(box);
  }
  root.replaceChildren(...boxes);
  root.dataset.ready = waiting.length ? 'false' : 'true';
  if (cues.length) noteCaptionText();
  return waiting;
}

function activeCuesAt(cues, time) {
  const active = [];
  for (const cue of cues) {
    if (cue.start > time) break;
    if (cue.end > time) active.push(cue);
  }
  return active;
}

// ── Videos whose browser-drawn track gets the layer ──────────────────────────

function isJapaneseTrack(track) {
  if (!track || !['subtitles', 'captions'].includes(track.kind)) return false;
  if (CAPTION_JAPANESE_LANG_RE.test(track.language || '') || CAPTION_JAPANESE_LABEL_RE.test(track.label || '')) return true;
  // Unlabelled tracks: mostly Japanese text in the first cues.
  const sample = Array.from(track.cues || []).slice(0, 20).map((cue) => cue.text || '').join('');
  return sample.length > 0 && (sample.match(JAPANESE_CHAR_GLOBAL_RE) || []).length / sample.length > 0.3;
}

function playerCaptionContainer(video) {
  for (const selector of CAPTION_PLAYER_CONTAINERS) {
    let node = video;
    // The player box is a few levels up; look no further than that.
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const found = node.querySelector?.(selector);
      if (found) return found;
    }
  }
  return null;
}

/** Find a Japanese track the reader turned on, and decide how its captions get furigana. */
function bindVideoTextTracks(video) {
  if (!isFuriganaActive || currentSite === 'youtube' || isNetflixPage()) return;
  const tracks = Array.from(video.textTracks || []);
  const known = captionLayers.get(video);
  const container = playerCaptionContainer(video);
  const track = known?.track && tracks.includes(known.track)
    ? known.track
    : tracks.find((item) => item.mode === 'showing' && isJapaneseTrack(item))
      || tracks.find((item) => item.mode === 'hidden' && isJapaneseTrack(item) && container);
  if (track) {
    const cues = cuesFromTextTrack(track);
    // The key stays the same while a stream adds cues, so lines already processed are kept.
    if (cues.length) setCaptionCueTrack(`track:${track.language}:${track.label}`, 'track', cues);
  }
  // A player that draws captions as page text redraws them whenever it likes: show its text in the layer instead.
  if (container) {
    mirrorPlayerCaptions(video, container);
    return;
  }
  if (!track) return;
  if (!known) {
    const entry = { root: createCaptionLayer('track'), track, kind: 'track' };
    captionLayers.set(video, entry);
    track.addEventListener('cuechange', () => renderVideoLayer(video));
  }
  startCaptionLayerTimer();
  renderVideoLayer(video);
}

function renderVideoLayer(video) {
  const entry = captionLayers.get(video);
  if (!entry || !isFuriganaActive || !video.isConnected) return;
  if (!mountCaptionLayer(entry, video)) return;
  let cues;
  if (entry.kind === 'mirror') {
    if (!entry.container.isConnected) entry.container = playerCaptionContainer(video) || entry.container;
    // The player's caption box is hidden, so its lines are read from its elements (innerText skips hidden text).
    const cue = plainCue(0, 1, captionBoxText(entry.container));
    cues = cue ? [cue] : [];
    if (cue && !captionCueTrack) findPlayerVttFile(cue.text);
  } else if (entry.kind === 'netflix') {
    // Netflix's own box is hidden only while the layer shows the same line; otherwise it shows as usual.
    cues = netflixCuesShowing(video);
    document.documentElement.toggleAttribute('data-tsukeru-netflix-captions', Boolean(cues));
    cues = cues || [];
  } else {
    const active = Array.from(entry.track?.activeCues || []);
    cues = active.map((cue) => plainCue(cue.startTime, cue.endTime, stripVttTags(cue.text || ''))).filter(Boolean);
  }
  const waiting = renderCaptionCues(entry.root, cues);
  if (waiting.length) requestCaptionPieces(waiting);
}

/** A caption box's text with its line breaks: <br>, and each line or cue element on its own line. */
function captionBoxText(box) {
  let text = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.nodeValue;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') {
          text += '\n';
          continue;
        }
        const line = /^(DIV|P|LI)$/.test(child.tagName) || /(cue|line)/i.test(String(child.className || ''));
        if (line) text += '\n';
        walk(child);
        if (line) text += '\n';
      }
    }
  };
  walk(box);
  return text;
}

/**
 * A player that draws captions as page text (JW Player, Video.js, ...): hide
 * its caption box and show the same lines in the layer, which the player
 * never redraws and whose words can be clicked.
 */
function mirrorPlayerCaptions(video, container) {
  const known = captionLayers.get(video);
  if (known?.kind === 'mirror' && known.container === container) return;
  known?.observer?.disconnect();
  known?.root.remove();
  const entry = { root: createCaptionLayer('mirror'), track: null, kind: 'mirror', container };
  entry.observer = new MutationObserver(() => renderVideoLayer(video));
  entry.observer.observe(container, { childList: true, subtree: true, characterData: true });
  captionLayers.set(video, entry);
  document.documentElement.setAttribute('data-tsukeru-player-captions', 'true');
  renderVideoLayer(video);
}

/** Lines processed meanwhile: redraw layers waiting for them. */
function onCaptionPiecesStored() {
  for (const video of captionLayers.keys()) renderVideoLayer(video);
}

function startCaptionLayerTimer() {
  if (captionLayerTimer) return;
  captionLayerTimer = setInterval(() => {
    let playing = false;
    for (const [video, entry] of captionLayers) {
      if (!video.isConnected) {
        entry.root.remove();
        captionLayers.delete(video);
        // Netflix's own captions show again until a layer for its new video shows the line.
        if (entry.kind === 'netflix') document.documentElement.removeAttribute('data-tsukeru-netflix-captions');
        continue;
      }
      if (!video.paused) playing = true;
      renderVideoLayer(video);
    }
    if (!captionLayers.size || !playing) stopCaptionLayerTimer();
  }, CAPTION_LAYER_TICK_MS);
}

function stopCaptionLayerTimer() {
  if (captionLayerTimer) clearInterval(captionLayerTimer);
  captionLayerTimer = 0;
}

/** Furigana is on: look at this page's videos now (and again when one plays). */
function startCaptionLayers() {
  for (const video of document.querySelectorAll('video')) bindVideoTextTracks(video);
}

/** Furigana was cleared: give the browser its tracks back and remove the layers. */
function stopCaptionLayers() {
  stopCaptionLayerTimer();
  for (const entry of captionLayers.values()) {
    if (entry.track && entry.track.mode === 'hidden' && entry.kind === 'track') entry.track.mode = 'showing';
    entry.observer?.disconnect();
    entry.root.remove();
  }
  captionLayers.clear();
  document.documentElement.removeAttribute('data-tsukeru-player-captions');
  netflixCaptionObserver?.disconnect();
  netflixCaptionObserver = null;
  document.documentElement.removeAttribute('data-tsukeru-netflix-captions');
}

function onCaptionLayerMedia(event) {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement) || !isFuriganaActive) return;
  if (event.type === 'playing') {
    if (isNetflixPage()) attachNetflixLayer();
    else maybeHintStyledSubtitles(video);
    bindVideoTextTracks(video);
    if (captionLayers.has(video)) startCaptionLayerTimer();
  }
  if (captionLayers.has(video)) renderVideoLayer(video);
}

function onCaptionLayerFullscreen() {
  for (const video of captionLayers.keys()) renderVideoLayer(video);
}

let captionLayerListenersBound = false;
function bindCaptionLayerListeners() {
  if (captionLayerListenersBound) return;
  captionLayerListenersBound = true;
  for (const type of ['playing', 'seeked', 'pause', 'loadeddata']) document.addEventListener(type, onCaptionLayerMedia, true);
  document.addEventListener('fullscreenchange', onCaptionLayerFullscreen);
}

// ── Embedded players that draw captions as page text: their WebVTT file ─────

function pageFetchForCaptions() {
  // Firefox: content.fetch runs as the page (its origin and cache), like Chrome's content-script fetch.
  return typeof content !== 'undefined' && typeof content?.fetch === 'function' ? content.fetch.bind(content) : fetch;
}

/**
 * The player shows Japanese captions as page text but no cue list is known:
 * find the .vtt file the page loaded and process its lines ahead.
 */
async function findPlayerVttFile(onScreenText) {
  if (captionVttLookedUp || captionCueTrack) return;
  captionVttLookedUp = true;
  const urls = [...new Set(performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => /^https:\/\/[^/]+\/[^?#]*\.vtt(?:[?#]|$)/i.test(name)))].slice(-CAPTION_VTT_MAX);
  const target = captionPieceKey(onScreenText);
  let best = null;
  for (const url of urls) {
    try {
      const response = await pageFetchForCaptions()(url, { credentials: 'omit', cache: 'force-cache', redirect: 'error' });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.length > CAPTION_VTT_MAX_CHARS || !/^﻿?WEBVTT/.test(text)) continue;
      // One piece per line, as the layer shows them.
      const cues = parseWebVtt(text, { joined: false });
      if (!cues.length) continue;
      const matches = target && cues.some((cue) => captionPieceKey(cue.text).includes(target) || target.includes(captionPieceKey(cue.text)));
      if (matches) {
        best = { url, cues };
        break;
      }
      if (!best || cues.length > best.cues.length) best = { url, cues };
    } catch (_) { /* The next file, or live processing. */ }
  }
  if (best) setCaptionCueTrack(`vtt:${best.url}`, 'vtt', best.cues);
}

/** A player that draws styled (ASS) subtitles on a canvas has no text: say how to get furigana, once. */
function maybeHintStyledSubtitles(video) {
  if (captionStyledHintShown || !isFuriganaActive || playerCaptionContainer(video)) return;
  const box = video.parentElement?.parentElement || video.parentElement;
  const canvas = box?.querySelector?.('canvas');
  const marker = canvas ? `${canvas.className} ${canvas.id} ${canvas.parentElement?.className || ''}` : '';
  if (!CAPTION_STYLED_RENDERER_RE.test(marker)) return;
  captionStyledHintShown = true;
  showToast(t('caption_styled_hint', undefined, 'This player draws styled subtitles as pictures. Turn off styled (ASS) subtitles in the player to get furigana.'), { type: 'info', duration: 9000 });
}

// ── Netflix ──────────────────────────────────────────────────────────────────

function isNetflixPage() {
  return /(^|\.)netflix\.com$/.test(location.hostname);
}

/** Netflix's own caption box shows Japanese now (it stays in the page, hidden, while the layer shows). */
function netflixJapaneseShowing() {
  const box = document.querySelector('.player-timedtext');
  return Boolean(box && captionHasJapanese(box.textContent || ''));
}

/** A cue's text is in Netflix's box (which may also hold the author's readings between its characters). */
function netflixBoxHasCue(boxKey, cue) {
  const key = captionPieceKey(cue.text);
  // A short line (はい) is not taken for part of a longer one; up to about three cues show at once.
  if (!key || key.length * 3 < boxKey.length) return false;
  if (boxKey.includes(key)) return true;
  let at = 0;
  for (const char of boxKey) {
    if (char === key[at]) at += 1;
    if (at === key.length) return true;
  }
  return false;
}

/**
 * The cues to show for the line Netflix shows now, or null when Netflix shows
 * no Japanese line that is in the cue list. Netflix restarts its video's clock
 * after an ad, so the clock offset is set again from the line it shows.
 */
function netflixCuesShowing(video) {
  if (captionCueTrack?.source !== 'netflix') return null;
  const box = document.querySelector('.player-timedtext');
  const boxKey = captionPieceKey(box?.textContent || '');
  if (!captionHasJapanese(boxKey)) return null;
  const cues = captionCueTrack.cues;
  const active = activeCuesAt(cues, captionCueTime(video));
  if (active.length && active.every((cue) => netflixBoxHasCue(boxKey, cue))) return active;
  // The nearest cue with this text (short lines such as はい repeat).
  const time = captionCueTime(video);
  let best = null;
  for (const cue of cues) {
    if (netflixBoxHasCue(boxKey, cue) && (!best || Math.abs(cue.start - time) < Math.abs(best.start - time))) best = cue;
  }
  if (!best) return null;
  // The box changes when a line starts, so this is close; the next line makes it exact.
  captionClockOffset = best.start + 0.05 - (Number(video.currentTime) || 0);
  const synced = activeCuesAt(cues, captionCueTime(video));
  return synced.length ? synced : null;
}

/** Netflix's Japanese subtitle file arrived: show it in the layer while furigana is on. */
function startNetflixCaptions(key, cues) {
  if (!cues.length) return;
  setCaptionCueTrack(key, 'netflix', cues);
  if (isFuriganaActive) attachNetflixLayer();
}

function attachNetflixLayer() {
  if (!isNetflixPage() || captionCueTrack?.source !== 'netflix') return;
  const video = document.querySelector('video');
  if (!video) return;
  if (!captionLayers.has(video)) captionLayers.set(video, { root: createCaptionLayer('netflix'), track: null, kind: 'netflix' });
  // Netflix can rebuild its caption box (after an ad): watch the current one.
  const box = document.querySelector('.player-timedtext');
  if (box && netflixCaptionObserver?.box !== box) {
    netflixCaptionObserver?.disconnect();
    netflixCaptionObserver = new MutationObserver(() => {
      const current = document.querySelector('video');
      if (current) renderVideoLayer(current);
    });
    netflixCaptionObserver.box = box;
    netflixCaptionObserver.observe(box, { childList: true, subtree: true, characterData: true });
  }
  startCaptionLayerTimer();
  renderVideoLayer(video);
}
