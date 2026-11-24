// Subtitle files read ahead of playback (content-caption-cues): YouTube's
// json3 (hand-made and auto-generated), WebVTT, and Netflix's IMSC TTML with
// its own furigana and vertical lines; which lines are processed ahead; and
// which page messages are believed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// A small XML reader with the few DOM calls parseTtml uses (Node has no DOMParser).
class XmlNode {
  constructor(name, attributes = []) {
    this.nodeType = 1;
    this.localName = name.includes(':') ? name.split(':')[1] : name;
    this.attributes = attributes;
    this.childNodes = [];
  }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get textContent() { return this.childNodes.map((node) => (node.nodeType === 3 ? node.nodeValue : node.textContent)).join(''); }
  getElementsByTagNameNS(_ns, name) {
    const found = [];
    const walk = (node) => node.children.forEach((child) => {
      if (child.localName === name) found.push(child);
      walk(child);
    });
    walk(this);
    return found;
  }
}

class FakeDOMParser {
  parseFromString(text) {
    const doc = new XmlNode('#document');
    const stack = [doc];
    const decode = (value) => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const match of text.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g)) {
      const [, closing, name, attrs, selfClosing, chars] = match;
      if (chars !== undefined) {
        stack[stack.length - 1].childNodes.push({ nodeType: 3, nodeValue: decode(chars) });
      } else if (closing) {
        stack.pop();
      } else {
        const attributes = [...attrs.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, key, value]) => ({
          localName: key.includes(':') ? key.split(':')[1] : key,
          value: decode(value),
        }));
        const node = new XmlNode(name, attributes);
        stack[stack.length - 1].childNodes.push(node);
        if (!selfClosing) stack.push(node);
      }
    }
    doc.documentElement = doc.children[0];
    doc.getElementsByTagName = () => [];
    return doc;
  }
}

function load(browserName) {
  const source = readFileSync(new URL(`../${browserName}/js/content-caption-cues.js`, import.meta.url), 'utf8');
  const sent = [];
  const sandbox = {
    console,
    location: { href: 'https://www.youtube.com/watch?v=CBPJaMCuKow', hostname: 'www.youtube.com', origin: 'https://www.youtube.com' },
    window: {},
    document: { addEventListener() {}, querySelector: () => null },
    DOMParser: FakeDOMParser,
    TextEncoder,
    URL,
    JAPANESE_CHAR_RE: /[぀-ヿ㐀-鿿]/,
    TOKEN_PREFIX: '__TSUKERU_SPLIT__',
    currentSite: 'youtube',
    isFuriganaActive: true,
    videoCaptionSettings: { furiganaType: 'hiragana' },
    lastAppliedSettings: null,
    captionGateOpen: () => true,
    noteCaptionRefused() {},
    extractMarkedChunks: () => new Map(),
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); return { success: false }; } } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(`${source}
globalThis.api = { parseYoutubeJson3, parseWebVtt, parseTtml, captionPieceKey, setCaptionCueTrack, captionPiecesAhead, onPageCaptionsMessage, storeCaptionPiece, self: window, get track() { return captionCueTrack; } };`, sandbox);
  return { api: sandbox.api, sent, sandbox };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

// The shape of a real auto-generated track (kind=asr): lines, then "\n" events that roll the window.
const JSON3 = JSON.stringify({
  wireMagic: 'pb3',
  events: [
    { tStartMs: 0, dDurationMs: 3719842, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    { tStartMs: 1964, dDurationMs: 2020, wWinId: 1, segs: [{ utf8: '[うめき声]' }] },
    { tStartMs: 12030, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 12040, dDurationMs: 2425, wWinId: 1, segs: [{ utf8: '世界最大のレボ', acAsrConf: 0 }, { utf8: '[叫び声]', tOffsetMs: 405 }] },
    { tStartMs: 68640, dDurationMs: 479, wWinId: 1, segs: [{ utf8: 'ですね。' }] },
    { tStartMs: 70000, dDurationMs: 2000, wWinId: 1, segs: [{ utf8: 'hello' }] },
    { tStartMs: 80000, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: '一行目\n二行目' }] },
  ],
});

