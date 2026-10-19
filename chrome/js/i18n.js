/*
Module: i18n
Purpose: Resolve the display language and share catalog lookup across extension contexts.

Inputs:
- Validated uiLocale sync preferences, packaged catalogs, native i18n, and internal catalog replies.

Outputs:
- Localized strings, active BCP 47 language, and message-only catalog snapshots.

Side Effects:
- Fetches private packaged files in extension contexts and sends internal messages from content scripts.
- Watches sync preferences; caches at most the four supported catalogs and notifies subscribers.

Failure Modes:
- Invalid preferences use Auto; unavailable catalogs use English, native messages, or caller text.
- Revision checks discard stale loads; failed content requests can retry on the next user action.

Security Notes:
- Locale paths come only from a fixed list; content scripts never fetch extension resources.
- Catalog strings remain text; callers retain their existing escaping and sanitization.
*/
(() => {
  if (globalThis.TsukeruI18n) return;
  const locales = Object.freeze({
    en: Object.freeze({ lang: 'en', name: 'English', home: '' }),
    ja: Object.freeze({ lang: 'ja', name: '日本語', home: '/jp' }),
    ko: Object.freeze({ lang: 'ko', name: '한국어', home: '/ko' }),
    zh_TW: Object.freeze({ lang: 'zh-TW', name: '繁體中文', home: '/zh-hant' }),
  });
  const api = globalThis.chrome || globalThis.browser;
  const subscribers = new Set();
  const files = new Map();
  let mode = '';
  let preference = '';
  let revision = 0;
  let snapshot = null;
  let loading = Promise.resolve();
  let initial;
  let contentRequest;

  const normalize = value => typeof value === 'string' && Object.hasOwn(locales, value) ? value : '';
  const native = (key, substitutions) => api?.i18n?.getMessage?.(key, substitutions) || '';
  function autoLocale() {
    const tag = native('ui_lang');
    return Object.keys(locales).find(code => locales[code].lang === tag) || 'en';
  }
  function format(template, substitutions) {
    const values = Array.isArray(substitutions) ? substitutions : substitutions == null ? [] : [substitutions];
    return String(template || '').replace(/\$\$|\$([1-9])/g, (token, index) =>
      token === '$$' ? '$' : String(values[Number(index) - 1] ?? ''));
  }
  function t(key, substitutions, fallback = '') {
    if (!snapshot) return native(key, substitutions) || format(fallback, substitutions);
    return format(snapshot.messages[key] || snapshot.english[key] || fallback, substitutions);
  }
  function language() {
    return t('ui_lang', undefined, 'en');
  }
  function messagesOnly(catalog) {
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(catalog || {})) {
      if (typeof entry?.message === 'string') result[key] = entry.message;
    }
    return result;
  }
  function fetchCatalog(code) {
    if (!files.has(code)) {
      const request = fetch(api.runtime.getURL(`_locales/${code}/messages.json`))
        .then(response => {
          if (!response.ok) throw new Error('catalog unavailable');
          return response.json();
        }).then(messagesOnly).catch(() => {
          files.delete(code);
          console.warn('Tsukeru: could not load a UI catalog');
          return Object.create(null);
        });
      files.set(code, request);
    }
    return files.get(code);
  }
  function select(value) {
    preference = normalize(value);
    const version = ++revision;
    const locale = preference || autoLocale();
    loading = Promise.all([fetchCatalog(locale), fetchCatalog('en')]).then(([messages, english]) => {
      if (version !== revision) return;
      snapshot = { preference, locale, messages, english };
      for (const subscriber of subscribers) subscriber();
    });
    return loading;
  }
  function listen() {
    api?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'sync' || !changes.uiLocale) return;
      const next = normalize(changes.uiLocale.newValue);
      if (mode === 'extension') {
        if (!snapshot || next !== preference) select(next);
      } else {
        const used = Boolean(snapshot || contentRequest);
        preference = next;
        revision += 1;
        snapshot = null;
        if (used) void ready();
      }
    });
  }
  function initExtension() {
    if (initial) return initial;
    mode = 'extension';
    listen();
    const version = revision;
    initial = api.storage.sync.get('uiLocale').then(stored => {
      if (version === revision) return select(stored.uiLocale);
    }).catch(() => {
      console.warn('Tsukeru: could not read the UI language');
      if (version === revision) return select('');
    });
    return initial;
  }
  function initContent() {
    if (mode) return;
    mode = 'content';
    listen();
  }
  function validSnapshot(value) {
    return value && Object.hasOwn(locales, value.locale)
      && normalize(value.preference) === value.preference
      && [value.messages, value.english].every(catalog => catalog && typeof catalog === 'object'
        && !Array.isArray(catalog) && Object.values(catalog).every(text => typeof text === 'string'));
  }
  async function ready() {
    if (mode !== 'content') {
      await initExtension();
      let pending;
      do { pending = loading; await pending; } while (pending !== loading);
      return;
    }
    while (!snapshot) {
      const version = revision;
      if (!contentRequest || contentRequest.version !== version) {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('catalog timeout')), 3000);
        });
        const promise = Promise.race([api.runtime.sendMessage({ action: 'getUiCatalog' }), timeout])
          .then(reply => {
            if (!reply?.success || !validSnapshot(reply.catalog)) throw new Error('invalid catalog');
            if (version === revision) {
              snapshot = reply.catalog;
              preference = snapshot.preference;
            }
          }).catch(() => console.warn('Tsukeru: could not receive the UI catalog'))
          .finally(() => { clearTimeout(timer); });
        contentRequest = { version, promise };
      }
      const request = contentRequest;
      await request.promise;
      if (version !== revision) continue;
      if (!snapshot) contentRequest = null;
      return;
    }
  }
  async function getCatalog() {
    await ready();
    // A new page request also reconciles a sync event still queued in this context.
    const version = revision;
    try {
      const stored = await api.storage.sync.get('uiLocale');
      if (version === revision && normalize(stored.uiLocale) !== preference) select(stored.uiLocale);
    } catch (_) { /* Keep the already loaded catalog when storage is unavailable. */ }
    await ready();
    return snapshot;
  }
  function websiteUrl(page = '') {
    const code = Object.keys(locales).find(value => locales[value].lang === language()) || 'en';
    const prefix = locales[code].home;
    return `https://www.ezfurigana.com${prefix}${page || (prefix ? '' : '/')}`;
  }
  globalThis.TsukeruI18n = Object.freeze({
    locales, normalize, autoLocale, format, t, language, ready, initExtension, initContent, getCatalog, websiteUrl,
    preference: () => preference,
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
  });
})();
