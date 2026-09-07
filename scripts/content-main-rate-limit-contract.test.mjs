import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function loadSerializer(browserName) {
  const sourceUrl = new URL(`../${browserName}/js/content-main.js`, import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  const sandbox = {
    window: {},
    document: {},
    detectSite: () => 'default',
    chrome: {
      i18n: { getMessage: () => '' },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) },
    },
  };
  vm.runInNewContext(source, sandbox, { filename: `${browserName}/js/content-main.js` });
  return sandbox.serializeApplyFailure;
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} preserves structured Apply rate-limit failures`, () => {
    const serializeApplyFailure = loadSerializer(browserName);
    const retryAt = Date.now() + 120_000;
    const result = serializeApplyFailure({
      message: 'Character limit reached',
      status: 429,
      errorCode: 'rate_limited',
      operation: 'furigana',
      rateLimitType: 'hourly_chars',
      retryAfter: 120,
      retryAt,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      ok: false,
      error: 'Character limit reached',
      status: 429,
      errorCode: 'rate_limited',
      operation: 'furigana',
      rateLimitType: 'hourly_chars',
      retryAfter: 120,
      retryAt,
    });
  });
}
