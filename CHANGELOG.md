# Changelog

## 4.1.0 — 2026-10-19

### Added

- Korean and Taiwan Traditional Chinese interfaces, with a display-language setting for English, Japanese, Korean, Traditional Chinese, or the browser default.
- Dictionary translations into easy Japanese, Korean, and Traditional Chinese. Available translations load from cache; a button requests a new AI translation when needed. English remains available with one click.
- Clear notices when translation limits are reached or translations are unavailable. New translations share strict server-side quotas and a daily extension cap.

### Changed

- Dictionary translations use language-appropriate fonts and safe Japanese ruby rendering. Saved word definitions and CSV exports retain their existing English behavior.
- Localized Supporter links follow the selected display language.

## 4.0.0 — 2026-10-08

### Added

- **My Words**: Learning and Known lists replace the old saved-vocabulary list. Looking up a new kanji word adds it to Learning, and you can switch a word between Learning and Known from the dictionary tooltip or the popup.
- **Review on EZFurigana**: the popup and toolbar badge show how many words are due, with a link to review them on the website.
- **Sync with EZFurigana**: My Words syncs with the website while an EZFurigana page is open.
- **Study mode**: readings are hidden; click a word to reveal its reading, then again to see its meaning.
- **Hide furigana for Known words**, with a setting to keep them visible.
- **Words in this text** groups numbers by their counter, such as 2024年 and 1998年 under 〜年.
- Light and dark themes, and highlighting by JLPT level or part of speech.

### Changed

- The popup is reorganized into This page, My Words, and Settings tabs, with a refreshed header and bundled IBM Plex Sans font.
- Eligible kanji words from the old saved-vocabulary list move into Learning automatically. Kana-only entries stay in the old storage.
- Anki export produces a CSV file of the selected list.
- Requests to EZFurigana include the extension version.

### Removed

- The Anki ZIP export with audio.

### Security

- Network access is limited to `https://www.ezfurigana.com`; other ezfurigana.com subdomains are no longer trusted for API calls, the audio proxy, or word sync.
- Dictionary tooltip markup escapes quotes in attribute values.
- Reading reports require a genuine click to open and submit, and the reported word, reading, and context cannot be changed by the page.

## Earlier versions

Releases before 4.0.0 are recorded in the [commit history](https://github.com/ln2058/tsukeru-furigana-converter/commits/main).
