// Purpose: After its hour, the stored Discover feed is checked with its tag, and an unchanged feed is not downloaded again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (browser) => readFileSync(new URL(`../${browser}/js/bg-api.js`, import.meta.url), 'utf8');
const withoutModules = (source) => source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 23, 12);
const FEED = { version: 1, prototype: false, articles: [{ id: 'a1' }] };

function harness(browser, answers) {
  const session = {};
  const requests = [];
  const sandbox = {
    URL,
    console: { info() {}, warn() {}, error() {} },
    normalizeDiscoverFeed: (body) => (body && body.version === 1 ? body : null),
    chrome: {
      runtime: { getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        session: {
          async get(key) { return { [key]: session[key] }; },
          async set(values) { Object.assign(session, values); },
        },
      },
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, ifNoneMatch: options.headers?.['If-None-Match'] || null });
      const answer = answers.shift();
      return {
        ok: answer.status === 200,
        status: answer.status,
        headers: { get: (key) => (key.toLowerCase() === 'etag' ? answer.tag || null : null) },
        async text() { return answer.status === 200 ? JSON.stringify(FEED) : ''; },
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(withoutModules(read(browser)), sandbox);
  return { api: sandbox, requests };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} an unchanged Discover feed is kept after a 304`, async () => {
    const { api, requests } = harness(browser, [{ status: 200, tag: '"0123456789abcdef0123"' }, { status: 304 }]);
    assert.equal((await api.fetchDiscoverFeed(NOW)).articles[0].id, 'a1');
    // Within the hour: the stored copy, no request.
    await api.fetchDiscoverFeed(NOW + HOUR / 2);
    assert.equal(requests.length, 1);
    // After it: the tag goes with the request, and the 304 keeps the stored copy for another hour.
    assert.equal((await api.fetchDiscoverFeed(NOW + HOUR + 1)).articles[0].id, 'a1');
    assert.equal(requests[1].ifNoneMatch, '"0123456789abcdef0123"');
    await api.fetchDiscoverFeed(NOW + HOUR + 2);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].ifNoneMatch, null);
  });
}
