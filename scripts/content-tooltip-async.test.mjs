import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

const helperFiles = [
  new URL('../chrome/js/tooltip-async-state.js', import.meta.url),
  new URL('../firefox/js/tooltip-async-state.js', import.meta.url),
];

function loadCoordinator(helperUrl) {
  const sandbox = {};
  vm.runInNewContext(readFileSync(helperUrl, 'utf8'), sandbox, {
    filename: helperUrl.pathname,
  });
  return sandbox.TsukeruTooltipAsyncState.createTooltipAsyncCoordinator();
}

for (const helperUrl of helperFiles) {
  const browserName = helperUrl.pathname.includes('/firefox/') ? 'Firefox' : 'Chrome';

  test(`${browserName} coordinator lazily reuses one request per lookup session`, async () => {
    const coordinator = loadCoordinator(helperUrl);
    coordinator.reset('学習');

    let requestCount = 0;
    let resolveRequest;
    let successCount = 0;

    assert.equal(coordinator.getState('example'), 'idle');
    assert.equal(requestCount, 0, 'no enrichment request starts before the section opens');

    const first = coordinator.open(
      'example',
      () => {
        requestCount += 1;
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      },
      { onSuccess: () => { successCount += 1; } }
    );
    await Promise.resolve();
    assert.equal(requestCount, 1);
    assert.equal(coordinator.getState('example'), 'loading');

    const repeated = coordinator.open('example', () => {
      throw new Error('repeated open must reuse the pending request');
    });
    assert.strictEqual(repeated, first);

    resolveRequest({ html: '<p>例文</p>' });
    const loadedResult = await first;
    assert.equal(loadedResult.status, 'loaded');
    assert.equal(loadedResult.value.html, '<p>例文</p>');
    assert.equal(successCount, 1);
    assert.equal(coordinator.getState('example'), 'loaded');

    const loadedAgain = coordinator.open('example', () => {
      throw new Error('loaded content must not refetch in the same lookup session');
    });
    assert.strictEqual(loadedAgain, first);
    assert.equal(requestCount, 1);
  });

  test(`${browserName} coordinator suppresses late success after dismissal or word switch`, async () => {
    const coordinator = loadCoordinator(helperUrl);
    let resolveDismissed;
    let resolveSwitched;
    let successCount = 0;

    coordinator.reset('猫');
    const dismissed = coordinator.open('example', () => new Promise((resolve) => {
      resolveDismissed = resolve;
    }), { onSuccess: () => { successCount += 1; } });
    await Promise.resolve();
    coordinator.invalidate();
    resolveDismissed('late dismissal result');
    assert.equal((await dismissed).status, 'stale');

    coordinator.reset('猫');
    const switched = coordinator.open('kanji', () => new Promise((resolve) => {
      resolveSwitched = resolve;
    }), { onSuccess: () => { successCount += 1; } });
    await Promise.resolve();
    coordinator.reset('犬');
    resolveSwitched('late switched-word result');
    assert.equal((await switched).status, 'stale');
    assert.equal(successCount, 0);
  });

  test(`${browserName} coordinator suppresses late error after dismissal`, async () => {
    const coordinator = loadCoordinator(helperUrl);
    let rejectRequest;
    let errorCount = 0;

    coordinator.reset('辞書');
    const request = coordinator.open('kanji', () => new Promise((resolve, reject) => {
      rejectRequest = reject;
    }), { onError: () => { errorCount += 1; } });
    await Promise.resolve();
    coordinator.invalidate();
    rejectRequest(new Error('late failure'));

    assert.equal((await request).status, 'stale');
    assert.equal(errorCount, 0);
  });
}

const tooltipFiles = [
  new URL('../chrome/js/content-tooltip.js', import.meta.url),
  new URL('../firefox/js/content-tooltip.js', import.meta.url),
];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createClassList() {
  const classes = new Set();
  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const enabled = force ?? !classes.has(name);
      if (enabled) classes.add(name);
      else classes.delete(name);
      return enabled;
    },
  };
}

