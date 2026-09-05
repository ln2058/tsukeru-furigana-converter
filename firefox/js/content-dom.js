/*
Module: content-dom
Purpose: Collect processable page text, structurally index long pages, resolve complete backend word units, sanitize backend HTML, and apply DOM/observer workflows.

Inputs:
- Current document nodes, site-specific selectors, settings, and processed HTML batches.

Outputs:
- Batched marker payloads, injected ruby wrappers, complete-unit metadata, and extracted vocab/context data.

Side Effects:
- Mutates page DOM, attributes, classes, and inline CSS variables.
- Starts/stops guarded mutation, viewport intersection, container-discovery, and caption observers.

Failure Modes:
- Invalid selectors, DOM race conditions, and batch marker mismatches.
- Rate-limit failures surface as visible toasts and retry via sendFuriganaWithRateLimitRetry.
- Partial dynamic processing failures are logged and skipped.
- Lifecycle, viewport, container, and insertion checks discard stale asynchronous work before DOM mutation.

Security Notes:
- Enforces strict allowlist sanitization before HTML insertion.
- Excludes sensitive/non-text targets from processing.
*/
// ============================================================================
// content-dom.js — DOM utilities, text node collection, observers, HTML cleaning
// Loaded as a plain content script (no import/export). State variables
// (processedNodes, currentSite, etc.) are declared as var in content-main.js
// and are accessible here at call time via shared global scope.
// ============================================================================

// ── Constants ────────────────────────────────────────────────────────────────

const TOKEN_PREFIX = '__TSUKERU_SPLIT__';
const MAX_BATCH_BYTES = 40000;
const LONG_PAGE_BLOCK_THRESHOLD = 150;
const LONG_PAGE_JA_CHAR_THRESHOLD = 30000;
const VIEWPORT_ROOT_MARGIN = '1200px 0px';
const MAX_INSERTIONS_PER_SLICE = 24;
const MAX_INSERTION_SLICE_MS = 8;
const MAX_DISCOVERY_SLICE_MS = 6;
const LONG_PAGE_FALLBACK_SPLIT_CHAR_THRESHOLD = 2000;
const VIEWPORT_PREFETCH_PX = 1200;
const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 2000;
const DICTIONARY_MAX_SENSES = 3;

const LONG_PAGE_SEMANTIC_BLOCK_TAGS = new Set([
  'p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'figcaption', 'dt', 'dd', 'pre', 'article'
]);
const LONG_PAGE_FALLBACK_BLOCK_TAGS = new Set([
  'body', 'main', 'div', 'section', 'header', 'footer', 'nav', 'aside',
  'figure', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'dl',
  'fieldset', 'details', 'summary', 'form'
]);

const ANALYSIS_METADATA_ATTRIBUTES = [
  'jlpt', 'pos', 'surface', 'dict-form', 'dict-reading', 'reading',
  'lookup-reading', 'alt-readings', 'word'
];
const SUPPORTED_READING_TYPES = new Set(['hiragana', 'katakana', 'romaji']);

function getDataAttribute(element, name) {
  if (!element) return '';
  const datasetName = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  if (element.dataset && Object.prototype.hasOwnProperty.call(element.dataset, datasetName)) {
    return String(element.dataset[datasetName] || '');
  }
  return String(element.getAttribute?.(`data-${name}`) || '');
}

function hasDataAttribute(element, name) {
  return Boolean(element?.hasAttribute?.(`data-${name}`));
}

function isExtensionOwnedElement(element) {
  let current = element?.nodeType === 1 ? element : element?.parentElement;
  while (current) {
    const id = String(current.id || '');
    if (id === 'tsukeru-word-tooltip' || id === 'tsukeru-content-report-modal') return true;
    if (current.hasAttribute?.('data-tsukeru-extension-ui')) return true;
    current = current.parentElement;
  }
  return false;
}

function hasAnalysisMetadata(element) {
  return ANALYSIS_METADATA_ATTRIBUTES.some((name) => (
    hasDataAttribute(element, name) || Boolean(getDataAttribute(element, name).trim())
  ));
}

function isAnalysisWordElement(element) {
  if (!element || element.nodeType !== 1 || isExtensionOwnedElement(element)) return false;
  const tagName = getElementTagNameLower(element);
  const className = String(element.className || '').split(/\s+/);
  const isKnownWrapper = className.includes('analysis-word') || className.includes('srt-word');
  const isLegacyMetadataElement = (tagName === 'ruby' && (
    hasDataAttribute(element, 'surface') || hasDataAttribute(element, 'dict-form')
  )) || (
    tagName === 'span' && (
      hasDataAttribute(element, 'jlpt') ||
      hasDataAttribute(element, 'surface') ||
      hasDataAttribute(element, 'dict-form')
    )
  );
  return (isKnownWrapper || isLegacyMetadataElement) && hasAnalysisMetadata(element);
}

function resolveAnalysisWordElement(target) {
  let current = target?.nodeType === 1 ? target : target?.parentElement;
  let fallback = null;
  let preferredWrapper = null;
  let outerLegacyWrapper = null;
  while (current) {
    if (isExtensionOwnedElement(current)) return null;
    if (isAnalysisWordElement(current)) {
      fallback ||= current;
      if (String(current.className || '').split(/\s+/).some((name) => (
        name === 'analysis-word' || name === 'srt-word'
      ))) {
        preferredWrapper = current;
      } else if (getElementTagNameLower(current) === 'span') {
        outerLegacyWrapper = current;
      }
    }
    current = current.parentElement;
  }
  return preferredWrapper || outerLegacyWrapper || fallback;
}

function getAnalysisWordElements(root = document) {
  const candidates = [];
  const seen = new Set();
  const rootElement = root?.nodeType === 9 ? root.documentElement : root;
  if (isAnalysisWordElement(rootElement)) candidates.push(rootElement);

  const selector = [
    '.analysis-word', '.srt-word',
    'ruby[data-surface]', 'ruby[data-dict-form]', 'ruby[data-jlpt]', 'ruby[data-pos]',
    'span[data-jlpt]', 'span[data-surface]', 'span[data-dict-form]'
  ].join(', ');
  root?.querySelectorAll?.(selector)?.forEach((candidate) => candidates.push(candidate));

  return candidates.filter((candidate) => {
    if (seen.has(candidate) || !isAnalysisWordElement(candidate)) return false;
    seen.add(candidate);
    return resolveAnalysisWordElement(candidate) === candidate;
  });
}

function getAnalysisBaseText(element) {
  if (!element) return '';
  const clone = element.cloneNode?.(true);
  if (clone?.querySelectorAll) {
    clone.querySelectorAll('rt, rp').forEach((readingNode) => readingNode.remove());
    return String(clone.textContent || '').trim();
  }
  const readingText = Array.from(element.querySelectorAll?.('rt, rp') || [])
    .map((readingNode) => readingNode.textContent || '')
    .join('');
  return String(element.textContent || '').replace(readingText, '').trim();
}

function getPlainTextWithoutReadings(node) {
  if (!node) return '';
  const clone = node.cloneNode?.(true);
  if (clone?.querySelectorAll) {
    clone.querySelectorAll('rt, rp, [data-tsukeru-reading-only="true"]').forEach((readingNode) => readingNode.remove());
    return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
  }
  return String(node.textContent || '').replace(/\s+/g, ' ').trim();
}

function getPlainTextFromHtml(html) {
  const container = document.createElement('div');
  container.innerHTML = String(html || '');
  return getPlainTextWithoutReadings(container);
}

function getPageWordsSnippet(node, maxLength = 72) {
  if (!node) return '';
  let result = '';
  let pendingSpace = false;
  let truncated = false;

  const appendText = (value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ');
    for (const character of normalized) {
      if (character === ' ') {
        if (result) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        result += ' ';
        pendingSpace = false;
      }
      result += character;
      if (result.length > maxLength) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  const visit = (current) => {
    if (!current || truncated) return;
    if (current.nodeType === 3) {
      appendText(current.textContent || '');
      return;
    }
    if (current.nodeType !== 1) return;
    const tagName = getElementTagNameLower(current);
    if (tagName === 'rt' || tagName === 'rp' || current.getAttribute?.('data-tsukeru-reading-only') === 'true') return;
    for (const child of current.childNodes || []) visit(child);
  };

  visit(node);
  return result.slice(0, maxLength) + (truncated ? '…' : '');
}

function getAnalysisWordData(target) {
  const element = resolveAnalysisWordElement(target) || (isAnalysisWordElement(target) ? target : null);
  if (!element) return {};

  const nestedReading = Array.from(element.querySelectorAll?.('rt') || [])
    .map((readingNode) => String(readingNode.textContent || '').trim())
    .filter(Boolean)
    .join('');
  const surface = getDataAttribute(element, 'surface').trim() || getAnalysisBaseText(element);
  const dictForm = getDataAttribute(element, 'dict-form').trim() || surface;
  const dataReading = getDataAttribute(element, 'reading').trim();
  const dictReading = getDataAttribute(element, 'dict-reading').trim();
  const reading = dictReading || dataReading || nestedReading;
  const surfaceReading = dataReading || nestedReading;
  const canonicalLookupReading = getDataAttribute(element, 'lookup-reading').trim();
  const lookupReading = canonicalLookupReading || reading;
  const declaredReadingType = getDataAttribute(element, 'reading-type').trim().toLowerCase();

  return {
    element,
    word: dictForm || surface,
    dictForm,
    surface,
    reading,
    surfaceReading,
    lookupReading,
    lookupReadingType: canonicalLookupReading
      ? 'hiragana'
      : (SUPPORTED_READING_TYPES.has(declaredReadingType) ? declaredReadingType : ''),
    jlpt: getDataAttribute(element, 'jlpt').trim(),
    pos: getDataAttribute(element, 'pos').trim(),
    altReadings: getDataAttribute(element, 'alt-readings')
      .split(',').map((value) => value.trim()).filter(Boolean),
  };
}

/**
 * Returns an inter-batch delay in ms, scaled linearly with batch byte utilization.
 * A near-empty batch → MIN_DELAY_MS (200ms); a full batch → MAX_DELAY_MS (2000ms).
 */
function batchDelay(byteCount) {
  const ratio = Math.min(byteCount / MAX_BATCH_BYTES, 1);
  return Math.round(MIN_DELAY_MS + ratio * (MAX_DELAY_MS - MIN_DELAY_MS));
}

const EXCLUDED_TEXT_PARENT_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'object', 'embed',
  'canvas', 'svg', 'code', 'pre', 'textarea', 'input', 'button',
  'select', 'option', 'math', 'time', 'data', 'var', 'kbd',
  'samp', 'rt', 'rp', 'ruby'
];

// Site-specific configuration
const SITE_CONFIGS = {
  twitter: {
    name: 'X (Twitter)',
    selectors: [
      '[data-testid="tweetText"]',
      '[data-testid="UserDescription"]',
      '[data-testid="card.layoutSmall.detail"] > div',
      'article [lang]'
    ],
    containerSelector: 'main[role="main"]',
    debounceDelay: 800,
    useIntersectionObserver: true
  },
  youtube: {
    name: 'YouTube',
    selectors: [
      '#content-text',
      '#description-text',
      'yt-formatted-string',
      '#video-title',
      '.ytd-comment-renderer #content-text'
    ],
    containerSelector: '#page-manager',
    debounceDelay: 600,
    useIntersectionObserver: true
  },
  reddit: {
    name: 'Reddit',
    selectors: [
      '[data-test-id="post-content"]',
      '[data-testid="comment"]',
      '.md'
    ],
    containerSelector: 'main',
    debounceDelay: 700,
    useIntersectionObserver: true
  },
  default: {
    name: 'Default',
    selectors: [],
    containerSelector: 'body',
    debounceDelay: 1000,
    useIntersectionObserver: false
  }
};

function shouldUseViewportProcessing(plan, siteConfig) {
  return Boolean(plan?.isLongPage || siteConfig?.useIntersectionObserver);
}

// ── Site detection ────────────────────────────────────────────────────────────

function detectSite() {
  const hostname = window.location.hostname;
  if (hostname.includes('twitter.com') || hostname.includes('x.com')) return 'twitter';
  if (hostname.includes('youtube.com')) return 'youtube';
  if (hostname.includes('reddit.com')) return 'reddit';
  return 'default';
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function generateEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getElementTagNameLower(node) {
  if (!node) return '';
  const tagName = node.localName || node.tagName || '';
  return String(tagName).toLowerCase();
}

function getDocumentProcessingRoot() {
  return document.body || document.documentElement || null;
}

function sanitizeHtmlFragment(html) {
  const fragment = document.createDocumentFragment();
  if (typeof html !== 'string' || !html) return fragment;

  const template = document.createElement('template');
  template.innerHTML = html;

  const allowedTags = new Set(['ruby', 'rt', 'mark', 'span']);

  const isAllowedAttribute = (name) => {
    return name === 'class' || name.startsWith('data-');
  };

  const sanitizeNode = (node, parent) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent || ''));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const nodeTag = getElementTagNameLower(node);

    if (!allowedTags.has(nodeTag)) {
      const frag = document.createDocumentFragment();
      for (const child of Array.from(node.childNodes || [])) sanitizeNode(child, frag);
      parent.appendChild(frag);
      return;
    }

    // Only preserve metadata-bearing backend spans. Generic host-page spans are
    // flattened so host markup cannot become extension word UI by accident.
    if (nodeTag === 'span' && !hasAnalysisMetadata(node)) {
      parent.appendChild(document.createTextNode(node.textContent || ''));
      return;
    }

    const clean = document.createElement(nodeTag);
    for (const attr of Array.from(node.attributes)) {
      if (isAllowedAttribute(attr.name)) {
        clean.setAttribute(attr.name, attr.value);
      }
    }

    for (const child of Array.from(node.childNodes)) {
      sanitizeNode(child, clean);
    }

    parent.appendChild(clean);
  };

  for (const child of Array.from(template.content.childNodes)) {
    sanitizeNode(child, fragment);
  }

  return fragment;
}

