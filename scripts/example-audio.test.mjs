// Purpose: A TKGJE example with a recorded reading gets a play button that asks
// the background for it by id, only on a trusted click.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.events = {};
    this.attrs = {};
    this.className = '';
    this.textContent = '';
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(name, callback) { this.events[name] = callback; }
  find(className) {
    for (const child of this.children) {
      if (child.className.split(' ').includes(className)) return child;
      const found = child.find?.(className);
      if (found) return found;
    }
    return null;
  }
}

function load(browser) {
  const messages = [];
  const sandbox = {
    console,
    TsukeruI18n: { language: () => 'en', t: (_key, _subs, fallback) => fallback },
    chrome: { runtime: { sendMessage(message) { messages.push(message); } } },
    document: { createElement: (tag) => new Element(tag) },
  };
  vm.createContext(sandbox);
  for (const file of ['ui-messages.js', 'content-tooltip.js']) {
    vm.runInContext(readFileSync(new URL(`../${browser}/js/${file}`, import.meta.url), 'utf8'), sandbox);
  }
  return { sandbox, messages };
}

function render(sandbox, example) {
  const senses = [{ senseNumber: 1 }];
  sandbox.normalizeTkgjeExamples(
    [{ id: '00001_ame_ex1', japanese: '雨だ。', english: 'It is raining.', sense_numbers: [1], ...example }],
    senses,
  );
  const container = new Element();
  container.dataset.senseIndex = '0';
  const tooltip = { querySelectorAll: () => [container] };
  sandbox.appendAttachedExamples(tooltip, senses);
  return container.find('tsukeru-example-audio');
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} plays a recorded example by id on a trusted click`, () => {
    const { sandbox, messages } = load(browser);
    const button = render(sandbox, { audio: true });
    assert.equal(button.attrs['aria-label'], 'Play example sentence');
    button.events.click({ isTrusted: false, stopPropagation() {} });
    assert.deepEqual(messages, []);
    button.events.click({ isTrusted: true, stopPropagation() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ action: 'playExample', exampleId: '00001_ame_ex1' }]);
  });

  test(`${browser} shows no button without a recording or with an odd id`, () => {
    const { sandbox } = load(browser);
    assert.equal(render(sandbox, {}), null);
    assert.equal(render(sandbox, { audio: true, id: '../x' }), null);
  });
}