function createElement() {
  return {
    innerHTML: '',
    textContent: '',
    dataset: {},
    isConnected: true,
    classList: createClassList(),
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function createAsyncSection(name) {
  const section = createElement();
  section.dataset = { section: name, state: 'idle', expanded: 'true' };
  const toggle = createElement();
  const label = createElement();
  toggle.querySelector = () => label;
  const content = createElement();
  const parts = { '.tsukeru-dropdown-toggle': toggle, '.tsukeru-dropdown-content': content };
  section.querySelector = (selector) => parts[selector] ?? null;
  return { section, content };
}

// The Kanji tab panel is filled directly, without a disclosure toggle.
function createKanjiPanel() {
  const section = createElement();
  section.dataset = { section: 'kanji', state: 'idle' };
  return { section, content: section };
}

function loadTooltipWithSeparateWindow(tooltipUrl) {
  const sentMessages = [];
  const sections = {
    'tsukeru-example-container': createAsyncSection('example'),
    'tsukeru-kanji-container': createKanjiPanel(),
  };
  const tooltip = createElement();
  const sandbox = {
    console,
    URL,
    // Firefox content scripts run in a sandbox whose global is not the page window.
    window: {},
    document: { getElementById: (id) => sections[id]?.section ?? null },
    chrome: {
      runtime: {
        async sendMessage(message) {
          sentMessages.push(message);
          if (message.action === 'fetchKanjiBreakdown') {
            return {
              success: true,
              data: { characters: [{ character: '学', on_readings: ['ガク'], meanings: ['study'] }] },
            };
          }
          return { success: true, data: {} };
        },
      },
    },
    TsukeruI18n: {
      async ready() {},
      t: (_key, _substitutions, fallback) => fallback,
      language: () => 'en',
    },
    escapeHtml,
    requestAnimationFrame() {},
    applyTsukeruUiTheme() {},
    showRateLimitToast() {},
    dictionaryTooltip: tooltip,
  };
  vm.createContext(sandbox);
  for (const url of [new URL('./tooltip-async-state.js', tooltipUrl), tooltipUrl]) {
    vm.runInContext(readFileSync(url, 'utf8'), sandbox, { filename: url.pathname });
  }
  // Keep the test on the async sections, not positioning, word capture, or definitions.
  Object.assign(sandbox, {
    positionTooltip() {},
    addTooltipInteractionHandlers() {},
    getTooltipLoadingHtml: () => '',
    captureCheckedWord: async () => null,
    lookupDefinition: () => new Promise(() => {}),
  });
  return { sandbox, sections, sentMessages, tooltip };
}

for (const tooltipUrl of tooltipFiles) {
  const browserName = tooltipUrl.pathname.includes('/firefox/') ? 'Firefox' : 'Chrome';

  test(`${browserName} tooltip loads kanji and example sections when globalThis is not window`, async () => {
    const { sandbox, sections, sentMessages, tooltip } = loadTooltipWithSeparateWindow(tooltipUrl);

    void sandbox.showDefinitionTooltip({ isConnected: true }, { word: '学習', reading: 'がくしゅう' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(tooltip._asyncCoordinator, 'the tooltip creates its async coordinator');

    await sandbox.loadKanjiBreakdown('学習');
    await sandbox.loadExampleSentence('学習');

    assert.deepEqual(sentMessages.map((message) => message.action), ['fetchKanjiBreakdown', 'fetchExampleSentence']);
    assert.equal(sections['tsukeru-kanji-container'].section.dataset.state, 'loaded');
    assert.match(sections['tsukeru-kanji-container'].content.innerHTML, /学/);
    assert.equal(sections['tsukeru-example-container'].section.dataset.state, 'empty');
  });
}

for (const tooltipUrl of tooltipFiles) {
  const browserName = tooltipUrl.pathname.includes('/firefox/') ? 'Firefox' : 'Chrome';

  test(`${browserName} Kanji panel credits KanjiVG only with valid stroke paths`, () => {
    const { sandbox } = loadTooltipWithSeparateWindow(tooltipUrl);
    const panel = (strokes) => sandbox.renderKanjiPanelHtml({ characters: [{ character: '一', strokes }] });
    assert.match(panel(['M11,54.2c3.2,0.6,6.2,0.8,9.7,0.5']), /tsukeru-stroke-attribution[^>]*>Stroke order data: <a href="https:\/\/kanjivg\.tagaini\.net"/);
    assert.doesNotMatch(panel(['M1,1"><script>']), /tsukeru-stroke-attribution/);
    assert.doesNotMatch(panel([]), /tsukeru-stroke-attribution/);
  });
}