// ── Highlight mode ────────────────────────────────────────────────────────────

function setHighlightMode(mode = 'off') {
  const allowed = ['off', 'pos', 'jlpt'];
  // currentHighlightMode is a var declared in content-main.js
  currentHighlightMode = allowed.includes(mode) ? mode : 'off';
  document.documentElement.setAttribute('data-tsukeru-highlight', currentHighlightMode);
}

// ── Node visibility and filtering ─────────────────────────────────────────────

function isNodeVisible(node, visibilityCache = null) {
  const element = node.parentElement || node;
  if (!element || !element.isConnected) return false;
  if (visibilityCache?.has(element)) return visibilityCache.get(element);

  let visible = true;

  if (element.closest('head, template, meta, title, [hidden], [aria-hidden="true"], noscript, script, style')) {
    visible = false;
  }

  let current = element;
  const checkedAncestors = [];
  while (visible && current && current !== document.documentElement) {
    if (current !== element && visibilityCache?.has(current)) {
      visible = visibilityCache.get(current);
      break;
    }
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      visible = false;
      break;
    }

    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      visible = false;
      break;
    }

    const rect = current.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      visible = false;
      break;
    }

    // Do not publish an intermediate ancestor as visible until the complete
    // chain has passed. A hidden higher ancestor must invalidate all of them.
    checkedAncestors.push(current);
    current = current.parentElement;
  }

  if (visible && visibilityCache) {
    checkedAncestors.forEach((ancestor) => visibilityCache.set(ancestor, true));
  }
  visibilityCache?.set(element, visible);
  return visible;
}

function isProcessableTextNode(node, { visibilityCache = null } = {}) {
  // processedNodes and currentSite are var globals from content-main.js
  const parent = node?.parentNode;
  if (!parent) return false;
  if (processedNodes.has(node)) return false;

  const tag = parent.nodeName.toLowerCase();
  if (EXCLUDED_TEXT_PARENT_TAGS.includes(tag)) return false;
  if (parent.closest?.('code, pre')) return false;

  if (parent.closest('ruby')) return false;
  if (parent.isContentEditable || parent.hasAttribute('contenteditable')) return false;
  if (parent.closest('[data-no-furigana]')) return false;
  if (parent.closest('[data-tsukeru-wrapper="1"]')) return false;

  if (currentSite === 'youtube') {
    if (parent.closest('.ytp-caption-segment, .caption-window, video, .video-stream')) {
      return false;
    }
  }

  if (currentSite === 'twitter') {
    if (parent.closest('[data-testid="analytics"], [aria-hidden="true"]')) {
      return false;
    }
  }

  const text = node.textContent || '';
  if (!text.trim()) return false;
  if (!/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) return false;
  if (!isNodeVisible(node, visibilityCache)) return false;

  return true;
}

// ── Text node collection ──────────────────────────────────────────────────────

function collectTextNodes(rootNode = getDocumentProcessingRoot()) {
  if (!rootNode) return [];
  const walker = document.createTreeWalker(
    rootNode,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;

        return isProcessableTextNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
    false
  );

  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}

function countJapaneseCharacters(text) {
  return (String(text || '').match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g) || []).length;
}

function isStructurallyProcessableTextNode(node) {
  const parent = node?.parentNode;
  if (!parent) return false;

  const tag = getElementTagNameLower(parent);
  if (EXCLUDED_TEXT_PARENT_TAGS.includes(tag)) return false;
  if (parent.closest?.('code, pre')) return false;
  if (parent.closest?.('head, template, meta, title, [hidden], [aria-hidden="true"], noscript, script, style')) {
    return false;
  }
  if (parent.closest?.('ruby, [data-tsukeru-wrapper="1"], [data-no-furigana]')) return false;
  if (parent.isContentEditable || parent.hasAttribute?.('contenteditable')) return false;
  if (isExtensionOwnedElement(parent)) return false;

  const text = node.textContent || '';
  return Boolean(text.trim() && countJapaneseCharacters(text));
}

function getNearestLongPageBlockElement(node, root = getDocumentProcessingRoot()) {
  let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (current) {
    if (LONG_PAGE_SEMANTIC_BLOCK_TAGS.has(getElementTagNameLower(current))) return current;
    if (LONG_PAGE_FALLBACK_BLOCK_TAGS.has(getElementTagNameLower(current))) return current;
    if (current === root) break;
    current = current.parentElement;
  }
  return root;
}

function countStructurallyProcessableJapaneseCharacters(rootNode) {
  if (!rootNode) return 0;
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let count = 0;
  let current;
  while ((current = walker.nextNode())) {
    if (isStructurallyProcessableTextNode(current)) count += countJapaneseCharacters(current.textContent || '');
  }
  return count;
}

function collectLongPageFallbackChildren(record) {
  const children = [];
  const seen = new Set();
  const visit = (parent) => {
    for (const child of parent.children || []) {
      if (seen.has(child)) continue;
      const childCount = countStructurallyProcessableJapaneseCharacters(child);
      if (!childCount) continue;
      seen.add(child);
      children.push(child);
      if (childCount >= LONG_PAGE_FALLBACK_SPLIT_CHAR_THRESHOLD && child.children?.length) {
        visit(child);
      }
    }
  };
  visit(record.element);
  return children;
}

function getNearestLongPageRecordFromMap(node, blockByElement) {
  let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (current) {
    const record = blockByElement.get(current);
    if (record) return record;
    current = current.parentElement;
  }
  return null;
}

function recomputeLongPagePlanCounts(rootNode, blocks, blockByElement) {
  blocks.forEach((record) => { record.japaneseCharacterCount = 0; });
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let japaneseCharacterCount = 0;
  let current;
  while ((current = walker.nextNode())) {
    if (!isStructurallyProcessableTextNode(current)) continue;
    const record = getNearestLongPageRecordFromMap(current, blockByElement);
    if (!record) continue;
    const count = countJapaneseCharacters(current.textContent || '');
    record.japaneseCharacterCount += count;
    japaneseCharacterCount += count;
  }
  return japaneseCharacterCount;
}

async function countStructurallyProcessableJapaneseCharactersCooperatively(rootNode, state, signal, isCurrent) {
  if (!rootNode) return 0;
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let count = 0;
  let current;
  while ((current = walker.nextNode())) {
    assertDiscoveryCurrent(signal, isCurrent);
    if (isStructurallyProcessableTextNode(current)) {
      count += countJapaneseCharacters(current.textContent || '');
    }
    await yieldDiscoveryIfNeeded(state, signal, isCurrent);
  }
  return count;
}

async function collectLongPageFallbackChildrenCooperatively(record, state, signal, isCurrent) {
  const children = [];
  const seen = new Set();
  const visit = async (parent) => {
    for (const child of parent.children || []) {
      assertDiscoveryCurrent(signal, isCurrent);
      if (seen.has(child)) continue;
      const childCount = await countStructurallyProcessableJapaneseCharactersCooperatively(
        child,
        state,
        signal,
        isCurrent
      );
      if (!childCount) continue;
      seen.add(child);
      children.push(child);
      if (childCount >= LONG_PAGE_FALLBACK_SPLIT_CHAR_THRESHOLD && child.children?.length) {
        await visit(child);
      }
    }
  };
  await visit(record.element);
  return children;
}

function createLongPagePlanAccumulator(rootNode) {
  const blocks = [];
  const blockByElement = new Map();
  let japaneseCharacterCount = 0;

  const addTextNode = (current) => {
    if (current?.isConnected === false || !isNodeInsideCollectionRoot(current, rootNode)) return;
    if (!isStructurallyProcessableTextNode(current)) return;
    const element = getNearestLongPageBlockElement(current, rootNode);
    if (!element) return;

    let record = blockByElement.get(element);
    if (!record) {
      record = { element, japaneseCharacterCount: 0, state: 'waiting' };
      blockByElement.set(element, record);
      blocks.push(record);
    }
    const count = countJapaneseCharacters(current.textContent || '');
    record.japaneseCharacterCount += count;
    japaneseCharacterCount += count;
  };

  return {
    blocks,
    blockByElement,
    addTextNode,
    get japaneseCharacterCount() {
      return japaneseCharacterCount;
    },
  };
}

