import { loadI18n } from './i18n-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function loadMessages(browser, locale) {
  const read = (path) => readFileSync(new URL(`../${browser}/${path}`, import.meta.url), 'utf8');
  const catalog = JSON.parse(read(`_locales/${locale}/messages.json`));
  const getMessage = (key, substitutions = []) => {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return (catalog[key]?.message || '').replace(/\$(\d+)/g, (_, n) => values[n - 1]);
  };
  const t = (key, substitutions, fallback) => getMessage(key, substitutions) || fallback;
  const sandbox = vm.createContext({ chrome: { i18n: { getMessage } } });
  vm.runInContext(read('js/ui-messages.js'), sandbox);
  loadI18n(sandbox, browser);
  vm.runInContext(read('js/content-ui.js'), sandbox);
  return { sandbox, t, catalog, read };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} localized UI helpers load before consumers in all entry points`, () => {
    const { read } = loadMessages(browser, 'en');
    const scripts = JSON.parse(read('manifest.json')).content_scripts[0].js;
    assert.ok(scripts.indexOf('js/ui-messages.js') >= 0);
    assert.ok(scripts.indexOf('js/ui-messages.js') < scripts.indexOf('js/content-ui.js'));
    const html = read('popup.html');
    assert.ok(html.includes('src="js/ui-messages.js"'));
    assert.ok(html.indexOf('src="js/ui-messages.js"') < html.indexOf('src="js/popup-main.js"'));
    for (const path of ['background.js', 'js/popup-settings.js']) {
      const injection = read(path).match(/for \(const file of \[([\s\S]*?)\]/)[1];
      assert.ok(injection.indexOf("'js/ui-messages.js'") >= 0);
      assert.ok(injection.indexOf("'js/ui-messages.js'") < injection.indexOf("'js/content-ui.js'"));
    }
  });

  for (const locale of ['en', 'ja', 'ko', 'zh_TW']) {
    test(`${browser}/${locale} countdowns round up and keep automatic and manual retry wording distinct`, () => {
      const { sandbox, t } = loadMessages(browser, locale);
      const duration = (ms) => sandbox.TsukeruUiMessages.formatDuration(ms, t);
      const expected = {
        en: ['0s', '1s', '59s', '1m 0s', '1m 30s', '1h 0m', '1h 5m'],
        ja: ['0秒', '1秒', '59秒', '1分0秒', '1分30秒', '1時間0分', '1時間5分'],
        ko: ['0초', '1초', '59초', '1분 0초', '1분 30초', '1시간 0분', '1시간 5분'],
        zh_TW: ['0 秒', '1 秒', '59 秒', '1 分 0 秒', '1 分 30 秒', '1 小時 0 分', '1 小時 5 分'],
      }[locale];
      [-1, 1, 59000, 59001, 90000, 3599999, 3900000].forEach((ms, index) => {
        assert.equal(duration(ms), expected[index]);
        assert.equal(sandbox._formatRemaining(ms), expected[index], 'page notifications use the same units');
      });
      assert.equal(duration(NaN), expected[0]);
      const automatic = sandbox._withCountdown('request_count', duration(90000));
      const manual = sandbox.TsukeruUiMessages.errorMessage({ status: 429, retryAfter: 90 }, 'apply', t);
      assert.match(automatic, {
        en: /Retrying in 1m 30s/, ja: /1分30秒後に再試行します/,
        ko: /1분 30초 후에 자동으로 다시 시도합니다/, zh_TW: /將在 1 分 30 秒後自動重試/,
      }[locale]);
      assert.match(manual, {
        en: /Try again in 1m 30s/, ja: /1分30秒後にもう一度お試しください/,
        ko: /1분 30초 후에 다시 시도해 주세요/, zh_TW: /請在 1 分 30 秒後再試一次/,
      }[locale]);
    });

    test(`${browser}/${locale} errors use structured reasons and never expose backend text`, () => {
      const { sandbox, t, catalog } = loadMessages(browser, locale);
      const message = (error, operation = 'apply') => sandbox.TsukeruUiMessages.errorMessage(error, operation, t);
      const raw = 'Internal database error: SECRET';
      for (const [operation, key] of [['apply', 'content_toast_generic_error'], ['export', 'vocab_export_failed_short'], ['report', 'report_submit_failed']]) {
        assert.equal(message({ error: raw, message: raw, errorCode: 'unknown_code' }, operation), catalog[key].message);
      }
      for (const [metadata, key] of [
        [{ status: 503 }, 'rate_limit_service_unavailable'],
        [{ status: 403 }, 'content_toast_connection_error'],
        [{ errorCode: 'network_error' }, 'error_network'],
        [{ errorCode: 'timeout' }, 'error_timeout'],
        [{ errorCode: 'no_text' }, 'content_error_no_text_found'],
        [{ errorCode: 'page_connection' }, 'status_reload_and_retry'],
        [{ rateLimitType: 'daily_chars' }, 'rate_limit_toast_daily'],
      ]) {
        assert.equal(message({ ...metadata, error: raw, message: raw }), catalog[key].message);
      }
      assert.equal(message({ status: 429 }, 'report'), catalog.error_rate_limited.message);
      // The shared deadline wins over a stale retryAfter value.
      const deadline = message({ status: 429, retryAfter: 900, retryAt: Date.now() + 1000 });
      assert.equal(deadline, t('error_rate_limited_wait', [sandbox.TsukeruUiMessages.formatDuration(1000, t)]));
    });
  }

  test(`${browser} the known-word note follows stored settings and live changes`, async () => {
    const { sandbox, t, read } = loadMessages(browser, 'ja');
    const note = { hidden: true, textContent: '' };
    let stored = false;
    let storageListener;
    Object.assign(sandbox, {
      t, DEFAULT_SETTINGS: { hideKnownFurigana: true },
      getActiveTab: async () => null,
      document: { getElementById: (id) => id === 'pageWordsKnownNote' ? note : null },
    });
    sandbox.chrome.storage = {
      sync: { get: async () => ({ hideKnownFurigana: stored }) },
      onChanged: { addListener: (listener) => { storageListener = listener; } },
    };
    sandbox.chrome.runtime = { onMessage: { addListener() {} } };
    vm.runInContext(read('js/popup-vocab.js').replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '').replaceAll('export ', ''), sandbox);
    await sandbox.initPageTab();
    await sandbox.loadPageWords();
    sandbox.renderPageSummary({ known: 2 });
    assert.equal(note.hidden, true);
    assert.equal(note.textContent, '');

    stored = true;
    await sandbox.loadPageWords();
    sandbox.renderPageSummary({ known: 2 });
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /2語/);
    storageListener({ hideKnownFurigana: { newValue: false } }, 'sync');
    assert.equal(note.hidden, true, 'turning the setting off clears a visible claim');
    assert.equal(note.textContent, '');
    storageListener({ hideKnownFurigana: { newValue: true } }, 'local');
    sandbox.renderPageSummary({ known: 2 });
    assert.equal(note.hidden, true, 'unrelated storage does not change the setting');
    storageListener({ hideKnownFurigana: { newValue: true } }, 'sync');
    sandbox.renderPageSummary({ known: 0 });
    assert.equal(note.hidden, true, 'there is no hidden-reading claim without known words');
  });
}
