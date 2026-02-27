/*
Module: content-dom
Purpose: Collect processable page text, sanitize backend HTML, and apply DOM/observer workflows.

Inputs:
- Current document nodes, site-specific selectors, settings, and processed HTML batches.

Outputs:
- Batched marker payloads, injected ruby wrappers, and extracted vocab/context data.

Side Effects:
- Mutates page DOM, attributes, classes, and inline CSS variables.
- Starts/stops mutation, intersection, and caption observers.

Failure Modes:
- Invalid selectors, DOM race conditions, and batch marker mismatches.
- Partial dynamic processing failures are logged and skipped.

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
const MAX_BATCH_CHARS = 15000;
const REQUEST_DELAY_MS = 200;
const DICTIONARY_MAX_SENSES = 3;

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

function sanitizeHtmlFragment(html) {
  if (typeof html !== 'string' || !html) return '';

  const template = document.createElement('template');
  template.innerHTML = html;

  const fragment = document.createDocumentFragment();
  const allowedTags = new Set(['RUBY', 'RT', 'MARK', 'SPAN']);

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
      const frag = document.createDocumentFragment();
      while (node.firstChild) {
        sanitizeNode(node.firstChild, frag);
      }
      parent.appendChild(frag);
      return;
    }

    // Only allow SPAN elements that are backend kana-word spans (must carry data-jlpt)
    if (node.tagName === 'SPAN' && !node.hasAttribute('data-jlpt')) {
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

// ── Highlight mode ────────────────────────────────────────────────────────────

function setHighlightMode(mode = 'off') {
  const allowed = ['off', 'pos', 'jlpt'];
  // currentHighlightMode is a var declared in content-main.js
  currentHighlightMode = allowed.includes(mode) ? mode : 'off';
  document.documentElement.setAttribute('data-tsukeru-highlight', currentHighlightMode);
}

// ── Node visibility and filtering ─────────────────────────────────────────────

function isNodeVisible(node) {
  const element = node.parentElement || node;
  if (!element || !element.isConnected) return false;

  if (element.closest('head, template, meta, title, [hidden], [aria-hidden="true"], noscript, script, style')) {
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

function isProcessableTextNode(node) {
  // processedNodes and currentSite are var globals from content-main.js
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

// ── Text node collection ──────────────────────────────────────────────────────

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
  let charCount = 0;
  let batchIndex = 0;

  const flush = () => {
    if (!currentNodes.length) return;
    batches.push({
      nodes: currentNodes,
      markers: currentMarkers,
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

// ── Batch application ─────────────────────────────────────────────────────────

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
    if (currentIndex === -1) continue;
    const targetNode = batch.nodes[currentIndex];
    replaceTextNodeWithHtml(targetNode, chunk, { markCaption });
    if (markProcessed) {
      // processedNodes is a var global from content-main.js
      processedNodes.add(targetNode);
    }
    currentIndex = -1;
  }
}

function replaceTextNodeWithHtml(node, html, { markCaption = false } = {}) {
  if (!node || !node.parentNode) return;
  const parent = node.parentNode;
  const originalText = node.textContent || '';
  const safeHtml = sanitizeHtmlFragment(html || originalText);

  const temp = document.createElement('span');
  temp.style.display = 'inline';
  temp.innerHTML = safeHtml;

  const fragment = document.createDocumentFragment();
  while (temp.firstChild) {
    fragment.appendChild(temp.firstChild);
  }

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
        } else if (tagName === 'span' && child.hasAttribute('data-jlpt')) {
          const span = document.createElement('span');
          for (let attr of child.attributes) {
            if (attr.name.startsWith('data-')) {
              span.setAttribute(attr.name, attr.value);
            }
          }
          span.textContent = child.textContent;
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
      if (tag === 'ruby' || (tag === 'span' && child.hasAttribute('data-jlpt'))) {
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

function startWatchingDynamicContent(settings) {
  // mutationObserver, debounceTimer, currentSite are var globals from content-main.js
  if (mutationObserver) return;

  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  const container = document.querySelector(siteConfig.containerSelector) || document.body;

  mutationObserver = new MutationObserver((mutations) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processMutations(mutations, settings);
    }, siteConfig.debounceDelay);
  });

  mutationObserver.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
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

  processCaptions();
}

function stopYoutubeCaptionsObserver() {
  clearTimeout(youtubeCaptionRetryTimer);
  if (youtubeCaptionObserver) {
    youtubeCaptionObserver.disconnect();
    youtubeCaptionObserver = null;
  }
}

function startIntersectionObserver(settings) {
  if (intersectionObserver) return;

  const siteConfig = SITE_CONFIGS[currentSite] || SITE_CONFIGS.default;
  if (!siteConfig.selectors.length) return;

  intersectionObserver = new IntersectionObserver((entries) => {
    const visibleElements = entries
      .filter(entry => entry.isIntersecting)
      .map(entry => entry.target);

    if (visibleElements.length === 0) return;

    processVisibleElements(visibleElements, settings);
  }, {
    rootMargin: '50px',
    threshold: 0.1
  });

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

  observeNewElements();

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
    if (mutation.type === 'characterData') {
      const textNode = mutation.target;
      if (textNode && isProcessableTextNode(textNode)) {
        newNodes.push(textNode);
      }
    }

    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.hasAttribute('data-tsukeru-processed')) continue;

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

          for (const element of matchedElements) {
            const textNodes = collectTextNodes(element);
            newNodes.push(...textNodes);
          }
        } else {
          const textNodes = collectTextNodes(node);
          newNodes.push(...textNodes);
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        if (isProcessableTextNode(node)) {
          newNodes.push(node);
        }
      }
    }
  }

  if (newNodes.length === 0) return;

  // processingQueue is a var global from content-main.js
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
    uniqueNodes.forEach(node => {
      processingQueue.delete(node);
    });
  }
}

// ── Page word extraction (for Vocab Mode) ─────────────────────────────────────

function extractAllPageWords() {
  const rubyElements = document.querySelectorAll('ruby[data-surface]');
  const wordMap = new Map();
  let occurrenceCounter = 0;

  rubyElements.forEach(ruby => {
    const surface = ruby.dataset.surface || '';
    const reading = ruby.dataset.reading || ruby.querySelector('rt')?.textContent || '';
    const jlpt = ruby.dataset.jlpt || '';
    const pos = ruby.dataset.pos || '';
    const dictForm = ruby.dataset.dictForm || surface;
    const dictReading = ruby.dataset.dictReading || reading;

    const key = `${dictForm}|${dictReading}`;

    if (dictForm) {
      if (!wordMap.has(key)) {
        let snippet = '';
        try {
          const block = ruby.closest('p, li, td, blockquote, h1, h2, h3, h4, article') || ruby.parentElement;
          if (block) {
            const clone = block.cloneNode(true);
            clone.querySelectorAll('rt').forEach(rt => rt.remove());
            const text = clone.textContent.trim().replace(/\s+/g, ' ');
            snippet = text.length > 72 ? text.slice(0, 72) + '…' : text;
          }
        } catch (e) { /* ignore */ }

        wordMap.set(key, {
          word: dictForm,
          reading: dictReading,
          surface: surface,
          jlpt: jlpt,
          pos: pos,
          frequency: 1,
          occurrenceIndex: occurrenceCounter++,
          snippet: snippet,
          altReadings: ruby.dataset.altReadings || '',
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
  const rubyElements = document.querySelectorAll('ruby[data-surface], ruby[data-dict-form]');
  let foundElement = null;

  for (const ruby of rubyElements) {
    const dictForm = ruby.dataset.dictForm || ruby.dataset.surface || '';
    const dictReading = ruby.dataset.dictReading || ruby.dataset.reading || '';
    const surface = ruby.dataset.surface || '';

    if (dictForm === word || surface === word) {
      if (!reading || dictReading === reading || ruby.dataset.reading === reading) {
        foundElement = ruby;
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
  const rubyElements = document.querySelectorAll('ruby[data-surface], ruby[data-dict-form]');
  let foundElement = null;

  for (const ruby of rubyElements) {
    const dictForm = ruby.dataset.dictForm || ruby.dataset.surface || '';
    const dictReading = ruby.dataset.dictReading || ruby.dataset.reading || '';
    const surface = ruby.dataset.surface || '';

    if (dictForm === word || surface === word) {
      if (!reading || dictReading === reading || ruby.dataset.reading === reading) {
        foundElement = ruby;
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
