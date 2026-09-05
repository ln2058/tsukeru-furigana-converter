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
