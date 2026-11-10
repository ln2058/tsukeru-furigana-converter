import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function load(browser) {
  const sandbox = {};
  const read = (rel) => readFileSync(new URL(`../${browser}/${rel}`, import.meta.url), 'utf8');
  vm.runInNewContext(read('js/word-rules.js'), sandbox);
  const tooltip = read('js/content-tooltip.js').replace(/\r\n/g, '\n');
  const start = tooltip.indexOf('// Elements that start a new line of text');
  const end = tooltip.indexOf('\n}\n', tooltip.indexOf('function blockTextAround')) + 2;
  // Page words: elements with a data-reading (and an optional data-id), as sentenceWordOf reads them.
  sandbox.sentenceWordOf = (node) => {
    const reading = node.getAttribute?.('data-reading');
    return reading ? { reading, id: node.getAttribute('data-id') || '' } : null;
  };
  vm.runInNewContext(`${tooltip.slice(start, end)}\nglobalThis.blockTextAround = blockTextAround;`, sandbox);
  const lineStart = tooltip.indexOf('let sentenceAudioSupporter');
  const lineEnd = tooltip.indexOf('\nfunction showSupporterTag');
  sandbox.escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  sandbox.t = (_key, _subs, fallback) => fallback;
  vm.runInNewContext(`${tooltip.slice(lineStart, lineEnd)}
globalThis.renderLine = renderTooltipSentenceLine;
globalThis.setSupporter = (value) => { sentenceAudioSupporter = value; };`, sandbox);
  return sandbox;
}

// Minimal element/text nodes: enough for the walk (tagName, children, siblings, parent).
function el(tagName, children = [], attrs = {}) {
  const node = { nodeType: 1, tagName, firstChild: null, nextSibling: null, parentElement: null, getAttribute: (name) => attrs[name] ?? null };
  let previous = null;
  for (const child of children) {
    const item = typeof child === 'string' ? { nodeType: 3, nodeValue: child, nextSibling: null } : child;
    item.parentElement = node;
    if (previous) previous.nextSibling = item; else node.firstChild = item;
    previous = item;
  }
  return node;
}

for (const browser of ['chrome', 'firefox']) {
  const { TsukeruWords: Words, blockTextAround, renderLine, setSupporter } = load(browser);

  test(`${browser} picks only the sentence holding the word`, () => {
    const lines = 'ウィキペディアへようこそ\nウィキペディアは誰でも編集できるフリー百科事典です\n1,526,611本の記事をあなたと';
    const at = lines.indexOf('百科');
    assert.equal(Words.sentenceAt(lines, at, at + 2, '百科'), 'ウィキペディアは誰でも編集できるフリー百科事典です');

    const prose = '雨が降った。「傘を持って行こう。」と彼は言った。次の日は晴れた。';
    const word = prose.indexOf('傘');
    assert.equal(Words.sentenceAt(prose, word, word + 1, '傘'), '「傘を持って行こう。」');
    const said = prose.indexOf('彼');
    assert.equal(Words.sentenceAt(prose, said, said + 1, '彼'), 'と彼は言った。');
  });

  test(`${browser} reads nested blocks and line breaks as sentence edges, without readings`, () => {
    const ruby = el('RUBY', ['百科', el('RT', ['ひゃっか'])]);
    el('DIV', [
      el('DIV', ['ウィキペディアへようこそ']),
      el('DIV', ['ウィキペディアは誰でも編集できるフリー', ruby, '事典です']),
      el('DIV', ['1,526,611本の記事', el('BR'), 'あなたと']),
      el('P', ['選り抜き記事']),
    ]);
    const around = blockTextAround(ruby);
    assert.equal(around.text.slice(around.start, around.end), '百科');
    assert.equal(Words.sentenceAt(around.text, around.start, around.end, '百科'), 'ウィキペディアは誰でも編集できるフリー百科事典です');
  });

  test(`${browser} keeps the readings of the sentence's words, over their kanji only`, () => {
    const ate = el('SPAN', ['食べました'], { 'data-reading': 'たべました', 'data-id': '食べる\u0000たべる' });
    el('P', [
      el('SPAN', ['昨日'], { 'data-reading': 'きのう' }), 'は休み。',
      el('SPAN', ['今日'], { 'data-reading': 'きょう' }), 'はパンを', ate, '。',
    ]);
    const around = blockTextAround(ate);
    const found = Words.sentenceWithReadingsAt(around.text, around.start, around.end, '食べました', around.words);
    assert.equal(found.sentence, '今日はパンを食べました。');
    assert.deepEqual(JSON.parse(JSON.stringify(found.readings)), [[0, 2, 'きょう', ''], [6, 1, 'た', '食べる\u0000たべる']]);

    // A word is kept with the readings of its sentence, and only valid spans.
    const store = Words.createStore();
    const record = Words.captureWord(store, {
      word: '食べる', reading: 'たべる', sentence: found.sentence,
      readings: [...found.readings, [20, 5, 'あ', ''], [0, 1, 'kyou', '']],
    }, 1000);
    assert.deepEqual(JSON.parse(JSON.stringify(record.sentenceReadings)), {
      '今日はパンを食べました。': [[0, 2, 'きょう', ''], [6, 1, 'た', '食べる\u0000たべる']],
    });
  });

  test(`${browser} shows the sentence it will read, tagged Supporter only for known Free browsers`, () => {
    assert.equal(renderLine('', '傘'), '', 'no line without a sentence');
    const html = renderLine('「傘」を<b>持って</b>行こう。', '傘');
    assert.ok(html.includes('data-sentence="「傘」を&lt;b>持って&lt;/b>行こう。"'));
    assert.ok(html.includes('「<mark class="tsukeru-sentence-word">傘</mark>」を&lt;b>'));
    assert.ok(html.includes('tsukeru-supporter-tag tsukeru-hidden'), 'tag hidden until the plan is known');
    // A word late in a long sentence stays visible; the whole sentence is still played.
    const long = `${'あ'.repeat(40)}傘を持って行こう。`;
    const late = renderLine(long, '傘');
    assert.ok(late.includes(`>…${'あ'.repeat(10)}<mark class="tsukeru-sentence-word">傘</mark>`));
    assert.ok(late.includes(`data-sentence="${long}"`));
    setSupporter(false);
    assert.ok(!renderLine('傘を持って行こう。', '傘').includes('tsukeru-hidden'));
    setSupporter(true);
    assert.ok(renderLine('傘を持って行こう。', '傘').includes('tsukeru-supporter-tag tsukeru-hidden'));
  });
}
