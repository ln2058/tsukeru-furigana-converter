// Prevent double-injection when the script is inserted multiple times
if (window.__TSUKERU_LOADED__) {
} else {
  window.__TSUKERU_LOADED__ = true;

// Apply furigana by extracting text nodes, sending them as plain text to the backend,
// then reinserting ruby markup without replacing the entire page (works better on JS-heavy sites).

const TOKEN_PREFIX = '__TSUKERU_SPLIT__';
const MAX_BATCH_CHARS = 15000;
const REQUEST_DELAY_MS = 200;
const DICTIONARY_MAX_SENSES = 3;

let isProcessing = false;
let isFuriganaActive = false;
let mutationObserver = null;
let intersectionObserver = null;
let intersectionObserverInterval = null;
let youtubeCaptionObserver = null;
let youtubeCaptionRetryTimer = null;
let processedNodes = new WeakSet();
let debounceTimer = null;
let processingQueue = new Set();
let currentSite = detectSite();
let currentHighlightMode = 'off';
let dictionaryTooltip = null;
let dictionaryEventsBound = false;
const definitionCache = new Map();
let originalTextMap = new WeakMap();
const EXCLUDED_TEXT_PARENT_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'object', 'embed',
  'canvas', 'svg', 'code', 'pre', 'textarea', 'input', 'button',
  'select', 'option', 'math', 'time', 'data', 'var', 'kbd',
  'samp', 'rt', 'rp', 'ruby'
];

function isProcessableTextNode(node) {
  const parent = node?.parentNode;
  if (!parent) return false;
  if (processedNodes.has(node)) return false;

  const tag = parent.nodeName.toLowerCase();
  if (EXCLUDED_TEXT_PARENT_TAGS.includes(tag)) return false;

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
  if (!isNodeVisible(node)) return false;

  return true;
}

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
      '#content-text', // Comments
      '#description-text', // Video description
      'yt-formatted-string', // General text
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

function detectSite() {
  const hostname = window.location.hostname;
  if (hostname.includes('twitter.com') || hostname.includes('x.com')) return 'twitter';
  if (hostname.includes('youtube.com')) return 'youtube';
  if (hostname.includes('reddit.com')) return 'reddit';
  return 'default';
}

function setHighlightMode(mode = 'off') {
  const allowed = ['off', 'pos', 'jlpt'];
  currentHighlightMode = allowed.includes(mode) ? mode : 'off';
  document.documentElement.setAttribute('data-tsukeru-highlight', currentHighlightMode);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeHtmlFragment(html) {
  if (typeof html !== 'string' || !html) return '';

  const template = document.createElement('template');
  template.innerHTML = html;

  const fragment = document.createDocumentFragment();
  const allowedTags = new Set(['RUBY', 'RT']);

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

    if (!allowedTags.has(node.tagName)) {
      parent.appendChild(document.createTextNode(node.textContent || ''));
      return;
    }

    const clean = document.createElement(node.tagName.toLowerCase());
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

  const container = document.createElement('div');
  container.appendChild(fragment);
  return container.innerHTML;
}

function isNodeVisible(node) {
  const element = node.parentElement || node;
  if (!element || !element.isConnected) return false;

  // Skip anything explicitly hidden or living outside the main document flow
  if (element.closest('head, template, meta, title, [hidden], [aria-hidden=\"true\"], noscript, script, style')) {
    return false;
  }

  let current = element;
  while (current && current !== document.documentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = current.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }

    current = current.parentElement;
  }

  return true;
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'applyFurigana') {
    applyFurigana(request.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // keep the channel alive for async response
  }

  if (request.action === 'clearFurigana') {
    clearFurigana();
    sendResponse({ ok: true });
  }

  if (request.action === 'getFuriganaState') {
    sendResponse({ active: isFuriganaActive });
  }

  if (request.action === 'getPageWords') {
    const words = extractAllPageWords();
    sendResponse({ words });
  }

  if (request.action === 'scrollToWord') {
    const result = scrollToAndHighlightWord(request.word, request.reading);
    sendResponse(result);
  }

  if (request.action === 'getWordContext') {
    const result = getWordContextSentence(request.word, request.reading);
    sendResponse(result);
  }
});

