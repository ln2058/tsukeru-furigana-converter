// Purpose: Check that both browser copies place the dictionary tooltip by the cases shared with EZFurigana, and keep a dragged one on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

const cases = JSON.parse(readFileSync(new URL('./fixtures/tooltip-placement-cases.json', import.meta.url), 'utf8'));

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} tooltip placement follows the shared cases`, () => {
    const url = new URL(`../${browser}/js/content-tooltip.js`, import.meta.url);
    const sandbox = { console, URL };
    vm.runInNewContext(readFileSync(url, 'utf8'), sandbox, { filename: url.pathname });

    for (const { name, input, expected } of cases) {
      const result = sandbox.computeTooltipPlacement(input);
      if (expected === null) {
        assert.equal(result, null, name);
        continue;
      }
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(result[key], value, `${name}: ${key}`);
      }
      if (!input.vertical && result.anchorVisible) {
        const rect = input.anchorRects[result.anchorIndex];
        const bottom = result.top + Math.min(input.size.height, result.maxHeight);
        assert.ok(result.top >= rect.bottom || bottom <= rect.top, `${name}: never covers the word`);
      }
    }
  });
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} a dragged tooltip stays inside the viewport, as on EZFurigana`, () => {
    const url = new URL(`../${browser}/js/content-tooltip.js`, import.meta.url);
    const sandbox = { console, URL };
    vm.runInNewContext(readFileSync(url, 'utf8'), sandbox, { filename: url.pathname });
    const size = { width: 320, height: 240 };
    const viewport = { width: 1000, height: 700 };
    assert.deepEqual({ ...sandbox.clampTooltipPosition({ left: 300.4, top: 200.6, size, viewport }) }, { left: 300, top: 201 });
    assert.deepEqual({ ...sandbox.clampTooltipPosition({ left: -50, top: 900, size, viewport }) }, { left: 12, top: 448 });
    // Taller than the viewport: the top stays reachable.
    assert.equal(sandbox.clampTooltipPosition({ left: 0, top: 50, size: { width: 320, height: 900 }, viewport }).top, 12);
  });
}