function finalizeLongPagePlanRecords(blocks, japaneseCharacterCount) {
  const nonEmptyBlocks = blocks.filter((record) => record.japaneseCharacterCount > 0);
  blocks.length = 0;
  blocks.push(...nonEmptyBlocks);
  blocks.sort((left, right) => {
    if (left.element === right.element) return 0;
    const position = left.element.compareDocumentPosition?.(right.element) || 0;
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return {
    blocks,
    japaneseCharacterCount,
    isLongPage: blocks.length >= LONG_PAGE_BLOCK_THRESHOLD ||
      japaneseCharacterCount >= LONG_PAGE_JA_CHAR_THRESHOLD,
  };
}

function finalizeLongPagePlan(rootNode, accumulator) {
  const { blocks, blockByElement } = accumulator;
  let japaneseCharacterCount = accumulator.japaneseCharacterCount;

  const largeFallbacks = blocks.filter((record) =>
    LONG_PAGE_FALLBACK_BLOCK_TAGS.has(getElementTagNameLower(record.element)) &&
    record.japaneseCharacterCount >= LONG_PAGE_FALLBACK_SPLIT_CHAR_THRESHOLD
  );
  for (const record of largeFallbacks) {
    for (const child of collectLongPageFallbackChildren(record)) {
      if (blockByElement.has(child)) continue;
      const childRecord = { element: child, japaneseCharacterCount: 0, state: 'waiting' };
      blockByElement.set(child, childRecord);
      blocks.push(childRecord);
    }
  }
  if (largeFallbacks.length) japaneseCharacterCount = recomputeLongPagePlanCounts(rootNode, blocks, blockByElement);

  return finalizeLongPagePlanRecords(blocks, japaneseCharacterCount);
}

async function finalizeLongPagePlanCooperatively(rootNode, accumulator, { signal = null, isCurrent = null } = {}) {
  const { blocks, blockByElement } = accumulator;
  let japaneseCharacterCount = accumulator.japaneseCharacterCount;
  const state = { sliceStart: getMonotonicNow() };
  const largeFallbacks = blocks.filter((record) =>
    LONG_PAGE_FALLBACK_BLOCK_TAGS.has(getElementTagNameLower(record.element)) &&
    record.japaneseCharacterCount >= LONG_PAGE_FALLBACK_SPLIT_CHAR_THRESHOLD
  );

  for (const record of largeFallbacks) {
    const children = await collectLongPageFallbackChildrenCooperatively(record, state, signal, isCurrent);
    for (const child of children) {
      if (blockByElement.has(child)) continue;
      const childRecord = { element: child, japaneseCharacterCount: 0, state: 'waiting' };
      blockByElement.set(child, childRecord);
      blocks.push(childRecord);
    }
    await yieldDiscoveryIfNeeded(state, signal, isCurrent);
  }

  if (largeFallbacks.length) {
    blocks.forEach((record) => { record.japaneseCharacterCount = 0; });
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    let current;
    japaneseCharacterCount = 0;
    while ((current = walker.nextNode())) {
      assertDiscoveryCurrent(signal, isCurrent);
      if (isStructurallyProcessableTextNode(current)) {
        const record = getNearestLongPageRecordFromMap(current, blockByElement);
        if (record) {
          const count = countJapaneseCharacters(current.textContent || '');
          record.japaneseCharacterCount += count;
          japaneseCharacterCount += count;
        }
      }
      await yieldDiscoveryIfNeeded(state, signal, isCurrent);
    }
  }

  assertDiscoveryCurrent(signal, isCurrent);
  return finalizeLongPagePlanRecords(blocks, japaneseCharacterCount);
}

function buildLongPagePlanFromTextNodes(rootNode, textNodes) {
  const accumulator = createLongPagePlanAccumulator(rootNode);
  for (const current of textNodes) accumulator.addTextNode(current);
  return finalizeLongPagePlan(rootNode, accumulator);
}

async function yieldDiscoveryIfNeeded(state, signal, isCurrent) {
  if (getMonotonicNow() - state.sliceStart < MAX_DISCOVERY_SLICE_MS) return false;
  await delayWithAbort(0, signal);
  assertDiscoveryCurrent(signal, isCurrent);
  state.sliceStart = getMonotonicNow();
  return true;
}

function isNodeInsideCollectionRoot(node, rootNode) {
  if (!node || !rootNode) return false;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!element) return false;
  if (element === rootNode || rootNode.contains?.(element)) return true;
  let current = element.parentElement;
  while (current) {
    if (current === rootNode) return true;
    current = current.parentElement;
  }
  return false;
}

function collectLongPagePlan(rootNode = getDocumentProcessingRoot()) {
  if (!rootNode) return { blocks: [], japaneseCharacterCount: 0, isLongPage: false };
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  const structuralNodes = [];
  let current;
  while ((current = walker.nextNode())) structuralNodes.push(current);
  return buildLongPagePlanFromTextNodes(rootNode, structuralNodes);
}

function createDiscoveryCancellationError() {
  const error = new Error('Furigana discovery cancelled');
  error.cancelled = true;
  return error;
}

function assertDiscoveryCurrent(signal, isCurrent) {
  if (signal?.aborted || (isCurrent && !isCurrent())) throw createDiscoveryCancellationError();
}

async function collectInitialDiscovery(rootNode, {
  signal = null,
  isCurrent = null,
  viewportModeKnown = false,
} = {}) {
  if (!rootNode) return { plan: { blocks: [], japaneseCharacterCount: 0, isLongPage: false }, textNodes: [] };

  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  const accumulator = createLongPagePlanAccumulator(rootNode);
  const structuralNodes = viewportModeKnown ? null : [];
  const discoveryState = { sliceStart: getMonotonicNow() };
  let current;

  while ((current = walker.nextNode())) {
    assertDiscoveryCurrent(signal, isCurrent);
    if (isStructurallyProcessableTextNode(current)) {
      accumulator.addTextNode(current);
      if (structuralNodes) structuralNodes.push(current);
    }

    await yieldDiscoveryIfNeeded(discoveryState, signal, isCurrent);
  }

  assertDiscoveryCurrent(signal, isCurrent);
  const plan = await finalizeLongPagePlanCooperatively(rootNode, accumulator, { signal, isCurrent });
  if (viewportModeKnown || plan.isLongPage) return { plan, textNodes: [] };

  const visibleNodes = [];
  let visibilityCache = new WeakMap();
  for (const node of structuralNodes) {
    assertDiscoveryCurrent(signal, isCurrent);
    if (node.isConnected !== false && isNodeInsideCollectionRoot(node, rootNode) &&
      isProcessableTextNode(node, { visibilityCache })) {
      visibleNodes.push(node);
    }
    if (await yieldDiscoveryIfNeeded(discoveryState, signal, isCurrent)) {
      visibilityCache = new WeakMap();
    }
  }

  return { plan, textNodes: visibleNodes };
}

function installLongPagePlan(plan, { force = false, rootNode = null } = {}) {
  longPageBlocks = Array.isArray(plan?.blocks) ? plan.blocks : [];
  longPagePlanRoot = rootNode;
  longPageBlockByElement = new WeakMap();
  longPageBlocks.forEach((record) => longPageBlockByElement.set(record.element, record));
  longPageMode = Boolean(longPageBlocks.length && (force || plan?.isLongPage));
  wasLongPage = wasLongPage || longPageMode;
  viewportVisibleBlocks.clear();
  viewportNearbyBlocks.clear();
  dynamicPendingTargets.clear();
  cleanupPending = false;
  viewportProcessingPending = false;
  longPageFirstWorkState = longPageMode ? 'pending' : 'idle';
  longPageBatchSerial = 0;
}

function clearLongPageRuntime({ retainClassification = false } = {}) {
  longPageMode = false;
  longPageBlocks = [];
  longPageBlockByElement = new WeakMap();
  longPagePlanRoot = null;
  viewportVisibleBlocks.clear();
  viewportNearbyBlocks.clear();
  dynamicPendingTargets.clear();
  cleanupPending = false;
  viewportProcessingPending = false;
  longPageFirstWorkState = 'idle';
  longPageBatchSerial = 0;
  if (!retainClassification) wasLongPage = false;
}

function getRegisteredLongPageBlockForNode(node) {
  let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (current) {
    const record = longPageBlockByElement.get(current);
    if (record) return record;
    current = current.parentElement;
  }
  return null;
}

function isManagedWrapperNode(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(element?.closest?.('[data-tsukeru-wrapper="1"]'));
}

function isOwnedTextReplacementMutation(mutation) {
  const removedNodes = Array.from(mutation?.removedNodes || []);
  const addedNodes = Array.from(mutation?.addedNodes || []);
  if (!removedNodes.length || removedNodes.length !== addedNodes.length) return false;
  if (!removedNodes.every((node) => node?.nodeType === Node.TEXT_NODE)) return false;
  if (!addedNodes.every((node) => node?.nodeType === Node.ELEMENT_NODE && isManagedWrapperNode(node))) return false;

  const originalTexts = new Set(
    addedNodes.map((node) => node.getAttribute?.('data-tsukeru-original') || '')
  );
  return removedNodes.every((node) => originalTexts.has(node.textContent || ''));
}

function walkOwnedLongPageTextNodes(record, callback, { includeVisibility = true } = {}) {
  if (!record?.element?.isConnected) return;
  const walker = document.createTreeWalker(record.element, NodeFilter.SHOW_TEXT);
  let current;
  while ((current = walker.nextNode())) {
    if (!isStructurallyProcessableTextNode(current)) continue;
    if (getRegisteredLongPageBlockForNode(current) !== record) continue;
    if (processedNodes.has(current)) continue;
    if (includeVisibility && !isProcessableTextNode(current)) continue;
    if (callback(current) === false) break;
  }
}

function hasOwnedLongPageText(record, { includeVisibility = true } = {}) {
  let found = false;
  walkOwnedLongPageTextNodes(record, () => {
    found = true;
    return false;
  }, { includeVisibility });
  return found;
}

function getConfiguredLongPageRoots(rootNode, siteConfig, container) {
  const element = rootNode?.nodeType === Node.TEXT_NODE ? rootNode.parentElement : rootNode;
  if (!element || !siteConfig?.selectors?.length) return element ? [element] : [];
  const roots = [];
  for (const selector of siteConfig.selectors) {
    try {
      if (element.matches?.(selector)) roots.push(element);
      element.querySelectorAll?.(selector).forEach((match) => roots.push(match));
      const ancestor = element.parentElement?.closest?.(selector);
      if (ancestor && isNodeInsideContainer(ancestor, container)) roots.push(ancestor);
    } catch (_) {
      // Invalid site selector; keep the other selectors usable.
    }
  }
  return Array.from(new Set(roots)).filter((root) => isNodeInsideContainer(root, container));
}

function registerLongPageBlocks(rootNode, siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default, container = dynamicContainer) {
  if (!longPageMode || !rootNode) return [];
  const added = [];
  for (const root of getConfiguredLongPageRoots(rootNode, siteConfig, container)) {
    const plan = collectLongPagePlan(root);
    for (const candidate of plan.blocks) {
      const existing = longPageBlockByElement.get(candidate.element);
      if (existing) {
        existing.japaneseCharacterCount = Math.max(existing.japaneseCharacterCount, candidate.japaneseCharacterCount);
        continue;
      }
      longPageBlockByElement.set(candidate.element, candidate);
      longPageBlocks.push(candidate);
      added.push(candidate);
    }
  }
  return added;
}

function getYoutubeCaptionContainer() {
  return document.querySelector('.ytp-caption-window-container') ||
    document.querySelector('.caption-window') ||
    document.querySelector('.ytp-caption-segment') ||
    null;
}

function collectCaptionTextNodes(rootNode) {
  if (!rootNode) return [];
  const walker = document.createTreeWalker(
    rootNode,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!isNodeVisible(node)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('ruby')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-tsukeru-caption-processed]')) return NodeFilter.FILTER_REJECT;

        const text = node.textContent || '';
        if (!text.trim()) return NodeFilter.FILTER_SKIP;
        if (!/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) return NodeFilter.FILTER_SKIP;

        return NodeFilter.FILTER_ACCEPT;
      },
    },
    false
  );

  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}

