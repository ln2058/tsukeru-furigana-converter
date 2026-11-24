// The video caption allowance (bg-captions): the one-time preview, a free
// account's daily minutes, Supporters without a limit, counting that never
// double-counts, and the sign-in tab that closes once Tsukeru is connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const MINUTE = 60 * 1000;

function load(browserName, { status = { state: 'free' }, perks = null, storageFails = false } = {}) {
  const source = readFileSync(new URL(`../${browserName}/js/bg-captions.js`, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  const local = new Map();
  const session = new Map();
  const tabs = { created: [], removed: [], updated: [], messages: [] };
  const area = (map) => ({
    async get(key) {
      if (storageFails) throw new Error('storage unavailable');
      return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {};
    },
    async set(items) {
      if (storageFails) throw new Error('storage unavailable');
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
  });
  const sandbox = {
    setTimeout, clearTimeout, Promise, Number, Math, Object,
    state: { status },
    getSupporterStatus: async () => sandbox.state.status,
    getSupporterPerks: async () => perks,
    localDay: (now) => new Date(now).toISOString().slice(0, 10),
    TsukeruI18n: { ready: async () => {}, signInUrl: (trigger) => `https://www.ezfurigana.com/auth/login?trigger=${trigger}` },
    chrome: {
      storage: { local: area(local), session: area(session) },
      tabs: {
        async create(options) { tabs.created.push(options); return { id: 900 + tabs.created.length }; },
        async remove(id) { tabs.removed.push(id); },
        async update(id, options) { tabs.updated.push([id, options]); },
        async sendMessage(id, message) { tabs.messages.push([id, message]); },
      },
      windows: { async update() {} },
    },
  };
  vm.runInNewContext(`${source}
globalThis.api = { cleanAllowanceRecord, captionPlanFor, allowanceFor, allowanceOpen, countPlayback, getCaptionAllowance, noteCaptionPlayback, openCaptionSignIn, finishCaptionSignIn, MAX_TICK_MS };`, sandbox);
  return { api: sandbox.api, local, tabs, sandbox };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} a new day starts a free account's minutes again, but never the preview`, () => {
    const { api } = load(browserName);
    const kept = api.cleanAllowanceRecord({ day: '2026-11-23', usedMs: 25 * MINUTE, guestUsedMs: 5 * MINUTE, lastCountedAt: 10 }, '2026-11-24');
    assert.deepEqual(plain(kept), { day: '2026-11-24', usedMs: 0, guestUsedMs: 5 * MINUTE, lastCountedAt: 10 });
    const junk = api.cleanAllowanceRecord({ day: '2026-11-24', usedMs: -4, guestUsedMs: 'x', lastCountedAt: Infinity }, '2026-11-24');
    assert.deepEqual(plain(junk), { day: '2026-11-24', usedMs: 0, guestUsedMs: 0, lastCountedAt: 0 });
  });

  test(`${browserName} each connection state gets its own allowance`, () => {
    const { api } = load(browserName);
    assert.equal(api.captionPlanFor({ state: 'supporter' }), 'supporter');
    assert.equal(api.captionPlanFor({ state: 'free' }), 'free');
    assert.equal(api.captionPlanFor({ state: 'expired' }), 'free', 'a lapsed Supporter keeps the free minutes');
    assert.equal(api.captionPlanFor({ state: 'none' }), 'guest');
    assert.equal(api.captionPlanFor({ state: 'disconnected' }), 'guest');

    const record = { usedMs: 30 * MINUTE, guestUsedMs: 2 * MINUTE };
    assert.equal(api.allowanceFor(record, 'supporter').state, 'unlimited');
    assert.equal(api.allowanceFor(record, 'free').state, 'free_done');
    assert.equal(api.allowanceFor(record, 'free', { freeDailyMinutes: 45 }).remainingMs, 15 * MINUTE);
    const guest = api.allowanceFor(record, 'guest');
    assert.deepEqual(plain(guest), { state: 'guest', plan: 'guest', remainingMs: 3 * MINUTE, limitMs: 5 * MINUTE, freeLimitMs: 30 * MINUTE });
    assert.equal(api.allowanceOpen({ state: 'guest_done' }), false);
    assert.equal(api.allowanceOpen({ state: 'unchecked' }), true, 'our own error never cuts a reader off');
  });

  test(`${browserName} playback counts once, however many tabs tick, and never more than a tick`, () => {
    const { api } = load(browserName);
    const start = { day: 'd', usedMs: 0, guestUsedMs: 0, lastCountedAt: 0 };
    const first = api.countPlayback(start, 'free', 5000, 100_000);
    assert.equal(first.usedMs, 5000);
    // A second tab ticks one second later: only that second counts.
    const second = api.countPlayback(first, 'free', 5000, 101_000);
    assert.equal(second.usedMs, 6000);
    // A long gap still counts one tick at most; a clock that moves back counts nothing.
    assert.equal(api.countPlayback(second, 'free', 60_000, 500_000).usedMs, 6000 + api.MAX_TICK_MS);
    assert.equal(api.countPlayback(second, 'free', 5000, 50_000).usedMs, 6000);
    assert.equal(api.countPlayback(start, 'guest', 5000, 100_000).guestUsedMs, 5000);
    assert.equal(api.countPlayback(start, 'supporter', 5000, 100_000), start, 'Supporters are not counted');
  });

  test(`${browserName} a free account's day runs out and stays out, with the server's minutes`, async () => {
    const { api, local } = load(browserName, { perks: { captions: { free: 1, guest: 5 } } });
    let now = Date.parse('2026-11-24T10:00:00Z');
    let allowance;
    for (let tick = 0; tick < 13; tick += 1) {
      now += 5000;
      allowance = await api.noteCaptionPlayback(5000, now);
    }
    assert.equal(allowance.state, 'free_done');
    assert.equal(local.get('captionAllowance').usedMs, 60_000, 'counting stops at the limit');
    assert.equal((await api.getCaptionAllowance(now)).state, 'free_done');
    // The next day has the full minute again.
    assert.equal((await api.getCaptionAllowance(now + 24 * 60 * MINUTE)).state, 'free');
  });

  test(`${browserName} the preview is counted once, and signing in moves on to the free minutes`, async () => {
    const loaded = load(browserName, { status: { state: 'none' } });
    let now = Date.parse('2026-11-24T10:00:00Z');
    for (let tick = 0; tick < 61; tick += 1) {
      now += 5000;
      await loaded.api.noteCaptionPlayback(5000, now);
    }
    const used = await loaded.api.getCaptionAllowance(now);
    assert.equal(used.state, 'guest_done');
    assert.equal(used.freeLimitMs, 30 * MINUTE);
    loaded.sandbox.state.status = { state: 'free' };
    const signedIn = await loaded.api.getCaptionAllowance(now);
    assert.equal(signedIn.state, 'free');
    assert.equal(signedIn.remainingMs, 30 * MINUTE);
  });

  test(`${browserName} unreadable storage answers unchecked, so captions keep working`, async () => {
    const { api } = load(browserName, { storageFails: true });
    assert.equal((await api.getCaptionAllowance()).state, 'unchecked');
    assert.equal((await api.noteCaptionPlayback(5000)).state, 'unchecked');
  });

  test(`${browserName} the sign-in tab it opened closes after connecting; other tabs are left alone`, async () => {
    const { api, tabs } = load(browserName);
    await api.openCaptionSignIn({ id: 7, index: 2, windowId: 3 });
    assert.equal(tabs.created[0].url, 'https://www.ezfurigana.com/auth/login?trigger=tsukeru_captions');
    assert.equal(tabs.created[0].index, 3, 'opens next to the video');

    await api.finishCaptionSignIn(555, 'free');
    assert.deepEqual(tabs.removed, [], 'a tab the reader opened stays open');
    await api.finishCaptionSignIn(901, 'disconnected');
    assert.deepEqual(tabs.removed, [], 'no connection, nothing to close');

    await api.finishCaptionSignIn(901, 'free');
    assert.deepEqual(tabs.removed, [901]);
    assert.deepEqual(plain(tabs.updated), [[7, { active: true }]]);
    assert.deepEqual(plain(tabs.messages), [[7, { action: 'captionConnected', plan: 'free' }]]);
    await api.finishCaptionSignIn(901, 'free');
    assert.deepEqual(tabs.removed, [901], 'closed once');
  });

  test(`${browserName} caption text is marked, refused past the limit, and other text is never limited`, () => {
    const background = readFileSync(new URL(`../${browserName}/background.js`, import.meta.url), 'utf8');
    assert.match(background, /const \{ caption = false, \.\.\.payload \} = message\.payload \|\| \{\};/);
    assert.match(background, /errorCode: 'caption_limit'/);
    assert.match(background, /handleFuriganaRequest\(payload\)/, 'the backend request carries no caption flag');
    const dom = readFileSync(new URL(`../${browserName}/js/content-dom.js`, import.meta.url), 'utf8');
    assert.match(dom, /caption: true,\s*\}, 3, \(\) => isVideoCaptionOperationCurrent\(operation\)/);
    assert.match(dom, /noteCaptionText\(\);\s*if \(!captionGateOpen\(\)\) return;/);
    const manifest = JSON.parse(readFileSync(new URL(`../${browserName}/manifest.json`, import.meta.url), 'utf8'));
    const scripts = manifest.content_scripts[0].js;
    assert.ok(scripts.indexOf('js/content-captions.js') < scripts.indexOf('js/content-main.js'));
    const injected = background.match(/CONTENT_SCRIPT_FILES = \[([\s\S]*?)\]/)[1].match(/'[^']+'/g).map((file) => file.slice(1, -1));
    // Discover's scripts only run on pages Discover opened, which load them from the manifest.
    assert.deepEqual(injected, scripts.filter((file) => !file.includes('discover')), 'injected (and added to embedded frames) in manifest order');
  });
}