// The shape of a Netflix IMSC 1.1 subtitle file: the author's own furigana, a vertical region, line breaks.
const TTML = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" ttp:timeBase="media" xml:lang="ja">
<head><styling>
<style xml:id="style0" tts:textAlign="center"/><style xml:id="style1" tts:fontSize="100%"/>
<style xml:id="style2" tts:shear="16.670%" tts:textAlign="start"/>
<style xml:id="style5" tts:ruby="container"/><style xml:id="style6" tts:ruby="base"/><style xml:id="style7" tts:ruby="text"/>
</styling><layout>
<region xml:id="region0" tts:displayAlign="after" tts:writingMode="lrtb"/>
<region xml:id="region1" tts:displayAlign="before" tts:writingMode="tbrl"/>
</layout></head>
<body><div>
<p xml:id="subtitle2" begin="749910000t" end="767430000t" region="region1" style="style2">〝ホワイトウィングス<br/>医療団〞</p>
<p xml:id="subtitle89" begin="3936840000t" end="3958120000t" region="region0" style="style0"><span style="style5"><span style="style6">木蓮</span><span style="style7">モンニョン</span></span><span style="style1">会は</span><br/><span style="style1">団結が不可欠です</span></p>
<p xml:id="subtitle90" begin="3960000000t" end="3970000000t" region="region0" style="style0">Hello</p>
</div></body></tt>`;

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} YouTube json3 keeps each line, skips the window's roll events, and joins a cue's lines`, () => {
    const { api } = load(browserName);
    const cues = plain(api.parseYoutubeJson3(JSON3));
    assert.deepEqual(cues.map((cue) => [cue.start, cue.pieces]), [
      [1.964, ['[うめき声]']],
      [12.04, ['世界最大のレボ[叫び声]']],
      [68.64, ['ですね。']],
      [80, ['一行目二行目']],
    ]);
    assert.equal(cues[1].end, 12.04 + 2.425);
    assert.deepEqual(plain(api.parseYoutubeJson3('not json')), []);
  });

  test(`${browserName} WebVTT drops tags, entities and non-Japanese cues`, () => {
    const { api } = load(browserName);
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.500 align:center
<v Ryuk>このノートに&amp;名前を</v>
<i>書かれた人間は</i>

2
00:01:02.250 --> 00:01:04.000
English only`;
    const [cue, ...rest] = plain(api.parseWebVtt(vtt));
    assert.deepEqual(rest, []);
    assert.equal(cue.start, 1);
    assert.equal(cue.end, 3.5);
    assert.deepEqual(cue.pieces, ['このノートに&名前を書かれた人間は']);
    assert.deepEqual(plain(api.parseWebVtt(vtt, { joined: false }))[0].pieces, ['このノートに&名前を', '書かれた人間は']);
  });

  test(`${browserName} Netflix TTML keeps the author's furigana as written and never sends it`, () => {
    const { api } = load(browserName);
    const cues = plain(api.parseTtml(TTML));
    assert.equal(cues.length, 2, 'English lines are left out');
    const [vertical, ruby] = cues;
    assert.equal(vertical.vertical, true);
    assert.equal(vertical.top, true);
    assert.equal(vertical.align, 'start');
    assert.equal(vertical.start, 74.991);
    assert.deepEqual(vertical.lines.map((line) => line.map((part) => part.text)), [['〝ホワイトウィングス'], ['医療団〞']]);
    assert.equal(vertical.lines[0][0].slanted, true);
    assert.deepEqual(ruby.lines[0][0], { base: '木蓮', ruby: 'モンニョン', slanted: false, emphasis: false });
    assert.deepEqual(ruby.pieces, ['会は', '団結が不可欠です'], 'the ruby base is not processed again');
    assert.equal(ruby.text, '木蓮会は\n団結が不可欠です');
  });

  test(`${browserName} only the next few minutes without a result are processed ahead`, () => {
    const { api, sandbox } = load(browserName);
    // Furigana off: the cues are kept but nothing is sent yet.
    sandbox.isFuriganaActive = false;
    const cues = [0, 30, 100, 140, 200, 400].map((start) => ({ start, end: start + 3, text: `行${start}`, lines: [], pieces: [`行${start}`] }));
    api.setCaptionCueTrack('youtube:x:ja:manual', 'youtube', cues);
    api.storeCaptionPiece('行30', '<ruby>行</ruby>');
    assert.deepEqual(plain(api.captionPiecesAhead(10)).map((piece) => piece.text), ['行100', '行140'], 'past lines, stored lines, and lines beyond 150 s are left');
    assert.deepEqual(plain(api.captionPiecesAhead(300)).map((piece) => piece.text), ['行400']);
    assert.equal(api.captionPieceKey(' 一行目\n 二行目 '), '一行目二行目');
  });

  test(`${browserName} subtitle files are taken only from this window, for the video on screen`, () => {
    const { api } = load(browserName);
    // The content script's own window (the sandbox's global).
    const message = (data, source = api.self, origin = 'https://www.youtube.com') => api.onPageCaptionsMessage({ source, origin, data });
    const body = JSON3;
    message({ source: 'other', kind: 'youtube-json3', track: { video: 'CBPJaMCuKow', lang: 'ja' }, body });
    message({ source: 'tsukeru-page-captions', kind: 'youtube-json3', track: { video: 'CBPJaMCuKow', lang: 'ja' }, body }, {});
    message({ source: 'tsukeru-page-captions', kind: 'youtube-json3', track: { video: 'another', lang: 'ja' }, body });
    message({ source: 'tsukeru-page-captions', kind: 'youtube-json3', track: { video: 'CBPJaMCuKow', lang: 'ja' }, body: 42 });
    assert.equal(api.track, null);
    message({ source: 'tsukeru-page-captions', kind: 'youtube-json3', track: { video: 'CBPJaMCuKow', lang: 'ja', auto: true }, body });
    assert.equal(api.track.key, 'youtube:CBPJaMCuKow:ja:auto');
    assert.equal(api.track.cues.length, 4);
  });

  test(`${browserName} the page script passes on only Japanese subtitle files and changes no request`, () => {
    const page = readFileSync(new URL(`../${browserName}/js/page-captions.js`, import.meta.url), 'utf8');
    assert.match(page, /url\.pathname === '\/api\/timedtext' && url\.searchParams\.get\('fmt'\) === 'json3'/);
    assert.match(page, /if \(!\/\^ja\\b\/i\.test\(lang\)\) return null;/);
    assert.match(page, /window\.postMessage\(\{ source: SOURCE, kind: match\.kind, track: match\.track, body \}, location\.origin\)/);
    assert.doesNotMatch(page, /chrome\.|fetch\(\s*['"`]http/, 'no extension APIs and no requests of its own');
    const manifest = JSON.parse(readFileSync(new URL(`../${browserName}/manifest.json`, import.meta.url), 'utf8'));
    const entry = manifest.content_scripts.find((item) => item.js.includes('js/page-captions.js'));
    assert.equal(entry.world, 'MAIN');
    assert.deepEqual(entry.matches, ['https://www.youtube.com/*', 'https://www.netflix.com/*']);
    // Content scripts run in embedded frames too (captions only there); nothing is injected into frames.
    assert.equal(manifest.content_scripts[0].all_frames, true);
    const background = readFileSync(new URL(`../${browserName}/background.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(background.match(/async function startFrameCaptions[\s\S]*?\n}\r?\n/)[0], /executeScript|insertCSS/);
    const main = readFileSync(new URL(`../${browserName}/js/content-main.js`, import.meta.url), 'utf8');
    assert.match(main, /if \(window\.top !== window\) return handleFrameCaptionMessage\(request, sendResponse\);/, 'a frame routes the tab\'s messages to frame mode');
    // A frame answers only the background's request for the video's words, never the popup's own.
    const captions = readFileSync(new URL(`../${browserName}/js/content-captions.js`, import.meta.url), 'utf8');
    const frameHandler = captions.match(/function handleFrameCaptionMessage[\s\S]*?\n}\r?\n/)[0];
    assert.equal((frameHandler.match(/return true;/g) || []).length, 1);
    assert.match(frameHandler, /request\?\.action === 'getVideoWords' && request\.frameVideoWords === true/);
    assert.match(background, /action: 'getVideoWords', frameVideoWords: true \}, \{ frameId \}/);
    assert.match(background.match(/if \(message\?\.action === 'frameVideoWords'\) \{[\s\S]*?\n  \}/)[0], /sender\.frameId !== 0/, 'only the top page asks');
  });
}

// Explain this line sends the whole sentence the caption belongs to (content-caption-tools).
for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} Explain takes the whole caption sentence, across lines not yet on screen`, () => {
    const source = readFileSync(new URL(`../${browserName}/js/content-caption-tools.js`, import.meta.url), 'utf8');
    const pick = (name) => source.slice(source.indexOf(name), source.indexOf('\n}\n', source.indexOf(name)) + 3);
    const constants = source.match(/const CAPTION_SENTENCE_END_RE[^\n]*\n/)[0]
      + 'const CAPTION_SENTENCE_GAP_S = 3;\nconst CAPTION_SENTENCE_MAX_CHARS = 120;\n';
    const sentenceAt = new Function(`${constants}${pick('function cueSentenceText')}${pick('function captionSentenceAt')}return captionSentenceAt;`)();
    const cue = (start, end, text) => ({ start, end, text });
    const cues = [
      cue(0, 2, 'もう終わりだ。'), cue(2.2, 4, 'このノートに名前を'), cue(4.1, 6, '書かれた人間は'), cue(6.1, 8, '死ぬ。'),
      cue(12, 14, '[音楽]'), cue(14, 16, 'え、'), cue(20, 22, 'ほんとに？'),
    ];
    for (const index of [1, 2, 3]) assert.equal(sentenceAt(cues, index), 'このノートに名前を書かれた人間は死ぬ。');
    assert.equal(sentenceAt(cues, 0), 'もう終わりだ。');
    assert.equal(sentenceAt(cues, 5), 'え、', 'a long pause ends the sentence');
    const long = [cue(0, 1, 'あ'.repeat(70)), cue(1, 2, 'い'.repeat(70))];
    assert.equal(sentenceAt(long, 1), 'い'.repeat(70), 'too long to explain: the line on screen');
  });
}

// Netflix restarts its video's clock after an ad: the layer follows the line Netflix shows
// (content-caption-layer), and hides Netflix's own captions only while it shows that line.
for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} the Netflix layer follows Netflix's line when the video's clock restarts after an ad`, () => {
    const { api, sandbox } = load(browserName);
    const layer = readFileSync(new URL(`../${browserName}/js/content-caption-layer.js`, import.meta.url), 'utf8');
    const pick = (name) => layer.slice(layer.indexOf(name), layer.indexOf('\n}\n', layer.indexOf(name)) + 3);
    vm.runInContext(`${pick('function activeCuesAt')}${pick('function netflixBoxHasCue')}${pick('function netflixCuesShowing')}
globalThis.layer = { netflixCuesShowing, time: (video) => captionCueTime(video), offset: () => captionClockOffset };`, sandbox);
    let boxText = '';
    sandbox.document.querySelector = (selector) => (selector === '.player-timedtext' ? { textContent: boxText } : null);
    const cue = (start, end, text) => ({ start, end, text, lines: [[{ text }]], pieces: [text] });
    api.setCaptionCueTrack('netflix:1', 'netflix', [
      cue(10, 12, 'はい'), cue(300, 303, '雨が降ってきた'), cue(306.8, 309, '傘を持ってる？'), cue(320, 322, 'はい'),
    ]);
    const video = { currentTime: 29.5 };
    const shown = () => plain((sandbox.layer.netflixCuesShowing(video) || []).map((item) => item.text));

    boxText = '傘を 持ってる？';
    assert.deepEqual(shown(), ['傘を持ってる？'], "the line Netflix shows, though the video's clock says 29.5 s");
    assert.ok(Math.abs(sandbox.layer.time(video) - 306.85) < 0.01, 'processing ahead and Explain use the same clock');
    video.currentTime = 43;
    boxText = 'はい';
    assert.deepEqual(shown(), ['はい'], 'a repeated short line: the one at the corrected clock, not the one at 10 s');
    assert.ok(Math.abs(sandbox.layer.time(video) - 320.35) < 0.01, 'the clock is kept while it agrees with Netflix');

    boxText = 'はじめまして、いい天気ですね';
    assert.equal(sandbox.layer.netflixCuesShowing(video), null, "a line not in the list: Netflix's own captions stay");
    boxText = '';
    assert.equal(sandbox.layer.netflixCuesShowing(video), null, 'no line: nothing hidden');
    api.setCaptionCueTrack('netflix:2', 'netflix', [cue(1, 2, 'つぎ')]);
    assert.equal(sandbox.layer.offset(), 0, 'a new episode starts on its own clock');
  });
}

// Every Apply path that turns furigana on also starts the caption extras (tools bar, caption layer, frames).
for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} every Apply path that turns furigana on starts video captions`, () => {
    const main = readFileSync(new URL(`../${browserName}/js/content-main.js`, import.meta.url), 'utf8');
    const apply = main.slice(main.indexOf('async function applyFurigana'), main.indexOf('function refreshPageDock'));
    // A long page (YouTube) once returned straight after starting page processing.
    assert.doesNotMatch(apply, /startLongPageProcessing\(settings\);\s*return;/);
    assert.ok((apply.match(/startVideoCaptions\(settings\)/g) || []).length >= 4);
  });
}
