/*
Module: popup-theme-init
Purpose: Restore the cached popup theme before styles load to avoid an opening flash.

Inputs:
- The extension popup's localStorage theme cache.

Outputs:
- A light/dark data-theme attribute on the popup document only.

Side Effects:
- Reads localStorage synchronously before the popup is painted.

Failure Modes:
- Missing, invalid, or inaccessible cache leaves the popup following the system theme.

Security Notes:
- Accepts only light/dark values; never runs in a website document.
*/
(() => {
  try {
    const theme = localStorage.getItem('tsukeru.uiTheme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    }
  } catch (_) {
    // System colours remain available when localStorage is inaccessible.
  }
})();
