import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (browser, path) => readFileSync(new URL(`../${browser}/${path}`, import.meta.url), 'utf8');
const withoutModules = source => source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const click = isTrusted => ({ isTrusted, stopPropagation() {} });

function node() {
  return { value: '', innerHTML: '', isConnected: true, dataset: {}, classList: { add() {}, remove() {}, contains() { return true; } } };
}

function tooltipHarness(browser) {
  const fields = new Map(['close', 'submit', 'word', 'reading', 'context', 'correct', 'error', 'success']
    .map(name => [`tsukeru-crm-${name}`, node()]));
  const reportButton = node();
  const tooltip = Object.assign(node(), {
    _activeRuby: {},
    querySelector(selector) { return selector === '.tsukeru-tooltip-report-btn' ? reportButton : null; },
    querySelectorAll() { return []; },
  });
  const requests = [];
  const sandbox = {
    console, URL, dictionaryTooltip: tooltip, DICTIONARY_MAX_SENSES: 5,
    chrome: { i18n: { getMessage() { return ''; } }, runtime: { sendMessage(message) { requests.push(plain(message)); } } },
    applyTsukeruUiTheme() {}, requestAnimationFrame() {},
    document: {
      getElementById(id) { return fields.get(id) || null; },
      createElement() {
        // Browser text-node serialization escapes markup, but leaves quotes literal.
        const element = node();
        Object.defineProperty(element, 'innerHTML', {
          get() { return String(this.textContent || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); },
          set() {},
        });
        return element;
      },
      body: { appendChild(element) { fields.set(element.id, element); } },
    },
  };
  vm.createContext(sandbox);
  const dom = read(browser, 'js/content-dom.js');
  const start = dom.indexOf('function escapeHtml(text)');
  vm.runInContext(dom.slice(start, dom.indexOf('\nfunction escapeRegex', start)), sandbox);
  loadI18n(sandbox, browser);
  vm.runInContext(read(browser, 'js/content-tooltip.js'), sandbox);
  sandbox.extractSentenceContext = () => '猫がいる。';
  sandbox.getPlainTextFromHtml = value => value;
  return { sandbox, fields, tooltip, reportButton, requests };
}

function audioHarness(browser, fetch) {
  const sandbox = {
    Blob, Uint8Array, URL, fetch, kata2hira: value => value,
    console: { info() {}, warn() {}, error() {} },
    FileReader: class {
      readAsDataURL() { this.result = 'data:audio/mpeg;base64,YQ=='; this.onloadend(); }
    },
  };
  vm.runInNewContext(withoutModules(read(browser, 'js/bg-api.js')), sandbox);
  return sandbox;
}

