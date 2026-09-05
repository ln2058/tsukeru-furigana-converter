import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = text;
    this.parentElement = null;
    this.parentNode = null;
    this.isConnected = true;
  }

  cloneNode() {
    return new FakeText(this.textContent);
  }
}

class FakeElement {
  constructor(tagName, attributes = {}, children = []) {
    this.nodeType = 1;
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.attributes = [];
    this.dataset = {};
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.isConnected = true;
    this.rect = { top: 0, bottom: 20, width: 100, height: 20 };
    this.className = attributes.class || '';
    this.id = attributes.id || '';
    for (const [name, value] of Object.entries(attributes)) {
      this.setAttribute(name, value);
    }
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    const existing = this.attributes.find((attribute) => attribute.name === name);
    if (existing) existing.value = stringValue;
    else this.attributes.push({ name, value: stringValue });
    if (name === 'class') this.className = stringValue;
    if (name === 'id') this.id = stringValue;
    if (name.startsWith('data-')) {
      const datasetName = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[datasetName] = stringValue;
    }
  }

  hasAttribute(name) {
    return this.attributes.some((attribute) => attribute.name === name);
  }

  getAttribute(name) {
    return this.attributes.find((attribute) => attribute.name === name)?.value || null;
  }

  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    this.childNodes.push(child);
    if (child.nodeType === 1) this.children.push(child);
    return child;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent || '').join('');
  }

  set textContent(value) {
    this.childNodes = [new FakeText(String(value))];
    this.children = [];
    this.childNodes[0].parentElement = this;
  }

  matches(selector) {
    const [tagPart, attrPart] = selector.match(/^([a-z-]+)?(?:\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\])?$/i)?.slice(1) || [];
    if (tagPart && this.localName !== tagPart.toLowerCase()) return false;
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (attrPart && !this.hasAttribute(attrPart)) return false;
    if (attrPart && valueMatches(attrPart, attrPart, attrPart) && arguments.length > 1) return false;
    return true;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    const found = [];
    const visit = (node) => {
      if (node.nodeType !== 1) return;
      if (selectors.some((part) => matchesSelector(node, part))) found.push(node);
      node.children.forEach(visit);
    };
    this.children.forEach(visit);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  compareDocumentPosition(other) {
    if (this === other) return 0;
    const root = this.getRootNode();
    const ordered = [];
    const visit = (node) => {
      if (node.nodeType === 1) ordered.push(node);
      node.childNodes?.forEach(visit);
    };
    visit(root);
    return ordered.indexOf(this) < ordered.indexOf(other) ? 4 : 2;
  }

  getRootNode() {
    let current = this;
    while (current.parentElement) current = current.parentElement;
    return current;
  }

  closest(selector) {
    let current = this;
    const selectors = selector.split(',').map((part) => part.trim());
    while (current) {
      if (selectors.some((part) => matchesSelector(current, part))) return current;
      current = current.parentElement;
    }
    return null;
  }

  cloneNode(deep = false) {
    const copy = new FakeElement(this.localName, Object.fromEntries(this.attributes.map(({ name, value }) => [name, value])));
    if (deep) this.childNodes.forEach((child) => copy.appendChild(child.nodeType === 1 ? child.cloneNode(true) : child.cloneNode()));
    return copy;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement.childNodes = this.parentElement.childNodes.filter((child) => child !== this);
    this.parentElement = null;
  }
}

function valueMatches() {
  return false;
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  const match = selector.match(/^([a-z-]+)?(?:\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\])?$/i);
  if (!match) return false;
  const [, tagName, attribute, value] = match;
  if (tagName && element.localName !== tagName.toLowerCase()) return false;
  if (attribute && !element.hasAttribute(attribute)) return false;
  return !attribute || value === undefined || element.getAttribute(attribute) === value;
}

class FakeDocument extends FakeElement {
  constructor(root) {
    super('document');
    this.nodeType = 9;
    this.documentElement = root;
    this.body = root;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    const found = [];
    const visit = (node) => {
      if (node.nodeType !== 1) return;
      if (selectors.some((part) => matchesSelector(node, part))) found.push(node);
      node.children.forEach(visit);
    };
    visit(this.documentElement);
    return found;
  }

  createTreeWalker(root, whatToShow) {
    const nodes = [];
    const visit = (node) => {
      if (node.nodeType === 3 && (whatToShow & 4)) nodes.push(node);
      if (node.nodeType === 1 || node.nodeType === 9) node.childNodes.forEach(visit);
    };
    visit(root);
    let index = 0;
    return { nextNode: () => nodes[index++] || null };
  }
}

