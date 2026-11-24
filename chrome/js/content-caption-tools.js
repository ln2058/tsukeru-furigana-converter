/*
Module: content-caption-tools
Purpose: Tools for studying with video captions: pause while a caption word's dictionary popup is open, replay / previous / next line, Explain this line, and Words in this video (counts for everyone, the full list for Supporters).

Inputs:
- Clicks on caption words (from content-tooltip's dictionary click) and the popup closing.
- The current video, its cue list (content-caption-cues), and the caption text on screen.
- The player's controls being shown or hidden (its own class, such as `ytp-autohide` or `jw-flag-user-inactive`), pointer movement over the player, fullscreen changes, and the `[`, `]` and `\` keys while the pointer is over it.
- The background's Explain answers and whether a Supporter account is connected.

Outputs:
- A small tools bar in the player (replay, previous, next, Explain, words), an Explain panel, and a words panel.
- `getVideoWords()` for the popup's This page tab.

Side Effects:
- Pauses and plays the video (only one this module paused) and seeks it to a line's start.
- Processes the rest of a video's lines in a few background batches when its words are asked for (while the caption allowance lasts).
- Sends one caption line to the background for Explain, after the usual first-use notice.

Failure Modes:
- Without a cue list (or on Netflix, whose player does not allow seeking from outside), replay/previous/next are hidden.
- Explain refusals (no account, limits) show the same messages and links as the dictionary popup's Explain.

Security Notes:
- Buttons and keys act only on trusted (user) input; the page cannot press them.
- Caption text is read as text; explanations render through the tooltip's DOM helpers, never as HTML.
- The Supporter word list is gated on this device only (like the other caption limits); nothing extra is sent.
*/

const CAPTION_LOOKUP_SELECTOR = `${VIDEO_CAPTION_TEXT_SELECTOR}, .ytp-caption-window-container, .caption-window`;
const CAPTION_TOOLS_IDLE_MS = 2500;
const CAPTION_WORDS_MAX_BATCHES = 10;
const CAPTION_WORDS_BATCH_GAP_MS = 1500;
const CAPTION_WORDS_LIST_MAX = 60;
// Pixel icons on the website's grid, like the page dock's. Previous and next are mirror images,
// each symmetric top to bottom; replay is an arrow that turns back on itself.
const CAPTION_TOOL_ICONS = {
  replay: '<svg viewBox="0 0 10 8" shape-rendering="crispEdges" aria-hidden="true"><path d="M3 0h1v1H3zM2 1h2v1H2zM1 2h7v1H1zM2 3h2v1H2zM8 3h1v4H8zM3 4h1v1H3zM2 7h6v1H2z"/></svg>',
  previous: '<svg viewBox="0 0 7 7" shape-rendering="crispEdges" aria-hidden="true"><path d="M0 0h1v7H0zM5 0h2v1H5zM4 1h3v1H4zM3 2h4v1H3zM2 3h5v1H2zM3 4h4v1H3zM4 5h3v1H4zM5 6h2v1H5z"/></svg>',
  next: '<svg viewBox="0 0 7 7" shape-rendering="crispEdges" aria-hidden="true"><path d="M6 0h1v7H6zM0 0h2v1H0zM0 1h3v1H0zM0 2h4v1H0zM0 3h5v1H0zM0 4h4v1H0zM0 5h3v1H0zM0 6h2v1H0z"/></svg>',
};

let captionLookupVideo = null;
let captionTools = null;
let captionToolsTimer = 0;
let captionToolsBound = false;
let captionPointerAt = 0;
let captionPointerCheckedAt = 0;
let captionPanel = null;
let captionPanelVideo = null;
let captionWordsRun = null;

// ── Pause while looking up ───────────────────────────────────────────────────

/**
 * A caption word was clicked for the dictionary popup: keep the player from
 * treating the click as play/pause, and pause the video while the popup is open.
 */
function captionWordLookupStarted(element, event) {
  if (!element?.closest?.(CAPTION_LOOKUP_SELECTOR)) return;
  event.preventDefault();
  event.stopPropagation();
  const video = captionPlayingVideo();
  if (video && !video.paused) {
    video.pause();
    captionLookupVideo = video;
  }
}

