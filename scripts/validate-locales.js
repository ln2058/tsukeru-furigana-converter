/*
Module: validate-locales
Purpose: Validate locale syntax, key/placeholder/browser parity, manifest limits, language options, and source-key usage.

Inputs:
- Locale message files under chrome/_locales and firefox/_locales.
- Source files under chrome/ and firefox/ that reference locale keys.
- Display-language options and the shared helper's fixed locale table in both browser packages.

Outputs:
- Process exit code (0 success, 1 failures) and validation report to stdout.

Side Effects:
- None.

Failure Modes:
- Invalid JSON, malformed/missing placeholders, locale or browser drift, overlong manifest text, or missing referenced keys cause non-zero exit.

Security Notes:
- Reads local repository files only.
*/
const fs = require('fs');
const path = require('path');

const CANONICAL_LOCALE_FILE = path.join('chrome', '_locales', 'en', 'messages.json');
const LOCALE_FILES = [
  CANONICAL_LOCALE_FILE,
  path.join('chrome', '_locales', 'ja', 'messages.json'),
  path.join('chrome', '_locales', 'ko', 'messages.json'),
  path.join('chrome', '_locales', 'zh_TW', 'messages.json'),
  path.join('firefox', '_locales', 'en', 'messages.json'),
  path.join('firefox', '_locales', 'ja', 'messages.json'),
  path.join('firefox', '_locales', 'ko', 'messages.json'),
  path.join('firefox', '_locales', 'zh_TW', 'messages.json')
];
// File-access instructions differ because browser runtime permissions differ.
const BROWSER_SPECIFIC_KEYS = new Set(['status_enable_file_access', 'status_local_files_not_supported']);
// Both packages also target stores with a 45-character name cap (Edge Add-ons / AMO).
const MANIFEST_MESSAGE_LIMITS = { manifest_name: 45, manifest_description: 132 };
const SOURCE_ROOTS = ['chrome', 'firefox'];
const SOURCE_EXTENSIONS = new Set(['.js', '.html', '.json']);
const SKIP_SOURCE_DIRS = new Set(['_locales', 'icons']);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectFiles(rootDir, options = {}) {
  const { allowedExtensions = null, skipDirs = new Set(), fileName = null } = options;
  const files = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (fileName && entry.name !== fileName) {
        continue;
      }
      if (allowedExtensions && !allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      files.push(fullPath);
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return files;
}

function validateMessage(message) {
  const issues = [];
  // Escaped dollar signs are literals, not positional or named placeholders.
  message = message.replace(/\$\$/g, '');

  if (/\$\d+\$/.test(message)) {
    issues.push('invalid wrapped numeric placeholder (example: $1$)');
  }
  if (/\$[A-Za-z_][A-Za-z0-9_]*\$/.test(message)) {
    issues.push('unsupported named placeholder token (example: $name$)');
  }
  if (/(\$\d+)(\$\d+)/.test(message)) {
    issues.push('adjacent numeric placeholders must have a separator (example: "$1 $2")');
  }

  const indices = [...message.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  if (indices.some((n) => n < 1 || n > 9)) {
    issues.push('placeholder indices must be in the supported range $1–$9');
  }

  return issues;
}

function positionalTokens(message) {
  // Translations may reorder tokens, but must retain the same set of indices.
  return [...new Set(String(message).replace(/\$\$/g, '').match(/\$\d+/g) || [])].sort();
}

function localeOptionIssues(browser) {
  const issues = [];
  const folders = fs.readdirSync(path.join(browser, '_locales'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const checked = LOCALE_FILES.filter(file => file.startsWith(`${browser}${path.sep}`))
    .map(file => path.basename(path.dirname(file))).sort();
  const html = fs.readFileSync(path.join(browser, 'popup.html'), 'utf8');
  const select = html.match(/<select\b[^>]*\bid="uiLocale"[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
  const options = [...select.matchAll(/<option\b([^>]*)>/g)].map(([, attributes]) => ({
    value: attributes.match(/\bvalue="([^"]*)"/)?.[1],
    lang: attributes.match(/\blang="([^"]*)"/)?.[1],
    translated: /\bdata-i18n/.test(attributes),
  }));
  const codes = options.filter(option => option.value).map(option => option.value).sort();
  // Read the fixed locale table without executing extension source during validation.
  const source = fs.readFileSync(path.join(browser, 'js', 'i18n.js'), 'utf8');
  const table = source.match(/const locales = Object\.freeze\(\{([\s\S]*?)\n  \}\);/)?.[1] || '';
  const supported = [...table.matchAll(/^    ([A-Za-z_]+):/gm)].map(match => match[1]).sort();
  for (const [label, values] of [['dropdown options', codes], ['supported locales', supported], ['validated catalogs', checked]]) {
    if (JSON.stringify(values) !== JSON.stringify(folders)) issues.push(`${label} must match _locales folders`);
  }
  if (options.filter(option => option.value === '').length !== 1) issues.push('language dropdown must have exactly one Auto option');
  if (options.some(option => option.translated || (option.value && option.lang !== option.value.replace('_', '-')))) {
    issues.push('language options must retain their native names and matching lang attributes');
  }
  return issues;
}

function getKeyLineNumber(rawContent, key) {
  const keyPattern = new RegExp(`"${escapeRegex(key)}"\\s*:`);
  const lines = rawContent.split(/\r?\n/);
  const idx = lines.findIndex((line) => keyPattern.test(line));
  return idx >= 0 ? idx + 1 : null;
}

function getLineNumberFromIndex(rawContent, index) {
  if (index <= 0) return 1;
  return rawContent.slice(0, index).split(/\r?\n/).length;
}

function readLocaleFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw);
  return { raw, json };
}

function getRelativePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function addReference(map, key, filePath, lineNumber, kind) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push({
    filePath: getRelativePath(filePath),
    lineNumber,
    kind
  });
}

function collectReferencedKeys() {
  const refs = new Map();
  const sourceFiles = SOURCE_ROOTS.flatMap((root) => collectFiles(root, {
    allowedExtensions: SOURCE_EXTENSIONS,
    skipDirs: SKIP_SOURCE_DIRS
  }));

  const regexes = [
    { kind: 'js:t()', regex: /\bt\s*\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g, group: 2 },
    { kind: 'js:getMessage()', regex: /\bgetMessage\s*(?:\?\.\s*)?\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g, group: 2 },
    { kind: 'html:data-i18n', regex: /data-i18n(?:-title|-placeholder|-aria-label)?\s*=\s*(['"])([^'"`]+)\1/g, group: 2 },
    { kind: 'manifest:__MSG__', regex: /__MSG_([A-Za-z0-9_]+)__/g, group: 1 }
  ];

  for (const filePath of sourceFiles) {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const { kind, regex, group } of regexes) {
      regex.lastIndex = 0;
      for (const match of raw.matchAll(regex)) {
        const key = match[group];
        const line = getLineNumberFromIndex(raw, match.index || 0);
        addReference(refs, key, filePath, line, kind);
      }
    }
  }

  return refs;
}

function main() {
  let hardIssues = 0;
  for (const browser of SOURCE_ROOTS) {
    try {
      for (const issue of localeOptionIssues(browser)) {
        hardIssues += 1;
        console.error(`[ERROR] ${browser}: ${issue}`);
      }
    } catch (error) {
      hardIssues += 1;
      console.error(`[ERROR] ${browser}: cannot validate language options (${error.message})`);
    }
  }
  let warnings = 0;
  let totalCheckedMessages = 0;

  const localeData = new Map();
  for (const filePath of LOCALE_FILES) {
    if (!fs.existsSync(filePath)) {
      hardIssues += 1;
      console.error(`\n[ERROR] ${getRelativePath(filePath)}`);
      console.error('  Missing locale file.');
      continue;
    }
    try {
      localeData.set(filePath, readLocaleFile(filePath));
    } catch (err) {
      hardIssues += 1;
      console.error(`\n[ERROR] ${getRelativePath(filePath)}`);
      console.error(`  Invalid JSON: ${err.message}`);
    }
  }

  for (const filePath of LOCALE_FILES) {
    const data = localeData.get(filePath);
    if (!data) {
      continue;
    }
    const { raw, json } = data;
    const fileLabel = getRelativePath(filePath);

    for (const [key, value] of Object.entries(json)) {
      if (!value || typeof value.message !== 'string') {
        hardIssues += 1;
        const lineNo = getKeyLineNumber(raw, key);
        const location = lineNo ? `${fileLabel}:${lineNo}` : fileLabel;
        console.error(`\n[ERROR] ${location}`);
        console.error(`  key: ${key}`);
        console.error('  Missing required string field: "message".');
        continue;
      }
      totalCheckedMessages += 1;
      const issues = validateMessage(value.message);
      if (Object.hasOwn(value, 'placeholders')) {
        issues.push('named placeholders fields are unsupported; use positional $1–$9 tokens');
      }
      const limit = MANIFEST_MESSAGE_LIMITS[key];
      if (limit && value.message.length > limit) {
        issues.push(`manifest text exceeds ${limit} characters (${value.message.length})`);
      }
      const browser = filePath.split(path.sep)[0];
      const english = localeData.get(path.join(browser, '_locales', 'en', 'messages.json'));
      const sourceMessage = english?.json[key]?.message;
      if (typeof sourceMessage === 'string'
          && JSON.stringify(positionalTokens(value.message)) !== JSON.stringify(positionalTokens(sourceMessage))) {
        issues.push(`positional placeholders differ from ${browser}/en: expected ${positionalTokens(sourceMessage).join(', ') || 'none'}`);
      }
      if (issues.length === 0) {
        continue;
      }

      hardIssues += issues.length;
      const lineNo = getKeyLineNumber(raw, key);
      const location = lineNo ? `${fileLabel}:${lineNo}` : fileLabel;
      console.error(`\n[ERROR] ${location}`);
      console.error(`  key: ${key}`);
      console.error(`  message: ${JSON.stringify(value.message)}`);
      for (const issue of issues) {
        console.error(`  - ${issue}`);
      }
    }
  }

  const canonicalData = localeData.get(CANONICAL_LOCALE_FILE);
  const canonicalKeys = canonicalData ? new Set(Object.keys(canonicalData.json)) : null;

  for (const [filePath, { json }] of localeData) {
    if (!filePath.startsWith(`chrome${path.sep}`)) continue;
    // Enforce shared wording for new catalogs; leave the existing en/ja copy untouched.
    if (!['ko', 'zh_TW'].includes(path.basename(path.dirname(filePath)))) continue;
    const firefoxPath = filePath.replace(/^chrome/, 'firefox');
    const firefox = localeData.get(firefoxPath);
    if (!firefox) continue;
    for (const [key, entry] of Object.entries(json)) {
      if (BROWSER_SPECIFIC_KEYS.has(key) || !firefox.json[key]) continue;
      if (entry?.message !== firefox.json[key]?.message) {
        hardIssues += 1;
        console.error(`\n[ERROR] ${getRelativePath(firefoxPath)}`);
        console.error(`  Browser translation differs from Chrome for shared key: ${key}`);
      }
    }
  }

  if (canonicalData && canonicalKeys) {
    for (const filePath of LOCALE_FILES) {
      if (filePath === CANONICAL_LOCALE_FILE) {
        continue;
      }
      const candidate = localeData.get(filePath);
      if (!candidate) {
        continue;
      }

      const fileLabel = getRelativePath(filePath);
      const candidateKeys = new Set(Object.keys(candidate.json));
      const missing = [...canonicalKeys].filter((key) => !candidateKeys.has(key)).sort();
      const extra = [...candidateKeys].filter((key) => !canonicalKeys.has(key)).sort();

      for (const key of missing) {
        hardIssues += 1;
        const canonicalLine = getKeyLineNumber(canonicalData.raw, key);
        const canonicalLocation = canonicalLine
          ? `${getRelativePath(CANONICAL_LOCALE_FILE)}:${canonicalLine}`
          : getRelativePath(CANONICAL_LOCALE_FILE);
        console.error(`\n[ERROR] ${fileLabel}`);
        console.error(`  Missing key: ${key}`);
        console.error(`  Present in canonical locale at ${canonicalLocation}`);
      }

      for (const key of extra) {
        hardIssues += 1;
        const lineNo = getKeyLineNumber(candidate.raw, key);
        const location = lineNo ? `${fileLabel}:${lineNo}` : fileLabel;
        console.error(`\n[ERROR] ${location}`);
        console.error(`  Extra key not present in canonical locale: ${key}`);
      }
    }

    const references = collectReferencedKeys();
    const referencedKeys = [...references.keys()].sort();
    for (const key of referencedKeys) {
      if (canonicalKeys.has(key)) {
        continue;
      }
      hardIssues += 1;
      const firstRef = references.get(key)[0];
      const location = `${firstRef.filePath}:${firstRef.lineNumber}`;
      console.error(`\n[ERROR] ${location}`);
      console.error(`  Referenced locale key not found in canonical locale: ${key}`);
      console.error(`  Reference type: ${firstRef.kind}`);
      console.error(`  Total references found: ${references.get(key).length}`);
    }

    const unusedKeys = [...canonicalKeys].filter((key) => !references.has(key)).sort();
    if (unusedKeys.length > 0) {
      warnings += unusedKeys.length;
      console.warn('\n[WARN] Unused locale keys in canonical locale:');
      for (const key of unusedKeys) {
        const lineNo = getKeyLineNumber(canonicalData.raw, key);
        const location = lineNo
          ? `${getRelativePath(CANONICAL_LOCALE_FILE)}:${lineNo}`
          : getRelativePath(CANONICAL_LOCALE_FILE);
        console.warn(`  - ${key} (${location})`);
      }
    }
  }

  const parsedLocaleFiles = [...localeData.keys()].length;
  if (hardIssues > 0) {
    console.error(
      `\nLocale validation failed: ${hardIssues} hard issue(s), ${warnings} warning(s), `
      + `${totalCheckedMessages} message key(s) checked across ${parsedLocaleFiles} locale file(s).`
    );
    process.exit(1);
  }

  console.log(
    `Locale validation passed: ${totalCheckedMessages} message key(s) checked across `
    + `${parsedLocaleFiles} locale file(s). Warnings: ${warnings}.`
  );
}

main();