async function applyFurigana(settings) {
  if (isProcessing) {
    return;
  }

  isProcessing = true;
  setHighlightMode(settings?.highlightMode || 'off');

  try {
    const textNodes = collectTextNodes();
    if (!textNodes.length) throw new Error('No text content found on page');

    const batches = buildBatches(textNodes);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
      const response = await chrome.runtime.sendMessage({
        action: 'processFurigana',
        payload: {
          textContent: batch.payload,
          settings,
          tabUrl: window.location.href,
        },
      });

      if (!response || !response.success || !response.processedHTML) {
        throw new Error(response?.error || 'Backend returned an empty response');
      }

      applyBatchResult(batch, response.processedHTML);

      if (i < batches.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    isFuriganaActive = true;

    // Enable dictionary popups on click
    enableDictionaryPopups();

    // Start watching for dynamic content if enabled
    if (settings.watchDynamic) {
      startWatchingDynamicContent(settings);

      // For sites with virtual scrolling, also use Intersection Observer
      const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
      if (siteConfig.useIntersectionObserver) {
        startIntersectionObserver(settings);
      }
    }

    // Always watch YouTube captions when on YouTube
    if (currentSite === 'youtube') {
      startYoutubeCaptionsObserver(settings);
    }

  } catch (error) {
    console.error('Error applying furigana:', error);
    alert('Failed to apply furigana: ' + error.message);
    setHighlightMode('off');
  } finally {
    isProcessing = false;
  }
}

function clearFurigana() {
  const wrappers = document.querySelectorAll('[data-tsukeru-wrapper="1"]');
  wrappers.forEach((wrapper) => {
    const originalText = originalTextMap.get(wrapper)
      ?? wrapper.getAttribute('data-tsukeru-original')
      ?? wrapper.textContent
      ?? '';
    wrapper.replaceWith(document.createTextNode(originalText));
  });
  document.querySelectorAll('[data-tsukeru-processed]').forEach(el => {
    el.removeAttribute('data-tsukeru-processed');
  });
  document.querySelectorAll('[data-tsukeru-caption-processed]').forEach(el => {
    el.removeAttribute('data-tsukeru-caption-processed');
  });
  document.querySelectorAll('[data-tsukeru-observed]').forEach(el => {
    el.removeAttribute('data-tsukeru-observed');
  });
  originalTextMap = new WeakMap();
  hideDefinitionTooltip();
  isFuriganaActive = false;
  processedNodes = new WeakSet();
  processingQueue.clear();
  stopWatchingDynamicContent();
  stopIntersectionObserver();
  stopYoutubeCaptionsObserver();
  setHighlightMode('off');
}

function collectTextNodes(rootNode = document.body) {
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

function buildBatches(nodes) {
  const batches = [];
  let currentNodes = [];
  let currentMarkers = [];
  let parts = [];
  let charCount = 0;
  let batchIndex = 0;

  const flush = () => {
    if (!currentNodes.length) return;
    batches.push({
      nodes: currentNodes,
      markers: currentMarkers,
      // Join without newlines to avoid backends converting them into <br> tags
      payload: parts.join(''),
    });
    currentNodes = [];
    currentMarkers = [];
    parts = [];
    charCount = 0;
    batchIndex += 1;
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const text = node.textContent || '';
    const marker = `${TOKEN_PREFIX}${batchIndex}_${currentNodes.length}__`;

    // Prefix each node with a marker so we can split the response reliably
    parts.push(marker);
    parts.push(text);

    currentNodes.push(node);
    currentMarkers.push(marker);
    charCount += text.length;

    if (charCount >= MAX_BATCH_CHARS) {
      flush();
    }
  }
  flush();
  return batches;
}

function applyBatchResult(batch, processedHTML, markProcessed = true, markCaption = false) {
  if (!batch.markers.length) return;
  const markerPattern = batch.markers.map(escapeRegex).join('|');
  const splitRegex = new RegExp(`(${markerPattern})`, 'g');
  const chunks = processedHTML.split(splitRegex).filter(Boolean);

  const markerToIndex = new Map(batch.markers.map((m, idx) => [m, idx]));
  let currentIndex = -1;

  for (const chunk of chunks) {
    if (markerToIndex.has(chunk)) {
      currentIndex = markerToIndex.get(chunk);
      continue;
    }
    if (currentIndex === -1) continue; // Skip content before the first marker
    const targetNode = batch.nodes[currentIndex];
    replaceTextNodeWithHtml(targetNode, chunk, { markCaption });
    if (markProcessed) {
      processedNodes.add(targetNode);
    }
    currentIndex = -1; // ensure one segment per marker
  }
}

function replaceTextNodeWithHtml(node, html, { markCaption = false } = {}) {
  if (!node || !node.parentNode) return;
  const parent = node.parentNode;
  const originalText = node.textContent || '';
  const safeHtml = sanitizeHtmlFragment(html || originalText);

  // Create a temporary container to parse HTML
  const temp = document.createElement('span');
  temp.style.display = 'inline'; // Ensure inline rendering
  temp.innerHTML = safeHtml;

  // Extract all child nodes from the temp container
  const fragment = document.createDocumentFragment();
  while (temp.firstChild) {
    fragment.appendChild(temp.firstChild);
  }

  const wrapper = document.createElement('span');
  wrapper.setAttribute('data-tsukeru-wrapper', '1');
  wrapper.setAttribute('data-tsukeru-original', originalText);
  originalTextMap.set(wrapper, originalText);
  wrapper.appendChild(fragment);

  // Mark the parent as processed to prevent re-processing
  if (markCaption) {
    parent.setAttribute('data-tsukeru-caption-processed', 'true');
  } else {
    parent.setAttribute('data-tsukeru-processed', 'true');
  }

  // Replace the text node with the wrapper
  parent.replaceChild(wrapper, node);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Dynamic content watching with MutationObserver
function startWatchingDynamicContent(settings) {
  if (mutationObserver) return; // Already watching

  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  const container = document.querySelector(siteConfig.containerSelector) || document.body;

  mutationObserver = new MutationObserver((mutations) => {
    // Debounce to avoid excessive processing
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processMutations(mutations, settings);
    }, siteConfig.debounceDelay);
  });

  mutationObserver.observe(container, {
    childList: true,
    subtree: true,
    characterData: true, // Watch for text content changes
    characterDataOldValue: false
  });

}

function stopWatchingDynamicContent() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
}

