import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// The website page this script runs on, with a Supporter check that is not yet due.
function page(browser, search = '') {
  const runtime = [];
  const fetches = [];
  const toasts = [];
  let onMessage = null;
  const window = {
    location: { origin: 'https://www.ezfurigana.com', search },
    postMessage() {},
    addEventListener(name, callback) { if (name === 'message') onMessage = callback; },
  };
  const sandbox = {
    window, console, URLSearchParams,
    document: { cookie: 'ez_csrf_token=abc' },
    TsukeruI18n: { t: (_key, _subs, fallback) => fallback },
    showToast: (message) => toasts.push(message),
    fetch: async (url) => {
      fetches.push(url);
      return { ok: true, json: async () => ({ plan: 'supporter', token: 't', expires_at: 1 }) };
    },
    chrome: {
      storage: { onChanged: { addListener() {} } },
      runtime: {
        id: 'extension-id',
        async sendMessage(message) {
          runtime.push(message.action);
          if (message.action === 'supporterRefreshDue') return { success: true, due: false };
          if (message.action === 'supporterHandoff') return { success: true, plan: 'supporter', changed: false };
          return { success: true };
        },
      },
    },
  };
  vm.runInNewContext(readFileSync(new URL(`../${browser}/js/content-sync.js`, import.meta.url), 'utf8'), sandbox);
  return {
    runtime, fetches, toasts,
    send(data, source = window) {
      onMessage({ source, origin: 'https://www.ezfurigana.com', data: { source: 'ezfurigana', protocol: 1, ...data } });
    },
  };
}

const settle = async () => { for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve)); };

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} an ordinary page waits for the recheck interval`, async () => {
    const p = page(browser);
    await settle();
    assert.deepEqual(p.runtime, ['supporterRefreshDue']);
    assert.equal(p.fetches.length, 0);
  });

  test(`${browser} a Connect or checkout address asks right away and confirms`, async () => {
    const p = page(browser, '?session_id=cs_1&tsukeru=connect');
    await settle();
    assert.equal(p.runtime.includes('supporterRefreshDue'), false);
    assert.equal(p.fetches.length, 1);
    assert.match(p.toasts[0], /connected to your Supporter account/);
  });

  test(`${browser} the checkout page's supporter message asks right away, once`, async () => {
    const p = page(browser);
    await settle();
    p.send({ type: 'supporter' });
    p.send({ type: 'supporter' });
    await settle();
    assert.equal(p.fetches.length, 1);
    assert.match(p.toasts[0], /connected to your Supporter account/);
    p.send({ type: 'supporter' }, {});
    await settle();
    assert.equal(p.fetches.length, 1, 'other windows are ignored');
  });
}