// ── Batch building ────────────────────────────────────────────────────────────

function buildBatches(nodes) {
  const batches = [];
  let currentNodes = [];
  let currentMarkers = [];
  let parts = [];
  let byteCount = 0;
  let batchIndex = 0;
  const encoder = new TextEncoder();

  const flush = () => {
    if (!currentNodes.length) return;
    batches.push({
      nodes: currentNodes,
      markers: currentMarkers,
      payload: parts.join(''),
      byteCount,
      sourceTexts: currentNodes.map((node) => node.textContent || ''),
    });
    currentNodes = [];
    currentMarkers = [];
    parts = [];
    byteCount = 0;
    batchIndex += 1;
  };

  const addOversizedBatch = (node, text) => {
    batches.push({
      nodes: [node],
      markers: [],
      payload: '',
      byteCount: 0,
      sourceTexts: [text],
      oversizedNode: node,
    });
    batchIndex += 1;
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const text = node.textContent || '';
    const marker = `${TOKEN_PREFIX}${batchIndex}_${currentNodes.length}__`;
    const entryBytes = encoder.encode(text).length + marker.length; // marker is ASCII

    if (entryBytes > MAX_BATCH_BYTES) {
      flush();
      addOversizedBatch(node, text);
      continue;
    }
    if (currentNodes.length && byteCount + entryBytes > MAX_BATCH_BYTES) {
      flush();
    }

    parts.push(marker, text);
    currentNodes.push(node);
    currentMarkers.push(marker);
    byteCount += entryBytes;

    if (byteCount === MAX_BATCH_BYTES) flush();
  }
  flush();
  return batches;
}

// ── Batch application ─────────────────────────────────────────────────────────

function isBatchTargetCurrent(batch, index) {
  const node = batch?.nodes?.[index];
  return Boolean(
    node &&
    node.parentNode &&
    node.isConnected !== false &&
    node.textContent === batch.sourceTexts?.[index]
  );
}

function extractBatchResultChunks(batch, processedHTML) {
  const results = new Map();
  if (!batch?.markers?.length) return results;

  const markerPattern = batch.markers.map(escapeRegex).join('|');
  const splitRegex = new RegExp(`(${markerPattern})`, 'g');
  const chunks = String(processedHTML || '').split(splitRegex).filter(Boolean);
  const markerToIndex = new Map(batch.markers.map((marker, index) => [marker, index]));
  let currentIndex = -1;

  for (const chunk of chunks) {
    if (markerToIndex.has(chunk)) {
      currentIndex = markerToIndex.get(chunk);
      continue;
    }
    if (currentIndex === -1) continue;
    results.set(currentIndex, `${results.get(currentIndex) || ''}${chunk}`);
    currentIndex = -1;
  }
  return results;
}

function splitLongPageTextIntoSegments(text, batchSerial) {
  const sourceText = String(text || '');
  const encoder = new TextEncoder();
  const segments = [];
  const isGoodBoundary = (character) => /[\s\u3000、。，．！？!?;；：:）)】〕］〉》」』’”]/u.test(character);
  let offset = 0;
  let segmentIndex = 0;

  while (offset < sourceText.length) {
    const marker = `${TOKEN_PREFIX}long_${batchSerial}_oversized_${segmentIndex}__`;
    const maxTextBytes = MAX_BATCH_BYTES - marker.length;
    let cursor = offset;
    let lastBoundary = offset;
    let textBytes = 0;

    while (cursor < sourceText.length) {
      const codePoint = sourceText.codePointAt(cursor);
      const character = String.fromCodePoint(codePoint);
      const characterBytes = encoder.encode(character).length;
      if (textBytes + characterBytes > maxTextBytes) break;
      textBytes += characterBytes;
      cursor += character.length;
      if (isGoodBoundary(character)) lastBoundary = cursor;
    }

    if (cursor === offset) {
      throw new Error('Unable to split oversized text node within the request limit');
    }
    const end = cursor < sourceText.length && lastBoundary > offset + 32 ? lastBoundary : cursor;
    const segmentText = sourceText.slice(offset, end);
    segments.push({
      marker,
      text: segmentText,
      byteCount: marker.length + encoder.encode(segmentText).length,
    });
    offset = end;
    segmentIndex += 1;
  }

  return segments;
}

async function processOversizedNode(batch, settings, operation, {
  markProcessed = true,
  markCaption = false,
  onInserted = null,
  isCurrent = null,
} = {}) {
  const sourceText = batch.sourceTexts?.[0] || '';
  const segments = splitLongPageTextIntoSegments(sourceText, longPageBatchSerial++);
  const processedSegments = [];
  const isOperationCurrent = isCurrent || (() => operation?.isCurrent?.() ?? isDynamicOperationCurrent(operation));
  const signal = operation?.controller?.signal || null;

  for (let index = 0; index < segments.length; index += 1) {
    if (!isOperationCurrent()) return { inserted: 0, skipped: 0, cancelled: true };
    if (!isBatchTargetCurrent(batch, 0)) return { inserted: 0, skipped: 1, cancelled: false };
    const segment = segments[index];
    const segmentBatch = {
      nodes: [batch.oversizedNode],
      markers: [segment.marker],
      sourceTexts: [segment.text],
    };
    const response = await sendFuriganaWithRateLimitRetry({
      textContent: `${segment.marker}${segment.text}`,
      settings,
      tabUrl: window.location.href,
    }, 3, isOperationCurrent, signal);
    if (!isOperationCurrent()) return { inserted: 0, skipped: 0, cancelled: true };

    const processedHTML = extractBatchResultChunks(segmentBatch, response.processedHTML).get(0);
    if (processedHTML === undefined) {
      throw new Error('Missing processed HTML for oversized text segment');
    }
    processedSegments.push(processedHTML);
    if (index < segments.length - 1) {
      await delayWithAbort(batchDelay(segment.byteCount), signal);
    }
  }

  if (!isOperationCurrent()) return { inserted: 0, skipped: 0, cancelled: true };
  const targetNode = batch.oversizedNode;
  if (!isBatchTargetCurrent(batch, 0)) return { inserted: 0, skipped: 1, cancelled: false };
  const replaced = replaceTextNodeWithHtml(targetNode, processedSegments.join(''), {
    markCaption,
    expectedText: sourceText,
    onInserted,
  });
  if (!replaced) return { inserted: 0, skipped: 1, cancelled: false };
  if (markProcessed) processedNodes.add(targetNode);
  return { inserted: 1, skipped: 0, cancelled: false };
}

async function processOversizedLongPageNode(batch, settings, operation) {
  return processOversizedNode(batch, settings, operation, {
    onInserted: (wrapper) => applySavedVocabularyHighlightsTo(wrapper),
  });
}

async function applyBatchResult(batch, processedHTML, markProcessed = true, markCaption = false, isTargetValid = null, {
  signal = null,
  operationIsCurrent = null,
  onInserted = null,
} = {}) {
  if (!batch.markers.length) return { inserted: 0, skipped: 0, cancelled: false };
  const processedChunks = extractBatchResultChunks(batch, processedHTML);
  let inserted = 0;
  let skipped = 0;
  let sliceStart = getMonotonicNow();

  for (const [currentIndex, chunk] of processedChunks) {
    if (signal?.aborted || (operationIsCurrent && !operationIsCurrent())) {
      return { inserted, skipped, cancelled: true };
    }
    const targetNode = batch.nodes[currentIndex];
    if (isTargetValid && !isTargetValid(targetNode, currentIndex)) {
      skipped += 1;
      continue;
    }
    const replaced = replaceTextNodeWithHtml(targetNode, chunk, {
      markCaption,
      expectedText: batch.sourceTexts?.[currentIndex],
      onInserted,
    });
    if (replaced && markProcessed) {
      // processedNodes is a var global from content-main.js
      processedNodes.add(targetNode);
    }
    if (replaced) inserted += 1;
    else skipped += 1;

    if (inserted && (inserted % MAX_INSERTIONS_PER_SLICE === 0 || getMonotonicNow() - sliceStart >= MAX_INSERTION_SLICE_MS)) {
      await delayWithAbort(0, signal);
      if (signal?.aborted || (operationIsCurrent && !operationIsCurrent())) {
        return { inserted, skipped, cancelled: true };
      }
      sliceStart = getMonotonicNow();
    }
  }
  return { inserted, skipped, cancelled: false };
}

function replaceTextNodeWithHtml(node, html, { markCaption = false, expectedText, onInserted = null } = {}) {
  if (!node || !node.parentNode || node.isConnected === false) return false;
  const parent = node.parentNode;
  const originalText = node.textContent || '';
  if (expectedText !== undefined && originalText !== expectedText) return false;
  const fragment = sanitizeHtmlFragment(html || originalText);

  const wrapper = document.createElement('span');
  wrapper.setAttribute('data-tsukeru-wrapper', '1');
  wrapper.setAttribute('data-tsukeru-original', originalText);
  // originalTextMap is a var global from content-main.js
  originalTextMap.set(wrapper, originalText);
  wrapper.appendChild(fragment);

  if (markCaption) {
    parent.setAttribute('data-tsukeru-caption-processed', 'true');
  } else {
    parent.setAttribute('data-tsukeru-processed', 'true');
  }

  parent.replaceChild(wrapper, node);
  onInserted?.(wrapper);
  return true;
}

// ── HTML cleaning and snippet extraction ──────────────────────────────────────

