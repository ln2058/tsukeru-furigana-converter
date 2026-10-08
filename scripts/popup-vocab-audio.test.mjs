import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function fakeButton() {
  const classes = new Set();
  return { classes, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
}

function loadPopupAudio(browserName, respond) {
  const fileUrl = new URL(`../${browserName}/js/popup-vocab.js`, import.meta.url);
  const source = readFileSync(fileUrl, 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/popup-settings\.js';/, '')
    .replaceAll('export ', '');
  const sent = [];
  const audios = [];
  const spoken = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.listeners = {};
      audios.push(this);
    }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const sandbox = {
    console,
    Audio: FakeAudio,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { cancel() {}, speak: (utterance) => spoken.push(utterance) },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: (message, callback) => { sent.push(message); callback(respond(message)); },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return { sandbox, sent, audios, spoken };
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} a playing My Words speaker ignores repeat clicks`, () => {
    const { sandbox, sent, audios } = loadPopupAudio(browserName, () => ({ success: true, dataUrl: 'data:audio/mpeg;base64,AA==' }));
    const button = fakeButton();

    sandbox.playWordAudio('今日', 'きょう', button);
    sandbox.playWordAudio('今日', 'きょう', button);

    assert.equal(sent.length, 1, 'one audio request per playback');
    assert.equal(sent[0].action, 'playAudio');
    assert.equal(sent[0].word, '今日');
    assert.equal(sent[0].reading, 'きょう');
    assert.ok(button.classes.has('is-playing'));

    audios[0].listeners.ended();
    assert.ok(!button.classes.has('is-playing'));
  });

  test(`${browserName} a missing or non-audio clip falls back to the browser voice reading the kana`, () => {
    for (const response of [{ success: false, rateLimitType: 'audio_cold_fetch' }, { success: true, dataUrl: 'data:text/html,x' }]) {
      const { sandbox, audios, spoken } = loadPopupAudio(browserName, () => response);
      const button = fakeButton();

      sandbox.playWordAudio('今日', 'きょう', button);

      assert.equal(audios.length, 0, 'nothing but data:audio/ is played');
      assert.equal(spoken.length, 1);
      assert.equal(spoken[0].text, 'きょう');
      assert.equal(spoken[0].lang, 'ja-JP');
      spoken[0].onend();
      assert.ok(!button.classes.has('is-playing'));
    }
  });
}
