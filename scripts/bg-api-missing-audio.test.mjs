// Purpose: JP101's spoken "audio not available" clip is never played as a word's pronunciation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (browser) => readFileSync(new URL(`../${browser}/js/bg-api.js`, import.meta.url), 'utf8');
const withoutModules = (source) => source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');

// Same size as the real placeholder; its digest stands in for the real one.
const placeholder = Uint8Array.from({ length: 52288 }, (_, i) => (i * 31 + 7) % 251);
const sameSizeWord = Uint8Array.from({ length: 52288 }, (_, i) => (i * 17 + 3) % 251);
const word = new Uint8Array(4000).fill(9);

function harness(browser, clips) {
  const fetches = [];
  const sandbox = {
    Blob, Uint8Array, URL, crypto: globalThis.crypto, kata2hira: (value) => value,
    console: { info() {}, warn() {}, error() {} },
    fetch: async (url) => {
      const bytes = clips[fetches.length];
      fetches.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: (key) => (key.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
        async blob() { return new Blob([bytes], { type: 'audio/mpeg' }); },
      };
    },
    FileReader: class {
      readAsDataURL() { this.result = 'data:audio/mpeg;base64,YQ=='; this.onloadend(); }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(withoutModules(read(browser)), sandbox);
  const digest = createHash('sha256').update(placeholder).digest('hex');
  vm.runInContext(`if (typeof JP101_MISSING_AUDIO_SHA256 !== 'undefined') JP101_MISSING_AUDIO_SHA256.add('${digest}');`, sandbox);
  return { api: sandbox, fetches };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} skips the "not available" clip and plays the next match`, async () => {
    const { api, fetches } = harness(browser, [placeholder, word]);
    assert.match((await api.handlePlayAudio('猫', 'ねこ')).dataUrl, /^data:audio\/mpeg/);
    assert.equal(fetches.length, 2);
  });

  test(`${browser} plays a real clip of the placeholder's size`, async () => {
    const { api, fetches } = harness(browser, [sameSizeWord]);
    await api.handlePlayAudio('猫', 'ねこ');
    assert.equal(fetches.length, 1);
  });

  test(`${browser} proxy audio rejects the "not available" clip`, async () => {
    const { api } = harness(browser, [placeholder]);
    await assert.rejects(
      () => api.handleFetchProxyAudio('https://www.ezfurigana.com/api/proxy-audio?kana=ねこ'),
      /Audio not found/,
    );
  });
}
