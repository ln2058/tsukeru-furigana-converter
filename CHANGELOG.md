# Changelog

## 4.3.0 — 2026-11-08

### Added

- **Sentence audio for Supporters**: the dictionary tooltip has a "Play sentence" line that shows the sentence it reads and plays it aloud. It uses your EZFurigana Supporter allowance.
- **EZFurigana connection**: Settings shows whether this browser is connected to EZFurigana and on which plan. Signing in to ezfurigana.com connects it, and the site confirms the first time. If the connection expires, Reconnect fixes it.
- **Export to Anki**: the My Words export menu opens EZFurigana's Anki export, which builds a deck with readings, meanings, and audio. CSV export stays under "Other formats".
- **My Words entries**: click a saved word to see its first meanings, in your display language when a translation is already available. Supporters can play each saved sentence aloud.
- When a day's free dictionary translations are used up, the tooltip says Supporters get more each day and links to Supporter. A Supporter who uses up the day sees English until tomorrow.

### Changed

- Clicking a word under Words in this text opens its dictionary popup on the page.
- The tooltip takes its sentence from the clicked word's own line, so sentences no longer run into nearby headings or list items, and closing quotes stay with the sentence. Saved words in My Words get the same cleaner sentences.
- Localized tooltips show the translated example for each meaning.
- Pitch-accent readings no longer split inside a sound such as しゅ, and long readings wrap the buttons onto the next line.
- Furigana requests include a random ID that changes every day, so EZFurigana can count daily users without a lasting identifier.

### Fixed

- Words with no JapanesePod101 recording no longer play its "not available" clip.

## 4.2.0 — 2026-11-02

### Added

- **Meaning and Kanji tabs**: the dictionary tooltip splits into tabs. Meaning shows the first three senses with a "+N more" toggle; Kanji loads when you open it and lists each character with its JLPT level, school grade, stroke count, readings, and common example words.
- **Stroke order**: the Kanji tab draws each character's strokes in order, with play and step controls. Stroke data comes from KanjiVG.
- **Word frequency**: a Common, Uncommon, or Rare badge next to the JLPT level shows how often a word appears in everyday Japanese.
- **Pitch accent**: the reading shows where the pitch rises and falls, using data from Kanjium.
- **Conjugation labels**: conjugated words show their form, such as 食べなかった · negative · past, with the dictionary form as the headword.
- **Popup size setting**: choose Small, Medium, or Large for the dictionary tooltip in Settings.

### Changed

- The tooltip opens beside the word instead of covering it, follows the word while you scroll, and closes when the word leaves the screen. Escape closes it.
- On narrow screens the tooltip opens as a sheet at the bottom of the screen with larger touch targets.
- The tooltip, report form, and notices use a plain paper background.

## 4.1.1 — 2026-10-21

Firefox only; the Chrome and Edge version number matches without changes.

### Added

- **Firefox for Android**: Tsukeru can be installed on Firefox for Android 120 and later.

### Changed

- On Android, the popup fills the screen, and Apply and Clear return to the page so furigana is added while the page is visible. The keyboard shortcut and right-click menu remain desktop-only.

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
