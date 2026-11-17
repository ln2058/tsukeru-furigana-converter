/*
Module: vocab-model
Purpose: Estimate how likely the reader knows a word and turn that into the readouts shared with EZFurigana: the share of a page they know, its difficulty label, and the read stretches that count as evidence. Generated from EZFurigana's static/js/vocab-model.js by its scripts/dev/export_extension_vocab_model.mjs; do not edit by hand.

Inputs:
- A word's frequency band (data-band) and JLPT level (data-jlpt), per-band evidence counts, the reader's chosen level, word states, and lookup positions and times.

Outputs:
- `globalThis.TsukeruVocab`: difficulties, chances, words a chosen level counts as known, the fitted ability, coverage, labels, read stretches, vocabulary size and level shares.

Side Effects:
- None.

Failure Modes:
- Missing bands or levels leave a word uncounted; too few counted words give no coverage.

Security Notes:
- Pure functions over numbers and word states; nothing here stores or sends words.
*/
(function attachVocabModel(root) {
  // Common kanji words (JLPT lists and the 9,000 most frequent) per difficulty.
  const BAND_SIZES = [129, 248, 224, 377, 339, 552, 670, 460, 626, 836, 799, 1197, 1278, 1471, 2413, 0, 0, 0, 0, 0, 0, 0];
  // Each JLPT level's kanji words per difficulty.
  const LEVEL_BANDS = {
      5: [129, 248, 135, 113, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      4: [0, 0, 89, 264, 181, 89, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      3: [0, 0, 0, 0, 158, 463, 670, 318, 261, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      2: [0, 0, 0, 0, 0, 0, 0, 27, 183, 571, 594, 686, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      1: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 189, 636, 972, 1476, 0, 0, 0, 0, 0, 0, 0],
  };
  // The ability each chosen reader level starts from.
  const LEVEL_ABILITY = {
      beginner: -1.339,
      n5: 3.556,
      n4: 5.579,
      n3: 8.273,
      n2: 12.03,
      n1: 15.267,
      beyond: 17.559,
  };



  const BAND_COUNT = 22;
  // Bands 0-17 within a JLPT level map linearly onto its difficulty range.
  const LEVEL_RANGE = { 5: [0, 3], 4: [2, 5], 3: [4, 8], 2: [7, 11], 1: [10, 14] };
  const LEVEL_SPREAD_BAND = 17;
  // A word outside the JLPT lists: OUTSIDE_FLOOR + OUTSIDE_SCALE * band.
  const OUTSIDE_FLOOR = 7;
  const OUTSIDE_SCALE = 0.6;
  const MAX_DIFFICULTY = BAND_COUNT - 1;
  const SLOPE = 0.7;
  const PRIOR_SIGMA = 1;
  // The prior is this much wider for a reader who skipped the level question.
  const SKIPPED_SIGMA_FACTOR = 1.6;
  const KNOWN_WEIGHT = 0.6;
  // Evidence halves in weight over this many days, so the estimate follows a
  // reader who is learning.
  const HALF_LIFE_DAYS = 120;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // A browser's evidence is scaled down past this many words, which keeps the
  // estimate able to move.
  const MAX_EVIDENCE = 4000;
  // The largest move of the ability in one fitting step.
  const MAX_STEP = 1.5;

  const READER_LEVELS = ['beginner', 'n5', 'n4', 'n3', 'n2', 'n1', 'beyond'];
  // The level a reader who skipped the question starts from.
  const DEFAULT_LEVEL = 'n4';
  // A JLPT level counts as done at this share of its words known.
  const LEVEL_DONE_SHARE = 0.9;
  // Below this share of N5 words known, a reader is a beginner.
  const BEGINNER_SHARE = 0.3;

  // A text needs this many counted words for a coverage figure.
  const MIN_COVERAGE_WORDS = 15;
  const COMFORTABLE_FROM = 95;
  const STRETCH_FROM = 85;
  // A word this likely to be known is "probably known".
  const PROBABLY_KNOWN = 0.9;

  // The common words of each JLPT level: frequency bands up to these, the most
  // frequent words that make up 90% of the level's words in running text
  // (measured on data/word_frequency.sqlite; under half of each level's list).
  const COMMON_BAND = { 5: 4, 4: 7, 3: 8, 2: 12, 1: 12 };
  // The JLPT level a chosen reader level stands at; beginner and N5 vouch for nothing.
  const READER_RANK = { beginner: 6, n5: 5, n4: 4, n3: 3, n2: 2, n1: 1, beyond: 0 };

  // Read stretches: two lookups at most this far apart in time and text mark
  // the words between them as read, if the text between could have been read
  // in that time.
  const STRETCH_MAX_MS = 5 * 60 * 1000;
  const STRETCH_MAX_CHARS = 700;
  const READ_CHARS_PER_SECOND = 15;
  const READ_SLACK_CHARS = 120;
  // A text shorter than this, open at least SHORT_TEXT_MIN_MS, counts as read whole.
  const SHORT_TEXT_CHARS = 300;
  const SHORT_TEXT_MIN_MS = 30 * 1000;

  function finite(value) {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      return typeof number === 'number' && Number.isFinite(number) ? number : null;
  }

  function levelOf(jlpt) {
      const level = finite(jlpt);
      return level !== null && Number.isInteger(level) && level >= 1 && level <= 5 ? level : 0;
  }

  /**
   * Where a word sits on a learner's path, 0 (first words) to 21, or null when
   * neither its band nor its JLPT level is known.
   */
  function wordDifficulty(band, jlpt) {
      const level = levelOf(jlpt);
      const value = finite(band);
      const known = value !== null && Number.isInteger(value) && value >= 0 && value < BAND_COUNT;
      if (level) {
          const [low, high] = LEVEL_RANGE[level];
          const within = known ? Math.min(value, LEVEL_SPREAD_BAND) : LEVEL_SPREAD_BAND;
          return low + ((high - low) * within) / LEVEL_SPREAD_BAND;
      }
      if (!known) return null;
      return Math.min(MAX_DIFFICULTY, OUTSIDE_FLOOR + OUTSIDE_SCALE * value);
  }

  /** The difficulty's bin for evidence counts. */
  function difficultyBin(difficulty) {
      return Math.max(0, Math.min(MAX_DIFFICULTY, Math.round(difficulty)));
  }

  function chanceKnown(difficulty, ability) {
      const exponent = Math.max(-50, Math.min(50, SLOPE * (difficulty - ability)));
      return 1 / (1 + Math.exp(exponent));
  }

  function zeros() {
      return new Array(BAND_COUNT).fill(0);
  }

  function validCounts(values) {
      return Array.isArray(values) && values.length === BAND_COUNT
          && values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  }

  /** A browser's evidence entry weighted down for its age at `at` (ms). */
  function decayed(entry, at) {
      if (!entry || !validCounts(entry.n) || !validCounts(entry.k)) return { n: zeros(), k: zeros() };
      const age = Number.isFinite(Number(entry.at)) ? Math.max(0, at - Number(entry.at)) : 0;
      const weight = 0.5 ** (age / (HALF_LIFE_DAYS * DAY_MS));
      return {
          n: entry.n.map((value) => value * weight),
          k: entry.k.map((value, index) => Math.min(value, entry.n[index]) * weight),
      };
  }

  /** All browsers' evidence together, each weighted for its age. */
  function pooledCounts(devices, at) {
      const n = zeros();
      const k = zeros();
      Object.values(devices && typeof devices === 'object' ? devices : {}).forEach((entry) => {
          const counts = decayed(entry, at);
          counts.n.forEach((value, index) => { n[index] += value; });
          counts.k.forEach((value, index) => { k[index] += value; });
      });
      return { n, k };
  }

  /**
   * Add a text's evidence (difficulty bins of words read and of words looked
   * up) to a browser's entry, ageing what it had first. Returns a new entry.
   */
  function addEvidence(entry, bins, at) {
      const current = decayed(entry, at);
      (bins.read || []).forEach((bin) => { current.n[bin] += 1; });
      (bins.looked || []).forEach((bin) => {
          current.n[bin] += 1;
          current.k[bin] += 1;
      });
      const total = current.n.reduce((sum, value) => sum + value, 0);
      const scale = total > MAX_EVIDENCE ? MAX_EVIDENCE / total : 1;
      const round = (value) => Math.round(value * scale * 1000) / 1000;
      return { at, n: current.n.map(round), k: current.k.map(round) };
  }

  /** The ability a chosen level starts from. */
  function levelAbility(level) {
      const value = LEVEL_ABILITY[level];
      return typeof value === 'number' ? value : LEVEL_ABILITY[DEFAULT_LEVEL];
  }

  /**
   * The most likely ability given the chosen level (or none) and the evidence:
   * damped Newton steps on the log posterior, which has a single peak.
   */
  function fitAbility(counts, level) {
      const chosen = READER_LEVELS.includes(level);
      const prior = levelAbility(chosen ? level : DEFAULT_LEVEL);
      const sigma = PRIOR_SIGMA * (chosen ? 1 : SKIPPED_SIGMA_FACTOR);
      const n = counts && validCounts(counts.n) ? counts.n : zeros();
      const k = counts && validCounts(counts.k) ? counts.k : zeros();
      let ability = prior;
      for (let round = 0; round < 100; round += 1) {
          let gradient = -(ability - prior) / (sigma * sigma);
          let curvature = -1 / (sigma * sigma);
          for (let bin = 0; bin < BAND_COUNT; bin += 1) {
              if (n[bin] <= 0) continue;
              const chance = chanceKnown(bin, ability);
              const unknown = Math.min(k[bin], n[bin]);
              const known = (n[bin] - unknown) * KNOWN_WEIGHT;
              gradient += known * SLOPE * (1 - chance) - unknown * SLOPE * chance;
              curvature -= (known + unknown) * SLOPE * SLOPE * chance * (1 - chance);
          }
          // Damped: where the curve is flat a full step would overshoot.
          const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, gradient / curvature));
          ability = Math.max(-4, Math.min(26, ability - step));
          if (Math.abs(step) < 1e-4) break;
      }
      return ability;
  }

  /**
   * Whether the chosen reader level counts an unmarked word as known: every
   * JLPT word two or more levels below it (N5 for an N3 reader) and the
   * common words (COMMON_BAND) of the level just below (N4 for N3). Words
   * outside the JLPT lists, and a missing or skipped level, never count.
   */
  function assumedKnown({ band, jlpt }, readerLevel) {
      const level = levelOf(jlpt);
      const rank = READER_RANK[readerLevel];
      if (!level || rank === undefined) return false;
      if (level >= rank + 2) return true;
      if (level !== rank + 1) return false;
      const value = finite(band);
      return value !== null && value <= COMMON_BAND[level];
  }

  /**
   * How likely the reader knows a word they have not marked: their own
   * choice decides for marked words (known 1, learning 0, ignored null), then
   * the chosen level (assumedKnown, 1). A kana word (`kana`) is known unless
   * it is on a JLPT list, where its level decides: conjugated kana forms
   * carry no level and are the basic verbs.
   */
  function wordChance({ band, jlpt, state = null, kana = false }, ability, readerLevel = null) {
      if (state === 'known') return 1;
      if (state === 'learning') return 0;
      if (state === 'ignored') return null;
      if (assumedKnown({ band, jlpt }, readerLevel)) return 1;
      if (kana && !levelOf(jlpt)) return 1;
      const difficulty = wordDifficulty(band, jlpt);
      return difficulty === null ? null : chanceKnown(difficulty, ability);
  }

  /**
   * The share of a text's words (counting repeats; particles and grammar
   * patterns are left out by the caller) the reader knows, as a whole
   * percentage, or null below MIN_COVERAGE_WORDS counted words. Counting the
   * kana words too makes it the running-word coverage the COMFORTABLE_FROM
   * and STRETCH_FROM thresholds come from.
   * `words`: [{ band, jlpt, state, kana, occurrences }]; `readerLevel` is the
   * chosen level (assumedKnown), or null.
   */
  function textCoverage(words, ability, readerLevel = null) {
      let counted = 0;
      let known = 0;
      (Array.isArray(words) ? words : []).forEach((word) => {
          const chance = wordChance(word, ability, readerLevel);
          if (chance === null) return;
          const times = Number.isInteger(word.occurrences) && word.occurrences > 0 ? word.occurrences : 1;
          counted += times;
          known += chance * times;
      });
      if (counted < MIN_COVERAGE_WORDS) return null;
      return Math.floor((known / counted) * 100);
  }

  /** 'comfortable', 'stretch' or 'hard' for a coverage percentage. */
  function difficultyLabel(pct) {
      if (typeof pct !== 'number') return null;
      if (pct >= COMFORTABLE_FROM) return 'comfortable';
      if (pct >= STRETCH_FROM) return 'stretch';
      return 'hard';
  }

  /**
   * Indexes of the units the reader evidently read. `units`: [{ offset,
   * sentence }] in text order (offset in characters); `lookups`: [{ index, at }]
   * (at in ms). The sentence of every lookup is read; so is everything between
   * two lookups made one after the other within STRETCH_MAX_MS, at most
   * STRETCH_MAX_CHARS apart, when the text between could have been read in
   * the time between them. A short text open long enough is read whole.
   * `charsBetween(from, to)` replaces the offsets where they are costly to
   * know (a long web page); it may stop counting past STRETCH_MAX_CHARS.
   */
  function readStretches(units, lookups, { textChars = Infinity, openMs = 0, charsBetween = null } = {}) {
      const read = new Set();
      const list = Array.isArray(units) ? units : [];
      if (textChars < SHORT_TEXT_CHARS && openMs >= SHORT_TEXT_MIN_MS) {
          list.forEach((_, index) => read.add(index));
          return read;
      }
      const valid = (Array.isArray(lookups) ? lookups : [])
          .filter((lookup) => Number.isInteger(lookup.index) && lookup.index >= 0 && lookup.index < list.length)
          .sort((a, b) => a.at - b.at);
      const sentences = new Set(valid.map((lookup) => list[lookup.index].sentence));
      list.forEach((unit, index) => {
          if (sentences.has(unit.sentence)) read.add(index);
      });
      for (let i = 1; i < valid.length; i += 1) {
          const before = valid[i - 1];
          const after = valid[i];
          const elapsed = after.at - before.at;
          if (elapsed < 0 || elapsed > STRETCH_MAX_MS) continue;
          const from = Math.min(before.index, after.index);
          const to = Math.max(before.index, after.index);
          const chars = typeof charsBetween === 'function'
              ? charsBetween(from, to)
              : Math.abs(list[to].offset - list[from].offset);
          if (chars > STRETCH_MAX_CHARS) continue;
          if (chars > (elapsed / 1000) * READ_CHARS_PER_SECOND + READ_SLACK_CHARS) continue;
          for (let index = from; index <= to; index += 1) read.add(index);
      }
      return read;
  }

  /**
   * The estimated number of words the reader knows among the common
   * vocabulary (the JLPT lists and the 9,000 most frequent kanji words):
   * never fewer than the words they marked known.
   */
  function vocabularySize(ability, knownCount = 0) {
      let total = 0;
      BAND_SIZES.forEach((size, bin) => { total += size * chanceKnown(bin, ability); });
      return Math.max(Math.round(total), knownCount || 0);
  }

  /** "About" figures: tens under 1,000, hundreds from there. */
  function roundedSize(value) {
      if (value < 100) return Math.round(value);
      if (value < 1000) return Math.round(value / 10) * 10;
      return Math.round(value / 100) * 100;
  }

  /**
   * The share of each JLPT level's kanji words the reader knows: their marked
   * words as they are, the rest by the estimate. `byLevel`: Map(level ->
   * { known, learning }) of the reader's records; `totals`: words per level.
   */
  function levelShares(ability, byLevel, totals) {
      const shares = new Map();
      [5, 4, 3, 2, 1].forEach((level) => {
          const bins = LEVEL_BANDS[level];
          const size = bins.reduce((sum, value) => sum + value, 0);
          let expected = 0;
          bins.forEach((count, bin) => { expected += count * chanceKnown(bin, ability); });
          const average = size ? expected / size : 0;
          const total = totals && totals[level] ? totals[level] : size;
          const counts = byLevel && byLevel.get ? byLevel.get(level) || {} : {};
          const known = Math.min(counts.known || 0, total);
          const learning = Math.min(counts.learning || 0, total - known);
          shares.set(level, total ? (known + (total - known - learning) * average) / total : 0);
      });
      return shares;
  }

  /**
   * The level the reader is working through: 'beginner', 'n5'...'n1', or
   * 'beyond' once N1 is done.
   */
  function workingLevel(shares) {
      if ((shares.get(5) || 0) < BEGINNER_SHARE) return 'beginner';
      const level = [5, 4, 3, 2, 1].find((value) => (shares.get(value) || 0) < LEVEL_DONE_SHARE);
      return level ? `n${level}` : 'beyond';
  }

  /**
   * The level to suggest to a reader who has words but has not chosen one:
   * the easiest level they have marked words in that is not yet mostly known
   * (else the hardest they have words in), or null without marked words.
   * `byLevel`: Map(level -> { known, learning }).
   */
  function suggestedLevel(byLevel) {
      const started = [5, 4, 3, 2, 1].filter((level) => {
          const counts = byLevel && byLevel.get ? byLevel.get(level) : null;
          return counts && (counts.known || 0) + (counts.learning || 0) > 0;
      });
      if (!started.length) return null;
      const total = (level) => LEVEL_BANDS[level].reduce((sum, value) => sum + value, 0);
      const level = started.find((value) => (byLevel.get(value).known || 0) / total(value) < LEVEL_DONE_SHARE)
          || started[started.length - 1];
      return `n${level}`;
  }

  /** The JLPT filter level that matches a chosen reader level (furigana from that level up). */
  function filterLevelFor(level) {
      const map = { beginner: 5, n5: 5, n4: 4, n3: 3, n2: 2, n1: 1, beyond: 1 };
      return map[level] || null;
  }

  root.TsukeruVocab = {
    BAND_COUNT,
    SLOPE,
    PRIOR_SIGMA,
    KNOWN_WEIGHT,
    HALF_LIFE_DAYS,
    MAX_EVIDENCE,
    READER_LEVELS,
    LEVEL_DONE_SHARE,
    MIN_COVERAGE_WORDS,
    COMFORTABLE_FROM,
    STRETCH_FROM,
    PROBABLY_KNOWN,
    COMMON_BAND,
    STRETCH_MAX_MS,
    STRETCH_MAX_CHARS,
    READ_CHARS_PER_SECOND,
    READ_SLACK_CHARS,
    SHORT_TEXT_CHARS,
    SHORT_TEXT_MIN_MS,
    wordDifficulty,
    difficultyBin,
    chanceKnown,
    decayed,
    pooledCounts,
    addEvidence,
    levelAbility,
    fitAbility,
    assumedKnown,
    wordChance,
    textCoverage,
    difficultyLabel,
    readStretches,
    vocabularySize,
    roundedSize,
    levelShares,
    workingLevel,
    suggestedLevel,
    filterLevelFor,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
