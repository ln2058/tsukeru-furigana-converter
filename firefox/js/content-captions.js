/*
Module: content-captions
Purpose: Keep video caption furigana within the daily allowance: remember what the background allows, count playback while Japanese captions are being processed, and show the player's limit card and the "minutes left" note. Also starts every caption path when furigana is turned on, and runs an embedded frame (a video player on another site) in captions-only mode.

Inputs:
- The background's allowance answers (`captionAllowance`, `captionTick`, and `caption_limit` refusals of caption text).
- Media events from the page's videos (playing, pause, ended), the page's visibility, picture-in-picture and fullscreen state.
- The caption container the caption code is watching (`videoCaptionContainer`) or Tsukeru's caption layer, and whether furigana is on (`isFuriganaActive`).
- In an embedded frame, the tab's Apply, Clear, `captionConnected`, `updateAppearance` and `updateLevel` messages (never answered), and the background's request for the video's words (answered).
- `captionAllowance`, `tsukeruSupporter` and `captionNotices` changes in local storage, and the background's `captionConnected` message.

Outputs:
- `captionGateOpen()` for the caption code, `noteCaptionText()` and `noteCaptionRefused()` from it.
- One limit card and one short note inside the video player (or its fullscreen element).
- `captionTick` and `captionSignIn` messages to the background.

Side Effects:
- Adds capture listeners for media play/pause/ended on the document, and one five-second timer only while a video plays.
- Writes `captionNotices` (the local day the card was closed and the note shown) to local storage.

Failure Modes:
- Without an answer from the background (extension reloaded), captions keep the last known allowance; the background still refuses caption text past the limit.
- A player without a positioned container shows the card at the bottom of the window instead.

Security Notes:
- Buttons act only on trusted (user) clicks; the page cannot press them.
- Card text comes from the extension's catalog and is set as text; the only links are fixed EZFurigana addresses.
- Ticks carry only a number of milliseconds; no caption text leaves the page through this module.
*/

const CAPTION_TICK_MS = 5000;
// Captions count while a Japanese line was on screen this recently (lines pause between sentences).
const CAPTION_RECENT_MS = 10000;
const CAPTION_WARN_FREE_MS = 5 * 60 * 1000;
const CAPTION_WARN_GUEST_MS = 60 * 1000;
const CAPTION_NOTE_MS = 6000;
const CAPTION_NOTICES_KEY = 'captionNotices';
const CAPTION_PLAYER_SELECTORS = [
  '#movie_player', '.html5-video-player', '.jwplayer', '.video-js', '.plyr', '.art-video-player', '.dplayer',
  '.shaka-video-container', '.mejs__container', '.flowplayer', '.watch-video',
];

let captionAllowanceKnown = null;
let captionAllowanceRequest = null;
let captionLastTextAt = 0;
let captionTickTimer = 0;
let captionLastTickAt = 0;
let captionCard = null;
let captionNote = null;
let captionNoteTimer = 0;
let captionNotices = null;
let captionBindingsReady = false;

function captionToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function captionAllowanceOpen(allowance = captionAllowanceKnown) {
  return !['free_done', 'guest_done'].includes(allowance?.state);
}

/** Whether caption text may be sent now (the background decides again for each request). */
function captionGateOpen() {
  return captionAllowanceOpen();
}

function askCaptionBackground(message) {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
  } catch (_) {
    return Promise.resolve(null); // Extension reloaded under the page.
  }
}

function setCaptionAllowance(allowance) {
  if (!allowance || typeof allowance !== 'object' || typeof allowance.state !== 'string') return;
  const wasOpen = captionAllowanceOpen();
  captionAllowanceKnown = allowance;
  const open = captionAllowanceOpen(allowance);
  if (open && !wasOpen) {
    removeCaptionCard();
    captionResumeProcessing();
  } else if (!open && captionRecentlyShown()) {
    showCaptionLimitCard();
  }
  if (open) maybeShowCaptionTimeNote(allowance);
}

/** Ask the background for the allowance (one request at a time). */
function refreshCaptionAllowance() {
  if (!captionAllowanceRequest) {
    captionAllowanceRequest = askCaptionBackground({ action: 'captionAllowance' })
      .then((response) => { if (response?.success) setCaptionAllowance(response.allowance); })
      .finally(() => { captionAllowanceRequest = null; });
  }
  return captionAllowanceRequest;
}

