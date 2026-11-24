/*
Module: page-captions
Purpose: Runs in the page itself (not the extension's isolated world) on YouTube (including its players embedded on other sites) and Netflix, and passes the Japanese subtitle file the site's own player downloads to Tsukeru's content script, so upcoming lines can get furigana before they show.

Inputs:
- Responses to the player's own requests: YouTube's `/api/timedtext` (`fmt=json3`, Japanese tracks only) and Netflix's TTML subtitle files (an XML `<tt>` document in Japanese).

Outputs:
- One `window.postMessage` per subtitle file to this window's own origin: `{ source: 'tsukeru-page-captions', kind, track, body }`, where `kind` is `youtube-json3` or `netflix-ttml`, `track` names the video and language only, and `body` is the file's text.

Side Effects:
- Wraps `XMLHttpRequest.prototype.open`/`send` and `window.fetch` to read matching responses after the player has them. Requests are never changed, delayed, or repeated.

Failure Modes:
- Responses that cannot be read (opaque, too large, another format) are ignored; the content script then adds furigana to each line as it shows.
- A site that changes how it loads subtitles stops this capture without breaking playback.

Security Notes:
- Never sends data anywhere: it only posts to the same window, where the page could read it anyway. Request addresses, tokens and cookies are not passed on.
- The content script treats every posted message as untrusted page data and validates its shape and size.
*/
(() => {
  if (window.__tsukeruPageCaptions) return;
  window.__tsukeruPageCaptions = true;

  const SOURCE = 'tsukeru-page-captions';
  const MAX_BODY_CHARS = 4 * 1024 * 1024;
  const youtube = /(^|\.)youtube\.com$/.test(location.hostname);
  const netflix = /(^|\.)netflix\.com$/.test(location.hostname);
  if (!youtube && !netflix) return;

  function parseUrl(value) {
    try {
      return new URL(String(value), location.href);
    } catch (_) {
      return null;
    }
  }

  /** What a request is: a Japanese YouTube track, a possible Netflix subtitle file, or nothing. */
  function classify(value) {
    const url = parseUrl(value);
    if (!url) return null;
    if (youtube && url.pathname === '/api/timedtext' && url.searchParams.get('fmt') === 'json3') {
      const lang = url.searchParams.get('tlang') || url.searchParams.get('lang') || '';
      if (!/^ja\b/i.test(lang)) return null;
      return {
        kind: 'youtube-json3',
        track: {
          video: url.searchParams.get('v') || '',
          lang,
          auto: url.searchParams.get('kind') === 'asr',
        },
      };
    }
    // Netflix serves subtitle files from its video hosts; the body decides.
    if (netflix && /(^|\.)nflxvideo\.net$/.test(url.hostname)) return { kind: 'netflix-ttml', track: { video: '', lang: 'ja' } };
    return null;
  }

  function looksLikeJapaneseTtml(text) {
    const head = text.slice(0, 4000);
    return /^\s*(<\?xml[^>]*>\s*)?<tt[\s>]/.test(head) && /xml:lang="ja/i.test(head);
  }

  function post(match, body) {
    if (typeof body !== 'string' || !body || body.length > MAX_BODY_CHARS) return;
    if (match.kind === 'netflix-ttml' && !looksLikeJapaneseTtml(body)) return;
    if (netflix) {
      const id = location.pathname.match(/^\/watch\/(\d+)/);
      match.track.video = id ? id[1] : '';
    }
    try {
      window.postMessage({ source: SOURCE, kind: match.kind, track: match.track, body }, location.origin);
    } catch (_) { /* Nothing to pass on. */ }
  }

  function decode(buffer) {
    // A subtitle file is small; skip anything that could not be one.
    if (!buffer || buffer.byteLength > MAX_BODY_CHARS) return '';
    try {
      return new TextDecoder('utf-8').decode(buffer);
    } catch (_) {
      return '';
    }
  }

  const requests = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function tsukeruOpen(method, url, ...rest) {
    try {
      const match = classify(url);
      if (match) requests.set(this, match);
      else requests.delete(this);
    } catch (_) { /* Never get in the player's way. */ }
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function tsukeruSend(...args) {
    const match = requests.get(this);
    if (match) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const type = this.responseType;
          if (type === '' || type === 'text') post(match, this.responseText);
          else if (type === 'arraybuffer') post(match, decode(this.response));
          else if (type === 'json' && this.response) post(match, JSON.stringify(this.response));
        } catch (_) { /* Ignored; lines get furigana as they show. */ }
      }, { once: true });
    }
    return send.apply(this, args);
  };

  const pageFetch = window.fetch;
  if (typeof pageFetch === 'function') {
    window.fetch = function tsukeruFetch(input, init) {
      const result = pageFetch.apply(this, arguments);
      try {
        const match = classify(typeof input === 'string' ? input : input?.url);
        if (match) {
          result.then((response) => {
            if (!response?.ok) return;
            const length = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(length) && length > MAX_BODY_CHARS) return;
            response.clone().text().then((body) => post(match, body)).catch(() => {});
          }).catch(() => {});
        }
      } catch (_) { /* Never get in the player's way. */ }
      return result;
    };
  }
})();
