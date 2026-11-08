import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseLocalOrigin, patchLocalCopy } = require('./build-local-extensions.js');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');

test('local builds accept only bare loopback origins', () => {
  assert.equal(parseLocalOrigin('http://localhost:8080').origin, 'http://localhost:8080');
  for (const bad of ['http://example.com:8080', 'http://localhost:8080/app', 'file:///x', 'localhost:8080']) {
    assert.throws(() => parseLocalOrigin(bad), bad);
  }
});

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} local build points every website check at the local origin`, () => {
    const out = mkdtempSync(path.join(tmpdir(), `tsukeru-local-${browser}-`));
    try {
      cpSync(path.join(repo, browser), out, { recursive: true });
      patchLocalCopy(out, parseLocalOrigin('http://localhost:8080'));
      const read = (rel) => readFileSync(path.join(out, rel), 'utf8');
      const manifest = JSON.parse(read('manifest.json'));
      assert.equal(manifest.name, 'Tsukeru Local');
      assert.ok(manifest.host_permissions.includes('http://localhost/*'));
      assert.ok(manifest.content_scripts.some((script) => script.matches.includes('http://localhost/*')));
      if (browser === 'firefox') assert.equal(manifest.browser_specific_settings.gecko.id, 'tsukeru-furigana-local@example.com');
      assert.match(read('js/bg-api.js'), /API_BASE_URL = 'http:\/\/localhost:8080'/);
      assert.match(read('js/content-sync.js'), /origin !== 'http:\/\/localhost:8080'/);
      assert.match(read('js/bg-words.js'), /url\.origin === 'http:\/\/localhost:8080'/);
      assert.match(read('background.js'), /parsed\.port !== '8080'/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}
