/*
Module: bg-cache
Purpose: Provide hashing plus IndexedDB/memory caching primitives for background workflows.

Inputs:
- Cache keys, source text, processed HTML, validated localized entries and timestamps.

Outputs:
- SHA-256 hashes and cache hit/miss values.

Side Effects:
- Reuses one recoverable IndexedDB connection for cache reads/writes.
- Mutates bounded in-memory definition cache state.

Failure Modes:
- IndexedDB transaction/open failures return safe null/no-op behavior.
- Crypto API failures propagate from hash operations.

Security Notes:
- Cache contains locally stored derived page text fragments.
- Page-cache TTL and a bounded seven-day translation store limit retention.
*/
// IndexedDB page-cache and in-memory definition cache for the service worker.

const IDB_NAME = 'tsukeru-cache';
const IDB_STORE = 'furigana';
const TRANSLATION_STORE = 'translations';
const TRANSLATION_TTL = 7 * 24 * 60 * 60 * 1000;
const TRANSLATION_MAX_ENTRIES = 500;
const IDB_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let cacheDb = null;
let cacheDbPromise = null;

export async function sha256Hash(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function resetCacheDB(db) {
  if (!db || cacheDb !== db) return;
  cacheDb = null;
  cacheDbPromise = null;
  try { db.close(); } catch (_) { /* already closed */ }
}

function openCacheDB() {
  if (cacheDb) return Promise.resolve(cacheDb);
  if (cacheDbPromise) return cacheDbPromise;

  let opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(TRANSLATION_STORE)) db.createObjectStore(TRANSLATION_STORE);
    };
    req.onsuccess = (event) => {
      const db = event.target.result;
      cacheDb = db;
      db.onversionchange = () => resetCacheDB(db);
      db.onclose = () => resetCacheDB(db);
      if (cacheDbPromise === opening) cacheDbPromise = null;
      resolve(db);
    };
    req.onerror = (event) => {
      if (cacheDbPromise === opening) cacheDbPromise = null;
      reject(event.target.error);
    };
  });
  cacheDbPromise = opening;
  return opening;
}

async function deleteExpiredCacheEntry(key) {
  try {
    const db = await openCacheDB();
    await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const request = store.get(key);
        request.onsuccess = () => {
          const current = request.result;
          if (current && Date.now() - current.timestamp > IDB_CACHE_TTL) store.delete(key);
        };
        request.onerror = () => resetCacheDB(db);
        tx.oncomplete = resolve;
        tx.onerror = () => { resetCacheDB(db); resolve(); };
        tx.onabort = () => { resetCacheDB(db); resolve(); };
      } catch (_) {
        resetCacheDB(db);
        resolve();
      }
    });
  } catch (_) { /* expired cleanup is a nonfatal cache optimization */ }
}

export async function cacheGet(key) {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      let tx;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        tx = db.transaction(IDB_STORE, 'readonly');
      } catch (_) {
        resetCacheDB(db);
        finish(null);
        return;
      }
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry) return finish(null);
        if (Date.now() - entry.timestamp > IDB_CACHE_TTL) {
          finish(null);
          void deleteExpiredCacheEntry(key);
          return;
        }
        finish(entry.html);
      };
      req.onerror = () => { resetCacheDB(db); finish(null); };
      tx.onerror = () => { resetCacheDB(db); finish(null); };
      tx.onabort = () => { resetCacheDB(db); finish(null); };
    });
  } catch { return null; }
}

export async function cacheSet(key, html) {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(IDB_STORE, 'readwrite');
      } catch (_) {
        resetCacheDB(db);
        resolve();
        return;
      }
      tx.objectStore(IDB_STORE).put({ html, timestamp: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => { resetCacheDB(db); resolve(); };
      tx.onabort = () => { resetCacheDB(db); resolve(); };
    });
  } catch { /* ignore */ }
}

export const definitionCache = new Map();
export const DEFINITION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function localizedCacheGet(key) {
  try {
    const db = await openCacheDB();
    return await new Promise(resolve => {
      const tx = db.transaction(TRANSLATION_STORE, 'readonly');
      const request = tx.objectStore(TRANSLATION_STORE).get(key);
      request.onsuccess = () => {
        const entry = request.result;
        resolve(entry && Date.now() - entry.timestamp < TRANSLATION_TTL ? entry.data : null);
      };
      request.onerror = tx.onerror = tx.onabort = () => resolve(null);
    });
  } catch (_) { return null; }
}

export async function localizedCacheSet(key, data) {
  try {
    const db = await openCacheDB();
    await new Promise(resolve => {
      const tx = db.transaction(TRANSLATION_STORE, 'readwrite');
      const store = tx.objectStore(TRANSLATION_STORE);
      store.put({ data, timestamp: Date.now() }, key);
      const entries = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) {
          if (Date.now() - item.value.timestamp >= TRANSLATION_TTL) item.delete();
          else entries.push({ key: item.key, timestamp: item.value.timestamp });
          item.continue();
        } else {
          entries.sort((a, b) => a.timestamp - b.timestamp);
          entries.slice(0, Math.max(0, entries.length - TRANSLATION_MAX_ENTRIES))
            .forEach(entry => store.delete(entry.key));
        }
      };
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch (_) { /* Persistent translation caching is optional. */ }
}