function startYoutubeCaptionsObserver(settings) {
  if (currentSite !== 'youtube') return;
  stopYoutubeCaptionsObserver();

  const container = getYoutubeCaptionContainer();
  if (!container) {
    clearTimeout(youtubeCaptionRetryTimer);
    youtubeCaptionRetryTimer = setTimeout(() => {
      if (isFuriganaActive) startYoutubeCaptionsObserver(settings);
    }, 1000);
    return;
  }

  const processCaptions = async () => {
    try {
      const nodes = collectCaptionTextNodes(container);
      if (!nodes.length) return;

      const batches = buildBatches(nodes);
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const response = await chrome.runtime.sendMessage({
          action: 'processFurigana',
          payload: {
            textContent: batch.payload,
            settings,
            tabUrl: window.location.href,
          },
        });

        if (response?.success && response.processedHTML) {
          applyBatchResult(batch, response.processedHTML, false, true);
        }

        if (i < batches.length - 1) {
          await sleep(REQUEST_DELAY_MS);
        }
      }
    } catch (err) {
      console.error('Tsukeru: YouTube captions processing failed', err);
    }
  };

  let captionTimer = null;
  youtubeCaptionObserver = new MutationObserver(() => {
    clearTimeout(captionTimer);
    captionTimer = setTimeout(processCaptions, 120);
  });

  youtubeCaptionObserver.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Initial run
  processCaptions();
}

function stopYoutubeCaptionsObserver() {
  clearTimeout(youtubeCaptionRetryTimer);
  if (youtubeCaptionObserver) {
    youtubeCaptionObserver.disconnect();
    youtubeCaptionObserver = null;
  }
}

// Intersection Observer for visible-only processing (performance optimization)
function startIntersectionObserver(settings) {
  if (intersectionObserver) return;

  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  if (!siteConfig.selectors.length) return;

  intersectionObserver = new IntersectionObserver((entries) => {
    const visibleElements = entries
      .filter(entry => entry.isIntersecting)
      .map(entry => entry.target);

    if (visibleElements.length === 0) return;

    // Process visible elements
    processVisibleElements(visibleElements, settings);
  }, {
    rootMargin: '50px', // Start processing slightly before element is visible
    threshold: 0.1
  });

  // Observe site-specific elements
  const observeNewElements = () => {
    for (const selector of siteConfig.selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (!el.hasAttribute('data-tsukeru-observed')) {
            el.setAttribute('data-tsukeru-observed', 'true');
            intersectionObserver.observe(el);
          }
        });
      } catch (e) {
        // Invalid selector
      }
    }
  };

  // Initial observation
  observeNewElements();

  // Re-check periodically for new elements (for sites with aggressive virtual scrolling)
  if (!intersectionObserverInterval) {
    intersectionObserverInterval = setInterval(() => {
      if (!intersectionObserver) return;
      observeNewElements();
    }, 2000);
  }

}

function stopIntersectionObserver() {
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  if (intersectionObserverInterval) {
    clearInterval(intersectionObserverInterval);
    intersectionObserverInterval = null;
  }
}

async function processVisibleElements(elements, settings) {
  const newNodes = [];

  for (const element of elements) {
    if (element.hasAttribute('data-tsukeru-processed')) continue;

    const textNodes = collectTextNodes(element);
    newNodes.push(...textNodes);
  }

  if (newNodes.length === 0) return;

  try {
    const batches = buildBatches(newNodes);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const response = await chrome.runtime.sendMessage({
        action: 'processFurigana',
        payload: {
          textContent: batch.payload,
          settings,
          tabUrl: window.location.href,
        },
      });

      if (response?.success && response.processedHTML) {
        applyBatchResult(batch, response.processedHTML);
      }

      if (i < batches.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }
  } catch (err) {
    console.error('Tsukeru: failed to process visible elements', err);
  }
}

