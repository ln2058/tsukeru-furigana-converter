/*
Module: content-sync
Purpose: Keep My Words in step with EZFurigana while one of its pages is open: send the words changed in the extension to the page, then hand the page's full record list to the background store. Also collect a signed-in Supporter's extension token for the background.

Inputs:
- Window messages from the EZFurigana page on this origin (ready with its store id, changed, and snapshot).
- Outbox and merge responses from the background store, and local word changes from `chrome.storage.onChanged`.

Outputs:
- Hello and push messages posted to this window for the page's sync module.
- `wordsSyncStart` and `wordsSyncFinish` runtime messages to the background store.
- `supporterRefreshDue` and `supporterHandoff` runtime messages with the website's Supporter answer.

Side Effects:
- Adds one window message listener and one storage change listener on EZFurigana pages only.
- While signed in, POSTs to the website's own /api/extension/supporter-token (daily for Supporters, at most once a minute otherwise) with its CSRF cookie (the only request this script makes).

Failure Modes:
- Without an answer from the page, an exchange gives up after a timeout and nothing is merged.
- Messages from other windows, origins, sources, or protocol versions are ignored.
- A failed or refused Supporter request changes nothing; the next visit tries again.

Security Notes:
- Runs only on https://www.ezfurigana.com pages (manifest match) and posts only to that origin.
- Word sync carries only words, readings, states, schedule times, and short sentences from the reader's lists; nothing is sent to a server.
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
    }
  });

  // Words marked in other tabs while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !pageReady) return;
    if (Object.keys(changes).some((key) => key.startsWith('w:') || key.startsWith('wr:'))) schedule();
  });

  // Signed-in pages carry the CSRF cookie; without it there is no account to ask about.
  async function refreshSupporterToken() {
    const cookie = document.cookie.split('; ').find((part) => part.startsWith('ez_csrf_token='));
    if (!cookie || !chrome.runtime?.id) return;
    const due = await chrome.runtime.sendMessage({ action: 'supporterRefreshDue' });
    if (!due?.success || !due.due) return;
    // Chrome content-script fetches run as the page, so they carry the site's cookies.
    const pageFetch = fetch;
    const response = await pageFetch(`${window.location.origin}/api/extension/supporter-token`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-CSRF-Token': decodeURIComponent(cookie.slice('ez_csrf_token='.length)) },
    });
    if (!response.ok) return;
    const body = await response.json();
    await chrome.runtime.sendMessage({
      action: 'supporterHandoff',
      plan: body?.plan,
      token: body?.token,
      expiresAt: body?.expires_at,
    });
  }

  post({ type: 'hello' });
  refreshSupporterToken().catch((error) => console.warn('Tsukeru: Supporter check failed', error?.message));
})();
