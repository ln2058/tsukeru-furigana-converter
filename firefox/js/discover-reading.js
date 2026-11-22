/*
Module: discover-reading
Purpose: Work out how much of a Discover article the reader really read: find the article on its page from the feed's start and end snippets, credit reading time to the paragraphs on screen in order at a believable reading speed, and judge the visit finished, skimmed or bounced.

Inputs:
- Paragraph texts in page order (readings in furigana left out), the feed's start and end snippets and character count, which paragraphs are on screen, and how many seconds of active reading passed.

Outputs:
- The paragraphs that hold the article, updated per-paragraph credit, page totals, and an outcome for the whole visit (all its pages).

Side Effects:
- None; content-discover runs it on the page and bg-discover judges the outcome.

Failure Modes:
- When neither snippet is found the page is not measured (except a later page of the same article, measured from its densest run of paragraphs), so a visit is never judged finished without the article's end on screen.

Security Notes:
- Pure functions over text the page already shows; nothing is stored or sent from here.
*/
(function defineDiscoverReading(root) {
  'use strict';

  // Normalized characters (letters and digits) a reader can be credited per active second.
  // Native readers manage about 10; the cap only stops scroll-to-the-end visits counting.
  const READ_RATE = 20;
  // Feed `chars` counts punctuation too; normalized text is about this share of it.
  const UNIT_SHARE = 0.88;
  const FINISHED_SHARE = 0.85;
  const COVERED_SHARE = 0.6;
  const SKIMMED_SHARE = 0.2;
  const SKIMMED_MIN_UNITS = 300;
  const SKIMMED_MS = 45000;
  const SHORT_NEEDLE = 12;
  const MIN_NEEDLE = 6;

  /** Letters and digits only, width-folded, so page text and feed snippets compare despite spacing and punctuation. */
  function normalize(text) {
    if (typeof text !== 'string' || !text) return '';
    return text.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  }

  /** The article's length in normalized characters, from the feed's character count. */
  function articleUnits(chars) {
    return Number.isFinite(chars) && chars > 0 ? Math.round(chars * UNIT_SHARE) : 0;
  }

  function startNeedles(text) {
    const full = normalize(text);
    return [full, full.slice(0, SHORT_NEEDLE), full.slice(SHORT_NEEDLE, SHORT_NEEDLE * 2)].filter((needle, index, all) => needle.length >= MIN_NEEDLE && all.indexOf(needle) === index);
  }

  function endNeedles(text) {
    const full = normalize(text);
    return [full, full.slice(-SHORT_NEEDLE), full.slice(-SHORT_NEEDLE * 2, -SHORT_NEEDLE)].filter((needle, index, all) => needle.length >= MIN_NEEDLE && all.indexOf(needle) === index);
  }

  function blockAt(offsets, position) {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (offsets[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /**
   * Where the article sits among `blocks` ([{ text, parent }], text normalized, in page order):
   * { first, last, end } block indexes (end: the article's last paragraph is on this page), or null.
   * `remaining` is the article length still unread on earlier pages; `later` marks a later page of the same article.
   */
  function locateArticle(blocks, { startText = '', endText = '', remaining = 0, later = false } = {}) {
    if (!Array.isArray(blocks) || !blocks.length) return null;
    const offsets = [];
    let joined = '';
    for (const block of blocks) {
      offsets.push(joined.length);
      joined += block.text;
    }
    let start = -1;
    for (const needle of startNeedles(startText)) {
      start = joined.indexOf(needle);
      if (start >= 0) break;
    }
    let end = -1;
    for (const needle of endNeedles(endText)) {
      const found = joined.lastIndexOf(needle);
      if (found >= 0 && found >= start) {
        end = found + needle.length - 1;
        break;
      }
    }
    if (start >= 0 && end >= 0) return { first: blockAt(offsets, start), last: blockAt(offsets, end), end: true };
    if (start >= 0) {
      const first = blockAt(offsets, start);
      let last = first;
      let length = 0;
      for (let index = first; index < blocks.length; index += 1) {
        last = index;
        length += blocks[index].text.length;
        if (remaining > 0 && length >= remaining) break;
      }
      return { first, last, end: false };
    }
    if (end >= 0) {
      const last = blockAt(offsets, end);
      let first = last;
      let length = 0;
      for (let index = last; index >= 0; index -= 1) {
        first = index;
        length += blocks[index].text.length;
        if (remaining > 0 && length >= remaining) break;
      }
      return { first, last, end: true };
    }
    if (!later) return null;
    // A middle page of the article: the run of paragraphs sharing the parent with the most text.
    const totals = new Map();
    blocks.forEach((block) => totals.set(block.parent, (totals.get(block.parent) || 0) + block.text.length));
    let parent = null;
    let best = 0;
    totals.forEach((total, key) => {
      if (total > best) {
        best = total;
        parent = key;
      }
    });
    const inside = blocks.map((block, index) => (block.parent === parent ? index : -1)).filter((index) => index >= 0);
    return inside.length ? { first: inside[0], last: inside[inside.length - 1], end: false } : null;
  }

  /**
   * Credit `seconds` of active reading to the paragraphs on screen: the first one in page order
   * with unread text first, the rest flowing on to the next one on screen. `credited` is changed in place.
   */
  function creditReading(lengths, credited, visible, seconds) {
    let budget = Math.max(0, seconds) * READ_RATE;
    const order = [...visible].sort((a, b) => a - b);
    for (const index of order) {
      if (budget <= 0) break;
      const left = (lengths[index] || 0) - (credited[index] || 0);
      if (left <= 0) continue;
      const taken = Math.min(left, budget);
      credited[index] = (credited[index] || 0) + taken;
      budget -= taken;
    }
    return credited;
  }

  /** Totals for one page: { length, credited } in normalized characters. */
  function pageTotals(lengths, credited) {
    let length = 0;
    let read = 0;
    lengths.forEach((value, index) => {
      length += value;
      read += Math.min(value, credited[index] || 0);
    });
    return { length, credited: Math.round(read) };
  }

  /**
   * The visit's outcome over its pages ([{ length, credited, end }]): 'finished' needs the
   * article's end reached, most of the measured text read and most of the article measured;
   * 'skimmed' a real part of it or some time; otherwise 'bounced'.
   */
  function readingOutcome(pages, { units = 0, activeMs = 0 } = {}) {
    let length = 0;
    let credited = 0;
    let endSeen = false;
    for (const page of Array.isArray(pages) ? pages : []) {
      length += Math.max(0, Number(page?.length) || 0);
      credited += Math.max(0, Math.min(Number(page?.credited) || 0, Number(page?.length) || 0));
      endSeen = endSeen || page?.end === true;
    }
    const covered = units > 0 ? length >= units * COVERED_SHARE : length > 0;
    if (endSeen && covered && length > 0 && credited >= length * FINISHED_SHARE) return 'finished';
    if ((length > 0 && credited >= Math.max(SKIMMED_MIN_UNITS, length * SKIMMED_SHARE)) || activeMs >= SKIMMED_MS) return 'skimmed';
    return 'bounced';
  }

  /** Whether `pageUrl` can be a page of the article at `articleUrl`: same host, and its path continues the article's. */
  function samePathStem(articleUrl, pageUrl) {
    try {
      const article = new URL(articleUrl);
      const page = new URL(pageUrl);
      if (article.hostname !== page.hostname) return false;
      const stem = article.pathname.replace(/\/index\.[a-z]+$/i, '').replace(/\.(html?|php)$/i, '').replace(/\/+$/, '');
      const path = page.pathname.replace(/\/+$/, '');
      return path === stem || path.startsWith(`${stem}/`) || path.startsWith(`${stem}.`) || path.startsWith(`${stem}_`) || path.startsWith(`${stem}-`);
    } catch (_) {
      return false;
    }
  }

  root.TsukeruDiscoverReading = Object.freeze({
    READ_RATE,
    articleUnits,
    creditReading,
    locateArticle,
    normalize,
    pageTotals,
    readingOutcome,
    samePathStem,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