async function processMutations(mutations, settings) {
  const newNodes = [];
  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;

  for (const mutation of mutations) {
    // Handle text content changes (for sites that mutate existing nodes)
    if (mutation.type === 'characterData') {
      const textNode = mutation.target;
      if (textNode && isProcessableTextNode(textNode)) {
        newNodes.push(textNode);
      }
    }

    // Handle new DOM nodes
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // Skip if already processed
        if (node.hasAttribute('data-tsukeru-processed')) continue;

        // For site-specific selectors, prioritize those elements
        if (siteConfig.selectors.length > 0) {
          const matchedElements = [];
          for (const selector of siteConfig.selectors) {
            try {
              if (node.matches && node.matches(selector)) {
                matchedElements.push(node);
              }
              matchedElements.push(...node.querySelectorAll(selector));
            } catch (e) {
              // Invalid selector, skip
            }
          }

          // Collect text nodes from matched elements
          for (const element of matchedElements) {
            const textNodes = collectTextNodes(element);
            newNodes.push(...textNodes);
          }
        } else {
          // Collect text nodes from the new element
          const textNodes = collectTextNodes(node);
          newNodes.push(...textNodes);
        }
    } else if (node.nodeType === Node.TEXT_NODE) {
      // Direct text node insertion
      if (isProcessableTextNode(node)) {
        newNodes.push(node);
      }
    }
  }
  }

  if (newNodes.length === 0) return;

  // Filter out nodes already in queue
  const uniqueNodes = newNodes.filter(node => {
    if (processingQueue.has(node)) return false;
    processingQueue.add(node);
    return true;
  });

  if (uniqueNodes.length === 0) return;

  try {
    const batches = buildBatches(uniqueNodes);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const response = await chrome.runtime.sendMessage({
        action: 'processFurigana',
        payload: {
          textContent: batch.payload,
          settings,
          tabUrl: window.location.href,
        },
      });

      if (response?.success && response.processedHTML) {
        applyBatchResult(batch, response.processedHTML);
      }

      if (i < batches.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }
  } catch (err) {
    console.error('Tsukeru: failed to process dynamic content', err);
  } finally {
    // Clear processing queue for these nodes
    uniqueNodes.forEach(node => {
      processingQueue.delete(node);
    });
  }
}

// Extract all unique words from page for Vocab Mode
function extractAllPageWords() {
  const rubyElements = document.querySelectorAll('ruby[data-surface]');
  const wordMap = new Map();

  rubyElements.forEach(ruby => {
    const surface = ruby.dataset.surface || '';
    const reading = ruby.dataset.reading || ruby.querySelector('rt')?.textContent || '';
    const jlpt = ruby.dataset.jlpt || '';
    const pos = ruby.dataset.pos || '';
    const dictForm = ruby.dataset.dictForm || surface;
    const dictReading = ruby.dataset.dictReading || reading;

    // Use dictionary form as the key to deduplicate
    const key = `${dictForm}|${dictReading}`;

    if (dictForm) {
      if (!wordMap.has(key)) {
        wordMap.set(key, {
          word: dictForm,
          reading: dictReading,
          surface: surface,
          jlpt: jlpt,
          pos: pos,
          frequency: 1
        });
      } else {
        const existing = wordMap.get(key);
        existing.frequency = (existing.frequency || 0) + 1;
      }
    }
  });

  // Convert to array and sort by word
  return Array.from(wordMap.values()).sort((a, b) => a.word.localeCompare(b.word, 'ja'));
}

// Dictionary pop-up handler and vocabulary saver
function enableDictionaryPopups() {
  if (dictionaryEventsBound) return;

  dictionaryEventsBound = true;
  document.addEventListener('click', handleDictionaryClick, true);
  document.addEventListener('dblclick', handleRubyDoubleClick, true);
  window.addEventListener('scroll', hideDefinitionTooltip, { passive: true });
  window.addEventListener('resize', hideDefinitionTooltip, { passive: true });
}

function handleDictionaryClick(event) {
  // Allow interactions inside the tooltip without closing it
  if (event.target.closest('#tsukeru-word-tooltip')) {
    return;
  }

  const ruby = event.target.closest('ruby');
  if (!ruby) {
    hideDefinitionTooltip();
    return;
  }

  // Ignore clicks on the ambiguous reading indicator
  if (event.target.closest('.alt-indicator')) return;

  const wordInfo = extractWordInfo(ruby);
  if (!wordInfo.word) return;

  event.preventDefault();
  event.stopPropagation();

  showDefinitionTooltip(ruby, wordInfo);
}

function extractWordInfo(ruby) {
  const readingFromAttrs = ruby.dataset.dictReading || ruby.dataset.reading || '';
  const readingFromRt = ruby.querySelector('rt')?.textContent || '';
  const surfaceReading = ruby.dataset.reading || readingFromRt;
  const surface = ruby.dataset.surface || ruby.querySelector('rb')?.textContent || ruby.textContent.replace(readingFromRt, '');
  const word = ruby.dataset.dictForm || ruby.dataset.surface || surface || '';
  const reading = readingFromAttrs || readingFromRt;

  return {
    word: (word || '').trim(),
    reading: (reading || '').trim(),
    surface: (surface || '').trim(),
    surfaceReading: (surfaceReading || '').trim(),
    jlpt: ruby.dataset.jlpt || '',
    pos: ruby.dataset.pos || ''
  };
}

