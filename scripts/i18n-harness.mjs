import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Supply the production classic-script dependency to isolated consumer tests.
export function loadI18n(sandbox, browser) {
  vm.runInNewContext(readFileSync(new URL(`../${browser}/js/i18n.js`, import.meta.url), 'utf8'), sandbox);
}