function cleanHTML(node) {
  const temp = document.createElement('div');

  const blockElements = new Set([
    'p', 'div', 'br', 'li', 'td', 'th', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'article', 'section', 'blockquote', 'header', 'footer', 'nav', 'aside'
  ]);

  const skipElements = new Set([
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'video', 'audio',
    'img', 'input', 'button', 'select', 'textarea', 'form', 'nav', 'footer',
    'header', 'aside', 'figure', 'figcaption', 'time', 'abbr'
  ]);

  let lastWasSpace = false;

  function processNode(sourceNode, targetNode) {
    for (let child of sourceNode.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        let text = child.textContent.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');

        if (text === ' ' && lastWasSpace) continue;

        if (text) {
          targetNode.appendChild(document.createTextNode(text));
          lastWasSpace = text.endsWith(' ');
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tagName = child.nodeName.toLowerCase();

        if (skipElements.has(tagName)) continue;

        if (tagName === 'ruby') {
          const ruby = document.createElement('ruby');

          for (let attr of child.attributes) {
            if (attr.name.startsWith('data-')) {
              ruby.setAttribute(attr.name, attr.value);
            }
          }

          for (let rubyChild of child.childNodes) {
            if (rubyChild.nodeType === Node.TEXT_NODE) {
              ruby.appendChild(document.createTextNode(rubyChild.textContent));
            } else if (rubyChild.nodeName.toLowerCase() === 'rt') {
              const rt = document.createElement('rt');
              rt.textContent = rubyChild.textContent;
              ruby.appendChild(rt);
            }
          }

          targetNode.appendChild(ruby);
          lastWasSpace = false;
        } else if (tagName === 'span' && isAnalysisWordElement(child)) {
          const span = document.createElement('span');
          for (let attr of child.attributes) {
            if (attr.name.startsWith('data-')) {
              span.setAttribute(attr.name, attr.value);
            }
          }
          processNode(child, span);
          targetNode.appendChild(span);
          lastWasSpace = false;
        } else if (blockElements.has(tagName)) {
          if (!lastWasSpace) {
            targetNode.appendChild(document.createTextNode(' '));
            lastWasSpace = true;
          }
          processNode(child, targetNode);
          if (!lastWasSpace) {
            targetNode.appendChild(document.createTextNode(' '));
            lastWasSpace = true;
          }
        } else {
          processNode(child, targetNode);
        }
      }
    }
  }

  processNode(node, temp);

  let result = temp.innerHTML
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+([。、！？）」』】])/g, '$1')
    .replace(/([（「『【])\s+/g, '$1');

  return result;
}

function collectSegments(node, target, out) {
  for (const child of node.childNodes) {
    if (child === target) {
      out.push(null);
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) {
        out.push({ text: child.textContent, html: escapeHtml(child.textContent) });
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.nodeName.toLowerCase();
      if (isAnalysisWordElement(child)) {
        const clone = child.cloneNode(true);
        clone.querySelectorAll('rt').forEach(rt => rt.remove());
        out.push({ text: clone.textContent, html: child.outerHTML });
      } else {
        collectSegments(child, target, out);
      }
    }
  }
}

function findLastOf(text, chars) {
  return Math.max(-1, ...chars.map(c => text.lastIndexOf(c)));
}

function findFirstOf(text, chars) {
  const hits = chars.map(c => text.indexOf(c)).filter(i => i !== -1);
  return hits.length ? Math.min(...hits) : -1;
}

function trimSegments(segments, windowSize, isLeft) {
  const hardTerminators = ['。', '！', '？', '.', '!', '?', '\n'];
  const openBrackets    = ['「', '『', '（', '【', '《', '〈', '(', '[', '{', '"'];
  const closeBrackets   = ['」', '』', '）', '】', '》', '〉', ')', ']', '}', '"'];

  if (isLeft) {
    const result = [];
    let chars = 0;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      const hardIdx = findLastOf(seg.text, hardTerminators);
      const openIdx = findLastOf(seg.text, openBrackets);
      if (chars > 0 && (hardIdx !== -1 || openIdx !== -1)) {
        let partial;
        if (openIdx >= hardIdx) {
          partial = seg.text.slice(openIdx);
        } else {
          partial = seg.text.slice(hardIdx + 1);
        }
        if (partial) result.unshift({ text: partial, html: escapeHtml(partial) });
        break;
      }
      if (chars + seg.text.length > windowSize) {
        const partial = seg.text.slice(-(windowSize - chars));
        result.unshift({ text: partial, html: escapeHtml(partial) });
        break;
      }
      result.unshift(seg);
      chars += seg.text.length;
    }
    return result.map(s => s.html).join('').replace(/^[、\s]+/, '');
  }

  const rightTerminators = [...hardTerminators, ...closeBrackets];
  const result = [];
  let chars = 0;
  for (const seg of segments) {
    if (chars >= windowSize) break;
    const termIdx = findFirstOf(seg.text, rightTerminators);
    if (termIdx !== -1) {
      const partial = seg.text.slice(0, termIdx + 1);
      result.push({ text: partial, html: escapeHtml(partial) });
      break;
    }
    if (chars + seg.text.length > windowSize) {
      const partial = seg.text.slice(0, windowSize - chars);
      result.push({ text: partial, html: escapeHtml(partial) });
      break;
    }
    result.push(seg);
    chars += seg.text.length;
  }
  return result.map(s => s.html).join('');
}

function buildCenteredSnippet(html, markerAttr, leftWindowSize, rightWindowSize) {
  const temp = document.createElement('div');
  temp.innerHTML = html;

  const target = temp.querySelector(`ruby[${markerAttr}], span[${markerAttr}]`);
  if (!target) return '';

  const targetClone = target.cloneNode(true);
  targetClone.removeAttribute(markerAttr);
  const targetHtml = targetClone.outerHTML;

  const segments = [];
  collectSegments(temp, target, segments);

  const markerIdx = segments.indexOf(null);
  if (markerIdx === -1) return '';

  const leftHtml  = trimSegments(segments.slice(0, markerIdx), leftWindowSize, true);
  const rightHtml = trimSegments(segments.slice(markerIdx + 1).filter(Boolean), rightWindowSize, false);

  return `${leftHtml}${targetHtml}${rightHtml}`;
}

// ── Dynamic content observers ─────────────────────────────────────────────────

// Kept behind one named switch until SPA replacement has been verified in the
// supported browsers. It calls the same discovery path and is not a second
// processing queue.
const ENABLE_TEMPORARY_CONTAINER_POLL_FALLBACK = true;
const TEMPORARY_CONTAINER_POLL_INTERVAL_MS = 2000;

function getConfiguredContainer(siteConfig) {
  try {
    if (siteConfig?.useIntersectionObserver) {
      return siteConfig.containerSelector ? document.querySelector(siteConfig.containerSelector) : null;
    }
    return getDocumentProcessingRoot();
  } catch (_) {
    return siteConfig?.useIntersectionObserver ? null : getDocumentProcessingRoot();
  }
}

function getAddedNodeMatch(node, selector) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  try {
    if (node.matches?.(selector)) return node;
    return node.querySelector?.(selector) || null;
  } catch (_) {
    return null;
  }
}

function getAddedCaptionMatch(node) {
  for (const selector of ['.ytp-caption-window-container', '.caption-window', '.ytp-caption-segment']) {
    const match = getAddedNodeMatch(node, selector);
    if (match) return match;
  }
  return null;
}

function shouldRunContainerDiscovery(mutations, siteConfig) {
  if (!dynamicContainer || dynamicContainer.isConnected === false) return true;
  if (currentSite === 'youtube' && youtubeCaptionContainer?.isConnected === false) return true;
  for (const mutation of mutations) {
    if (mutation.type !== 'childList') continue;
    for (const node of mutation.addedNodes || []) {
      const replacement = getAddedNodeMatch(node, siteConfig.containerSelector);
      if (replacement && replacement !== dynamicContainer) return true;
      const captionReplacement = currentSite === 'youtube' ? getAddedCaptionMatch(node) : null;
      if (captionReplacement && captionReplacement !== youtubeCaptionContainer) return true;
    }
  }
  return false;
}

function isNodeInsideContainer(node, container) {
  if (!node || !container) return false;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return Boolean(element && (element === container || container.contains?.(element)));
}

function isDynamicWorkCurrent(generation, container) {
  return Boolean(
    lifecycleGeneration === generation &&
    dynamicContainer === container &&
    container?.isConnected !== false
  );
}

function isDynamicOperationCurrent(operation) {
  return Boolean(
    dynamicProcessingOperation === operation &&
    isDynamicWorkCurrent(operation.generation, operation.container)
  );
}

function isLongPageBlockInBuffer(record) {
  return Boolean(
    record?.element?.isConnected !== false &&
    (viewportVisibleBlocks.has(record.element) || viewportNearbyBlocks.has(record.element))
  );
}

function observeLongPageBlock(record) {
  if (!intersectionObserver || !record?.element?.isConnected || observedIntersectionElements.has(record.element)) return;
  record.element.setAttribute('data-tsukeru-observed', 'true');
  observedIntersectionElements.add(record.element);
  intersectionObserver.observe(record.element);
}

function updateLongPageViewport(entry, settings, generation) {
  if (!longPageMode || lifecycleGeneration !== generation) return;
  const record = longPageBlockByElement.get(entry.target);
  if (!record || !entry.target.isConnected) return;

  const rect = entry.boundingClientRect || entry.target.getBoundingClientRect?.() || {};
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  const isActuallyVisible = Boolean(
    entry.isIntersecting && rect.bottom > 0 && rect.top < viewportHeight
  );

  if (!entry.isIntersecting) {
    viewportVisibleBlocks.delete(entry.target);
    viewportNearbyBlocks.delete(entry.target);
    if (record.state === 'queued') record.state = 'waiting';
    dynamicPendingTargets.delete(entry.target);
    return;
  }

  if (isActuallyVisible) {
    viewportVisibleBlocks.add(entry.target);
    viewportNearbyBlocks.delete(entry.target);
  } else {
    viewportVisibleBlocks.delete(entry.target);
    viewportNearbyBlocks.add(entry.target);
  }

  if (record.state !== 'complete' && record.state !== 'processing') {
    record.state = 'queued';
    dynamicPendingTargets.add(record.element);
    scheduleDynamicDrain(settings, dynamicContainer, generation, 0);
  }
}

function getLongPageRecordForTarget(target) {
  if (!target) return null;
  if (target.nodeType === Node.TEXT_NODE) return getRegisteredLongPageBlockForNode(target);
  return longPageBlockByElement.get(target) || getRegisteredLongPageBlockForNode(target);
}

function getViewportMarginPixels() {
  return VIEWPORT_PREFETCH_PX;
}

function getLongPageViewportPosition(record) {
  const rect = record?.element?.getBoundingClientRect?.() || {};
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  const hasGeometry = Number.isFinite(top) && Number.isFinite(bottom);
  if (!hasGeometry) return { inBuffer: false, visible: false, distance: Number.POSITIVE_INFINITY };
  const margin = getViewportMarginPixels();
  const inBuffer = bottom >= -margin && top <= viewportHeight + margin;
  const visible = bottom > 0 && top < viewportHeight;
  const distance = visible ? 0 : (bottom < 0 ? -bottom : Math.max(0, top - viewportHeight));
  return { inBuffer, visible, distance };
}

