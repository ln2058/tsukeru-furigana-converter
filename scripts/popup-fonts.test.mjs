import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// The popup's IBM Plex Sans faces must cover the Latin letters its text uses,
// such as the macrons in "Non-jōyō only"; a letter outside every face falls back
// to a Japanese font and looks larger than the letters around it.

const INTERFACE_TEXT = 'Non-jōyō only ĀāĒēĪīŌōŪū';
const WEIGHTS = ['400', '600', '700'];
const read = (browser, path) => readFileSync(new URL(`../${browser}/${path}`, import.meta.url));

function ranges(value) {
  return value.split(',').map((part) => {
    const [low, high] = part.trim().replace(/^U\+/, '').split('-');
    return [parseInt(low, 16), parseInt(high || low, 16)];
  });
}

function plexFaces(browser) {
  const css = read(browser, 'popup.css').toString('utf8');
  return [...css.matchAll(/@font-face \{([^}]*)\}/g)]
    .map(([, body]) => body)
    .filter((body) => body.includes('"IBM Plex Sans"'))
    .map((body) => ({
      weight: /font-weight: (\d+);/.exec(body)[1],
      src: /src: url\("([^"]+\.woff2)"\)/.exec(body)[1],
      ranges: ranges(/unicode-range: ([^;]+);/.exec(body)[1]),
    }));
}

const covers = (face, codepoint) => face.ranges.some(([low, high]) => codepoint >= low && codepoint <= high);

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} popup fonts cover every letter of the interface text in each weight`, () => {
    const faces = plexFaces(browser);
    for (const weight of WEIGHTS) {
      for (const char of new Set(INTERFACE_TEXT.replace(/ /g, ''))) {
        const owners = faces.filter((face) => face.weight === weight && covers(face, char.codePointAt(0)));
        assert.equal(owners.length, 1, `${char} at ${weight} is in ${owners.length} faces`);
        assert.ok(existsSync(new URL(`../${browser}/${owners[0].src}`, import.meta.url)), owners[0].src);
      }
    }
  });
}

test('Chrome and Firefox popups use the same font faces and files', () => {
  const chrome = plexFaces('chrome');
  assert.deepEqual(plexFaces('firefox'), chrome);
  for (const { src } of chrome) assert.ok(read('chrome', src).equals(read('firefox', src)), src);
});
