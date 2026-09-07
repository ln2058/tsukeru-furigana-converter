<div align="center">
  <img src="chrome/icons/icon128.png" alt="Tsukeru icon" width="128">
  <h1>Tsukeru</h1>
  <p>Furigana and dictionary tools for Japanese webpages.</p>
</div>

Tsukeru is a browser extension for Chrome, Microsoft Edge, and Firefox. It adds readings above kanji while preserving the layout of the page, and includes dictionary lookup, page-word navigation, vocabulary saving, and export tools.

![Furigana on a Japanese Wikipedia article](screenshots/wikipedia.png)

## Features

- Add furigana to Japanese text on ordinary and dynamic webpages.
- Choose a minimum JLPT level and adjust reading size, colour, weight, and display style.
- Look up annotated words for English definitions, parts of speech, JLPT level, example sentences, kanji details, and audio. English entries prefer TKGJE data and fall back to JMdict.
- Browse the words processed on the current page and jump back to them.
- Save vocabulary locally, export it as CSV, or download an Anki-ready ZIP with audio.
- Handle changing content on sites such as YouTube and X when dynamic-page processing is enabled.
- Use English or Japanese extension controls.

![Furigana on YouTube subtitles](screenshots/youtubesubtitles.png)
![Furigana on YouTube comments](screenshots/youtubecomments.png)
![Furigana on X](screenshots/twitter.png)

## Using Tsukeru

Open the extension and select **Apply Furigana**. You can also use the context menu or the keyboard shortcut:

- Chrome and Edge: `Ctrl+Shift+Z` (`Command+Shift+Z` on macOS)
- Firefox: `Ctrl+Shift+F` (`Command+Shift+F` on macOS)

On shorter pages, Tsukeru can process the available Japanese text at once. On long pages, it starts with visible and nearby sections, then processes more as you scroll. This keeps the page responsive and avoids sending unseen content in the background. The Page Words list grows as more sections are processed.

The extension sends text in bounded batches to the [EZFurigana](https://www.ezfurigana.com) service. Returned markup is sanitized before it is added to the page. Results are cached for a limited time to avoid repeated requests.

## Local HTML files

Tsukeru can process saved HTML files opened with `file://`.

For Chrome and Edge, open the extension's details page and enable **Allow access to file URLs**. Firefox does not require a separate file-access toggle. Local filesystem paths are not sent to the service or stored with saved vocabulary.

## Privacy and permissions

Tsukeru contains no analytics or advertising code.

Settings are kept in browser sync storage. Saved vocabulary, temporary API caches, and service cooldowns are kept in local browser storage. The extension sends data to EZFurigana only when a feature requires it:

- Japanese text when you apply furigana.
- A word and its reading for dictionary, example, kanji, or audio requests.
- Vocabulary terms when you request an Anki audio export.
- The fields shown in the reading-report form when you submit a report.

Content scripts are declared for webpages so the extension can respond when you use it. They do not annotate a page or submit its text until you choose Apply, use the shortcut, or select the context-menu action. After Apply, optional dynamic-page processing can continue while the page changes.

The extension uses these permissions:

- `activeTab` and `scripting` to work with the current page.
- `storage` for settings, vocabulary, caches, and cooldown state.
- `contextMenus` for Apply and Clear commands.
- host permissions for the EZFurigana API.

See the [EZFurigana privacy policy](https://www.ezfurigana.com/privacy) for information about the service.

## Install from source

There is no build step.

For Chrome or Edge:

1. Open the browser's extensions page.
2. Enable developer mode.
3. Choose **Load unpacked** and select the `chrome` folder.

For Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `firefox/manifest.json`.

The Firefox installation is temporary and is removed when Firefox restarts.

## Development checks

Chrome and Firefox contain separate copies of the extension source. Changes that affect shared behavior should be applied to both.

Validate locale files with:

```bash
node scripts/validate-locales.js
```

JavaScript files can be checked directly with `node --check`. Load both browser versions manually to verify changes that affect page interaction or visual behaviour.

## Support

Issues and feature requests can be filed in the [GitHub repository](https://github.com/ln2058/tsukeru-furigana-converter/issues). Security problems should be reported privately as described in [SECURITY.md](SECURITY.md).

If you find Tsukeru useful, you can [support its development on Ko-fi](https://ko-fi.com/riamua).

## License

MIT