function captionRecentlyShown() {
  return Date.now() - captionLastTextAt < CAPTION_RECENT_MS;
}

/** The caption code found Japanese caption text on screen. */
function noteCaptionText() {
  captionLastTextAt = Date.now();
  bindCaptionAllowance();
  if (captionAllowanceKnown === null) refreshCaptionAllowance();
  if (!captionAllowanceOpen()) showCaptionLimitCard();
  else if (captionPlayingVideo()) startCaptionTicks();
}

/** The background refused caption text: the allowance ran out meanwhile. */
function noteCaptionRefused(allowance) {
  if (allowance?.state) setCaptionAllowance(allowance);
  else refreshCaptionAllowance();
  showCaptionLimitCard();
}

function captionResumeProcessing() {
  if (typeof queueVideoCaptionProcessing === 'function' && videoCaptionObserver && videoCaptionSettings) {
    queueVideoCaptionProcessing(videoCaptionSettings, lifecycleGeneration, 0);
  }
}

// ── Counting playback ────────────────────────────────────────────────────────

function captionPlayingVideo() {
  for (const video of document.querySelectorAll('video')) {
    if (!video.paused && !video.ended && video.readyState > 2) return video;
  }
  return null;
}

function captionContainerHasJapanese() {
  // A caption box drawn as page text, or Tsukeru's caption layer (long lines stay on screen a while).
  const box = videoCaptionContainer?.isConnected ? videoCaptionContainer : document.querySelector('.tsukeru-caption-layer');
  const text = box ? box.textContent || '' : '';
  return Boolean(text) && JAPANESE_CHAR_RE.test(text);
}

/** Playback counts while furigana is on, a video plays where it can be seen, and Japanese captions show. */
function captionShouldCount() {
  if (!isFuriganaActive || !captionAllowanceOpen() || captionAllowanceKnown?.state === 'unlimited') return false;
  if (!captionPlayingVideo()) return false;
  if (document.visibilityState !== 'visible' && !document.pictureInPictureElement) return false;
  return captionContainerHasJapanese() || captionRecentlyShown();
}

function startCaptionTicks() {
  if (captionTickTimer) return;
  captionLastTickAt = Date.now();
  captionTickTimer = setInterval(captionTick, CAPTION_TICK_MS);
}

function stopCaptionTicks() {
  if (captionTickTimer) clearInterval(captionTickTimer);
  captionTickTimer = 0;
}

function captionTick() {
  const now = Date.now();
  const elapsed = Math.min(now - captionLastTickAt, 6000);
  captionLastTickAt = now;
  if (!captionPlayingVideo() || !isFuriganaActive) {
    stopCaptionTicks();
    return;
  }
  if (!captionShouldCount() || elapsed <= 0) return;
  askCaptionBackground({ action: 'captionTick', ms: elapsed })
    .then((response) => { if (response?.success) setCaptionAllowance(response.allowance); });
}

function onCaptionMediaEvent(event) {
  if (!(event.target instanceof HTMLVideoElement)) return;
  if (event.type === 'playing') {
    if (isFuriganaActive && captionRecentlyShown()) startCaptionTicks();
  } else if (!captionPlayingVideo()) {
    stopCaptionTicks();
  }
}

// ── Player surfaces: the limit card and the minutes-left note ────────────────

function captionPlayerHost() {
  const video = captionPlayingVideo() || document.querySelector('video');
  const fullscreen = document.fullscreenElement;
  if (fullscreen && (!video || fullscreen.contains(video))) return fullscreen;
  for (const selector of CAPTION_PLAYER_SELECTORS) {
    const player = video?.closest?.(selector) || document.querySelector(selector);
    if (player) return player;
  }
  return null;
}

function mountCaptionSurface(surface) {
  const host = captionPlayerHost();
  const positioned = host && getComputedStyle(host).position !== 'static';
  surface.dataset.placement = positioned ? 'player' : 'window';
  const parent = positioned ? host : document.body;
  if (parent && surface.parentNode !== parent) parent.appendChild(surface);
}

