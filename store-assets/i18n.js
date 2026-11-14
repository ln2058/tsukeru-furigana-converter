// Fills [data-i18n] elements for ?lang=xx: slide copy from store-assets/locales,
// extension UI words (Learning, Known, ...) from the extension's own _locales.
// <img data-src-ja="..."> (data-src-ko, -zh-cn, -zh-tw) swaps in a capture of the UI in that language.
// Marks <html data-ready="true"> once text, images and fonts are in, for render.mjs.
(async () => {
  const requested = new URLSearchParams(location.search).get('lang') || 'en';
  const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(requested) ? requested : 'en';
  document.documentElement.lang = lang.replace('_', '-');

  const load = (url) => fetch(url).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const [copy, ui] = await Promise.all([
    load(`../locales/${lang}.json`),
    load(`/chrome/_locales/${lang}/messages.json`),
  ]);
  const lookup = (key) => (typeof copy[key] === 'string' ? copy[key] : ui[key]?.message);

  const missing = [];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = lookup(el.dataset.i18n);
    if (typeof value !== 'string') { missing.push(el.dataset.i18n); return; }
    // [[words]] become the highlight mark; built as nodes, never parsed as HTML.
    el.replaceChildren(...value.split(/(\[\[.*?\]\])/).filter(Boolean).map((part) => {
      const match = /^\[\[(.*)\]\]$/.exec(part);
      if (!match) return document.createTextNode(part);
      const mark = document.createElement('mark');
      mark.className = 'hl';
      mark.textContent = match[1];
      return mark;
    }));
  });

  const htmlLang = document.documentElement.lang.toLowerCase();
  document.querySelectorAll(`img[data-src-${htmlLang}]`).forEach((img) => { img.src = img.getAttribute(`data-src-${htmlLang}`); });
  await Promise.all([...document.images].map((img) => img.decode().catch(() => missing.push(`image ${img.getAttribute('src')}`))));

  await document.fonts.ready;
  // [data-fit] text may wrap to at most data-lines lines (default 1); report any that wraps further.
  const overflow = [...document.querySelectorAll('[data-fit]')]
    .filter((el) => {
      const lines = Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
      return lines > Number(el.dataset.lines || 1);
    })
    .map((el) => el.dataset.fit);
  window.__slideReport = { lang, missing, overflow };
  document.documentElement.dataset.ready = 'true';
})();