function ruby(base, reading) {
  return new FakeElement('ruby', {}, [new FakeText(base), new FakeElement('rt', {}, [new FakeText(reading)])]);
}

function loadBrowser(browserName) {
  const root = new FakeElement('html');
  const document = new FakeDocument(root);
  const sandbox = {
    document,
    window: {
      innerHeight: 100,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
    console,
    TextEncoder,
    chrome: { i18n: { getMessage: () => '' } },
    setTimeout,
    clearTimeout,
    Node: {
      TEXT_NODE: 3,
      ELEMENT_NODE: 1,
      DOCUMENT_POSITION_PRECEDING: 2,
      DOCUMENT_POSITION_FOLLOWING: 4,
    },
    NodeFilter: { SHOW_TEXT: 4 },
    processedNodes: new WeakSet(),
    currentSite: 'default',
  };
  const baseUrl = new URL(`../${browserName}/js/content-dom.js`, import.meta.url);
  const tooltipUrl = new URL(`../${browserName}/js/content-tooltip.js`, import.meta.url);
  vm.runInNewContext(readFileSync(baseUrl, 'utf8'), sandbox, { filename: baseUrl.pathname });
  vm.runInNewContext(readFileSync(tooltipUrl, 'utf8'), sandbox, { filename: tooltipUrl.pathname });
  return { sandbox, root, document };
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} resolves current wrapper metadata and keeps readings separate`, () => {
    const { sandbox, root, document } = loadBrowser(browserName);
    const current = new FakeElement('span', {
      class: 'analysis-word',
      'data-jlpt': '3',
      'data-pos': 'Verb',
      'data-surface': '食べました',
      'data-dict-form': '食べる',
      'data-dict-reading': 'たべる',
      'data-reading': 'たべました',
      'data-lookup-reading': 'たべる',
    }, [ruby('食', 'た'), ruby('べ', 'べ'), new FakeText('ました')]);
    root.appendChild(current);

    const info = sandbox.extractWordInfo(current.querySelector('ruby'));
    assert.deepEqual(JSON.parse(JSON.stringify(info)), {
      word: '食べる',
      reading: 'たべる',
      surface: '食べました',
      surfaceReading: 'たべました',
      lookupReading: 'たべる',
      lookupReadingType: 'hiragana',
      jlpt: '3',
      pos: 'Verb',
      altReadings: [],
    });

    const words = sandbox.extractAllPageWords();
    assert.equal(words.length, 1);
    assert.equal(words[0].word, '食べる');
    assert.equal(words[0].reading, 'たべる');
    assert.equal(words[0].surfaceReading, 'たべました');
    assert.equal(words[0].lookupReading, 'たべる');
    assert.equal(words[0].frequency, 1);
    assert.equal(sandbox.resolveAnalysisWordElement(current.querySelector('ruby')), current);
    assert.equal(sandbox.getAnalysisWordElements(document).length, 1);
  });

  test(`${browserName} collects current, legacy, kana-only, and repeated units once`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const repeated = (surface) => new FakeElement('span', {
      class: 'srt-word',
      'data-jlpt': '5',
      'data-pos': 'Noun',
      'data-surface': surface,
      'data-reading': 'ねこ',
      'data-lookup-reading': 'ねこ',
    }, [ruby(surface, 'ねこ')]);
    root.appendChild(repeated('猫'));
    root.appendChild(repeated('猫'));
    root.appendChild(new FakeElement('span', {
      'data-jlpt': '4',
      'data-pos': 'Adverb',
      'data-surface': 'とても',
      'data-reading': 'とても',
    }, [new FakeText('とても')]));
    root.appendChild(new FakeElement('ruby', {
      'data-jlpt': '3',
      'data-pos': 'Noun',
      'data-surface': '水',
      'data-reading': 'みず',
    }, [new FakeText('水'), new FakeElement('rt', {}, [new FakeText('みず')])]));

    const words = sandbox.extractAllPageWords();
    assert.deepEqual(JSON.parse(JSON.stringify(words.map(({ word, frequency }) => ({ word, frequency })))), [
      { word: '猫', frequency: 2 },
      { word: 'とても', frequency: 1 },
      { word: '水', frequency: 1 },
    ]);
  });

  test(`${browserName} preserves Page words output at the snippet boundary`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const prefix = 'あ'.repeat(68);
    const word = (surface, reading) => new FakeElement('span', {
      class: 'analysis-word',
      'data-jlpt': '5',
      'data-pos': 'Noun',
      'data-surface': surface,
      'data-reading': reading,
      'data-lookup-reading': reading,
    }, [ruby(surface, reading)]);
    const block = new FakeElement('p', {}, [
      new FakeText(`${prefix}   `),
      word('猫', 'ねこ'),
      new FakeText('   '),
      word('犬', 'いぬ'),
      new FakeText('  追加の文章'),
      word('猫', 'ねこ'),
    ]);
    root.appendChild(block);

    const words = sandbox.extractAllPageWords();
    assert.deepEqual(JSON.parse(JSON.stringify(words.map(({ word: value, frequency, snippet }) => ({ word: value, frequency, snippet })))), [
      { word: '猫', frequency: 2, snippet: `${prefix} 猫 犬…` },
      { word: '犬', frequency: 1, snippet: `${prefix} 猫 犬…` },
    ]);
    assert.doesNotMatch(words[0].snippet, /ねこ|いぬ/);
  });

  test(`${browserName} rejects class-only host elements and tooltip UI`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const classOnly = new FakeElement('span', { class: 'analysis-word' }, [new FakeText('host')]);
    const tooltip = new FakeElement('div', { id: 'tsukeru-word-tooltip' }, [
      new FakeElement('span', { 'data-jlpt': '3', 'data-surface': 'N3' }, [new FakeText('N3')])
    ]);
    root.appendChild(classOnly);
    root.appendChild(tooltip);

    assert.equal(sandbox.resolveAnalysisWordElement(classOnly), null);
    assert.equal(sandbox.resolveAnalysisWordElement(tooltip.querySelector('span')), null);
    assert.equal(sandbox.extractAllPageWords().length, 0);
  });

  test(`${browserName} builds long-page metadata with nearest-block ownership`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const nested = new FakeElement('li', {}, [
      new FakeText('外側の文章'),
      new FakeElement('p', {}, [new FakeText('段落の文章')]),
      new FakeElement('ul', {}, [new FakeElement('li', {}, [new FakeText('内側の文章')])]),
    ]);
    const article = new FakeElement('article', {}, [
      new FakeText('記事の導入'),
      new FakeElement('p', {}, [new FakeText('記事の段落')]),
    ]);
    root.appendChild(nested);
    root.appendChild(article);

    const plan = sandbox.collectLongPagePlan(root);
    assert.equal(JSON.stringify(plan.blocks.map(({ element }) => element.localName)), JSON.stringify(['li', 'p', 'li', 'article', 'p']));
    assert.ok(plan.blocks.every((record) => Object.keys(record).sort().join(',') === 'element,japaneseCharacterCount,state'));
    assert.equal(plan.blocks.find(({ element }) => element === nested).japaneseCharacterCount, 5);
    assert.equal(plan.blocks.find(({ element }) => element === article).japaneseCharacterCount, 5);
    assert.equal(plan.isLongPage, false);
  });

  test(`${browserName} splits oversized fallback containers into child-owned blocks`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const fallback = new FakeElement('div', {}, [
      new FakeText('親本文'),
      new FakeElement('span', {}, [new FakeText('子'.repeat(2200))]),
      new FakeElement('span', {}, [new FakeText('別'.repeat(2200))]),
    ]);
    root.appendChild(fallback);

    const plan = sandbox.collectLongPagePlan(root);
    assert.equal(JSON.stringify(plan.blocks.map(({ element }) => element.localName)), JSON.stringify(['div', 'span', 'span']));
    assert.equal(plan.blocks[0].japaneseCharacterCount, 3);
    assert.equal(plan.blocks[1].japaneseCharacterCount, 2200);
    assert.equal(plan.blocks[2].japaneseCharacterCount, 2200);
    assert.ok(plan.blocks.every((record) => !Object.values(record).some((value) => Array.isArray(value))));
  });

  test(`${browserName} keeps inserted-subtree planning inside its collection boundary`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const insertedSubtree = new FakeElement('span', {}, [new FakeText('追加された文章')]);
    const existingFallback = new FakeElement('div', {}, [insertedSubtree]);
    root.appendChild(existingFallback);

    const plan = sandbox.collectLongPagePlan(insertedSubtree);
    assert.equal(plan.blocks.length, 1);
    assert.equal(plan.blocks[0].element, insertedSubtree);
  });

  test(`${browserName} bounds oversized text segments without losing source text`, () => {
    const { sandbox } = loadBrowser(browserName);
    const sourceText = '日本語'.repeat(12000);
    const segments = sandbox.splitLongPageTextIntoSegments(sourceText, 7);
    const encoder = new TextEncoder();

    assert.ok(segments.length > 1);
    assert.equal(segments.map(({ text }) => text).join(''), sourceText);
    assert.ok(segments.every(({ marker, text }) => encoder.encode(`${marker}${text}`).length <= 40000));
  });

  test(`${browserName} ignores structural/security exclusions and selects either long-page threshold`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    root.appendChild(new FakeElement('script', {}, [new FakeText('無視する文章')]));
    root.appendChild(new FakeElement('code', {}, [new FakeText('無視するコード')]));
    root.appendChild(new FakeElement('p', { hidden: '' }, [new FakeText('隠れた文章')]));
    root.appendChild(new FakeElement('p', { 'data-no-furigana': 'true' }, [new FakeText('除外する文章')]));
    for (let i = 0; i < 150; i++) root.appendChild(new FakeElement('p', {}, [new FakeText('日本語')]));

    const blockThresholdPlan = sandbox.collectLongPagePlan(root);
    assert.equal(blockThresholdPlan.blocks.length, 150);
    assert.equal(blockThresholdPlan.isLongPage, true);

    const { sandbox: charSandbox, root: charRoot } = loadBrowser(browserName);
    charRoot.appendChild(new FakeElement('p', {}, [new FakeText('日'.repeat(30000))]));
    const charThresholdPlan = charSandbox.collectLongPagePlan(charRoot);
    assert.equal(charThresholdPlan.blocks.length, 1);
    assert.equal(charThresholdPlan.isLongPage, true);
  });

  test(`${browserName} chooses viewport mode only for long or configured plans`, () => {
    const { sandbox } = loadBrowser(browserName);
    assert.equal(sandbox.shouldUseViewportProcessing({ isLongPage: false }, { useIntersectionObserver: false }), false);
    assert.equal(sandbox.shouldUseViewportProcessing({ isLongPage: true }, { useIntersectionObserver: false }), true);
    assert.equal(sandbox.shouldUseViewportProcessing({ isLongPage: false }, { useIntersectionObserver: true }), true);
  });

  test(`${browserName} skips layout visibility work when viewport mode is known`, async () => {
    const { sandbox, root } = loadBrowser(browserName);
    let visibilityChecks = 0;
    sandbox.window.getComputedStyle = () => {
      visibilityChecks += 1;
      return { display: 'block', visibility: 'visible', opacity: '1' };
    };
    root.appendChild(new FakeElement('p', {}, [new FakeText('日本語')]))

    const discovery = await sandbox.collectInitialDiscovery(root, {
      viewportModeKnown: true,
      isCurrent: () => true,
    });

    assert.equal(visibilityChecks, 0);
    assert.equal(discovery.textNodes.length, 0);
    assert.equal(discovery.plan.blocks.length, 1);
  });

  test(`${browserName} does not cache visible ancestors above hidden parents`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const hiddenParent = new FakeElement('div');
    const sharedParent = new FakeElement('div');
    const first = new FakeElement('p', {}, [new FakeText('最初')]);
    const second = new FakeElement('p', {}, [new FakeText('次')]);
    sharedParent.appendChild(first);
    sharedParent.appendChild(second);
    hiddenParent.appendChild(sharedParent);
    root.appendChild(hiddenParent);
    sandbox.window.getComputedStyle = (element) => element === hiddenParent
      ? { display: 'none', visibility: 'visible', opacity: '1' }
      : { display: 'block', visibility: 'visible', opacity: '1' };
    const visibilityCache = new WeakMap();

    assert.equal(sandbox.isNodeVisible(first.childNodes[0], visibilityCache), false);
    assert.equal(sandbox.isNodeVisible(second.childNodes[0], visibilityCache), false);
  });

  test(`${browserName} cancels cooperative discovery and matches fresh eligible collection`, async () => {
    const { sandbox: discoverySandbox, root: discoveryRoot } = loadBrowser(browserName);
    discoveryRoot.appendChild(new FakeElement('p', {}, [new FakeText('日本語')]))

    await assert.rejects(
      discoverySandbox.collectInitialDiscovery(discoveryRoot, { isCurrent: () => false }),
      (error) => error.cancelled === true
    );

    const discovery = await discoverySandbox.collectInitialDiscovery(discoveryRoot, { isCurrent: () => true });
    assert.deepEqual(
      discovery.textNodes.map((node) => node.textContent),
      discoverySandbox.collectTextNodes(discoveryRoot).map((node) => node.textContent)
    );
  });

  test(`${browserName} prioritizes visible records and keeps document order for equal distance`, () => {
    const { sandbox, root } = loadBrowser(browserName);
    const visible = new FakeElement('p', {}, [new FakeText('見える')]);
    const firstNearby = new FakeElement('p', {}, [new FakeText('近い一')]);
    const secondNearby = new FakeElement('p', {}, [new FakeText('近い二')]);
    root.appendChild(visible);
    root.appendChild(firstNearby);
    root.appendChild(secondNearby);
    visible.rect = { top: 10, bottom: 30 };
    firstNearby.rect = { top: 140, bottom: 160 };
    secondNearby.rect = { top: 140, bottom: 160 };

    const records = [visible, firstNearby, secondNearby].map((element) => ({
      element,
      japaneseCharacterCount: 3,
      state: 'queued',
    }));
    sandbox.longPageBlockByElement = new WeakMap(records.map((record) => [record.element, record]));
    sandbox.viewportVisibleBlocks = new Set([visible]);
    sandbox.viewportNearbyBlocks = new Set([firstNearby, secondNearby]);
    sandbox.dynamicPendingTargets = new Set([visible, firstNearby, secondNearby]);
    sandbox.longPageBlocks = records;
    sandbox.window.innerHeight = 100;

    const selected = sandbox.selectLongPageRecords().map(({ element }) => element);
    assert.equal(selected[0], visible);
    assert.equal(selected[1], firstNearby);
    assert.equal(selected[2], secondNearby);
  });

  test(`${browserName} filters owned mutations and schedules removal-only cleanup`, () => {
    const { sandbox } = loadBrowser(browserName);
    const mutationRoot = new FakeElement('div');
    const original = new FakeText('管理');
    const wrapper = new FakeElement('span', { 'data-tsukeru-wrapper': '1' }, [new FakeText('管理')]);
    wrapper.setAttribute('data-tsukeru-original', '管理');
    mutationRoot.appendChild(wrapper);
    sandbox.currentSite = 'default';
    sandbox.lifecycleGeneration = 0;
    sandbox.dynamicContainer = mutationRoot;
    sandbox.longPageMode = false;
    sandbox.intersectionObserver = null;
    sandbox.dynamicProcessingOperation = null;
    sandbox.dynamicDrainTimer = null;
    sandbox.dynamicPendingTargets = new Set();
    sandbox.cleanupPending = false;
    let scheduled = 0;
    sandbox.scheduleDynamicDrain = () => { scheduled += 1; };

    const ownedReplacement = { type: 'childList', target: mutationRoot, addedNodes: [wrapper], removedNodes: [original] };
    sandbox.longPageMode = true;
    sandbox.longPageBlocks = [];
    sandbox.longPageBlockByElement = new WeakMap();
    sandbox.viewportVisibleBlocks = new Set();
    sandbox.viewportNearbyBlocks = new Set();
    sandbox.processLongPageMutations([ownedReplacement], {}, mutationRoot, 0);
    assert.equal(sandbox.cleanupPending, false);
    assert.equal(scheduled, 0);

    sandbox.longPageMode = false;
    sandbox.processMutations([ownedReplacement], {}, mutationRoot, 0);
    assert.equal(sandbox.dynamicPendingTargets.size, 0);
    assert.equal(scheduled, 0);

    sandbox.processMutations([{ type: 'childList', target: mutationRoot, addedNodes: [], removedNodes: [wrapper] }], {}, mutationRoot, 0);
    assert.equal(sandbox.cleanupPending, true);
    assert.equal(scheduled, 1);
    sandbox.cleanupIntersectionTargets(mutationRoot);
    assert.equal(sandbox.cleanupPending, false);
  });

  test(`${browserName} keeps every generated request within the hard byte limit`, () => {
    const { sandbox } = loadBrowser(browserName);
    const oversized = new FakeText('日'.repeat(20000));
    const node = new FakeElement('p', {}, [oversized]);
    const batches = sandbox.buildBatches([oversized]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].oversizedNode, oversized);
    assert.ok(node.contains(oversized));
  });
}
