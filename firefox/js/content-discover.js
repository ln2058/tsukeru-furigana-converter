/*
Module: content-discover
Purpose: On a tab opened from Discover, measure how much of the article the reader actually reads, so Discover can learn what they enjoy and a finished article can count toward the streak.

Inputs:
- The tab's visit from the background (`discoverSession`): the article's start and end snippets, its length, and how much earlier pages covered.
- The page's paragraphs (furigana readings left out), which of them are on screen, tab visibility, and the reader's scrolling, pointer and key activity.

Outputs:
- `discoverProgress` messages: the article's measured length on this page, the characters credited as read, whether its end was reached, and the active time. Only totals are sent, never text.
- One short toast when the visit first counts as finished, with like and dislike buttons (`discoverVote`).
- `discoverMissing` once when the article cannot be found on the page.

Side Effects:
- On a Discover tab only: one IntersectionObserver over the article's paragraphs, passive activity listeners on the window, and a one-second timer, all stopped when the visit is finished, after three hours, or when the page goes away.

Failure Modes:
- Pages where the article cannot be found are not measured (and are reported, without any page detail); the visit then never counts as finished.
- A background restart or a closed extension context drops the progress not yet sent.

Security Notes:
- Does nothing on tabs the popup did not open from Discover; the background decides from the tab, not from the page.
- Reads page text only to find the article; nothing from the page leaves this script except character counts and flags.
- The vote buttons act only on trusted clicks (`showToast` checks), and the background accepts a vote only for this tab's finished visit.
*/
(function startDiscoverReading() {
  if (window.top !== window || window.__TSUKERU_DISCOVER_READING__) return;
  window.__TSUKERU_DISCOVER_READING__ = true;
  const Reading = globalThis.TsukeruDiscoverReading;
  if (!Reading || !chrome.runtime?.id) return;

  const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,td,th,pre,figcaption';
  const SKIP_SELECTOR = 'rt,rp,script,style,noscript,template,textarea,select,button,svg,[id^="tsukeru-"],[class^="tsukeru-toast"]';
  const TICK_MS = 1000;
  const MAX_TICK_SECONDS = 2;
  const IDLE_MS = 45000;
  const REPORT_MS = 10000;
  const STOP_MS = 3 * 60 * 60 * 1000;
  const SCAN_DELAYS_MS = [0, 2000, 5000, 10000];

  let visit = null;
  let region = null;
  let lengths = [];
  let credited = [];
  const visible = new Set();
  let endSeen = false;
  let activeMs = 0;
  let lastActive = Date.now();
  let lastTick = Date.now();
  let lastReport = 0;
  let reportedKey = '';
  let timer = null;
  let observer = null;
  let finished = false;
  const startedAt = Date.now();

  async function send(message) {
    try {
      return chrome.runtime?.id ? await chrome.runtime.sendMessage(message) : null;
    } catch (_) {
      return null;
    }
  }

  /** The page's paragraphs in order: [{ element, text }], text normalized and without readings. */
  function collectBlocks() {
    const blocks = [];
    const byElement = new Map();
    const body = document.body;
    if (!body) return blocks;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue.trim() || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement.closest(BLOCK_SELECTOR) || node.parentElement;
      let block = byElement.get(element);
      if (!block) {
        block = { element, raw: '' };
        byElement.set(element, block);
        blocks.push(block);
      }
      block.raw += node.nodeValue;
    }
    return blocks
      .map(({ element, raw }) => ({ element, text: Reading.normalize(raw) }))
      .filter((block) => block.text && block.element.getClientRects().length > 0);
  }

  function findArticle() {
    const blocks = collectBlocks();
    const located = Reading.locateArticle(
      blocks.map(({ element, text }) => ({ text, parent: element.parentElement })),
      {
        startText: visit.startText,
        endText: visit.endText,
        remaining: visit.remaining,
        later: visit.later && visit.sameArticle,
      },
    );
    if (!located) return null;
    const elements = blocks.slice(located.first, located.last + 1);
    return { elements: elements.map((block) => block.element), lengths: elements.map((block) => block.text.length), end: located.end };
  }

  function noteActive() {
    lastActive = Date.now();
  }

  function report(force = false) {
    if (!region) return;
    const totals = Reading.pageTotals(lengths, credited);
    const key = `${totals.credited}:${endSeen}:${Math.round(activeMs / 5000)}`;
    const now = Date.now();
    if (key === reportedKey || (!force && now - lastReport < REPORT_MS)) return;
    reportedKey = key;
    lastReport = now;
    void send({ action: 'discoverProgress', id: visit.id, length: totals.length, credited: totals.credited, end: endSeen, activeMs: Math.round(activeMs) })
      .then((response) => {
        if (response?.outcome === 'finished' && !finished) celebrate();
      });
  }

  function celebrate() {
    finished = true;
    stop();
    if (typeof showToast !== 'function') return;
    const vote = (kind) => () => { void send({ action: 'discoverVote', kind }); };
    // The popup's solid pixel thumb (7 x 7); upside down for the dislike.
    const thumb = { path: 'M3 0h1v1H3zM2 1h2v2H2zM0 3h1v4H0zM2 3h5v3H2zM2 6h4v1H2z', viewBox: '0 0 7 7' };
    showToast(TsukeruI18n.t('discover_finished_toast', undefined, 'Read to the end. Nice work!'), {
      type: 'info',
      duration: 10000,
      actions: [
        { icon: thumb, label: TsukeruI18n.t('discover_vote_up', undefined, 'I enjoyed it'), onClick: vote('liked') },
        { icon: { ...thumb, flip: 'matrix(1 0 0 -1 0 7)' }, label: TsukeruI18n.t('discover_vote_down', undefined, 'Not for me'), onClick: vote('disliked') },
      ],
    });
  }

  function tick() {
    const now = Date.now();
    const seconds = Math.min(MAX_TICK_SECONDS, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    if (now - startedAt > STOP_MS) {
      stop();
      return;
    }
    if (document.visibilityState !== 'visible' || now - lastActive > IDLE_MS) return;
    activeMs += seconds * 1000;
    Reading.creditReading(lengths, credited, visible, seconds);
    if (region.end && visible.has(lengths.length - 1)) endSeen = true;
    report();
  }

  function onHidden() {
    if (document.visibilityState === 'hidden') report(true);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    observer?.disconnect();
    observer = null;
    for (const name of ['scroll', 'wheel', 'keydown', 'pointermove', 'pointerdown', 'touchstart']) {
      window.removeEventListener(name, noteActive, { capture: true });
    }
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onPageHide);
  }

  function onPageHide() {
    report(true);
    stop();
  }

  function track(found) {
    region = found;
    lengths = found.lengths;
    credited = lengths.map(() => 0);
    const indexOf = new Map(found.elements.map((element, index) => [element, index]));
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const index = indexOf.get(entry.target);
        if (index === undefined) continue;
        if (entry.isIntersecting) visible.add(index);
        else visible.delete(index);
      }
    }, { rootMargin: '0px 0px -15% 0px' });
    found.elements.forEach((element) => observer.observe(element));
    for (const name of ['scroll', 'wheel', 'keydown', 'pointermove', 'pointerdown', 'touchstart']) {
      window.addEventListener(name, noteActive, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    lastTick = Date.now();
    timer = setInterval(tick, TICK_MS);
  }

  async function start() {
    const response = await send({ action: 'discoverSession' });
    visit = response?.success ? response.visit : null;
    if (!visit || typeof visit.id !== 'string') return;
    for (const delay of SCAN_DELAYS_MS) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const found = findArticle();
      if (found) {
        track(found);
        return;
      }
    }
    // Only the page the article was opened on: later pages may be other parts of the site.
    if (!visit.later) void send({ action: 'discoverMissing' });
  }

  void start();
})();