function routerHarness(browser) {
  let listener;
  const calls = [];
  const sandbox = {
    URL, isWordsAction: () => false,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    handleFetchProxyAudio: async url => { calls.push(url); return { dataUrl: 'data:audio/mpeg;base64,YQ==' }; },
  };
  const source = read(browser, 'background.js');
  const start = source.indexOf('chrome.runtime.onMessage.addListener');
  vm.runInNewContext(source.slice(start, source.indexOf('chrome.commands.onCommand.addListener', start)), sandbox);
  return { calls, send: message => new Promise(resolve => listener(message, {}, resolve)) };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} production HTML escaper protects tooltip attribute values`, () => {
    const { sandbox, tooltip } = tooltipHarness(browser);
    assert.equal(sandbox.escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
    const word = `猫" onfocus='bad'`;
    const reading = `ねこ" onpointerenter='bad'`;
    sandbox.renderDefinitionTooltip(tooltip, { word, reading, altReadings: [] }, {
      entries: [{ kana: ['ねこ'], senses: [{ glosses: ['cat'], pos: ['noun'] }] }],
    });
    assert.ok(tooltip.innerHTML.includes('data-word="猫&quot; onfocus=&#39;bad&#39;"'));
    assert.ok(tooltip.innerHTML.includes('data-reading="ねこ&quot; onpointerenter=&#39;bad&#39;"'));
    assert.doesNotMatch(tooltip.innerHTML, /"\s+on(?:focus|pointerenter)=/);
  });

  test(`${browser} rejects synthetic report clicks and ignores tampered display fields`, () => {
    const { sandbox, fields, reportButton, requests } = tooltipHarness(browser);
    sandbox.renderDefinitionTooltip(sandbox.dictionaryTooltip, { word: '猫', reading: 'ねこ', altReadings: [] }, {
      entries: [{ kana: ['ねこ'], senses: [{ glosses: ['cat'] }] }],
    });
    reportButton.onclick(click(false));
    assert.equal(fields.has('tsukeru-content-report-modal'), false);
    // Page scripts may edit data attributes before even a genuine report-opening click.
    reportButton.dataset.word = 'forged word';
    reportButton.dataset.reading = 'forged reading';
    reportButton.onclick(click(true));
    assert.equal(fields.get('tsukeru-crm-word').value, '猫');
    for (const name of ['word', 'reading', 'context']) fields.get(`tsukeru-crm-${name}`).value = 'forged';
    fields.get('tsukeru-crm-correct').value = '  ねこ  ';
    fields.get('tsukeru-crm-submit').onclick(click(false));
    assert.equal(requests.length, 0);
    fields.get('tsukeru-crm-submit').onclick(click(true));
    assert.deepEqual(requests, [{ action: 'reportReadingError', payload: {
      word: '猫', reading: 'ねこ', context_sentence: '猫がいる。', correct_reading: 'ねこ', consent_given: true,
    } }]);
    fields.get('tsukeru-crm-close').onclick(click(true));
    fields.get('tsukeru-crm-submit').onclick(click(true));
    assert.equal(requests.length, 1);
  });

  test(`${browser} reports cannot submit before opening and consent uses the captured context`, () => {
    const { sandbox, fields, reportButton, requests } = tooltipHarness(browser);
    sandbox.ensureContentReportModal();
    fields.get('tsukeru-crm-submit').onclick(click(true));
    assert.equal(requests.length, 0);
    sandbox.extractSentenceContext = () => '';
    sandbox.addTooltipInteractionHandlers({ word: '猫', reading: 'ねこ' });
    reportButton.onclick(click(true));
    fields.get('tsukeru-crm-context').value = 'page-injected context';
    fields.get('tsukeru-crm-submit').onclick(click(true));
    assert.equal(requests[0].payload.context_sentence, '');
    assert.equal(requests[0].payload.consent_given, false);
  });

  test(`${browser} sync routing accepts only this extension on the canonical HTTPS origin`, async () => {
    let reads = 0;
    const sandbox = {
      URL, console,
      chrome: { runtime: { id: 'extension-id' }, storage: { local: {
        async get() { reads++; return {}; }, async set() {}, async remove() {},
      } } },
    };
    vm.runInNewContext(read(browser, 'js/word-rules.js'), sandbox);
    vm.runInNewContext(withoutModules(read(browser, 'js/bg-words.js')), sandbox);
    for (const url of ['https://ezfurigana.com/', 'https://staging.ezfurigana.com/', 'http://www.ezfurigana.com/',
      'https://www.ezfurigana.com:444/', 'https://www.ezfurigana.com.evil.example/', 'invalid']) {
      for (const action of ['wordsSyncStart', 'wordsSyncFinish']) {
        const response = await sandbox.handleWordsMessage({ action, startedAt: 1, records: [] }, { id: 'extension-id', url });
        assert.equal(response.success, false, `${action}: ${url}`);
      }
    }
    assert.equal((await sandbox.handleWordsMessage({ action: 'wordsSyncStart' }, {
      id: 'other-extension', url: 'https://www.ezfurigana.com/',
    })).success, false);
    assert.equal(reads, 0, 'rejected pages cannot access the word store');
    assert.equal((await sandbox.handleWordsMessage({ action: 'wordsSyncStart', storeId: 'website' }, {
      id: 'extension-id', url: 'https://www.ezfurigana.com:443/review',
    })).success, true);
  });

  test(`${browser} manifest and bridge restrict sync and network access to www HTTPS`, () => {
    const manifest = JSON.parse(read(browser, 'manifest.json'));
    assert.deepEqual(manifest.host_permissions, ['https://www.ezfurigana.com/*']);
    assert.deepEqual(manifest.content_scripts.find(entry => entry.js.includes('js/content-sync.js')).matches,
      ['https://www.ezfurigana.com/*']);
    for (const origin of ['https://www.ezfurigana.com', 'https://ezfurigana.com', 'https://staging.ezfurigana.com',
      'http://www.ezfurigana.com', 'https://www.ezfurigana.com:444']) {
      const posts = [];
      let listeners = 0;
      const sandbox = {
        window: { location: { origin }, postMessage(message, target) { posts.push({ message, target }); }, addEventListener() { listeners++; } },
        chrome: { storage: { onChanged: { addListener() { listeners++; } } } },
      };
      vm.runInNewContext(read(browser, 'js/content-sync.js'), sandbox);
      const allowed = origin === 'https://www.ezfurigana.com';
      assert.equal(posts.length, allowed ? 1 : 0, origin);
      assert.equal(listeners, allowed ? 2 : 0, origin);
      if (allowed) assert.equal(posts[0].target, origin);
    }
  });

  test(`${browser} audio routing and API reject noncanonical hosts, schemes and ports`, async () => {
    const fetches = [];
    const api = audioHarness(browser, async (url, options) => {
      fetches.push({ url, options });
      return { ok: true, headers: { get: key => key === 'Content-Type' ? 'audio/mpeg' : null },
        async blob() { return new Blob([new Uint8Array(200)], { type: 'audio/mpeg' }); } };
    });
    const router = routerHarness(browser);
    for (const url of ['https://ezfurigana.com/audio', 'https://cdn.ezfurigana.com/audio', 'http://www.ezfurigana.com/audio',
      'https://www.ezfurigana.com:444/audio', 'https://www.ezfurigana.com.evil.example/audio', 'invalid']) {
      await assert.rejects(() => api.handleFetchProxyAudio(url));
      assert.equal((await router.send({ action: 'fetchProxyAudio', url })).success, false, url);
    }
    assert.equal(fetches.length, 0);
    assert.equal(router.calls.length, 0);
    const url = 'https://www.ezfurigana.com/api/proxy-audio?kana=ねこ';
    assert.match((await api.handleFetchProxyAudio(url)).dataUrl, /^data:audio\/mpeg/);
    assert.equal((await router.send({ action: 'fetchProxyAudio', url })).success, true);
    assert.equal(fetches[0].options.redirect, 'error');
    await api.handlePlayAudio('猫', 'ねこ');
    assert.equal(fetches[1].options.redirect, 'error');
    assert.ok(fetches.every(({ url }) => new URL(url).origin === 'https://www.ezfurigana.com'));
  });
}