async function showDefinitionTooltip(ruby, wordInfo) {
  const tooltip = ensureDictionaryTooltip();
  tooltip.dataset.word = wordInfo.word;
  tooltip.innerHTML = getTooltipLoadingHtml(wordInfo.word);

  positionTooltip(ruby, tooltip);
  tooltip.classList.add('show');
  addTooltipInteractionHandlers();

  try {
    const definitionData = await lookupDefinition(wordInfo.word);
    renderDefinitionTooltip(tooltip, wordInfo, definitionData);
  } catch (err) {
    console.error('Tsukeru: dictionary lookup failed', err);
    tooltip.innerHTML = getTooltipErrorHtml(wordInfo.word, 'Error loading definition');
    addTooltipInteractionHandlers();
  }
}

function ensureDictionaryTooltip() {
  if (dictionaryTooltip && dictionaryTooltip.isConnected) {
    return dictionaryTooltip;
  }
  dictionaryTooltip = document.createElement('div');
  dictionaryTooltip.id = 'tsukeru-word-tooltip';
  dictionaryTooltip.className = 'tsukeru-word-tooltip';
  document.body.appendChild(dictionaryTooltip);
  return dictionaryTooltip;
}

function addTooltipInteractionHandlers() {
  const tooltip = ensureDictionaryTooltip();
  const closeBtn = tooltip.querySelector('.tsukeru-tooltip-close');
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      hideDefinitionTooltip();
    };
  }

  const speakerBtn = tooltip.querySelector('.tsukeru-tooltip-speaker');
  if (speakerBtn) {
    speakerBtn.onclick = (e) => {
      e.stopPropagation();
      speakWord(speakerBtn.dataset.word || tooltip.dataset.word, speakerBtn);
    };
  }
}

function hideDefinitionTooltip() {
  if (dictionaryTooltip) {
    dictionaryTooltip.classList.remove('show');
    dictionaryTooltip.innerHTML = '';
  }
}

function positionTooltip(ruby, tooltip) {
  const rect = ruby.getBoundingClientRect();
  const tooltipWidth = 320;
  const tooltipHeight = 380;
  const padding = 10;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = rect.left + rect.width / 2;
  let transform = 'translateX(-50%)';

  if (left + tooltipWidth / 2 > viewportWidth - padding) {
    left = viewportWidth - tooltipWidth - padding;
    transform = 'translateX(0)';
  } else if (left - tooltipWidth / 2 < padding) {
    left = padding;
    transform = 'translateX(0)';
  }

  let top = rect.bottom + padding;
  if (top + tooltipHeight > viewportHeight - padding && rect.top - tooltipHeight - padding > 0) {
    top = rect.top - padding;
    transform += ' translateY(-100%)';
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.transform = transform;
}

function getTooltipLoadingHtml(word) {
  return `
    <button class="tsukeru-tooltip-close" aria-label="Close">&times;</button>
    <div class="tsukeru-tooltip-word">${escapeHtml(word)}</div>
    <div class="tsukeru-tooltip-loading">Loading...</div>
  `;
}

function getTooltipErrorHtml(word, message) {
  return `
    <button class="tsukeru-tooltip-close" aria-label="Close">&times;</button>
    <div class="tsukeru-tooltip-word">${escapeHtml(word)}</div>
    <div class="tsukeru-tooltip-error">${escapeHtml(message)}</div>
  `;
}

function renderDefinitionTooltip(tooltip, wordInfo, data) {
  if (data?.error) {
    tooltip.innerHTML = getTooltipErrorHtml(wordInfo.word, 'Dictionary not available');
    addTooltipInteractionHandlers();
    return;
  }

  const normalized = normalizeDefinitionData(data);
  if (!normalized || normalized.senses.length === 0) {
    tooltip.innerHTML = getTooltipErrorHtml(wordInfo.word, 'No definition found');
    addTooltipInteractionHandlers();
    return;
  }

  let html = `
    <button class="tsukeru-tooltip-close" aria-label="Close">&times;</button>
    <button class="tsukeru-tooltip-speaker" data-word="${escapeHtml(wordInfo.word)}" title="Listen">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
      </svg>
    </button>
    <div class="tsukeru-tooltip-word">${escapeHtml(wordInfo.word)}</div>
  `;

  const readingText = wordInfo.reading || normalized.reading;
  if (readingText) {
    html += `<div class="tsukeru-tooltip-reading">${escapeHtml(readingText)}</div>`;
  }

  const sensesToShow = normalized.senses.slice(0, DICTIONARY_MAX_SENSES);
  sensesToShow.forEach((sense) => {
    const gloss = (sense.glosses || []).join('; ');
    if (!gloss) return;

    html += '<div class="tsukeru-tooltip-sense">';
    if (sense.pos && sense.pos.length) {
      html += `<div class="tsukeru-tooltip-pos">${escapeHtml(sense.pos.join(', '))}</div>`;
    }
    html += `<div class="tsukeru-tooltip-gloss">${escapeHtml(gloss)}</div>`;
    html += '</div>';
  });

  if (normalized.senses.length > sensesToShow.length) {
    html += `<div class="tsukeru-tooltip-extra">+${normalized.senses.length - sensesToShow.length} more definitions</div>`;
  }

  tooltip.innerHTML = html;
  tooltip.classList.add('show');
  addTooltipInteractionHandlers();
}

function normalizeDefinitionData(data) {
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
    return null;
  }

  const entry = data.entries[0];
  const senses = Array.isArray(entry.senses) ? entry.senses : [];
  const trimmed = [];

  for (const sense of senses) {
    const glosses = Array.isArray(sense.glosses) ? sense.glosses.filter(Boolean) : [];
    if (!glosses.length) continue;
    trimmed.push({
      glosses: glosses.slice(0, 3),
      pos: Array.isArray(sense.pos) ? sense.pos.slice(0, 3) : []
    });
    if (trimmed.length >= 6) break;
  }

  return {
    senses: trimmed,
    reading: Array.isArray(entry.kana) && entry.kana.length ? entry.kana.join('、') : ''
  };
}