function compareLongPageDocumentOrder(left, right) {
  if (left.element === right.element) return 0;
  const position = left.element.compareDocumentPosition?.(right.element) || 0;
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function selectLongPageRecords() {
  const records = [];
  const candidates = new Set([...viewportVisibleBlocks, ...viewportNearbyBlocks]);
  for (const element of candidates) {
    const record = longPageBlockByElement.get(element);
    if (!record || record.state !== 'queued') continue;
    if (!record.element.isConnected) {
      viewportVisibleBlocks.delete(element);
      viewportNearbyBlocks.delete(element);
      dynamicPendingTargets.delete(element);
      continue;
    }
    const position = getLongPageViewportPosition(record);
    if (!position.inBuffer) {
      viewportVisibleBlocks.delete(element);
      viewportNearbyBlocks.delete(element);
      dynamicPendingTargets.delete(element);
      if (record.state === 'queued') record.state = 'waiting';
      continue;
    }
    if (position.visible) {
      viewportVisibleBlocks.add(element);
      viewportNearbyBlocks.delete(element);
    } else {
      viewportVisibleBlocks.delete(element);
      viewportNearbyBlocks.add(element);
    }
    records.push({ record, visible: position.visible, distance: position.distance });
  }
  records.sort((left, right) => (
    Number(right.visible) - Number(left.visible) ||
    left.distance - right.distance ||
    compareLongPageDocumentOrder(left.record, right.record)
  ));
  return records.map(({ record }) => record);
}

function buildNextLongPageBatch() {
  const candidates = selectLongPageRecords();
  const nodes = [];
  const markers = [];
  const sourceTexts = [];
  const touchedBlocks = new Set();
  const parts = [];
  const encoder = new TextEncoder();
  let byteCount = 0;
  const batchSerial = longPageBatchSerial++;
  let batchFull = false;
  let oversizedNode = null;
  let oversizedRecord = null;

  for (const record of candidates) {
    if (!isLongPageBlockInBuffer(record) || record.state === 'complete' || record.state === 'processing') continue;
    let addedFromBlock = 0;
    walkOwnedLongPageTextNodes(record, (node) => {
      if (processingQueue.has(node)) return true;
      const text = node.textContent || '';
      const marker = `${TOKEN_PREFIX}long_${batchSerial}_${nodes.length}__`;
      const entryBytes = encoder.encode(text).length + marker.length;
      if (entryBytes > MAX_BATCH_BYTES) {
        if (nodes.length) {
          batchFull = true;
        } else {
          oversizedNode = node;
          oversizedRecord = record;
        }
        return false;
      }
      if (nodes.length && byteCount + entryBytes > MAX_BATCH_BYTES) {
        batchFull = true;
        return false;
      }
      parts.push(marker, text);
      nodes.push(node);
      markers.push(marker);
      sourceTexts.push(text);
      byteCount += entryBytes;
      addedFromBlock += 1;
      if (byteCount === MAX_BATCH_BYTES) batchFull = true;
      return true;
    });
    if (addedFromBlock) {
      record.state = 'processing';
      touchedBlocks.add(record);
    }
    if (batchFull || oversizedNode) break;
  }

  if (oversizedNode) {
    oversizedRecord.state = 'processing';
    touchedBlocks.add(oversizedRecord);
    return {
      nodes: [oversizedNode],
      markers: [],
      payload: '',
      byteCount: 0,
      sourceTexts: [oversizedNode.textContent || ''],
      touchedBlocks,
      oversizedNode,
    };
  }
  if (!nodes.length) return null;
  return {
    nodes,
    markers,
    payload: parts.join(''),
    byteCount,
    sourceTexts,
    touchedBlocks,
  };
}

function markLongPageFirstWorkSucceeded() {
  if (longPageFirstWorkState === 'pending') longPageFirstWorkState = 'succeeded';
}

function markLongPageFirstWorkFailed(error) {
  if (longPageFirstWorkState !== 'pending' || error?.cancelled) return;
  longPageFirstWorkState = 'failed';
  if (!error?.rateLimitType) {
    console.error('Tsukeru: failed to process the initial visible page content', error);
    showToast(getUserFacingApplyError(error), { type: 'error', duration: 8000 });
    setHighlightMode('off');
  }
}

function finalizeLongPageBatch(batch, operation, { allowRetry = true } = {}) {
  if (lifecycleGeneration !== operation.generation || !longPageMode) return;
  for (const record of batch.touchedBlocks) {
    if (!record.element.isConnected || !longPageBlockByElement.has(record.element)) continue;
    record.state = 'waiting';
    if (!hasOwnedLongPageText(record, { includeVisibility: false })) {
      record.state = 'complete';
      viewportVisibleBlocks.delete(record.element);
      viewportNearbyBlocks.delete(record.element);
      dynamicPendingTargets.delete(record.element);
      const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
      if (!(dynamicSettings?.watchDynamic || siteConfig.useIntersectionObserver) && intersectionObserver) {
        intersectionObserver.unobserve(record.element);
        observedIntersectionElements.delete(record.element);
        record.element.removeAttribute('data-tsukeru-observed');
      }
      continue;
    }
    if (allowRetry && isLongPageBlockInBuffer(record)) {
      record.state = 'queued';
      dynamicPendingTargets.add(record.element);
    } else {
      dynamicPendingTargets.delete(record.element);
    }
  }
}

function processLongPageMutations(mutations, settings, container, generation) {
  if (!isDynamicWorkCurrent(generation, container)) return;
  const affected = new Set();
  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  for (const mutation of mutations) {
    if (mutation.type === 'characterData') {
      if (isExtensionOwnedElement(mutation.target) || isManagedWrapperNode(mutation.target)) continue;
      const record = getRegisteredLongPageBlockForNode(mutation.target);
      if (record) {
        record.state = 'waiting';
        affected.add(record);
      }
      continue;
    }
    if (mutation.removedNodes?.length && !isOwnedTextReplacementMutation(mutation)) {
      cleanupPending = true;
    }
    for (const node of mutation.addedNodes || []) {
      if (isExtensionOwnedElement(node) || isManagedWrapperNode(node)) continue;
      const addedBlocks = registerLongPageBlocks(node, siteConfig, container);
      addedBlocks.forEach(observeLongPageBlock);
      const record = getLongPageRecordForTarget(node);
      if (record) {
        record.state = 'waiting';
        affected.add(record);
      }
    }
  }
  for (const record of affected) {
    if (isLongPageBlockInBuffer(record)) {
      record.state = 'queued';
      dynamicPendingTargets.add(record.element);
    }
  }
  if (dynamicPendingTargets.size || cleanupPending) scheduleDynamicDrain(settings, container, generation, 0);
}

function addIntersectionCandidates(root, container, siteConfig) {
  if (!intersectionObserver || !root || !isNodeInsideContainer(root, container)) return;
  if (longPageMode) {
    const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
    registerLongPageBlocks(root, siteConfig, container).forEach(observeLongPageBlock);
    return;
  }
  const candidates = [];
  const addMatching = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    for (const selector of siteConfig.selectors) {
      try {
        if (element.matches?.(selector)) candidates.push(element);
        element.querySelectorAll?.(selector).forEach((match) => candidates.push(match));
      } catch (_) {
        // Invalid site selector; keep the other selectors usable.
      }
    }
  };
  addMatching(root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement);
  candidates.forEach((element) => {
    if (!element.isConnected || observedIntersectionElements.has(element)) return;
    element.setAttribute('data-tsukeru-observed', 'true');
    observedIntersectionElements.add(element);
    intersectionObserver.observe(element);
  });
}

function observeConfiguredElements(container, siteConfig) {
  if (!intersectionObserver || !container) return;
  if (longPageMode) {
    longPageBlocks.forEach(observeLongPageBlock);
    return;
  }
  if (!siteConfig.selectors.length) return;
  addIntersectionCandidates(container, container, siteConfig);
}

function cleanupIntersectionTargets(container) {
  if (longPageMode) {
    const retainedBlocks = [];
    for (const record of longPageBlocks) {
      const element = record.element;
      if (!element.isConnected || !isNodeInsideContainer(element, container)) {
        viewportVisibleBlocks.delete(element);
        viewportNearbyBlocks.delete(element);
        dynamicPendingTargets.delete(element);
        intersectionObserver?.unobserve(element);
        observedIntersectionElements.delete(element);
        element.removeAttribute('data-tsukeru-observed');
        longPageBlockByElement.delete(element);
      } else {
        retainedBlocks.push(record);
      }
    }
    longPageBlocks = retainedBlocks;
    cleanupPending = false;
    return;
  }
  if (!intersectionObserver) {
    cleanupPending = false;
    return;
  }
  for (const element of observedIntersectionElements) {
    const disconnected = !element.isConnected || !isNodeInsideContainer(element, container);
    const completed = element.hasAttribute('data-tsukeru-processed') || collectTextNodes(element).length === 0;
    if (!disconnected && !completed) continue;
    intersectionObserver.unobserve(element);
    element.removeAttribute('data-tsukeru-observed');
    observedIntersectionElements.delete(element);
  }
  cleanupPending = false;
}

function collapseDynamicTargets(targets) {
  const list = Array.from(targets).filter((target) => target && target.isConnected !== false);
  return list.filter((target, index) => {
    const element = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    return !list.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      const otherElement = other.nodeType === Node.TEXT_NODE ? other.parentElement : other;
      return Boolean(otherElement && otherElement !== element && otherElement.contains?.(element));
    });
  });
}

function collectDynamicTextNodes(targets, container, siteConfig) {
  const nodes = new Set();
  for (const target of collapseDynamicTargets(targets)) {
    if (!isNodeInsideContainer(target, container)) continue;
    if (target.nodeType === Node.TEXT_NODE) {
      if (isProcessableTextNode(target)) nodes.add(target);
      continue;
    }

    let roots = [];
    if (siteConfig.selectors.length) {
      for (const selector of siteConfig.selectors) {
        try {
          if (target.matches?.(selector)) roots.push(target);
          target.querySelectorAll?.(selector).forEach((match) => roots.push(match));
          const ancestor = target.parentElement?.closest?.(selector);
          if (ancestor && isNodeInsideContainer(ancestor, container)) roots.push(ancestor);
        } catch (_) {
          // Invalid site selector; keep the other selectors usable.
        }
      }
    } else {
      roots = [target];
    }

    for (const root of new Set(roots)) collectTextNodes(root).forEach((node) => nodes.add(node));
  }
  return Array.from(nodes);
}