/** The popup closed: play again, unless another caption word opened it meanwhile. */
function captionLookupEnded() {
  if (!captionLookupVideo) return;
  setTimeout(() => {
    if (dictionaryTooltip?.classList?.contains('show')) return;
    const video = captionLookupVideo;
    captionLookupVideo = null;
    if (video?.isConnected && video.paused) video.play()?.catch?.(() => {});
  }, 80);
}

// ── Lines: the active one, replay, previous, next ───────────────────────────

function captionToolsVideo() {
  return captionPlayingVideo() || (currentSite === 'youtube' ? captionVideo() : null) || document.querySelector('video');
}

function canSeekCaptions() {
  // Netflix's player stops with an error when its video is seeked from outside.
  return Boolean(captionCueTrack?.cues?.length) && !isNetflixPage();
}

function cueIndexAt(time) {
  const cues = captionCueTrack?.cues || [];
  let index = -1;
  for (let i = 0; i < cues.length && cues[i].start <= time + 0.05; i += 1) index = i;
  return index;
}

function seekCaptionLine(direction) {
  const video = captionToolsVideo();
  if (!video || !canSeekCaptions()) return;
  const cues = captionCueTrack.cues;
  const current = cueIndexAt(video.currentTime);
  let target = current;
  if (direction === 'previous') {
    // Early in a line, previous means the line before; later, the start of this one first.
    target = current > 0 && video.currentTime - cues[current].start < 1.2 ? current - 1 : current;
  } else if (direction === 'next') {
    target = Math.min(cues.length - 1, current + 1);
  }
  if (target < 0) target = 0;
  video.currentTime = cues[target].start + 0.01;
  if (video.paused && direction === 'replay') video.play()?.catch?.(() => {});
}

// A line ends a sentence with one of these (closing quotes and brackets may follow).
const CAPTION_SENTENCE_END_RE = /[。．！？!?…‥][」』）)】〉》"'”’]*$/;
// Lines further apart than this are not one sentence.
const CAPTION_SENTENCE_GAP_S = 3;
const CAPTION_SENTENCE_MAX_CHARS = 120;

/** A cue's text as one line, without sound and speaker tags such as [音楽]. */
function cueSentenceText(cue) {
  return cue.text.replace(/\n/g, '').replace(/[［[][^］\]]*[］\]]/g, '').trim();
}

/**
 * The whole sentence the line on screen belongs to, from the cue list: earlier
 * lines back to the end of the previous sentence and later lines up to the end
 * of this one, even before they show. Falls back to the line on screen when
 * the sentence would be too long to explain.
 */
function captionSentenceAt(cues, index) {
  const own = cueSentenceText(cues[index]);
  let first = index;
  let last = index;
  while (first > 0) {
    const previous = cues[first - 1];
    const text = cueSentenceText(previous);
    if (!text || CAPTION_SENTENCE_END_RE.test(text) || cues[first].start - previous.end >= CAPTION_SENTENCE_GAP_S) break;
    first -= 1;
  }
  while (last < cues.length - 1 && !CAPTION_SENTENCE_END_RE.test(cueSentenceText(cues[last]))) {
    const next = cues[last + 1];
    if (!cueSentenceText(next) || next.start - cues[last].end >= CAPTION_SENTENCE_GAP_S) break;
    last += 1;
  }
  const sentence = cues.slice(first, last + 1).map(cueSentenceText).join('');
  return Array.from(sentence).length <= CAPTION_SENTENCE_MAX_CHARS ? sentence : own;
}

/** The sentence on screen as plain text: from the cue list when known, else the caption box's text without readings. */
function currentCaptionLine() {
  const video = captionToolsVideo();
  if (video && captionCueTrack?.cues?.length) {
    const cues = captionCueTrack.cues;
    const active = activeCuesAt(cues, captionCueTime(video));
    if (active.length === 1) return captionSentenceAt(cues, cues.indexOf(active[0]));
    if (active.length) return active.map(cueSentenceText).join(' ');
  }
  const box = videoCaptionContainer?.isConnected ? videoCaptionContainer : document.querySelector(`.${CAPTION_LAYER_CLASS}`);
  return box ? getPlainTextWithoutReadings(box) : '';
}

// ── The tools bar ────────────────────────────────────────────────────────────