async function lookupDefinition(word) {
  const key = (word || '').trim();
  if (!key) return null;

  if (definitionCache.has(key)) {
    try {
      return await definitionCache.get(key);
    } catch (err) {
      definitionCache.delete(key);
    }
  }

  const promise = chrome.runtime.sendMessage({ action: 'lookupDefinition', word: key })
    .then((response) => {
      if (response?.success && response.data) {
        return response.data;
      }
      throw new Error(response?.error || 'Lookup failed');
    });

  definitionCache.set(key, promise);
  return promise;
}

async function handleRubyDoubleClick(event) {
  const ruby = event.target.closest('ruby');
  if (!ruby) return;

  event.preventDefault();
  event.stopPropagation();

  const wordInfo = extractWordInfo(ruby);
  if (!wordInfo.word) return;

  const sentenceContext = extractSentenceContext(ruby);

  const entry = {
    id: generateEntryId(),
    word: wordInfo.word,
    reading: wordInfo.reading || wordInfo.surfaceReading || wordInfo.surface,
    surface: wordInfo.surface || wordInfo.word,
    surfaceReading: wordInfo.surfaceReading || wordInfo.reading || '',
    sentence: sentenceContext,
    jlpt: wordInfo.jlpt,
    pos: wordInfo.pos,
    url: window.location.href,
    timestamp: Date.now()
  };

  try {
    await attachDefinitionToEntry(entry);
    await saveToVocabulary(entry);
    showVocabSavedToast(wordInfo.surface || wordInfo.word);
    ruby.classList.add('vocab-saved');
    setTimeout(() => ruby.classList.remove('vocab-saved'), 2000);
  } catch (err) {
    console.error('Tsukeru: failed to save vocabulary entry', err);
  }
}

async function attachDefinitionToEntry(entry) {
  try {
    const data = await lookupDefinition(entry.word);
    const normalized = normalizeDefinitionData(data);
    if (normalized) {
      entry.definition = normalized.senses.slice(0, DICTIONARY_MAX_SENSES).map(s => (s.glosses || []).join('; ')).filter(Boolean).join(' | ');
      entry.definitions = normalized.senses;
      if (!entry.reading && normalized.reading) {
        entry.reading = normalized.reading;
      }
    }
  } catch (err) {
    console.warn('Tsukeru: could not attach dictionary data to vocab entry', err);
  }
}

