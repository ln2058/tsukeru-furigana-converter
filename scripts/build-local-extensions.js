/*
Module: build-local-extensions
Purpose: Generate "Tsukeru Local" copies of both extensions that talk to a local EZFurigana server, for piloting backend features before release.

Inputs:
- chrome/ and firefox/ source extension folders.
- TSUKERU_LOCAL_ORIGIN (default http://localhost:8080): the local server's origin, http or https on localhost or 127.0.0.1.

Outputs:
- dist/chrome-local/ and dist/firefox-local/ (generated, git-excluded).

Side Effects:
- Deletes and recreates the two output folders under dist/.
- Rewrites the website origin, host checks, manifest name, host permissions, content-script matches and the Firefox add-on id in the generated copies only.

Failure Modes:
- An origin that is not a bare localhost/127.0.0.1 origin, a missing expected source string, or a leftover production origin literal exits non-zero.
- Paths outside the repository dist/ folder are refused.

Security Notes:
- Source folders are never modified; only generated copies change.
- Only loopback origins are accepted, so a generated build can never be pointed at another host.
- The copies use their own name and Firefox id so they install next to the store version.
*/
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const PRODUCTION_ORIGIN = 'https://www.ezfurigana.com';
const PRODUCTION_HOST = 'www.ezfurigana.com';
const LOCAL_NAME = 'Tsukeru Local';
const LOCAL_GECKO_ID = 'tsukeru-furigana-local@example.com';
const TEXT_EXTENSIONS = new Set(['.js', '.html', '.json', '.css']);

function parseLocalOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`TSUKERU_LOCAL_ORIGIN is not a URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.origin !== value.replace(/\/$/, '')) {
    throw new Error(`TSUKERU_LOCAL_ORIGIN must be a bare localhost or 127.0.0.1 origin, got: ${value}`);
  }
  return url;
}

function listTextFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTextFiles(full));
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

function replaceCounted(content, pattern, replacement, label, minimum) {
  let count = 0;
  const next = content.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (count < minimum) throw new Error(`${label}: expected at least ${minimum} match(es), found ${count}`);
  return next;
}

/** Point one copied extension folder at the local origin. */
function patchLocalCopy(outputDir, local) {
  const read = (rel) => fs.readFileSync(path.join(outputDir, rel), 'utf8');
  const write = (rel, content) => fs.writeFileSync(path.join(outputDir, rel), content, 'utf8');

  // Origin literals in every script, page and locale file.
  for (const file of listTextFiles(outputDir)) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(PRODUCTION_ORIGIN)) fs.writeFileSync(file, content.split(PRODUCTION_ORIGIN).join(local.origin), 'utf8');
  }

  // Audio proxy checks compare protocol, host and port separately.
  for (const rel of ['background.js', path.join('js', 'bg-api.js')]) {
    let content = read(rel);
    content = replaceCounted(content, `'${PRODUCTION_HOST}'`, `'${local.hostname}'`, `${rel} host check`, 1);
    content = replaceCounted(content, /(\w+)\.protocol !== 'https:'/g, (_, name) => `${name}.protocol !== '${local.protocol}'`, `${rel} protocol check`, 1);
    content = replaceCounted(content, /(\w+)\.port !== '' && \1\.port !== '443'/g, (_, name) => `${name}.port !== '${local.port}'`, `${rel} port check`, 1);
    write(rel, content);
  }

  const manifest = JSON.parse(read('manifest.json'));
  // Match patterns cannot name a port; this one covers any port on the host.
  const pattern = `${local.protocol}//${local.hostname}/*`;
  const localOriginPattern = `${local.origin}/*`;
  const swap = (value) => (value === localOriginPattern ? pattern : value);
  manifest.name = LOCAL_NAME;
  manifest.host_permissions = manifest.host_permissions.map(swap);
  for (const script of manifest.content_scripts) script.matches = script.matches.map(swap);
  if (!manifest.host_permissions.includes(pattern)) throw new Error('manifest host permission was not rewritten');
  if (manifest.browser_specific_settings?.gecko) manifest.browser_specific_settings.gecko.id = LOCAL_GECKO_ID;
  write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  const leftovers = listTextFiles(outputDir).filter((file) => {
    const content = fs.readFileSync(file, 'utf8');
    return /['"`]https:\/\/www\.ezfurigana\.com/.test(content) || content.includes(`'${PRODUCTION_HOST}'`);
  });
  if (leftovers.length) throw new Error(`production origin left in: ${leftovers.map((f) => path.relative(outputDir, f)).join(', ')}`);
}

function main() {
  const local = parseLocalOrigin(process.env.TSUKERU_LOCAL_ORIGIN || 'http://localhost:8080');
  for (const browser of ['chrome', 'firefox']) {
    const outputDir = path.join(DIST_DIR, `${browser}-local`);
    if (!path.resolve(outputDir).startsWith(DIST_DIR + path.sep)) throw new Error(`Refusing to write outside dist: ${outputDir}`);
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.cpSync(path.join(REPO_ROOT, browser), outputDir, { recursive: true, filter: (src) => !src.endsWith('.zip') });
    patchLocalCopy(outputDir, local);
    console.log(`  dist/${browser}-local/ -> ${local.origin}`);
  }
  console.log('Load dist/chrome-local as an unpacked extension (Chrome/Edge) and dist/firefox-local/manifest.json as a temporary add-on (Firefox).');
  console.log('Firefox: allow the localhost site permission in about:addons, since MV3 host permissions are opt-in there.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { parseLocalOrigin, patchLocalCopy };
