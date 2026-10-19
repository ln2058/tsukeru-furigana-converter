/*
Module: popup-theme-init
Purpose: Set the popup language and restore the cached theme before styles load.

Inputs:
- The resolved catalog's ui_lang message and the extension popup's localStorage language/theme cache.

Outputs:
- The popup document language and a light/dark data-theme attribute.

Side Effects:
- Sets the document language and reads localStorage synchronously before the popup is painted.

Failure Modes:
- Missing, invalid, or inaccessible cache leaves the popup following the system theme.
- An unavailable language message falls back to English.

Security Notes:
- Accepts only supported locale and light/dark values; never runs in a website document.
*/
(() => {
  document.documentElement.lang = globalThis.chrome?.i18n?.getMessage?.('ui_lang') || 'en';
  try {
    const locale = globalThis.TsukeruI18n?.normalize(localStorage.getItem('tsukeru.uiLocale'));
    if (locale) document.documentElement.lang = TsukeruI18n.locales[locale].lang;
    const theme = localStorage.getItem('tsukeru.uiTheme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    }
  } catch (_) {
    // System colours remain available when localStorage is inaccessible.
  }
})();
