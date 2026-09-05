/*
Module: bg-cache
Purpose: Provide hashing plus IndexedDB/memory caching primitives for background workflows.

Inputs:
- Cache keys, source text, processed HTML, and timestamps.

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
- TTL limits retention of cached data.
*/
// IndexedDB page-cache and in-memory definition cache for the service worker.

const IDB_NAME = 'tsukeru-cache';
const IDB_STORE = 'furigana';
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
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
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