function speakWord(word, buttonElement) {
  if (!word || !('speechSynthesis' in window)) {
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'ja-JP';
  utterance.rate = 0.9;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  if (buttonElement) {
    buttonElement.classList.add('speaking');
  }

  utterance.onend = function() {
    if (buttonElement) {
      buttonElement.classList.remove('speaking');
    }
  };

  utterance.onerror = function() {
    if (buttonElement) {
      buttonElement.classList.remove('speaking');
    }
  };

  window.speechSynthesis.speak(utterance);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function extractSentenceContext(element) {
  // Find the containing block element - prefer larger containers for more context
  let container = element.closest('p, article, section, blockquote');
  if (!container || container.textContent.trim().length < 20) {
    container = element.closest('div, li, td, span');
  }
  if (!container) container = element.parentElement;
  if (!container) return element.textContent;

  // Mark the target so we can center the snippet around it
  const markerAttr = 'data-tsukeru-target';
  const hadMarker = element.hasAttribute(markerAttr);
  element.setAttribute(markerAttr, '1');

  // Clone the container to avoid modifying the actual DOM
  const clone = container.cloneNode(true);

  // Remove temporary marker from the live DOM
  if (!hadMarker) {
    element.removeAttribute(markerAttr);
  }

  // Clean the HTML: keep only text and ruby tags
  const cleanedHTML = cleanHTML(clone);

  // Center the snippet around the target ruby with a small window
  const centered = buildCenteredSnippet(cleanedHTML, markerAttr, 15);
  if (centered) return centered;

  // Limit length to reasonable size - allow longer sentences for better context
  if (cleanedHTML.length > 1000) {
    // Try to cut at a natural break point
    let cutPoint = cleanedHTML.lastIndexOf('。', 1000);
    if (cutPoint === -1 || cutPoint < 300) {
      cutPoint = cleanedHTML.lastIndexOf('、', 1000);
    }
    if (cutPoint === -1 || cutPoint < 300) {
      cutPoint = 1000;
    }
    return cleanedHTML.substring(0, cutPoint + 1) + (cutPoint < cleanedHTML.length - 1 ? '...' : '');
  }

  return cleanedHTML;
}

function buildCenteredSnippet(html, markerAttr, windowSize) {
  const temp = document.createElement('div');
  temp.innerHTML = html;

  const target = temp.querySelector(`ruby[${markerAttr}]`);
  if (!target) return '';

  // Save target HTML without the marker
  const targetClone = target.cloneNode(true);
  targetClone.removeAttribute(markerAttr);
  const targetHtml = targetClone.outerHTML;

   // Remove furigana text from surrounding context so we don't duplicate readings
  temp.querySelectorAll('rt').forEach(rt => rt.remove());

  // Replace target with a text marker so we can slice text around it
  const markerToken = '__TSUKERU_TARGET__';
  const markerNode = document.createTextNode(markerToken);
  target.replaceWith(markerNode);

  const fullText = temp.textContent || '';
  const markerIndex = fullText.indexOf(markerToken);
  if (markerIndex === -1) return '';

  const leftTextRaw = fullText.slice(0, markerIndex);
  const rightTextRaw = fullText.slice(markerIndex + markerToken.length);

  const leftWindow = trimSide(leftTextRaw, windowSize, true);
  const rightWindow = trimSide(rightTextRaw, windowSize, false);

  return `${escapeHtml(leftWindow)}${targetHtml}${escapeHtml(rightWindow)}`;
}

function trimSide(text, windowSize, isLeft) {
  if (!text) return '';
  if (isLeft) {
    let slice = text.slice(-windowSize);
    const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('、'));
    if (cut !== -1) {
      slice = slice.slice(cut + 1);
    }
    return slice;
  }

  let slice = text.slice(0, windowSize);
  const punctuations = [slice.indexOf('。'), slice.indexOf('、')].filter(i => i !== -1);
  if (punctuations.length) {
    slice = slice.slice(0, Math.min(...punctuations) + 1);
  }
  return slice;
}

function cleanHTML(node) {
  // Create a temporary container
  const temp = document.createElement('div');

  // Elements that should add spacing when traversed
  const blockElements = new Set([
    'p', 'div', 'br', 'li', 'td', 'th', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'article', 'section', 'blockquote', 'header', 'footer', 'nav', 'aside'
  ]);

  // Elements to skip entirely (no content extraction)
  const skipElements = new Set([
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'video', 'audio',
    'img', 'input', 'button', 'select', 'textarea', 'form', 'nav', 'footer',
    'header', 'aside', 'figure', 'figcaption', 'time', 'abbr'
  ]);

  let lastWasSpace = false;

  // Walk through all nodes and keep only text and ruby elements
  function processNode(sourceNode, targetNode) {
    for (let child of sourceNode.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        // Normalize whitespace in text nodes
        let text = child.textContent.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');

        // Don't add multiple spaces in a row
        if (text === ' ' && lastWasSpace) continue;

        if (text) {
          targetNode.appendChild(document.createTextNode(text));
          lastWasSpace = text.endsWith(' ');
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tagName = child.nodeName.toLowerCase();

        // Skip certain elements entirely
        if (skipElements.has(tagName)) continue;

        if (tagName === 'ruby') {
          // Keep ruby tags and their contents (preserve furigana)
          const ruby = document.createElement('ruby');

          // Copy data attributes from the original ruby tag
          for (let attr of child.attributes) {
            if (attr.name.startsWith('data-')) {
              ruby.setAttribute(attr.name, attr.value);
            }
          }

          // Process ruby children (should be text and <rt> tags)
          for (let rubyChild of child.childNodes) {
            if (rubyChild.nodeType === Node.TEXT_NODE) {
              ruby.appendChild(document.createTextNode(rubyChild.textContent));
            } else if (rubyChild.nodeName.toLowerCase() === 'rt') {
              const rt = document.createElement('rt');
              rt.textContent = rubyChild.textContent;
              ruby.appendChild(rt);
            }
            // Skip rp (ruby parentheses) and rb elements - just use their text
          }

          targetNode.appendChild(ruby);
          lastWasSpace = false;
        } else if (blockElements.has(tagName)) {
          // Add space for block elements to preserve word boundaries
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
          // For all other elements, recursively extract content
          processNode(child, targetNode);
        }
      }
    }
  }

  processNode(node, temp);

  // Final cleanup: normalize spaces and trim
  let result = temp.innerHTML
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+([。、！？）」』】])/g, '$1')  // Remove space before Japanese punctuation
    .replace(/([（「『【])\s+/g, '$1');         // Remove space after opening brackets

  return result;
}

