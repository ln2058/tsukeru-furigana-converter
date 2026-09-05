import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get(name) { return headers[name] || headers[name.toLowerCase()] || ''; } },
    async json() {
      if (body === Symbol.for('invalid-json')) throw new Error('invalid json');
      return body;
    },
  };
}

function loadApi(browserName, route, { cacheLimit = 200 } = {}) {
  const apiUrl = new URL(`../${browserName}/js/bg-api.js`, import.meta.url);
  let source = readFileSync(apiUrl, 'utf8')
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+'\.\/bg-cache\.js';\s*/m, '')
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+'\.\/utils\.js';\s*/m, '')
    .replace(/^export\s+/gm, '');
  source = source.replace(
    'const BACKGROUND_DEFINITION_CACHE_MAX_ENTRIES = 200;',
    `const BACKGROUND_DEFINITION_CACHE_MAX_ENTRIES = ${cacheLimit};`
  );
  source = `
    const definitionCache = new Map();
    const DEFINITION_CACHE_TTL = 300000;
    async function sha256Hash() { return 'hash'; }
    async function cacheGet() { return null; }
    async function cacheSet() {}
    function kata2hira(value) { return value || ''; }
  ${source}
    globalThis.__api = {
      lookupDefinition,
      fetchExampleSentence,
      fetchKanjiBreakdown,
      normalizeDefinitionLookupArgs,
      getDefinitionCacheKey,
      requestExtensionJson,
    };
  `;
  const calls = [];
  const sandbox = {
    console: { info() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => `${browserName}-session` },
    URL,
    fetch: (url, options) => {
      calls.push({ url: String(url), options });
      return Promise.resolve(route(new URL(String(url)), options));
    },
  };
  vm.runInNewContext(source, sandbox, { filename: apiUrl.pathname });
  return { api: sandbox.__api, calls };
}

