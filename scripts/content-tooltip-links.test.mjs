// A word inside a link opens its popup on the first click; the link is followed
// on a second click while that popup is open, and on modifier clicks or Enter.
import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const tooltipFiles = [
  new URL('../chrome/js/content-tooltip.js', import.meta.url),
  new URL('../firefox/js/content-tooltip.js', import.meta.url),
];

// Minimal elements: a word inside a link, and a word outside any link.
function element(parent, isLink = false) {
  return {
    parentElement: parent,
    closest(selector) {
      if (selector === 'a[href]') {
        for (let node = this; node; node = node.parentElement) if (node.isLink) return node;
      }
      return null;
    },
    contains(other) {
      for (let node = other; node; node = node.parentElement) if (node === this) return true;
      return false;
    },
    isLink,
  };
}

function load(tooltipUrl) {
  const sandbox = {
    chrome: { runtime: { id: 'test' }, i18n: { getMessage() { return ''; } } },
    console,
    URL,
    requestAnimationFrame() {},
    document: { createElement() { return {}; }, getElementById() { return null; } },
  };
  loadI18n(sandbox, tooltipUrl.pathname.includes('/firefox/') ? 'firefox' : 'chrome');
  vm.runInNewContext(readFileSync(tooltipUrl, 'utf8'), sandbox, { filename: tooltipUrl.pathname });

  const shown = [];
  let open = false;
  sandbox.isFuriganaActive = true;
  sandbox.dictionaryTooltip = { _activeRuby: null, classList: { contains: (name) => name === 'show' && open } };
  sandbox.resolveAnalysisWordElement = (target) => target;
  sandbox.extractWordInfo = () => ({ word: '行く' });
  sandbox.handleStudyReveal = () => false;
  sandbox.showDefinitionTooltip = (target) => {
    shown.push(target);
    sandbox.dictionaryTooltip._activeRuby = target;
    open = true;
  };
  sandbox.hideDefinitionTooltip = () => {
    sandbox.dictionaryTooltip._activeRuby = null;
    open = false;
  };
  return { sandbox, shown, isOpen: () => open };
}

function click(sandbox, target, extra = {}) {
  const event = {
    isTrusted: true, target, detail: 1, clientX: 0, clientY: 0,
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  sandbox.handleDictionaryClick(event);
  return event;
}

for (const tooltipUrl of tooltipFiles) {
  const browserName = tooltipUrl.pathname.includes('/firefox/') ? 'Firefox' : 'Chrome';

  test(`${browserName}: a second click on a linked word follows the link`, () => {
    const { sandbox, shown, isOpen } = load(tooltipUrl);
    const link = element(element(null), true);
    const word = element(link);

    assert.equal(click(sandbox, word).defaultPrevented, true);
    assert.deepEqual(shown, [word]);

    assert.equal(click(sandbox, word).defaultPrevented, false);
    assert.equal(isOpen(), false);
    assert.equal(shown.length, 1);
  });

  test(`${browserName}: modifier clicks and Enter on a link go to the link`, () => {
    const { sandbox, shown } = load(tooltipUrl);
    const word = element(element(element(null), true));
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { detail: 0 }]) {
      assert.equal(click(sandbox, word, extra).defaultPrevented, false, JSON.stringify(extra));
    }
    assert.equal(shown.length, 0);
  });

  test(`${browserName}: words outside links, or in another link, still open the popup`, () => {
    const { sandbox, shown } = load(tooltipUrl);
    const page = element(null);
    const plain = element(page);
    const first = element(element(page, true));
    const other = element(element(page, true));

    assert.equal(click(sandbox, plain).defaultPrevented, true);
    assert.equal(click(sandbox, plain).defaultPrevented, true);
    assert.equal(click(sandbox, first).defaultPrevented, true);
    assert.equal(click(sandbox, other).defaultPrevented, true);
    assert.deepEqual(shown, [plain, plain, first, other]);
  });
}
