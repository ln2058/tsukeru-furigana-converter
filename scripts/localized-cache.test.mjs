import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// An asynchronous IDB fixture preserves transaction boundaries and existing stores.
function database() {
  const stores = new Map([['furigana', new Map()]]);
  let version = 1;
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()); },
    close() {},
    transaction(name, mode) {
      const values = stores.get(name);
      if (!values) throw new Error('store missing');
      let pending = 0;
      const tx = { objectStore: () => store };
      function enqueue(fn) {
        pending += 1;
        queueMicrotask(() => {
          fn();
          pending -= 1;
          if (!pending) queueMicrotask(() => { if (!pending) tx.oncomplete?.(); });
        });
      }
      const store = {
        get(key) { const request = {}; enqueue(() => { request.result = values.get(key); request.onsuccess?.(); }); return request; },
        put(value, key) { assert.equal(mode, 'readwrite'); enqueue(() => values.set(key, value)); },
        delete(key) { assert.equal(mode, 'readwrite'); values.delete(key); },
        openCursor() {
          const request = {};
          let entries;
          let index = 0;
          function next() {
            enqueue(() => {
              entries ||= [...values.entries()];
              const entry = entries[index++];
              request.result = entry ? { key: entry[0], value: entry[1], continue: next, delete: () => values.delete(entry[0]) } : null;
              request.onsuccess?.();
            });
          }
          next();
          return request;
        },
      };
      return tx;
    },
  };
  return { stores, indexedDB: { open(_name, requestedVersion) {
    const request = {};
    queueMicrotask(() => {
      request.result = db;
      if (requestedVersion > version) { version = requestedVersion; request.onupgradeneeded?.({ target: request }); }
      request.onsuccess?.({ target: request });
    });
    return request;
  } } };
}

function load(browser, fixture, clock) {
  const source = readFileSync(new URL(`../${browser}/js/bg-cache.js`, import.meta.url), 'utf8').replace(/^export /gm, '');
  const sandbox = { indexedDB: fixture.indexedDB, Date: { now: () => clock.now }, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} translations survive worker restart, expire after seven days and preserve page cache`, async () => {
    const fixture = database();
    const clock = { now: 1000 };
    let cache = load(browser, fixture, clock);
    await cache.cacheSet('page', 'furigana');
    const translated = { source: 'je_localized_cache', locale: 'ko', entry: { gloss: '책' } };
    await cache.localizedCacheSet('ko:book', translated);
    cache = load(browser, fixture, clock);
    assert.equal((await cache.localizedCacheGet('ko:book')).entry.gloss, '책');
    assert.equal(await cache.localizedCacheGet('ja:book'), null);
    assert.equal(await cache.cacheGet('page'), 'furigana');
    clock.now += 7 * 24 * 60 * 60 * 1000;
    assert.equal(await cache.localizedCacheGet('ko:book'), null);
    assert.equal(await cache.cacheGet('page'), null, 'page cache retains its original shorter TTL');
  });

  test(`${browser} translation store prunes expired and oldest entries to its bound`, async () => {
    const fixture = database();
    fixture.stores.set('translations', new Map(Array.from({ length: 501 }, (_, index) => [`key${index}`, { timestamp: index + 1, data: index }])));
    const cache = load(browser, fixture, { now: 10000 });
    await cache.localizedCacheSet('new', { entry: {} });
    assert.equal(fixture.stores.get('translations').size, 500);
    assert.equal(await cache.localizedCacheGet('key0'), null);
    assert.equal(await cache.localizedCacheGet('key1'), null);
    assert.deepEqual(await cache.localizedCacheGet('new'), { entry: {} });
  });
}
