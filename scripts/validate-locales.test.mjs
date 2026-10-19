import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const validator = fileURLToPath(new URL('./validate-locales.js', import.meta.url));

function validate(mutate = () => {}, mutateFiles = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsukeru-locales-'));
  try {
    for (const browser of ['chrome', 'firefox']) {
      for (const locale of ['en', 'ja', 'ko', 'zh_TW']) {
        const catalog = {
          ui_lang: { message: locale === 'zh_TW' ? 'zh-TW' : locale },
          manifest_name: { message: 'Tsukeru' },
          manifest_description: { message: 'Furigana' },
          duration: { message: locale === 'en' ? '$1 min $2 sec' : '$2 seconds, $1 minutes' },
          status_enable_file_access: { message: browser === 'chrome' ? 'Enable file access' : 'Runtime permissions' },
          status_local_files_not_supported: { message: browser === 'chrome' ? 'Chrome/Edge files' : 'Browser permissions' },
        };
        mutate(catalog, browser, locale);
        const dir = path.join(root, browser, '_locales', locale);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(catalog));
      }
    }
    for (const browser of ['chrome', 'firefox']) {
      const options = ['en', 'ja', 'ko', 'zh_TW'].map(code => `<option value="${code}" lang="${code.replace('_', '-')}">${code}</option>`).join('');
      writeFileSync(path.join(root, browser, 'popup.html'), `<button data-i18n-aria-label="duration"></button><select id="uiLocale"><option value="">Auto</option>${options}</select>`);
      mkdirSync(path.join(root, browser, 'js'));
      writeFileSync(path.join(root, browser, 'js', 'i18n.js'), readFileSync(new URL(`../${browser}/js/i18n.js`, import.meta.url)));
    }
    writeFileSync(path.join(root, 'chrome', 'language.js'), "chrome.i18n?.getMessage?.('ui_lang');");
    mutateFiles(root);
    const result = spawnSync(process.execPath, [validator], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()), 'cleanup stays within the temporary directory');
    rmSync(root, { recursive: true, force: true });
  }
}

test('locale validation accepts reordered positional tokens and browser-specific file messages', () => {
  assert.equal(validate().status, 0);
});

test('locale validation rejects missing or unexpected positional tokens', () => {
  for (const message of ['$1 minutes', '$1 min $2 sec $3']) {
    const result = validate((catalog, browser, locale) => {
      if (browser === 'chrome' && locale === 'ko') catalog.duration.message = message;
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /positional placeholders differ from chrome\/en/);
  }
});

test('locale validation rejects browser drift in a shared translation', () => {
  const result = validate((catalog, browser, locale) => {
    if (browser === 'firefox' && locale === 'zh_TW') catalog.manifest_name.message = 'Different';
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /Browser translation differs from Chrome for shared key: manifest_name/);
});

test('locale validation catches missing accessibility label keys', () => {
  const result = validate(catalog => { delete catalog.duration; });
  assert.equal(result.status, 1);
  assert.match(result.output, /Referenced locale key not found in canonical locale: duration/);
});

test('locale validation catches missing keys referenced through optional getMessage calls', () => {
  const result = validate(catalog => { delete catalog.ui_lang; });
  assert.equal(result.status, 1);
  assert.match(result.output, /Referenced locale key not found in canonical locale: ui_lang/);
});

test('locale validation enforces translated manifest name and description limits', () => {
  for (const [key, limit] of [['manifest_name', 45], ['manifest_description', 132]]) {
    const result = validate((catalog, browser, locale) => {
      if (locale === 'ko') catalog[key].message = '가'.repeat(limit + 1);
    });
    assert.equal(result.status, 1);
    assert.match(result.output, new RegExp(`manifest text exceeds ${limit} characters`));
  }
});

test('locale validation rejects named placeholders fields and out-of-range tokens', () => {
  for (const mutate of [catalog => { catalog.duration.placeholders = {}; }, catalog => { catalog.duration.message = '$10'; }]) {
    assert.equal(validate(mutate).status, 1);
  }
});

test('locale validation catches missing language options and unvalidated locale folders', () => {
  for (const mutate of [
    root => {
      const file = path.join(root, 'chrome', 'popup.html');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/<option value="ko"[^>]*>.*?<\/option>/, ''));
    },
    root => mkdirSync(path.join(root, 'firefox', '_locales', 'fr')),
  ]) {
    const result = validate(() => {}, mutate);
    assert.equal(result.status, 1);
    assert.match(result.output, /must match _locales folders/);
  }
});