function queuedRoute(nonNonceResponses, nonceResponses = [response(200, { nonce: 'nonce-1', expires_in: 600 })]) {
  return (url) => {
    if (url.pathname === '/api/extension/nonce') return nonceResponses.shift() || response(500, { error: 'missing nonce fixture' });
    return nonNonceResponses.shift() || response(500, { error: 'missing response fixture' });
  };
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} validates lookup arguments and builds reading-aware requests`, async () => {
    const { api, calls } = loadApi(browserName, queuedRoute([
      response(200, { entries: [{ kana: ['たべる'], senses: [] }] })
    ]));

    assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeDefinitionLookupArgs(' 食べる ', ' たべる ', 'HIRAGANA'))), {
      word: '食べる', reading: 'たべる', readingType: 'hiragana'
    });
    assert.notEqual(api.getDefinitionCacheKey('行く', 'いく', 'hiragana'), api.getDefinitionCacheKey('行く', 'ゆく', 'hiragana'));
    await api.lookupDefinition(' 食べる ', 'たべる', 'hiragana');

    const request = new URL(calls.find(({ url }) => url.includes('/word-definition?')).url);
    assert.equal(request.searchParams.get('word'), '食べる');
    assert.equal(request.searchParams.get('reading'), 'たべる');
    assert.equal(request.searchParams.get('reading_type'), 'hiragana');
    assert.equal(request.searchParams.get('ext_nonce'), 'nonce-1');
    assert.equal(calls[1].options.headers['x-extension-session-id'], `${browserName}-session`);

    const before = calls.length;
    for (const args of [[{}, undefined, undefined], ['x'.repeat(65), undefined, undefined], ['x', {}, undefined], ['x', 'い', 'kanji']]) {
      assert.throws(() => api.normalizeDefinitionLookupArgs(...args));
    }
    assert.equal(calls.length, before, 'malformed arguments are rejected before fetching');
  });

  test(`${browserName} keeps cache identity separate for different readings and accepts empty definitions`, async () => {
    const { api, calls } = loadApi(browserName, queuedRoute([
      response(200, { entries: [] }),
      response(200, { entries: [{ kana: ['ゆく'], senses: [] }] })
    ]));
    await api.lookupDefinition('行く', 'いく', 'hiragana');
    await api.lookupDefinition('行く', 'いく', 'hiragana');
    await api.lookupDefinition('行く', 'ゆく', 'hiragana');
    assert.equal(calls.filter(({ url }) => url.includes('/word-definition?')).length, 2);
  });

  test(`${browserName} shares identical pending lookups and retries after rejection`, async () => {
    let definitionCalls = 0;
    let rejectFirst;
    const firstResponse = new Promise((_, reject) => { rejectFirst = reject; });
    const fixture = loadApi(browserName, (url) => {
      if (url.pathname === '/api/extension/nonce') return response(200, { nonce: 'nonce-1', expires_in: 600 });
      if (url.pathname === '/api/extension/word-definition') {
        definitionCalls += 1;
        return definitionCalls === 1 ? firstResponse : response(200, { entries: [] });
      }
      return response(500, { error: 'unexpected request' });
    });

    const first = fixture.api.lookupDefinition('猫', 'ねこ', 'hiragana');
    const second = fixture.api.lookupDefinition('猫', 'ねこ', 'hiragana');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(definitionCalls, 1);

    rejectFirst(new Error('temporary lookup failure'));
    await assert.rejects(first, /API request failed/);
    await assert.rejects(second, /API request failed/);

    await fixture.api.lookupDefinition('猫', 'ねこ', 'hiragana');
    assert.equal(definitionCalls, 2);
  });

  test(`${browserName} evicts the oldest completed definition result`, async () => {
    const fixture = loadApi(browserName, queuedRoute([
      response(200, { entries: [] }),
      response(200, { entries: [] }),
      response(200, { entries: [] }),
      response(200, { entries: [] }),
    ]), { cacheLimit: 2 });

    await fixture.api.lookupDefinition('一', 'いち', 'hiragana');
    await fixture.api.lookupDefinition('二', 'に', 'hiragana');
    await fixture.api.lookupDefinition('三', 'さん', 'hiragana');
    assert.equal(fixture.calls.filter(({ url }) => url.includes('/word-definition?')).length, 3);

    await fixture.api.lookupDefinition('一', 'いち', 'hiragana');
    assert.equal(fixture.calls.filter(({ url }) => url.includes('/word-definition?')).length, 4);
  });

  test(`${browserName} retries one recognized nonce failure and stops after retry exhaustion`, async () => {
    const retryFixture = loadApi(browserName, queuedRoute([
      response(403, { error: 'Invalid or expired nonce' }),
      response(200, { entries: [] })
    ], [
      response(200, { nonce: 'nonce-1', expires_in: 600 }),
      response(200, { nonce: 'nonce-2', expires_in: 600 })
    ]));
    await retryFixture.api.lookupDefinition('猫', 'ねこ', 'hiragana');
    assert.equal(retryFixture.calls.filter(({ url }) => url.includes('/word-definition?')).length, 2);
    assert.equal(retryFixture.calls.filter(({ url }) => url.endsWith('/api/extension/nonce')).length, 2);
    assert.equal(new URL(retryFixture.calls[3].url).searchParams.get('ext_nonce'), 'nonce-2');

    const exhausted = loadApi(browserName, queuedRoute([
      response(403, { detail: 'Nonce required' }),
      response(403, { detail: 'Nonce required' })
    ], [
      response(200, { nonce: 'nonce-1', expires_in: 600 }),
      response(200, { nonce: 'nonce-2', expires_in: 600 })
    ]));
    await assert.rejects(() => exhausted.api.lookupDefinition('犬', 'いぬ', 'hiragana'), /Nonce required/);
    assert.equal(exhausted.calls.filter(({ url }) => url.includes('/word-definition?')).length, 2);
    assert.equal(exhausted.calls.filter(({ url }) => url.endsWith('/api/extension/nonce')).length, 2);
  });

  test(`${browserName} preserves nonce rate-limit metadata and does not retry generic rate/auth failures`, async () => {
    const refreshLimited = loadApi(browserName, queuedRoute([
      response(403, { error: 'Invalid or expired nonce' })
    ], [
      response(200, { nonce: 'nonce-1', expires_in: 600 }),
      response(429, { error: 'Nonce rate limited', rate_limit_type: 'nonce' }, { 'Retry-After': '12' })
    ]));
    await assert.rejects(
      () => refreshLimited.api.lookupDefinition('鳥', 'とり', 'hiragana'),
      (error) => error.status === 429 && error.rateLimitType === 'nonce' && error.retryAfter === 12
    );
    assert.equal(refreshLimited.calls.filter(({ url }) => url.includes('/word-definition?')).length, 1);

    for (const [status, body] of [[403, { error: 'Forbidden' }], [500, { error: 'Server error' }], [429, { error: 'Too many', rate_limit_type: 'dictionary' }]]) {
      const fixture = loadApi(browserName, queuedRoute([response(status, body)]));
      await assert.rejects(() => fixture.api.lookupDefinition('空', 'そら', 'hiragana'));
      assert.equal(fixture.calls.filter(({ url }) => url.includes('/word-definition')).length, 1);
      assert.equal(fixture.calls.filter(({ url }) => url.includes('/api/word-definition/')).length, 0);
    }
  });

  test(`${browserName} only uses the legacy dictionary route for 404 or 405`, async () => {
    for (const status of [404, 405]) {
      const fixture = loadApi(browserName, queuedRoute([
        response(status, { error: 'route unavailable' }),
        response(200, { entries: [] })
      ]));
      await fixture.api.lookupDefinition('見る', 'みる', 'hiragana');
      const legacy = fixture.calls.find(({ url }) => url.includes('/api/word-definition/'));
      assert.ok(legacy);
      const legacyUrl = new URL(legacy.url);
      assert.equal(legacyUrl.searchParams.get('reading'), 'みる');
      assert.equal(legacyUrl.searchParams.get('reading_type'), 'hiragana');
    }
  });

  test(`${browserName} uses the same nonce/session JSON helper for enrichment endpoints`, async () => {
    const fixture = loadApi(browserName, queuedRoute([
      response(200, { japanese: '猫です' }),
      response(200, { characters: [] })
    ]));
    await fixture.api.fetchExampleSentence('猫');
    await fixture.api.fetchKanjiBreakdown('猫');
    const enrichmentCalls = fixture.calls.filter(({ url }) => url.includes('/api/example-sentence/') || url.includes('/api/kanji-breakdown/'));
    assert.equal(enrichmentCalls.length, 2);
    for (const call of enrichmentCalls) {
      assert.equal(new URL(call.url).searchParams.get('ext_nonce'), 'nonce-1');
      assert.equal(call.options.headers['x-extension-session-id'], `${browserName}-session`);
    }
  });

  test(`${browserName} shares concurrent nonce refresh`, async () => {
    const concurrent = loadApi(browserName, queuedRoute([
      response(403, { error: 'Invalid or expired nonce' }),
      response(403, { error: 'Invalid or expired nonce' }),
      response(200, { entries: [] }),
      response(200, { entries: [] })
    ], [
      response(200, { nonce: 'nonce-1', expires_in: 600 }),
      response(200, { nonce: 'nonce-2', expires_in: 600 })
    ]));
    await Promise.all([
      concurrent.api.lookupDefinition('上', 'うえ', 'hiragana'),
      concurrent.api.lookupDefinition('下', 'した', 'hiragana')
    ]);
    assert.equal(concurrent.calls.filter(({ url }) => url.endsWith('/api/extension/nonce')).length, 2);
  });
}