async function saveToVocabulary(entry) {
  try {
    if (!entry.id) {
      entry.id = generateEntryId();
    }
    // Get existing vocabulary from storage
    const result = await chrome.storage.local.get(['vocabulary']);
    const vocabulary = result.vocabulary || [];

    // Check if word already exists (by dictionary form)
    const existingIndex = vocabulary.findIndex(v => v.word === entry.word && v.reading === entry.reading);

    if (existingIndex >= 0) {
      // Update existing entry
      vocabulary[existingIndex] = {
        ...vocabulary[existingIndex],
        ...entry,
        timestamp: Date.now() // Update timestamp
      };
    } else {
      // Add new entry at the beginning
      vocabulary.unshift(entry);
    }

    // Limit to 1000 entries
    if (vocabulary.length > 1000) {
      vocabulary.length = 1000;
    }

    // Save back to storage
    await chrome.storage.local.set({ vocabulary });
  } catch (err) {
    console.error('Failed to save vocabulary:', err);
  }
}

function showVocabSavedToast(word) {
  const toast = document.createElement('div');
  toast.textContent = `Saved: ${word}`;
  toast.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    background: #10b981;
    color: white;
    padding: 10px 16px;
    border-radius: 6px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    z-index: 2147483647;
    animation: slideInRight 0.2s ease;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  `;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.2s ease reverse';
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}

function showProcessingIndicator() {
  const indicator = document.createElement('div');
  indicator.id = 'tsukeru-processing';
  indicator.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <div class="tsukeru-spinner"></div>
      <span>Processing...</span>
    </div>
  `;
  indicator.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    background: #475569;
    color: white;
    padding: 10px 16px;
    border-radius: 6px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    z-index: 2147483647;
    animation: slideInRight 0.2s ease;
  `;

  // Add spinner styles
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideInRight {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .tsukeru-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(indicator);
  return indicator;
}

function hideProcessingIndicator(indicator) {
  if (indicator && indicator.parentNode) {
    indicator.style.animation = 'slideInRight 0.2s ease reverse';
    setTimeout(() => indicator.remove(), 200);
    return;
  }
  const existing = document.getElementById('tsukeru-processing');
  if (existing) {
    existing.style.animation = 'slideInRight 0.2s ease reverse';
    setTimeout(() => existing.remove(), 200);
  }
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    background: #1e293b;
    color: white;
    padding: 10px 16px;
    border-radius: 6px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    z-index: 2147483647;
    animation: slideInRight 0.2s ease;
  `;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.2s ease reverse';
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}

// Scroll to and highlight a word on the page
function scrollToAndHighlightWord(word, reading) {
  // Find all ruby elements that match this word
  const rubyElements = document.querySelectorAll('ruby[data-surface], ruby[data-dict-form]');
  let foundElement = null;

  for (const ruby of rubyElements) {
    const dictForm = ruby.dataset.dictForm || ruby.dataset.surface || '';
    const dictReading = ruby.dataset.dictReading || ruby.dataset.reading || '';
    const surface = ruby.dataset.surface || '';

    // Match by dictionary form or surface form
    if (dictForm === word || surface === word) {
      // If reading is provided, also match reading
      if (!reading || dictReading === reading || ruby.dataset.reading === reading) {
        foundElement = ruby;
        break;
      }
    }
  }

  if (!foundElement) {
    return { found: false };
  }

  // Remove any existing highlights
  document.querySelectorAll('.tsukeru-highlight').forEach(el => {
    el.classList.remove('tsukeru-highlight');
  });

  // Scroll to the element
  foundElement.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'center'
  });

  // Add highlight class
  foundElement.classList.add('tsukeru-highlight');

  // Remove highlight after 3 seconds
  setTimeout(() => {
    foundElement.classList.remove('tsukeru-highlight');
  }, 3000);

  return { found: true };
}

// Get the context sentence for a word
function getWordContextSentence(word, reading) {
  // Find all ruby elements that match this word
  const rubyElements = document.querySelectorAll('ruby[data-surface], ruby[data-dict-form]');
  let foundElement = null;

  for (const ruby of rubyElements) {
    const dictForm = ruby.dataset.dictForm || ruby.dataset.surface || '';
    const dictReading = ruby.dataset.dictReading || ruby.dataset.reading || '';
    const surface = ruby.dataset.surface || '';

    // Match by dictionary form or surface form
    if (dictForm === word || surface === word) {
      // If reading is provided, also match reading
      if (!reading || dictReading === reading || ruby.dataset.reading === reading) {
        foundElement = ruby;
        break;
      }
    }
  }

  if (!foundElement) {
    return { found: false, sentence: '' };
  }

  // Extract the sentence context
  const sentence = extractSentenceContext(foundElement);
  return { found: true, sentence };
}

} // end guard