function scheduleDynamicDrain(settings, container, generation, delayMs) {
  if (!isDynamicWorkCurrent(generation, container) || dynamicDrainTimer !== null || dynamicProcessingOperation) return;
  dynamicSettings = settings;
  dynamicDrainContainer = container;
  dynamicDrainTimer = setTimeout(() => {
    dynamicDrainTimer = null;
    if (dynamicDrainContainer === container) dynamicDrainContainer = null;
    drainDynamicQueue(settings, container, generation);
  }, Math.max(0, delayMs));
}

function enqueueDynamicTargets(targets, settings, container = dynamicContainer, generation = lifecycleGeneration, delayMs = 0) {
  if (!isDynamicWorkCurrent(generation, container)) return;
  dynamicSettings = settings;
  if (longPageMode) {
    for (const target of targets) {
      const record = getLongPageRecordForTarget(target);
      if (!record || record.state === 'complete' || !isLongPageBlockInBuffer(record)) continue;
      if (record.state !== 'processing') record.state = 'queued';
      dynamicPendingTargets.add(record.element);
    }
    if (dynamicPendingTargets.size) scheduleDynamicDrain(settings, container, generation, delayMs);
    return;
  }
  for (const target of targets) {
    if (target && target.isConnected !== false) dynamicPendingTargets.add(target);
  }
  if (dynamicPendingTargets.size) {
    const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
    scheduleDynamicDrain(settings, container, generation, delayMs || siteConfig.debounceDelay);
  }
}

function processMutations(mutations, settings, container = dynamicContainer, generation = lifecycleGeneration) {
  if (!isDynamicWorkCurrent(generation, container)) return;
  if (longPageMode) {
    processLongPageMutations(mutations, settings, container, generation);
    return;
  }
  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  const targets = [];
  for (const mutation of mutations) {
    if (mutation.type === 'characterData') {
      if (isExtensionOwnedElement(mutation.target) || isManagedWrapperNode(mutation.target)) continue;
      targets.push(mutation.target);
      continue;
    }
    if (mutation.removedNodes?.length && !isOwnedTextReplacementMutation(mutation)) {
      cleanupPending = true;
    }
    mutation.addedNodes?.forEach((node) => {
      if (isExtensionOwnedElement(node) || isManagedWrapperNode(node)) return;
      targets.push(node);
      if (intersectionObserver) addIntersectionCandidates(node, container, siteConfig);
    });
  }
  enqueueDynamicTargets(targets, settings, container, generation);
  if (cleanupPending) scheduleDynamicDrain(settings, container, generation, siteConfig.debounceDelay);
}

async function drainLongPageQueue(settings, container, generation) {
  const batch = buildNextLongPageBatch();
  if (!batch) {
    cleanupIntersectionTargets(container);
    return;
  }

  const operation = {
    token: Symbol('long-page'),
    generation,
    container,
    controller: new AbortController(),
  };
  dynamicProcessingOperation = operation;
  batch.nodes.forEach((node) => processingQueue.set(node, operation));
  let allowRetry = true;

  try {
    if (!isDynamicOperationCurrent(operation)) return;
    let result;
    if (batch.oversizedNode) {
      result = await processOversizedLongPageNode(batch, settings, operation);
    } else {
      const response = await sendFuriganaWithRateLimitRetry({
        textContent: batch.payload,
        settings,
        tabUrl: window.location.href,
      }, 3, () => isDynamicOperationCurrent(operation), operation.controller.signal);
      if (!isDynamicOperationCurrent(operation)) return;
      result = await applyBatchResult(
        batch,
        response.processedHTML,
        true,
        false,
        (node, index) => isDynamicOperationCurrent(operation) && isBatchTargetCurrent(batch, index),
        {
          signal: operation.controller.signal,
          operationIsCurrent: () => isDynamicOperationCurrent(operation),
          onInserted: (wrapper) => applySavedVocabularyHighlightsTo(wrapper),
        }
      );
    }
    if (!result.cancelled && isDynamicOperationCurrent(operation)) {
      markLongPageFirstWorkSucceeded();
    } else if (result.cancelled) {
      allowRetry = false;
    }
  } catch (error) {
    allowRetry = false;
    if (isDynamicOperationCurrent(operation)) markLongPageFirstWorkFailed(error);
    if (!error.cancelled && !error.rateLimitType && longPageFirstWorkState !== 'failed') {
      console.error('Tsukeru: failed to process long-page content', error);
    }
  } finally {
    batch.nodes.forEach((node) => {
      if (processingQueue.get(node) === operation) processingQueue.delete(node);
    });
    if (isDynamicOperationCurrent(operation)) {
      finalizeLongPageBatch(batch, operation, { allowRetry });
    }
    if (dynamicProcessingOperation === operation) {
      dynamicProcessingOperation = null;
      if (dynamicContainer === container && (cleanupPending || !longPageMode)) cleanupIntersectionTargets(container);
      const currentContainer = dynamicContainer;
      const currentGeneration = lifecycleGeneration;
      const currentSettings = dynamicSettings || settings;
      if (
        currentContainer &&
        isDynamicWorkCurrent(currentGeneration, currentContainer) &&
        dynamicPendingTargets.size
      ) {
        scheduleDynamicDrain(currentSettings, currentContainer, currentGeneration, 0);
      }
    }
  }
}

async function drainDynamicQueue(settings, container, generation) {
  if (dynamicProcessingOperation || !isDynamicWorkCurrent(generation, container)) return;
  if (longPageMode) {
    return drainLongPageQueue(settings, container, generation);
  }
  const targets = Array.from(dynamicPendingTargets);
  dynamicPendingTargets.clear();
  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  const nodes = collectDynamicTextNodes(targets, container, siteConfig)
    .filter((node) => !processingQueue.has(node) && isProcessableTextNode(node));
  if (!nodes.length) {
    cleanupIntersectionTargets(container);
    if (dynamicPendingTargets.size) scheduleDynamicDrain(settings, container, generation, 0);
    return;
  }

  const operation = {
    token: Symbol('dynamic'),
    generation,
    container,
    controller: new AbortController(),
  };
  dynamicProcessingOperation = operation;
  nodes.forEach((node) => processingQueue.set(node, operation));
  try {
    const batches = buildBatches(nodes);
    for (let i = 0; i < batches.length; i++) {
      if (!isDynamicOperationCurrent(operation)) return;
      const batch = batches[i];
      if (batch.oversizedNode) {
        await processOversizedNode(batch, settings, operation);
      } else {
        const response = await sendFuriganaWithRateLimitRetry({
          textContent: batch.payload,
          settings,
          tabUrl: window.location.href,
        }, 3, () => isDynamicOperationCurrent(operation), operation.controller.signal);
        if (!isDynamicOperationCurrent(operation)) return;
        await applyBatchResult(
          batch,
          response.processedHTML,
          true,
          false,
          (node, index) => isDynamicOperationCurrent(operation) && isBatchTargetCurrent(batch, index),
          {
            signal: operation.controller.signal,
            operationIsCurrent: () => isDynamicOperationCurrent(operation),
          }
        );
      }
      if (i < batches.length - 1) {
        await delayWithAbort(batchDelay(batch.byteCount), operation.controller.signal);
      }
    }
  } catch (error) {
    if (!error.cancelled && !error.rateLimitType) console.error('Tsukeru: failed to process dynamic content', error);
  } finally {
    nodes.forEach((node) => {
      if (processingQueue.get(node) === operation) processingQueue.delete(node);
    });
    if (dynamicProcessingOperation === operation) {
      dynamicProcessingOperation = null;
      if (dynamicContainer === container) cleanupIntersectionTargets(container);
      const currentContainer = dynamicContainer;
      const currentGeneration = lifecycleGeneration;
      const currentSettings = dynamicSettings || settings;
      if (currentContainer && isDynamicWorkCurrent(currentGeneration, currentContainer) && dynamicPendingTargets.size) {
        scheduleDynamicDrain(currentSettings, currentContainer, currentGeneration, 0);
      }
    }
  }
}

function bindDynamicContainer(settings, generation) {
  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  const nextContainer = getConfiguredContainer(siteConfig);
  if (!nextContainer) return;
  if (dynamicContainer === nextContainer && mutationObserver) {
    return;
  }
  const previousContainer = dynamicContainer;
  if (previousContainer && dynamicDrainTimer !== null && dynamicDrainContainer === previousContainer) {
    clearTimeout(dynamicDrainTimer);
    dynamicDrainTimer = null;
    dynamicDrainContainer = null;
  }
  dynamicPendingTargets.clear();
  if (dynamicProcessingOperation?.container === previousContainer) {
    dynamicProcessingOperation.controller.abort();
  }
  if (previousContainer && intersectionObserver) cleanupIntersectionTargets(previousContainer);
  cleanupPending = false;
  if (longPageMode && (longPagePlanRoot !== nextContainer || !longPageBlocks.length)) {
    installLongPagePlan(collectLongPagePlan(nextContainer), { force: true, rootNode: nextContainer });
  }
  if (mutationObserver) mutationObserver.disconnect();
  mutationObserver = null;
  dynamicContainer = nextContainer;
  mutationObserver = new MutationObserver((mutations) => {
    processMutations(mutations, settings, nextContainer, generation);
  });
  mutationObserver.observe(nextContainer, { childList: true, subtree: true, characterData: true });
  observeConfiguredElements(nextContainer, siteConfig);
  if (!longPageMode) enqueueDynamicTargets([nextContainer], settings, nextContainer, generation, 0);
}

function refreshYoutubeCaptionBinding(settings, generation) {
  if (currentSite !== 'youtube' || !isFuriganaActive || lifecycleGeneration !== generation) return;
  const nextContainer = getYoutubeCaptionContainer();
  if (!nextContainer && !youtubeCaptionContainer && !youtubeCaptionObserver) {
    if (!youtubeCaptionRetryTimer) startYoutubeCaptionsObserver(settings);
    return;
  }
  if (youtubeCaptionContainer === nextContainer && youtubeCaptionObserver) return;
  stopYoutubeCaptionsObserver();
  startYoutubeCaptionsObserver(settings);
}

function discoverDynamicTargets(settings, generation) {
  if (lifecycleGeneration !== generation || !isFuriganaActive) return;
  bindDynamicContainer(settings, generation);
  refreshYoutubeCaptionBinding(settings, generation);
}

function startWatchingDynamicContent(settings) {
  if (mutationObserver || containerDiscoveryObserver) return;
  const generation = lifecycleGeneration;
  dynamicSettings = settings;
  const stableAncestor = document.documentElement || document;
  containerDiscoveryObserver = new MutationObserver((mutations) => {
    const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
    if (shouldRunContainerDiscovery(mutations, siteConfig)) {
      discoverDynamicTargets(settings, generation);
    }
  });
  containerDiscoveryObserver.observe(stableAncestor, { childList: true, subtree: true });
  discoverDynamicTargets(settings, generation);
  if (ENABLE_TEMPORARY_CONTAINER_POLL_FALLBACK && !containerDiscoveryPollTimer) {
    containerDiscoveryPollTimer = setInterval(() => discoverDynamicTargets(settings, generation), TEMPORARY_CONTAINER_POLL_INTERVAL_MS);
  }
}