function captionSurface(className) {
  const root = document.createElement('div');
  root.className = className;
  root.setAttribute('data-tsukeru-extension-ui', 'true');
  root.setAttribute('data-no-furigana', 'true');
  // The player's own shortcuts and click-to-pause never see presses on the card.
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown', 'keyup', 'wheel']) {
    root.addEventListener(type, (event) => event.stopPropagation());
  }
  applyTsukeruUiTheme(root);
  return root;
}

function captionText(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function captionLimitMinutes(allowance, fallback) {
  const minutes = Math.round(Number(allowance?.limitMs) / 60000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

function buildCaptionCard(allowance) {
  const guest = allowance?.state === 'guest_done';
  const freeMinutes = captionLimitMinutes({ limitMs: allowance?.freeLimitMs }, 30);
  const root = captionSurface('tsukeru-caption-card');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-live', 'polite');
  root.dataset.state = guest ? 'guest_done' : 'free_done';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tsukeru-caption-card-close';
  close.textContent = '×';
  close.setAttribute('aria-label', t('content_close', undefined, 'Close'));
  close.title = t('content_close', undefined, 'Close');

  const title = captionText('p', 'tsukeru-caption-card-title', guest
    ? t('caption_limit_guest_title', undefined, 'Your free preview of caption furigana is used.')
    : t('caption_limit_free_title', [String(captionLimitMinutes(allowance, 30))], `Today's ${captionLimitMinutes(allowance, 30)} free minutes are used.`));
  root.setAttribute('aria-label', title.textContent);
  const body = captionText('p', 'tsukeru-caption-card-text', guest
    ? t('caption_limit_guest_text', [String(freeMinutes)], `Sign in free for ${freeMinutes} minutes of caption furigana a day. Your video keeps playing while you sign in.`)
    : t('caption_limit_free_text', undefined, 'Furigana and word lookup in captions are paused until tomorrow. Supporters have no daily limit.'));

  const actions = document.createElement('div');
  actions.className = 'tsukeru-caption-card-actions';
  let primary;
  if (guest) {
    primary = document.createElement('button');
    primary.type = 'button';
    primary.textContent = t('caption_limit_sign_in', undefined, 'Sign in free');
    primary.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      askCaptionBackground({ action: 'captionSignIn' });
    });
  } else {
    primary = document.createElement('a');
    primary.href = TsukeruI18n.websiteUrl('/pricing?from=tsukeru&placement=extension_captions');
    primary.target = '_blank';
    primary.rel = 'noopener noreferrer';
    primary.textContent = t('supporter_become', undefined, 'Become a Supporter');
  }
  primary.className = 'tsukeru-caption-card-primary';
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'tsukeru-caption-card-later';
  later.textContent = t('caption_limit_later', undefined, 'Not now');
  actions.append(primary, later);

  root.append(close, title, body, actions);
  if (guest) {
    root.append(captionText('p', 'tsukeru-caption-card-note', t('caption_sign_in_provider', undefined, 'Secure sign-in by WorkOS')));
  }
  const dismiss = (event) => {
    if (!event.isTrusted) return;
    dismissCaptionCard(root.dataset.state);
  };
  close.addEventListener('click', dismiss);
  later.addEventListener('click', dismiss);
  return root;
}

async function loadCaptionNotices() {
  if (captionNotices) return captionNotices;
  try {
    const stored = (await chrome.storage.local.get(CAPTION_NOTICES_KEY))[CAPTION_NOTICES_KEY];
    captionNotices = stored && typeof stored === 'object' ? stored : {};
  } catch (_) {
    captionNotices = {};
  }
  return captionNotices;
}

function saveCaptionNotices(update) {
  captionNotices = { ...(captionNotices || {}), ...update };
  try {
    chrome.storage.local.set({ [CAPTION_NOTICES_KEY]: captionNotices })?.catch?.(() => {});
  } catch (_) { /* Extension reloaded under the page. */ }
}

async function showCaptionLimitCard() {
  const allowance = captionAllowanceKnown;
  if (captionAllowanceOpen(allowance) || !isFuriganaActive) return;
  const notices = await loadCaptionNotices();
  if (notices.dismissed === `${allowance.state}|${captionToday()}`) return;
  if (captionCard?.isConnected && captionCard.dataset.state === allowance.state) {
    mountCaptionSurface(captionCard);
    return;
  }
  removeCaptionCard();
  removeCaptionNote();
  captionCard = buildCaptionCard(allowance);
  mountCaptionSurface(captionCard);
}

function dismissCaptionCard(state) {
  saveCaptionNotices({ dismissed: `${state}|${captionToday()}` });
  removeCaptionCard();
}

function removeCaptionCard() {
  captionCard?.remove();
  captionCard = null;
}

/** A short note when the allowance is nearly used: once a day for free accounts, once for the preview. */
async function maybeShowCaptionTimeNote(allowance) {
  const guest = allowance?.state === 'guest';
  if (!guest && allowance?.state !== 'free') return;
  const remaining = Number(allowance.remainingMs);
  if (!Number.isFinite(remaining) || remaining > (guest ? CAPTION_WARN_GUEST_MS : CAPTION_WARN_FREE_MS)) return;
  const notices = await loadCaptionNotices();
  const key = guest ? 'guest' : captionToday();
  if (notices.warned === key || !captionRecentlyShown()) return;
  saveCaptionNotices({ warned: key });
  const minutes = String(Math.max(1, Math.ceil(remaining / 60000)));
  showCaptionNote(guest
    ? t('caption_preview_left', [minutes], `${minutes} min left in your free preview of caption furigana`)
    : t('caption_time_left', [minutes], `${minutes} min of caption furigana left today`));
}

function showCaptionNote(message) {
  removeCaptionNote();
  captionNote = captionSurface('tsukeru-caption-note');
  captionNote.setAttribute('role', 'status');
  captionNote.textContent = message;
  mountCaptionSurface(captionNote);
  captionNoteTimer = setTimeout(removeCaptionNote, CAPTION_NOTE_MS);
}

function removeCaptionNote() {
  if (captionNoteTimer) clearTimeout(captionNoteTimer);
  captionNoteTimer = 0;
  captionNote?.remove();
  captionNote = null;
}

/** Keep the card and note inside the player when it enters or leaves fullscreen. */
function onCaptionFullscreenChange() {
  if (captionCard) mountCaptionSurface(captionCard);
  if (captionNote) mountCaptionSurface(captionNote);
  if (captionTools?.root?.isConnected) mountCaptionSurface(captionTools.root);
  if (captionPanel?.isConnected) mountCaptionSurface(captionPanel);
}

/** The sign-in tab opened from the card connected Tsukeru and closed. */
function handleCaptionConnected() {
  removeCaptionCard();
  refreshCaptionAllowance().then(() => {
    if (!captionAllowanceOpen()) return;
    showToast(t('caption_connected_toast', undefined, 'Connected. Caption furigana is back on.'), { type: 'info', duration: 5000 });
    captionResumeProcessing();
  });
}

/**
 * Furigana is on: start every caption path this page can have. YouTube and
 * players that draw captions as page text get furigana in place (content-dom),
 * browser-drawn tracks and Netflix get the caption layer.
 */
function startVideoCaptions(settings) {
  // The top page tells the background to start captions in its embedded players' frames.
  if (window.top === window) askCaptionBackground({ action: 'frameCaptionsStart' });
  bindCaptionAllowance();
  bindCaptionTools();
  bindCaptionLayerListeners();
  startVideoCaptionsObserver(settings);
  startCaptionLayers();
  attachNetflixLayer();
}

/**
 * A page without Japanese text of its own but with a video (here, or in an
 * embedded player's frame): turn furigana on for the video's captions only.
 */
async function pageHasVideo() {
  if (document.querySelector('video')) return true;
  if (!document.querySelector('iframe')) return false;
  const answer = await askCaptionBackground({ action: 'tabHasVideoFrames' });
  return Boolean(answer?.success && answer.has);
}

function startCaptionsOnly(settings) {
  isFuriganaActive = true;
  lastAppliedSettings = { ...settings };
  enableDictionaryPopups();
  refreshWordStates();
  startVideoCaptions(settings);
}

// ── Embedded frames ──────────────────────────────────────────────────────────
// In a frame (an embedded player), only captions get furigana: the frame
// follows the top page's Apply and Clear, and never answers messages, so the
// top page's answer is the one the popup and background get.

function startFrameCaptions(settings) {
  if (!settings || typeof settings !== 'object') return;
  const root = document.documentElement;
  (document.body || root).classList.remove('tsukeru-furigana-disabled');
  root.style.setProperty('--tsukeru-ruby-size', `${Number(settings.rubySize) || 0.65}em`);
  setRubyColor(settings.rubyColor);
  root.style.setProperty('--tsukeru-ruby-weight', settings.rubyWeight === 'bold' ? 'bold' : 'normal');
  root.setAttribute('data-tsukeru-custom-style', settings.removeCustomStyling ? 'off' : 'on');
  setLevelFilter(settings);
  isFuriganaActive = true;
  lastAppliedSettings = { ...settings };
  enableDictionaryPopups();
  refreshWordStates();
  startVideoCaptions(settings);
}

/**
 * In a frame: tell the background when it has a video (once loaded, when one
 * plays, and on each Apply), so the top page can start its captions.
 */
let frameVideoReported = false;
function reportFrameVideo() {
  if (frameVideoReported || !document.querySelector('video')) return;
  frameVideoReported = true;
  askCaptionBackground({ action: 'frameCaptionsReady' }).then((answer) => {
    if (!answer) frameVideoReported = false;
  });
}

function watchFrameVideo() {
  document.addEventListener('playing', (event) => {
    if (event.target instanceof HTMLVideoElement && !isFuriganaActive) reportFrameVideo();
  }, true);
  if (document.readyState === 'complete') reportFrameVideo();
  else window.addEventListener('load', reportFrameVideo, { once: true });
}

/** A message to a frame: Apply, Clear, and the caption sign-in's return. Never answered. */
function handleFrameCaptionMessage(request, sendResponse) {
  if (request?.action === 'applyFurigana') {
    // The tab's Apply reaches every frame; this frame starts once the top page asks for it.
    if (request.frameCaptions === true) startFrameCaptions(request.settings);
    else {
      frameVideoReported = false;
      reportFrameVideo();
    }
  }
  else if (request?.action === 'clearFurigana') clearFurigana();
  else if (request?.action === 'captionConnected') handleCaptionConnected();
  // The popup's live setting changes reach every frame; follow them while this frame shows captions.
  else if (request?.action === 'updateAppearance' && isFuriganaActive) applyAppearanceUpdate(request);
  else if (request?.action === 'updateLevel' && isFuriganaActive) setLevelFilter(request.settings || {});
  // Only the background's request for the top page is answered (the popup's own request reaches every frame).
  else if (request?.action === 'getVideoWords' && request.frameVideoWords === true && typeof sendResponse === 'function') {
    getVideoWords().then(sendResponse).catch(() => sendResponse({ available: false }));
    return true;
  }
  return false;
}

/** Furigana was cleared: stop counting and take the card and note away. */
function stopCaptionAllowance() {
  removeCaptionTools();
  stopCaptionTicks();
  removeCaptionCard();
  removeCaptionNote();
}

function bindCaptionAllowance() {
  if (captionBindingsReady) return;
  captionBindingsReady = true;
  for (const type of ['playing', 'pause', 'ended', 'emptied']) {
    document.addEventListener(type, onCaptionMediaEvent, true);
  }
  // A player that draws captions as page text may build its caption box only once a video plays.
  document.addEventListener('playing', (event) => {
    if (!isFuriganaActive || !(event.target instanceof HTMLVideoElement)) return;
    if (!videoCaptionObserver || videoCaptionContainer?.isConnected === false) {
      stopVideoCaptionsObserver();
      startVideoCaptionsObserver(lastAppliedSettings);
    }
  }, true);
  document.addEventListener('fullscreenchange', onCaptionFullscreenChange);
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.captionAllowance || changes.tsukeruSupporter) refreshCaptionAllowance();
    if (changes[CAPTION_NOTICES_KEY]) captionNotices = changes[CAPTION_NOTICES_KEY].newValue || {};
  });
}
