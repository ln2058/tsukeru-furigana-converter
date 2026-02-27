/*
Module: bg-cache
Purpose: Provide hashing plus IndexedDB/memory caching primitives for background workflows.

Inputs:
- Cache keys, source text, processed HTML, and timestamps.

Outputs:
- SHA-256 hashes and cache hit/miss values.

Side Effects:
- Opens IndexedDB and reads/writes cache entries.
- Mutates in-memory definition cache map.

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
const IDB_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function sha256Hash(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => { e.target.result.createObjectStore(IDB_STORE); };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function cacheGet(key) {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry || Date.now() - entry.timestamp > IDB_CACHE_TTL) return resolve(null);
        resolve(entry.html);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function cacheSet(key, html) {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ html, timestamp: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* ignore */ }
}

export const definitionCache = new Map();
export const DEFINITION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
