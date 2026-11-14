#!/usr/bin/env node
// Renders store-assets/slides/*.html to PNG for every locale in store-assets/locales.
//
//   node store-assets/render.mjs                    all slides, all locales
//   node store-assets/render.mjs --lang=en,ja       some locales
//   node store-assets/render.mjs --slide=02         slides whose file name contains "02"
//   node store-assets/render.mjs --scale=2          2x pixels (README/website use; stores want 1x)
//   node store-assets/render.mjs --serve            preview server only; open the printed URLs
//
// A page can set its own size with <meta name="store-size" content="440x280">; the default is 1280x800.
// Output file names follow the page file names.
//
// No dependencies: a local static server plus headless Chrome or Edge over the
// DevTools protocol. Set CHROME_PATH to use a specific browser binary.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SERVED = ['store-assets', 'chrome']; // Only these top-level folders are reachable.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const scale = Number(args.scale || 1);
const locales = (args.lang ? args.lang.split(',') : readdirSync(join(HERE, 'locales')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
const slides = readdirSync(join(HERE, 'slides')).filter((f) => f.endsWith('.html') && (!args.slide || f.includes(args.slide))).sort();

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '');
    const file = join(ROOT, path);
    const top = relative(ROOT, file).split(sep)[0];
    if (!SERVED.includes(top) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found. Set CHROME_PATH.');
  return found;
}

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'tsukeru-render-'));
  const proc = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--font-render-hinting=none',
    'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message)); else waiter.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const close = async () => {
    try { await send('Browser.close'); } catch (_) { /* already gone */ }
    proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
  };
  return { send, close };
}

function pageSize(slide) {
  const match = readFileSync(join(HERE, 'slides', slide), 'utf8').match(/<meta name="store-size" content="(\d+)x(\d+)">/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1280, height: 800 };
}

// Windows can briefly lock a PNG that a viewer or sync client has open; retry before giving up.
async function writeWithRetry(file, data) {
  for (let attempt = 1; ; attempt++) {
    try { writeFileSync(file, data); return; } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function capture(browser, url, outFile, size) {
  const { send } = browser;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: scale, mobile: false }, sessionId);
    // Store images use the light theme whatever this computer's setting is.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    let report = null;
    for (let i = 0; i < 100 && !report; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const { result } = await send('Runtime.evaluate', {
        expression: 'document.documentElement.dataset.ready === "true" ? JSON.stringify(window.__slideReport) : ""',
        returnByValue: true,
      }, sessionId);
      if (result.value) report = JSON.parse(result.value);
    }
    if (!report) throw new Error(`Timed out waiting for ${url}`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    mkdirSync(dirname(outFile), { recursive: true });
    await writeWithRetry(outFile, Buffer.from(data, 'base64'));
    return report;
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/store-assets/slides`;

if (args.serve) {
  console.log('Preview (Ctrl+C to stop):');
  for (const slide of slides) console.log(`  ${base}/${slide}?lang=${locales[0] || 'en'}`);
} else {
  const browser = await launch();
  let problems = 0;
  try {
    for (const lang of locales) {
      for (const slide of slides) {
        const suffix = scale === 1 ? '' : `@${scale}x`;
        const out = join(HERE, 'output', lang, slide.replace(/\.html$/, `${suffix}.png`));
        const report = await capture(browser, `${base}/${slide}?lang=${lang}`, out, pageSize(slide));
        const notes = [];
        if (report.missing.length) notes.push(`missing text: ${report.missing.join(', ')}`);
        if (report.overflow.length) notes.push(`overflows: ${report.overflow.join(', ')}`);
        problems += notes.length;
        console.log(`${notes.length ? '!' : '✓'} ${relative(ROOT, out)}${notes.length ? `  (${notes.join('; ')})` : ''}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (problems) process.exitCode = 1;
}
