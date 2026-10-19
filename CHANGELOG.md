# Changelog

## 4.1.0 — 2026-10-19

### Added

- **Korean and Traditional Chinese**: the popup, dictionary tooltip, notices, and settings are available in 한국어 and 繁體中文 (Taiwan), alongside English and Japanese.
- **Display language setting**: choose English, 日本語, 한국어, 繁體中文, or follow the browser language in Settings. Pages already open switch to the new language without reloading.
- **Dictionary translations**: with a Japanese, Korean, or Traditional Chinese display language, the dictionary tooltip shows definitions in easy Japanese (やさしい日本語, with readings), Korean, or Traditional Chinese. Translated words appear automatically; for others, a button requests an AI translation. The English entry stays one click away, and new translations are protected by strict server-side limits.
- **Review reminder**: after a week of use on at least three days, the popup occasionally asks you to support Tsukeru with a store review. It opens the store for your browser in your display language, offers Later and Don't ask again, and appears at most three times.

### Changed

- Translated definitions use language-appropriate fonts and safe Japanese ruby rendering. Saved words and CSV exports keep their English definitions.
- Supporter and store-review links follow the display language.

### Fixed

- JLPT and part-of-speech highlights cover the whole word with fonts that sit low in the line, such as the Japanese default font on Japanese Wikipedia in Firefox.

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
