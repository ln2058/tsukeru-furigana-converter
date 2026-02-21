// Shared utility functions for all extension contexts.
// NOTE: escapeHtml and sanitizeSafeFuriganaHtml are DOM-dependent;
//       they must not be called from the service worker (bg-api.js imports kata2hira only).

export function kata2hira(str) {
  return (str || '').replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function generateEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Unified safe HTML sanitizer (merges sanitizeHtmlFragment + sanitizeExtensionHtml).
// Strips everything except ruby/rt/rp/span/div and known furigana data-* attributes.
export function sanitizeSafeFuriganaHtml(dirtyHtml) {
  if (!dirtyHtml) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(dirtyHtml, 'text/html');
  const allowedTags = new Set(['ruby', 'rt', 'rp', 'span', 'div']);
  const allowedAttributes = new Set([
    'class', 'data-surface', 'data-reading', 'data-dict-form',
    'data-dict-reading', 'data-jlpt', 'data-pos'
  ]);

  function cleanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); return; }
    const tag = node.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      const frag = document.createDocumentFragment();
      while (node.firstChild) {
        cleanNode(node.firstChild);
        if (node.firstChild) frag.appendChild(node.firstChild);
      }
      node.replaceWith(frag);
      return;
    }
    Array.from(node.attributes).forEach(attr => {
      if (!allowedAttributes.has(attr.name.toLowerCase())) node.removeAttribute(attr.name);
    });
    Array.from(node.childNodes).forEach(cleanNode);
  }

  Array.from(doc.body.childNodes).forEach(cleanNode);
  return doc.body.innerHTML;
}
