/*
Module: content-vocab
Purpose: Gather this page's evidence for the vocabulary estimate, as EZFurigana does for its results: the words the reader looked up, and the words they evidently read without one (the sentence of each lookup, and the text between two lookups made close together in time and place, or a whole short text read for a while). When the page is hidden or left, the difficulty of those words goes to the background store.

Inputs:
- Lookups and Study reveals from content-tooltip (`TsukeruPageVocab.noteLookup(element)`).
- The page's annotated words (content-dom), their band and JLPT data attributes, My Words states (`wordStates`), and the shared model (`TsukeruVocab`).
- `visibilitychange` and `pagehide` events.

Outputs:
- `vocabEvidence` runtime messages with difficulty bins only: `{ read: [bin], looked: [bin] }`.

Side Effects:
- Adds one visibility listener and one pagehide listener. Only when a page is hidden or left, and only if it had lookups or is short, walks the annotated text around the lookups (at most MAX_WALK_CHARS characters).

Failure Modes:
- Without the model, word rules, or annotated words, nothing is sent. A failed message loses that page's evidence only.
- Each word counts at most once per page, however often the page is hidden and shown.

Security Notes:
- Sends no words, sentences, or addresses: only small integers for word difficulty, to this extension's background.
- Does nothing on EZFurigana itself, which gathers its own evidence.
*/
(function startPageVocab(root) {
  if (root.TsukeruPageVocab) return;
  const noop = { noteLookup() {} };
  if (typeof window === 'undefined' || window.location.origin === 'https://www.ezfurigana.com') {
    root.TsukeruPageVocab = noop;
    return;
  }

  const NOT_WORDS = new Set(['Particle', 'Grammar', 'Aux verb', 'Symbol', 'Punctuation']);
  const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]|[\uD840-\uD87F][\uDC00-\uDFFF]/;
  const SENTENCE_END_RE = /[。！？!?\n]/g;
  const BLOCK_SELECTOR = 'p, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, figcaption, pre, article, section, div';
  const MAX_LOOKUPS = 300;
  // Pages longer than this cannot be a short text read whole; skip the walk.
  const SHORT_TEXT_SCAN_CHARS = 2000;
  // Annotated text nodes walked before the first lookup and after the last.
  const WALK_PAD_REGIONS = 20;
  // The walk stops after this many characters; lookups past it are not counted.
  const MAX_WALK_CHARS = 100000;

  let shownAt = Date.now();
  let lookups = [];
  let wholeTextCounted = false;
  const countedIds = new Set();

  function noteLookup(element) {
    if (element && lookups.length < MAX_LOOKUPS) lookups.push({ element, at: Date.now() });
  }

  function wrappers() {
    return Array.from(document.querySelectorAll('[data-tsukeru-wrapper="1"]'))
      .filter((wrapper) => !wrapper.parentElement?.closest('[data-tsukeru-wrapper="1"]'));
  }

  /** Kanji word units in text order with their character offset and sentence number. */
  function layout(regions) {
    const elements = typeof getAnalysisWordElements === 'function'
      ? regions.flatMap((region) => getAnalysisWordElements(region))
      : [];
    const candidates = new Set(elements.filter((element) => element.getAttribute?.('data-tsukeru-continued') !== '1'));
    const starts = new Map();
    let offset = 0;
    let sentence = 0;
    let block = null;
    regions.forEach((region) => {
      if (offset > MAX_WALK_CHARS) return;
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest('rt, rp, script, style')) continue;
        const nodeBlock = parent.closest(BLOCK_SELECTOR);
        if (nodeBlock !== block) {
          block = nodeBlock;
          sentence += 1;
        }
        for (let element = parent; element && element !== region.parentElement; element = element.parentElement) {
          if (candidates.has(element)) {
            if (!starts.has(element)) starts.set(element, { offset, sentence });
            break;
          }
        }
        const value = node.nodeValue || '';
        offset += value.length;
        sentence += (value.match(SENTENCE_END_RE) || []).length;
      }
    });
    const units = [];
    elements.forEach((element) => {
      const place = starts.get(element);
      if (!place) return;
      const data = getAnalysisWordData(element);
      if (NOT_WORDS.has(String(data.pos || '').split(',')[0].trim())) return;
      if (!KANJI_RE.test(data.surface || '')) return;
      const identity = typeof wordIdentityOf === 'function' ? wordIdentityOf(element) : null;
      if (!identity) return;
      units.push({ element, id: identity.id, band: data.band, jlpt: data.jlpt, ...place });
    });
    return { units, chars: offset };
  }

  /** The annotated text nodes from a little before the first lookup to a little after the last. */
  function around(all, pending) {
    const position = new Map(all.map((region, index) => [region, index]));
    const indexes = pending.map((lookup) => {
      for (let element = lookup.element; element; element = element.parentElement) {
        if (position.has(element)) return position.get(element);
      }
      return -1;
    }).filter((index) => index >= 0);
    if (!indexes.length) return [];
    return all.slice(Math.max(0, Math.min(...indexes) - WALK_PAD_REGIONS), Math.max(...indexes) + WALK_PAD_REGIONS + 1);
  }

  function stateOf(id) {
    return typeof wordStates !== 'undefined' && wordStates?.get ? wordStates.get(id) : undefined;
  }

  /** Turn this page's read stretches into evidence and start afresh. */
  function settle() {
    const Vocab = root.TsukeruVocab;
    const pending = lookups;
    const openMs = Date.now() - shownAt;
    lookups = [];
    if (!Vocab || !chrome.runtime?.id) return;
    const all = wrappers();
    if (!all.length) return;
    const shortCandidate = !wholeTextCounted
      && all.reduce((sum, region) => sum + (region.textContent || '').length, 0) < SHORT_TEXT_SCAN_CHARS;
    if (!pending.length && !shortCandidate) return;
    const regions = shortCandidate ? all : around(all, pending);
    const { units, chars } = layout(regions);
    if (!units.length) return;
    const index = new Map(units.map((unit, position) => [unit.element, position]));
    const placed = pending
      .filter((lookup) => index.has(lookup.element))
      .map((lookup) => ({ index: index.get(lookup.element), at: lookup.at }));
    const read = Vocab.readStretches(units, placed, {
      textChars: wholeTextCounted ? Infinity : chars,
      openMs,
    });
    if (chars < Vocab.SHORT_TEXT_CHARS && openMs >= Vocab.SHORT_TEXT_MIN_MS) wholeTextCounted = true;
    const looked = new Set(placed.map((lookup) => units[lookup.index].id));
    const bins = { read: [], looked: [] };
    read.forEach((position) => {
      const unit = units[position];
      if (countedIds.has(unit.id)) return;
      const difficulty = Vocab.wordDifficulty(unit.band, unit.jlpt);
      if (difficulty === null) return;
      if (looked.has(unit.id)) {
        bins.looked.push(Vocab.difficultyBin(difficulty));
        countedIds.add(unit.id);
      } else if (!stateOf(unit.id)) {
        bins.read.push(Vocab.difficultyBin(difficulty));
        countedIds.add(unit.id);
      }
    });
    if (!bins.read.length && !bins.looked.length) return;
    try {
      chrome.runtime.sendMessage({ action: 'vocabEvidence', ...bins })?.catch?.(() => {});
    } catch (_) {
      // The extension was reloaded; this page's evidence is lost.
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') settle();
    else shownAt = Date.now();
  });
  window.addEventListener('pagehide', settle);

  root.TsukeruPageVocab = { noteLookup };
})(globalThis);