function captionToolButton(className, label, { icon = '', text = '' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tsukeru-caption-tool ${className}`;
  if (icon) button.innerHTML = CAPTION_TOOL_ICONS[icon];
  if (text) button.append(document.createTextNode(text));
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function buildCaptionTools() {
  const root = captionSurface('tsukeru-caption-tools');
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', t('caption_tools_label', undefined, 'Tsukeru caption tools'));
  const replay = captionToolButton('tsukeru-caption-tool-replay', t('caption_tool_replay', undefined, 'Replay this line (\\)'), { icon: 'replay' });
  const previous = captionToolButton('tsukeru-caption-tool-previous', t('caption_tool_previous', undefined, 'Previous line ([)'), { icon: 'previous' });
  const next = captionToolButton('tsukeru-caption-tool-next', t('caption_tool_next', undefined, 'Next line (])'), { icon: 'next' });
  const explain = captionToolButton('tsukeru-caption-tool-explain', t('caption_tool_explain', undefined, 'Explain this line'), { text: t('caption_tool_explain_short', undefined, 'Explain') });
  const words = captionToolButton('tsukeru-caption-tool-words', t('video_words_title', undefined, 'Words in this video'), { text: t('caption_tool_words_short', undefined, 'Words') });
  root.append(replay, previous, next, explain, words);
  const on = (button, action) => button.addEventListener('click', (event) => { if (event.isTrusted) action(); });
  on(replay, () => seekCaptionLine('replay'));
  on(previous, () => seekCaptionLine('previous'));
  on(next, () => seekCaptionLine('next'));
  on(explain, () => explainCaptionLine());
  on(words, () => showCaptionWordsPanel());
  return { root, replay, previous, next, explain, words };
}

// The bar shows and hides with the player's own controls: players mark the
// moment their controls fade (classes below), so the bar appears whenever the
// control bar does (pointer moves, paused, after fullscreen changes). Players
// not listed show it for a few seconds after the pointer moves.
const CAPTION_PLAYER_STATE_BOXES = '.html5-video-player, .jwplayer, .video-js, .plyr, .art-video-player, .dplayer';
const CAPTION_CONTROLS_HIDDEN = '.ytp-autohide, .jw-flag-user-inactive, .vjs-user-inactive, .plyr--hide-controls, .art-hide-cursor, .dplayer-hide-controller';
let captionToolsPlayer = null;
let captionToolsPlayerObserver = null;

/** Whether captions are known for this page: a cue list, a caption box being watched, or the caption layer. */
function captionToolsHaveCaptions() {
  return Boolean(captionCueTrack?.cues?.length || videoCaptionContainer?.isConnected || document.querySelector(`.${CAPTION_LAYER_CLASS}`));
}

/** The player element that carries the controls' shown/hidden state, or null for a player we do not know. */
function captionToolsStatePlayer() {
  const video = captionToolsVideo();
  return video?.closest?.(CAPTION_PLAYER_STATE_BOXES) || document.querySelector(CAPTION_PLAYER_STATE_BOXES);
}

/** Follow the player's controls: watch its class changes (one observer, moved when the player changes). */
function followCaptionToolsPlayer() {
  const player = captionToolsStatePlayer();
  if (player === captionToolsPlayer) return player;
  captionToolsPlayerObserver?.disconnect();
  captionToolsPlayer = player;
  captionToolsPlayerObserver = null;
  if (player) {
    captionToolsPlayerObserver = new MutationObserver(() => updateCaptionTools());
    captionToolsPlayerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }
  return player;
}

/** Show or hide the bar: with the player's controls, or for a few seconds after the pointer moved. */
function updateCaptionTools({ pointer = false } = {}) {
  if (!isFuriganaActive || !captionToolsHaveCaptions()) {
    if (captionTools) captionTools.root.dataset.shown = 'false';
    return;
  }
  if (!captionTools) captionTools = buildCaptionTools();
  const seekable = canSeekCaptions();
  for (const button of [captionTools.replay, captionTools.previous, captionTools.next]) button.hidden = !seekable;
  captionTools.words.hidden = !captionCueTrack?.cues?.length;
  mountCaptionSurface(captionTools.root);
  const player = followCaptionToolsPlayer();
  const busy = captionTools.root.matches(':hover, :focus-within') || Boolean(captionPanel?.isConnected);
  clearTimeout(captionToolsTimer);
  let shown;
  if (player) {
    shown = busy || !player.matches(CAPTION_CONTROLS_HIDDEN);
  } else {
    if (pointer) captionPointerAt = Date.now();
    shown = busy || Date.now() - captionPointerAt < CAPTION_TOOLS_IDLE_MS;
    if (shown) captionToolsTimer = setTimeout(() => updateCaptionTools(), CAPTION_TOOLS_IDLE_MS);
  }
  captionTools.root.dataset.shown = shown ? 'true' : 'false';
}

function showCaptionTools() {
  updateCaptionTools({ pointer: true });
}

function removeCaptionTools() {
  clearTimeout(captionToolsTimer);
  captionToolsPlayerObserver?.disconnect();
  captionToolsPlayerObserver = null;
  captionToolsPlayer = null;
  captionTools?.root.remove();
  captionTools = null;
  removeCaptionPanel();
}

function pointerOverPlayer(target) {
  const host = captionPlayerHost();
  return Boolean(host && target instanceof Node && host.contains(target));
}

function onCaptionToolsPointer(event) {
  // Pointer moves are frequent: look at most every 200 ms.
  if (!isFuriganaActive || Date.now() - captionPointerCheckedAt < 200) return;
  captionPointerCheckedAt = Date.now();
  if (!pointerOverPlayer(event.target)) return;
  captionPointerAt = Date.now();
  showCaptionTools();
}

function onCaptionToolsKey(event) {
  if (!event.isTrusted || event.ctrlKey || event.metaKey || event.altKey || !isFuriganaActive) return;
  if (!['[', ']', '\\'].includes(event.key) || Date.now() - captionPointerAt > 4000 || !canSeekCaptions()) return;
  const target = event.target;
  if (target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName || '')) return;
  event.preventDefault();
  event.stopPropagation();
  seekCaptionLine(event.key === '[' ? 'previous' : event.key === ']' ? 'next' : 'replay');
}

function bindCaptionTools() {
  if (captionToolsBound) return;
  captionToolsBound = true;
  document.addEventListener('pointermove', onCaptionToolsPointer, true);
  document.addEventListener('keydown', onCaptionToolsKey, true);
  // Entering or leaving fullscreen moves the bar and shows it, as players show their controls then.
  document.addEventListener('fullscreenchange', () => setTimeout(showCaptionTools, 0));
  for (const type of ['pause', 'play']) document.addEventListener(type, () => updateCaptionTools(), true);
}

// ── Panels in the player: Explain and the video's words ─────────────────────

function removeCaptionPanel() {
  captionPanel?.remove();
  captionPanel = null;
  const video = captionPanelVideo;
  captionPanelVideo = null;
  if (video?.isConnected && video.paused) video.play()?.catch?.(() => {});
}

/** A card in the player for a tool; pauses the video while open when asked. */
function openCaptionPanel(kind, { pause = false } = {}) {
  removeCaptionPanel();
  const root = captionSurface('tsukeru-caption-card');
  root.dataset.kind = kind;
  root.setAttribute('role', 'dialog');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tsukeru-caption-card-close';
  close.textContent = '×';
  close.setAttribute('aria-label', t('content_close', undefined, 'Close'));
  close.addEventListener('click', (event) => { if (event.isTrusted) removeCaptionPanel(); });
  const body = document.createElement('div');
  body.className = 'tsukeru-caption-panel-body';
  root.append(close, body);
  captionPanel = root;
  mountCaptionSurface(root);
  if (pause) {
    const video = captionToolsVideo();
    if (video && !video.paused) {
      video.pause();
      captionPanelVideo = video;
    }
  }
  return body;
}

async function explainCaptionLine() {
  const selection = pageDockTextStatus(currentCaptionLine());
  if (selection.status !== 'ok') {
    const body = openCaptionPanel('explain');
    body.append(captionText('p', 'tsukeru-caption-card-text', selection.status === 'too_long'
      ? t('caption_explain_too_long', undefined, 'This line is too long to explain.')
      : t('caption_explain_none', undefined, 'There is no Japanese line on screen to explain.')));
    return;
  }
  const refuse = (code) => showRefusal(TsukeruUiMessages.explainMessage(code, t), code, 'extension_explain');
  const token = await askBackground({ action: 'hasSupporterToken' });
  if (token?.success && token.account !== true) {
    refuse('account_required');
    return;
  }
  const language = TsukeruI18n.language();
  const key = `${language}\n${selection.text}`;
  const body = openCaptionPanel('explain', { pause: true });
  const quote = captionText('p', 'tsukeru-caption-card-title', selection.text);
  quote.setAttribute('lang', 'ja');
  const notice = document.createElement('div');
  notice.className = 'tsukeru-explain-notice tsukeru-hidden';
  const result = document.createElement('div');
  result.className = 'tsukeru-explain-result';
  body.append(quote, notice, result);
  let explanation = shownExplanations.get(key);
  if (!explanation) {
    if (!(await noticeSeen(EXPLAIN_NOTICE_KEY))) {
      await confirmNotice(notice, EXPLAIN_NOTICE_KEY, t(
        'content_explain_notice',
        undefined,
        'This sentence will be sent to OpenAI to write the explanation, and OpenAI may use it to improve its models.'
      ));
    }
    if (!body.isConnected) return;
    result.textContent = t('content_explain_working', undefined, 'Explaining…');
    const response = await askBackground({ action: 'explainSentence', text: selection.text, language });
    if (!response?.success || !response.explanation) {
      removeCaptionPanel();
      refuse(response?.error);
      return;
    }
    explanation = response.explanation;
    shownExplanations.delete(key);
    shownExplanations.set(key, explanation);
    while (shownExplanations.size > MAX_SHOWN_EXPLANATIONS) shownExplanations.delete(shownExplanations.keys().next().value);
  }
  if (body.isConnected) renderTooltipExplanation(result, explanation, language);
}

// ── Words in this video ──────────────────────────────────────────────────────

function captionTrackPieces() {
  const pieces = [];
  for (const cue of captionCueTrack?.cues || []) pieces.push(...cue.pieces);
  return pieces;
}

/** Process the rest of the video's lines in a few batches, so its words can be counted. */
function processWholeCaptionTrack() {
  const key = captionCueTrack?.key;
  if (!key) return Promise.resolve();
  if (captionWordsRun?.key === key) return captionWordsRun.promise;
  const run = { key };
  run.promise = (async () => {
    for (let batch = 0; batch < CAPTION_WORDS_MAX_BATCHES; batch += 1) {
      if (captionCueTrack?.key !== key || !isFuriganaActive || !captionGateOpen()) return;
      if (Date.now() < captionPrefetchPausedUntil) return;
      const missing = captionTrackPieces().filter((piece) => captionPieceHtml(piece) === null);
      if (!missing.length) return;
      await requestCaptionPieces(missing);
      await new Promise((resolve) => setTimeout(resolve, CAPTION_WORDS_BATCH_GAP_MS));
    }
  })().finally(() => {
    // Asked again later (more cues, or the allowance back), it picks up what is still missing.
    if (captionWordsRun === run) captionWordsRun = null;
  });
  captionWordsRun = run;
  return run.promise;
}

/**
 * The video's words from its processed lines: the list the popup shows, and
 * counts by level and of words not yet known (by My Words identity).
 */
function videoWordsSummary() {
  const pieces = captionTrackPieces();
  const box = document.createElement('div');
  let processed = 0;
  for (const piece of pieces) {
    const html = captionPieceHtml(piece);
    if (html === null) continue;
    processed += 1;
    const line = document.createElement('p');
    line.append(sanitizeHtmlFragment(html));
    box.append(line);
  }
  const words = extractAllPageWords(box);
  const seen = new Map();
  for (const element of getAnalysisWordElements(box)) {
    if (element.getAttribute?.('data-tsukeru-continued') === '1') continue;
    const identity = wordIdentityOf(element);
    if (!identity?.id || seen.has(identity.id)) continue;
    const state = wordStates.get(identity.id);
    const info = getAnalysisWordData(element);
    seen.set(identity.id, {
      word: info.dictForm || info.surface || '',
      reading: info.reading || '',
      level: /^[1-5]$/.test(info.jlpt || '') ? `N${info.jlpt}` : '',
      learned: state === 'known' || state === 'ignored',
    });
  }
  const units = [...seen.values()];
  return { words, units, coverage: pieces.length ? processed / pieces.length : 0 };
}

/** For the popup's This page tab and the words panel: the video's words, and whether this browser is a Supporter's. */
async function getVideoWords() {
  if (!captionCueTrack?.cues?.length) return { available: false };
  processWholeCaptionTrack();
  const token = await askBackground({ action: 'hasSupporterToken' });
  const { words, units, coverage } = videoWordsSummary();
  return {
    available: true,
    supporter: Boolean(token?.success && token.supporter === true),
    coverage,
    words,
    units,
  };
}

/** The words panel in the player: counts by level for everyone, the new words for Supporters. */
async function showCaptionWordsPanel() {
  const body = openCaptionPanel('words');
  const title = captionText('p', 'tsukeru-caption-card-title', t('video_words_title', undefined, 'Words in this video'));
  const status = captionText('p', 'tsukeru-caption-card-text', t('video_words_reading', undefined, 'Reading the subtitles…'));
  body.append(title, status);
  let polls = 0;
  const render = async () => {
    const answer = await getVideoWords();
    if (!body.isConnected) return;
    if (!answer.available) {
      status.textContent = t('video_words_none', undefined, 'No subtitle lines are known for this video yet.');
      return;
    }
    const units = answer.units;
    const fresh = units.filter((unit) => !unit.learned);
    const meter = captionWordsMeter(units);
    status.textContent = t('video_words_counts', [String(units.length), String(fresh.length)], `${units.length} words, ${fresh.length} new to you`)
      + (answer.coverage < 1 ? ` ${t('video_words_partial', [String(Math.round(answer.coverage * 100))], `(${Math.round(answer.coverage * 100)}% of the video so far)`)}` : '');
    body.querySelector('.tsukeru-caption-words-levels')?.remove();
    body.querySelector('.tsukeru-caption-words-list')?.remove();
    body.querySelector('.tsukeru-caption-card-actions')?.remove();
    body.append(meter);
    if (answer.supporter) {
      const list = document.createElement('ul');
      list.className = 'tsukeru-caption-words-list';
      list.setAttribute('lang', 'ja');
      for (const word of fresh.slice(0, CAPTION_WORDS_LIST_MAX)) {
        const item = document.createElement('li');
        item.append(captionText('span', 'tsukeru-caption-word', word.word));
        if (word.reading && word.reading !== word.word) item.append(captionText('span', 'tsukeru-caption-word-reading', word.reading));
        list.append(item);
      }
      body.append(list, captionText('p', 'tsukeru-caption-card-note', t('video_words_sort_hint', undefined, 'Sort them into My Words from Tsukeru\'s This page tab.')));
    } else {
      const actions = document.createElement('div');
      actions.className = 'tsukeru-caption-card-actions';
      const upgrade = document.createElement('a');
      upgrade.className = 'tsukeru-caption-card-primary';
      upgrade.href = TsukeruI18n.websiteUrl('/pricing?from=tsukeru&placement=extension_video_words');
      upgrade.target = '_blank';
      upgrade.rel = 'noopener noreferrer';
      upgrade.textContent = t('supporter_become', undefined, 'Become a Supporter');
      actions.append(upgrade);
      body.append(captionText('p', 'tsukeru-caption-card-text', t('video_words_supporter', undefined, 'Supporters see every new word from the video and can sort them into My Words.')), actions);
    }
    polls += 1;
    if (answer.coverage < 1 && captionGateOpen() && body.isConnected && polls < 12) setTimeout(render, 2500);
  };
  render();
}

/**
 * The JLPT colour bar, as in the popup's This page tab: one segment per level,
 * as wide as its share of the words, named with its count for pointers and
 * screen readers.
 */
function captionWordsMeter(units) {
  const other = t('video_words_other', undefined, 'Other');
  const meter = document.createElement('span');
  meter.className = 'tsukeru-caption-words-levels';
  meter.setAttribute('role', 'img');
  const levels = ['N5', 'N4', 'N3', 'N2', 'N1', '']
    .map((level) => [level, units.filter((unit) => unit.level === level).length])
    .filter(([, count]) => count);
  meter.hidden = !levels.length;
  for (const [level, count] of levels) {
    const segment = document.createElement('span');
    segment.className = 'tsukeru-caption-words-segment';
    segment.dataset.level = level ? level.slice(1) : '0';
    segment.style.flexGrow = String(count);
    segment.title = `${level || other} · ${count}`;
    meter.append(segment);
  }
  meter.setAttribute('aria-label', levels
    .map(([level, count]) => `${level || other} ${Math.round((count / Math.max(1, units.length)) * 100)}%`)
    .join(', '));
  return meter;
}

/** New cues for the video: a words panel already open counts them again. */
function refreshVideoWords() {
  if (captionPanel?.dataset.kind === 'words') showCaptionWordsPanel();
}
