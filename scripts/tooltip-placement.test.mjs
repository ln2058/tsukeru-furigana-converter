// Purpose: Check that both browser copies place the dictionary tooltip by the cases shared with EZFurigana.
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
