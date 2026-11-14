# Changelog

## 4.5.2 — Unreleased

### Changed

- **Weekly user count**: furigana requests also carry a random ID that changes every week (Monday, UTC), next to the daily one, so EZFurigana can count weekly users. Like the daily ID, it is not an install ID.
- Furigana requests also send your browser's language as a bare language code, such as `en` or `ja`, so EZFurigana can see which languages readers use. Nothing else about your browser or settings is sent.

### Fixed

- **Account links open in your language**: Connect account, Manage account and Reconnect in the popup, and the header star for Supporters, now open your EZFurigana account page in the popup's language (for example `/zh/account` in 简体中文) instead of always opening the English page.

## 4.5.1 — 2026-11-12

### Added

- **Simplified Chinese**: the popup, dictionary tooltip, notices, and settings are available in 简体中文, alongside English, Japanese, Korean, and Traditional Chinese. A browser set to Simplified Chinese uses it automatically, and dictionary translations and Explain this sentence work in it too.

### Changed

- **Chrome and Edge shortcut is `Ctrl+Shift+F` again** (`Control+Shift+F` on macOS). Chrome and Edge keep `Alt+Shift+A` for their own use and never assigned it to Tsukeru. Firefox keeps `Alt+Shift+A`. If the shortcut does not work or shows as not set, another extension may be using it: check your browser's extension shortcut settings and choose a different key.

### Fixed

- **Disconnected stays disconnected**: when you disconnect on your EZFurigana account page, Tsukeru no longer reconnects by itself when you switch tabs, reload, or the page rechecks. Only Connect account in the popup reconnects.
- **Fewer connection messages on EZFurigana**: "Tsukeru is connected" now appears only when the connection really changes, such as switching between Free and Supporter, or after you choose Connect. It no longer reappears when the tab regains focus or the page reloads.

## 4.5.0 — 2026-11-10

### Changed

- **Words split by links or formatting are read as one word**: text broken only by inline tags, such as a link around 行 in 行った or bold on part of 東京, is now read together, so it gets the right reading and one dictionary entry. Both parts open the same word.
- Rarer kanji are recognised as Japanese text: 々 and 〆, Extension A and B kanji such as 𠮟, and compatibility kanji such as 﨑.
- A Supporter's sentence explanation is kept with the word in My Words and synced with EZFurigana, as on the website.
- **New keyboard shortcut, the same in every browser**: `Alt+Shift+A` (`Control+Shift+A` on macOS) turns furigana on and off. The old Chrome shortcut blocked Redo (`Ctrl+Shift+Z`) in text boxes, and Firefox now uses `Ctrl+Shift+F` itself. Wikipedia leaves `Alt+Shift+A` free of its access keys. The popup shows the shortcut your browser has set; if your browser kept the old one, you can change it in the browser's extension shortcut settings.
- **Disconnecting stays disconnected**: after you choose Disconnect on your EZFurigana account page, Tsukeru stays disconnected, even on the website, until you choose Connect account in its popup. The account card checks the connection each time the popup opens, so it shows the disconnect straight away.
- My Words no longer shows a "Supporter" label on every sentence.
- When Explain needs a Supporter account, its notice now links to the Supporter page.
- When the only "sentence" around a word is the word itself (a heading or a list item with just 猫, say), the dictionary popup leaves out Play sentence and Explain, and the word is saved without it. My Words also skips sentences like that saved earlier.

### Fixed

- **Links with furigana can be followed**: clicking a word in a link opens its dictionary popup as before, and clicking the link again while the popup is open follows it. Ctrl/⌘-click, Shift-click and Enter on a link go straight to the link.

## 4.4.0 — 2026-11-10

### Added

- **Explain this sentence (Supporters)**: the dictionary tooltip has an Explain button to the right of Play sentence. It explains the sentence in your display language, with a translation and notes on its key parts. The first time, Tsukeru says that the sentence goes to OpenAI and waits for Continue. Without a Supporter connection, nothing is sent and a note explains that it is a Supporter feature.
- **Automatic furigana on chosen sites**: Settings > Page behavior has "Always add furigana on this site" for the open tab's site. Listed sites get furigana as soon as a page opens, and the list below the switch lets you remove a site. The list stays in your browser. A site means its exact address (www. counts as the same site), so other subdomains are not included.

### Changed

- Pages taller than three screens, such as most Wikipedia articles, now get furigana around what you are reading and add more as you scroll, instead of all at once.
- Words in this text updates once furigana stops being added, at most every few seconds while it continues, instead of every fraction of a second.
- Saved sentences in My Words keep the readings Tsukeru gave their words, and sync them with EZFurigana, so the website's review cards can show them.
- The keyboard shortcut and context menu now use your furigana size, colour, and weight, as the Apply button does.

## 4.3.1 — 2026-11-09

### Added

- **Example audio for Supporters**: dictionary examples recorded for TKGJE have a play button at the end of the sentence, like the word's. It doesn't use your sentence audio allowance.

### Changed

- My Words has fewer explanations: the review bar shows only when the next review is, the sync line says "Synced 5 min ago", and the Learning and Known lists keep one short hint each.

- **Dictionary translations at the top**: in Japanese, Korean, and Traditional Chinese, View translation now sits at the top of the Meaning tab and shows how many new translations you have left today. Once a word is translated, an AI translation / English switch replaces it. When the day's free translations are used up, the tooltip says how many Supporters get each day.
- **Supporters translate without a click**: when no translation is stored yet, a Supporter's tooltip starts one as soon as the word is opened.
- After Supporter checkout on EZFurigana, Tsukeru connects right away instead of on a later visit.
- Supporter links open EZFurigana's pricing page with a note that Tsukeru connects after checkout.
- In dark mode, the popup header no longer shows a light line at its rounded top corners.

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
