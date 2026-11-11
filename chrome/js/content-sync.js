/*
Module: content-sync
Purpose: Keep My Words in step with EZFurigana while one of its pages is open: send the words changed in the extension to the page, then hand the page's full record list to the background store. Also collect a signed-in Supporter's extension token for the background.

Inputs:
- Window messages from the EZFurigana page on this origin (ready with its store id, changed, snapshot, and supporter once checkout has activated Supporter).
- A `?tsukeru=connect` page address (the popup's Connect button and the checkout success page).
- Outbox and merge responses from the background store, and local word changes from `chrome.storage.onChanged`.

Outputs:
- Hello and push messages posted to this window for the page's sync module.
- `wordsSyncStart` and `wordsSyncFinish` runtime messages to the background store.
- `supporterRefreshDue` and `supporterHandoff` runtime messages with the website's Supporter answer.

Side Effects:
- Adds one window message listener and one storage change listener on EZFurigana pages only.
- While signed in, POSTs to the website's own /api/extension/supporter-token (daily for Supporters, at most once a minute otherwise) with its CSRF cookie (the only request this script makes). A `?tsukeru=connect` address, the page's supporter message, or a changed sign-in cookie (seen on load, focus, or when the tab becomes visible) asks right away, at most once every few seconds.

Failure Modes:
- Without an answer from the page, an exchange gives up after a timeout and nothing is merged.
- Messages from other windows, origins, sources, or protocol versions are ignored.
- A failed or refused Supporter request changes nothing; the next visit tries again.
- If the sign-in cookie cannot be hashed or tab storage is blocked, account-change detection is skipped and the usual visit-time check still runs.

Security Notes:
- Runs only on https://www.ezfurigana.com pages (manifest match) and posts only to that origin.
- Word sync carries only words, readings, states, schedule times, and short sentences from the reader's lists; nothing is sent to a server.
- Only a SHA-256 digest of the CSRF cookie is kept (tab session storage) to notice an account change; the cookie itself is never stored or posted.
- The Supporter token goes straight to the background and is never posted to the page window.
*/
(function startWordSync() {
  if (window.location.origin !== 'https://www.ezfurigana.com') return;
  if (window.__TSUKERU_WORD_SYNC__) return;
  window.__TSUKERU_WORD_SYNC__ = true;

  const PROTOCOL = 1;
  const EXCHANGE_TIMEOUT_MS = 15000;
  const CHANGE_DELAY_MS = 300;

  let pageReady = false;
  let storeId = null;
  let exchange = null;
  let runAgain = false;
  let timer = null;

  function post(message) {
    window.postMessage({ source: 'tsukeru', protocol: PROTOCOL, ...message }, window.location.origin);
  }

  function schedule(delay = CHANGE_DELAY_MS) {
    clearTimeout(timer);
    timer = setTimeout(runExchange, delay);
  }

  function endExchange() {
    if (exchange?.timeout) clearTimeout(exchange.timeout);
    exchange = null;
    if (runAgain) {
      runAgain = false;
      schedule();
    }
  }

  async function runExchange() {
    if (!pageReady || !chrome.runtime?.id) return;
    if (exchange) {
      runAgain = true;
      return;
    }
    exchange = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, startedAt: 0, timeout: null };
    try {
      const outbox = await chrome.runtime.sendMessage({ action: 'wordsSyncStart', storeId });
      if (!outbox?.success) throw new Error('The word store did not answer');
      exchange.startedAt = outbox.startedAt;
      exchange.timeout = setTimeout(endExchange, EXCHANGE_TIMEOUT_MS);
      post({ type: 'push', exchangeId: exchange.id, changes: outbox.changes, removed: outbox.removed });
    } catch (error) {
      console.warn('Tsukeru: word sync could not start', error?.message);
      endExchange();
    }
  }

  async function finishExchange(data) {
    if (!exchange || !exchange.startedAt || data.exchangeId !== exchange.id || !Array.isArray(data.records)) return;
    const { startedAt } = exchange;
    try {
      await chrome.runtime.sendMessage({
        action: 'wordsSyncFinish',
        startedAt,
        storeId: typeof data.storeId === 'string' ? data.storeId : null,
        records: data.records,
      });
    } catch (error) {
      console.warn('Tsukeru: word sync could not finish', error?.message);
    } finally {
      endExchange();
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'ezfurigana' || data.protocol !== PROTOCOL) return;
    if (data.type === 'ready') {
      storeId = typeof data.storeId === 'string' ? data.storeId : null;
      pageReady = true;
      schedule(0);
    } else if (data.type === 'changed') {
      schedule();
    } else if (data.type === 'snapshot') {
      finishExchange(data);
    } else if (data.type === 'supporter') {
      // The page saw Supporter activate (checkout) or the account change after this page loaded.
      askNow();
    }
  });

  // Words marked in other tabs while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !pageReady) return;
    if (Object.keys(changes).some((key) => key.startsWith('w:') || key.startsWith('wr:'))) schedule();
  });

  const FORCED_REFRESH_GAP_MS = 5000;
  const FINGERPRINT_KEY = 'tsukeru:account';
  let lastForcedAt = 0;
  let refreshing = false;

  // Signed-in pages carry the CSRF cookie; without it there is no account to ask about.
  function csrfCookie() {
    const cookie = document.cookie.split('; ').find((part) => part.startsWith('ez_csrf_token='));
    return cookie ? decodeURIComponent(cookie.slice('ez_csrf_token='.length)) : '';
  }

  // A digest of the sign-in cookie, so a different account is noticed without keeping the cookie.
  async function accountFingerprint() {
    const value = csrfCookie();
    if (!value) return '';
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch (_) { return ''; }
  }

  function readFingerprint() {
    try { return sessionStorage.getItem(FINGERPRINT_KEY) || ''; } catch (_) { return ''; }
  }

  function writeFingerprint(value) {
    try { sessionStorage.setItem(FINGERPRINT_KEY, value); } catch (_) { /* detection is skipped */ }
  }

  // Skip the recheck wait, but not more than once every few seconds.
  function askNow() {
    const now = Date.now();
    if (refreshing || now - lastForcedAt < FORCED_REFRESH_GAP_MS) return;
    lastForcedAt = now;
    refreshSupporterToken({ now: true }).catch((error) => console.warn('Tsukeru: Supporter check failed', error?.message));
  }

  // Signing in as another account changes the cookie; ask again when the tab is back in view.
  async function checkAccountChanged() {
    const fingerprint = await accountFingerprint();
    const known = readFingerprint();
    if (fingerprint && known && fingerprint !== known) askNow();
  }

  // Asked to connect (the popup's Connect button or a finished checkout): skip the recheck wait.
  // The address is cleaned once read, so a reload or later visit does not repeat the confirmation.
  function connectAsked() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('tsukeru') !== 'connect') return false;
      try {
        params.delete('tsukeru');
        const query = params.toString();
        history.replaceState(history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
      } catch (_) { /* the confirmation may repeat on reload */ }
      return true;
    } catch (_) { return false; }
  }
  let connectRequested = false;

  async function refreshSupporterToken({ now = false } = {}) {
    const csrf = csrfCookie();
    if (!csrf || !chrome.runtime?.id || refreshing) return;
    refreshing = true;
    try {
      await requestSupporterToken(csrf, now);
    } finally {
      refreshing = false;
    }
  }

  async function requestSupporterToken(csrf, now) {
    const fingerprint = await accountFingerprint();
    // A different sign-in cookie since this tab last asked means another account.
    const known = readFingerprint();
    if (fingerprint && known && fingerprint !== known) now = true;
    // Everything but the user's own Connect asks the extension first; a disconnected browser stays so.
    const explicit = connectRequested;
    if (!explicit) {
      const due = await chrome.runtime.sendMessage({ action: 'supporterRefreshDue', forced: now });
      if (!due?.success || !due.due) {
        if (fingerprint) writeFingerprint(fingerprint);
        return;
      }
    }
    // Chrome content-script fetches run as the page, so they carry the site's cookies.
    const pageFetch = fetch;
    const response = await pageFetch(`${window.location.origin}/api/extension/supporter-token`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-CSRF-Token': csrf },
    });
    if (!response.ok) return;
    const body = await response.json();
    const stored = await chrome.runtime.sendMessage({
      action: 'supporterHandoff',
      plan: body?.plan,
      token: body?.token,
      expiresAt: body?.expires_at,
      connect: explicit,
    });
    if (fingerprint) writeFingerprint(fingerprint);
    // Only a real change of connection, or the user's own Connect click, is worth a message.
    // Rechecks after focus or a cookie rotation stay quiet when nothing changed.
    const asked = connectRequested;
    connectRequested = false;
    confirmConnection(stored, asked);
  }

  // A new connection (or the popup's Connect button) gets a short confirmation.
  function confirmConnection(stored, asked) {
    if (!stored?.success || (!stored.changed && !asked) || typeof showToast !== 'function') return;
    const message = stored.plan === 'supporter'
      ? TsukeruI18n.t('supporter_connected_toast', undefined, 'Tsukeru is connected to your Supporter account. Sentence audio is on.')
      : TsukeruI18n.t('supporter_connected_free_toast', undefined, 'Tsukeru is connected. This account is on the Free plan, so sentence audio stays off.');
    showToast(message, { type: 'info', duration: 7000 });
  }

  window.addEventListener('focus', () => { checkAccountChanged(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkAccountChanged();
  });

  post({ type: 'hello' });
  connectRequested = connectAsked();
  refreshSupporterToken({ now: connectRequested }).catch((error) => console.warn('Tsukeru: Supporter check failed', error?.message));
})();