function startLongPageProcessing(settings) {
  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  if (settings.watchDynamic || siteConfig.useIntersectionObserver) {
    startWatchingDynamicContent(settings);
  } else if (!dynamicContainer) {
    dynamicContainer = getConfiguredContainer(siteConfig) || getDocumentProcessingRoot();
    dynamicSettings = settings;
  }
  startIntersectionObserver(settings);
  observeConfiguredElements(dynamicContainer, siteConfig);
}

function stopWatchingDynamicContent() {
  if (mutationObserver) mutationObserver.disconnect();
  if (containerDiscoveryObserver) containerDiscoveryObserver.disconnect();
  mutationObserver = null;
  containerDiscoveryObserver = null;
  if (containerDiscoveryPollTimer) clearInterval(containerDiscoveryPollTimer);
  containerDiscoveryPollTimer = null;
  dynamicProcessingOperation?.controller.abort();
  if (dynamicDrainTimer !== null) clearTimeout(dynamicDrainTimer);
  dynamicDrainTimer = null;
  dynamicDrainContainer = null;
  dynamicPendingTargets.clear();
  cleanupPending = false;
  dynamicContainer = null;
  dynamicSettings = null;
  dynamicProcessingOperation = null;
  processingQueue.clear();
}

function queueYoutubeCaptionProcessing(settings, generation, delayMs = 120) {
  if (lifecycleGeneration !== generation || !youtubeCaptionObserver) return;
  youtubeCaptionPending = true;
  youtubeCaptionSettings = settings;
  if (youtubeCaptionTimer !== null) return;
  youtubeCaptionTimer = setTimeout(() => {
    youtubeCaptionTimer = null;
    processYoutubeCaptions(settings, generation);
  }, delayMs);
}

async function processYoutubeCaptions(settings, generation) {
  const container = youtubeCaptionContainer;
  if (!container || !youtubeCaptionObserver || lifecycleGeneration !== generation) return;
  if (youtubeCaptionProcessingOperation) {
    youtubeCaptionPending = true;
    return;
  }
  youtubeCaptionPending = false;
  const operation = {
    token: Symbol('captions'),
    generation,
    container,
    controller: new AbortController(),
  };
  youtubeCaptionProcessingOperation = operation;
  try {
    const nodes = collectCaptionTextNodes(container);
    if (!nodes.length) return;
    const batches = buildBatches(nodes);
    for (let i = 0; i < batches.length; i++) {
      if (!isYoutubeCaptionOperationCurrent(operation)) return;
      const batch = batches[i];
      if (batch.oversizedNode) {
        await processOversizedNode(batch, settings, operation, {
          markProcessed: false,
          markCaption: true,
          isCurrent: () => isYoutubeCaptionOperationCurrent(operation),
        });
      } else {
        const response = await sendFuriganaWithRateLimitRetry({
          textContent: batch.payload,
          settings,
          tabUrl: window.location.href,
        }, 3, () => isYoutubeCaptionOperationCurrent(operation), operation.controller.signal);
        if (!isYoutubeCaptionOperationCurrent(operation)) return;
        await applyBatchResult(
          batch,
          response.processedHTML,
          false,
          true,
          (node, index) => isYoutubeCaptionOperationCurrent(operation) && isBatchTargetCurrent(batch, index),
          {
            signal: operation.controller.signal,
            operationIsCurrent: () => isYoutubeCaptionOperationCurrent(operation),
          }
        );
      }
      if (i < batches.length - 1) {
        await delayWithAbort(batchDelay(batch.byteCount), operation.controller.signal);
      }
    }
  } catch (error) {
    if (!error.cancelled && !error.rateLimitType) console.error('Tsukeru: YouTube captions processing failed', error);
  } finally {
    if (youtubeCaptionProcessingOperation === operation) {
      youtubeCaptionProcessingOperation = null;
      if (youtubeCaptionPending && isYoutubeCaptionWorkCurrent(generation, container)) {
        queueYoutubeCaptionProcessing(settings, generation, 0);
      }
    }
  }
}

function isYoutubeCaptionWorkCurrent(generation, container) {
  return Boolean(
    lifecycleGeneration === generation &&
    youtubeCaptionContainer === container &&
    container?.isConnected !== false &&
    youtubeCaptionObserver
  );
}

function isYoutubeCaptionOperationCurrent(operation) {
  return Boolean(
    youtubeCaptionProcessingOperation === operation &&
    isYoutubeCaptionWorkCurrent(operation.generation, operation.container)
  );
}

function startYoutubeCaptionsObserver(settings) {
  if (currentSite !== 'youtube') return;
  const generation = lifecycleGeneration;
  const container = getYoutubeCaptionContainer();
  if (youtubeCaptionObserver && youtubeCaptionContainer === container) return;
  if (!container) {
    youtubeCaptionContainer = null;
    clearTimeout(youtubeCaptionRetryTimer);
    youtubeCaptionRetryTimer = setTimeout(() => {
      youtubeCaptionRetryTimer = null;
      if (isFuriganaActive && lifecycleGeneration === generation) startYoutubeCaptionsObserver(settings);
    }, 1000);
    return;
  }
  youtubeCaptionContainer = container;
  youtubeCaptionSettings = settings;
  youtubeCaptionObserver = new MutationObserver(() => queueYoutubeCaptionProcessing(settings, generation));
  youtubeCaptionObserver.observe(container, { childList: true, subtree: true, characterData: true });
  processYoutubeCaptions(settings, generation);
}

function stopYoutubeCaptionsObserver() {
  clearTimeout(youtubeCaptionRetryTimer);
  youtubeCaptionRetryTimer = null;
  if (youtubeCaptionTimer !== null) clearTimeout(youtubeCaptionTimer);
  youtubeCaptionTimer = null;
  youtubeCaptionPending = false;
  youtubeCaptionSettings = null;
  youtubeCaptionProcessingOperation?.controller.abort();
  if (youtubeCaptionObserver) youtubeCaptionObserver.disconnect();
  youtubeCaptionObserver = null;
  youtubeCaptionContainer = null;
  youtubeCaptionProcessingOperation = null;
}

function startIntersectionObserver(settings) {
  if (intersectionObserver) return;
  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  if (!longPageMode && !siteConfig.selectors.length) return;
  const generation = lifecycleGeneration;
  intersectionObserver = new IntersectionObserver((entries) => {
    if (longPageMode) {
      entries.forEach((entry) => updateLongPageViewport(entry, settings, generation));
      return;
    }
    const visibleElements = entries.filter((entry) => entry.isIntersecting && entry.target.isConnected).map((entry) => entry.target);
    if (visibleElements.length) processVisibleElements(visibleElements, settings);
  }, { rootMargin: longPageMode ? VIEWPORT_ROOT_MARGIN : '50px', threshold: longPageMode ? 0 : 0.1 });
  if (dynamicContainer) observeConfiguredElements(dynamicContainer, siteConfig);
}

function stopIntersectionObserver() {
  if (intersectionObserver) intersectionObserver.disconnect();
  intersectionObserver = null;
  for (const element of observedIntersectionElements) element.removeAttribute('data-tsukeru-observed');
  observedIntersectionElements.clear();
  viewportVisibleBlocks.clear();
  viewportNearbyBlocks.clear();
}

function processVisibleElements(elements, settings) {
  if (longPageMode) {
    elements.forEach((element) => {
      const record = longPageBlockByElement.get(element);
      if (record) {
        viewportVisibleBlocks.add(element);
        viewportNearbyBlocks.delete(element);
      }
    });
  }
  enqueueDynamicTargets(elements, settings, dynamicContainer, lifecycleGeneration, 0);
}

// ── Page word extraction (for Vocab Mode) ─────────────────────────────────────

function extractAllPageWords() {
  const wordElements = getAnalysisWordElements(document);
  const wordMap = new Map();
  const snippetCache = new Map();
  let occurrenceCounter = 0;

  wordElements.forEach((element) => {
    const wordInfo = getAnalysisWordData(element);
    const surface = wordInfo.surface || '';
    const reading = wordInfo.reading || '';
    const dictForm = wordInfo.dictForm || surface;
    const dictReading = reading;

    const key = `${dictForm}|${dictReading}`;

    if (dictForm) {
      if (!wordMap.has(key)) {
        let snippet = '';
        try {
          const block = element.closest?.('p, li, td, blockquote, h1, h2, h3, h4, article') || element.parentElement;
          if (block) {
            if (!snippetCache.has(block)) snippetCache.set(block, getPageWordsSnippet(block));
            snippet = snippetCache.get(block);
          }
        } catch (e) { /* ignore */ }

        wordMap.set(key, {
          word: dictForm,
          reading,
          surface: surface,
          surfaceReading: wordInfo.surfaceReading || '',
          lookupReading: wordInfo.lookupReading || '',
          lookupReadingType: wordInfo.lookupReadingType || '',
          jlpt: wordInfo.jlpt || '',
          pos: wordInfo.pos || '',
          frequency: 1,
          occurrenceIndex: occurrenceCounter++,
          snippet: snippet,
          altReadings: wordInfo.altReadings || [],
        });
      } else {
        const existing = wordMap.get(key);
        existing.frequency = (existing.frequency || 0) + 1;
      }
    }
  });

  return Array.from(wordMap.values()).sort((a, b) => a.occurrenceIndex - b.occurrenceIndex);
}

function scrollToAndHighlightWord(word, reading) {
  const wordElements = getAnalysisWordElements(document);
  let foundElement = null;

  for (const element of wordElements) {
    const wordInfo = getAnalysisWordData(element);
    const dictForm = wordInfo.dictForm || '';
    const surface = wordInfo.surface || '';
    const readings = new Set([wordInfo.reading, wordInfo.surfaceReading, wordInfo.lookupReading].filter(Boolean));

    if (dictForm === word || surface === word) {
      if (!reading || readings.has(reading)) {
        foundElement = element;
        break;
      }
    }
  }

  if (!foundElement) {
    return { found: false };
  }

  document.querySelectorAll('.tsukeru-highlight').forEach(el => {
    el.classList.remove('tsukeru-highlight');
  });

  foundElement.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'center'
  });

  foundElement.classList.add('tsukeru-highlight');

  setTimeout(() => {
    foundElement.classList.remove('tsukeru-highlight');
  }, 3000);

  return { found: true };
}

function getWordContextSentence(word, reading) {
  const wordElements = getAnalysisWordElements(document);
  let foundElement = null;

  for (const element of wordElements) {
    const wordInfo = getAnalysisWordData(element);
    const dictForm = wordInfo.dictForm || '';
    const surface = wordInfo.surface || '';
    const readings = new Set([wordInfo.reading, wordInfo.surfaceReading, wordInfo.lookupReading].filter(Boolean));

    if (dictForm === word || surface === word) {
      if (!reading || readings.has(reading)) {
        foundElement = element;
        break;
      }
    }
  }

  if (!foundElement) {
    return { found: false, sentence: '' };
  }

  const sentence = extractSentenceContext(foundElement);
  return { found: true, sentence };
}
