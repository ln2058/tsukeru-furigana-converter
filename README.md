<div align="center">
  <img src="chrome/edge/icons/icon128.png" alt="Tsukeru Logo" width="128">
  <h1>Tsukeru – Furigana Converter for Japanese Text</h1>
  <p>Chrome/Edge + Firefox Extension</p>
</div>

Tsukeru is a lightweight furigana converter for Chrome/Edge and Firefox that adds hiragana readings to kanji directly on the page. It works as a Japanese reading aid for learners by converting kanji to hiragana using ruby annotations, without leaving the site you are reading.

> Powered by the [EZFurigana](https://www.ezfurigana.com) backend.

---

## Features

- One-click Apply and Clear on the active tab only
- Global keyboard shortcut (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>) to toggle furigana on the current tab (Chrome/Edge)
- Optional support for dynamic content (SPA / infinite scroll)
- Dictionary popups and vocabulary saving
- Works on common sites such as YouTube, X (Twitter), Reddit, and more

---

## How It Works

When you click "Apply Furigana," the extension collects visible Japanese text from the active page only. The text is sent to the EZFurigana backend, which returns sanitized ruby markup. The extension then inserts the furigana annotations directly into the page.

This allows users to add furigana to Japanese text and read kanji with hiragana support in context.

No background processing occurs, and no content is sent unless the user explicitly triggers it.

---

## Privacy

Tsukeru does not collect, track, or store user data.

Japanese text is sent to the EZFurigana backend only when the user explicitly applies furigana. The text is processed to generate readings and exists on the server only for the duration of that request. It is not logged, stored, or retained after processing.

No personal information, browsing history, or page content is collected or saved.

For more details, see the full [privacy policy](https://www.ezfurigana.com/privacy).

---

## Extension Folders

- `chrome/edge`: MV3 build for Chrome and Microsoft Edge
- `firefox`: MV2 build for Firefox

---

## Permissions (Chrome/Edge Web Store)

The extension uses the minimum permissions required for its functionality:

- **activeTab, scripting**  
  Injects content only after explicit user action on the active tab

- **storage**  
  Stores user settings and optional vocabulary data

- **tabs**  
  Queries the currently active tab only

- **contextMenus**  
  Provides Apply and Clear actions via the context menu

- **host_permissions**  
  Network access is restricted to the EZFurigana API domain only

No wildcard URL access is requested.

---

## Permissions (Firefox MV2)

Firefox is configured in a stricter, popup-only mode:

- **activeTab**  
  Injects content only after explicit user action on the active tab

- **storage**  
  Stores user settings and optional vocabulary data

- **tabs**  
  Queries the currently active tab only

- **https://www.ezfurigana.com/**  
  Network access is restricted to the EZFurigana API domain only

No wildcard URL access, no always-on content scripts, no context menu, and no global shortcut.

---

## Submission Notes

- Manual activation only. The extension does not run automatically on pages.
- No page content is processed unless the user clicks "Apply Furigana" (and the Chrome/Edge shortcut is used).
- No analytics, trackers, or third-party scripts are included.

---

## License

MIT
