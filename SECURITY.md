# Security Policy

## Supported versions

Security fixes are made for the latest published Chrome, Edge, and Firefox releases. Update to the latest store version before reporting a problem found in an older release.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/ln2058/tsukeru-furigana-converter/security/advisories/new). Do not include exploit details or sensitive data in a public issue.

Include the affected browser and extension version, clear reproduction steps, the expected impact, and a minimal proof of concept when possible.

## Security model

Tsukeru runs content scripts on webpages so it can add furigana after the user activates it. Webpage content, messages, and API responses are treated as untrusted. The extension and its public API can be inspected, so backend validation and rate limits remain authoritative.

The extension uses `activeTab`, `scripting`, `storage`, and `contextMenus`. Its only network host permission is `https://www.ezfurigana.com/*`. API requests use that HTTPS host. Audio proxy checks accept only `www.ezfurigana.com` over HTTPS on the default port, and audio fetches refuse redirects. Other subdomains are not trusted for sync or audio proxy requests.

## Content and response handling

Before a furigana request, the extension extracts text from eligible page nodes and divides it into bounded batches. It does not send the page's HTML structure. Backend markup passes through allowlist sanitizers before insertion. Generated dictionary content escapes markup characters and both kinds of quotes, so values can be used in text and quoted HTML attributes.

Other relevant controls include:

- Dictionary actions require trusted browser input rather than page-generated click events.
- Audio responses have MIME and size checks before they are loaded into memory.
- CSV export neutralizes values that spreadsheet programs could interpret as formulas.
- Network requests use timeouts, and temporary caches have size or expiry limits.
- The extension stores and observes shared backend cooldowns instead of retrying blocked requests from every tab.

The backend enforces request and character quotas. When it returns a rate limit or temporary availability response, the extension preserves the retry deadline and shows it in the page notification and extension popup. Exact limits are controlled by the service and may change without an extension release.

## Reading reports

Opening and submitting the reading-report form injected into a webpage require genuine user clicks. The handlers ignore synthetic events using `isTrusted`.

When the form opens, the extension captures the word, reading, and context in content-script state that page scripts cannot access. Submission uses those captured values, so changing the displayed fields does not change them. The optional correction is read from the form's editable field. The form still lives in the page DOM, so that field is not protected from changes made by the page.

## Word sync

Word sync runs only on `https://www.ezfurigana.com`. The background checks the sender's extension ID and exact origin before accepting sync requests. The content script ignores messages from other windows or origins, from an unexpected source, or with a different protocol version. A snapshot must also match the current exchange.

After the website merges the extension's changes, its snapshot is treated as authoritative for word states and review schedules. If a word is absent from that snapshot, it is removed from the extension. Records changed locally while the exchange is running are kept for the next sync.

The extension's sync code exchanges records with the open website page through browser messages. It does not make network requests itself. This boundary gives the website access to the synced records; the website's own data handling is covered by the [EZFurigana privacy policy](https://www.ezfurigana.com/privacy).

## Data handling

Settings use browser sync storage. Browser vendors may synchronize settings according to the user's browser account configuration.

My Words records use `chrome.storage.local`. They include words, readings, states, review and activity times, lookup counts, and up to three short example sentences per word. Records can also include a short definition, part of speech, JLPT level, and how the word was added. They do not contain page URLs. Pending removals and sync metadata are stored locally too. Furigana results use an IndexedDB cache, and service cooldowns use local browser storage.

Tsukeru sends only the data needed for the requested feature:

- Japanese text and the current HTTP(S) page URL for furigana processing. Local-file URLs and filesystem paths are excluded.
- Words and readings for dictionary, example, kanji, and audio requests.
- Words and readings for missing-definition lookups during CSV export.
- The captured word, reading, and context, plus the optional correction, when a reading report is submitted.
- Word records shared with an open EZFurigana page during sync, as described above.

The extension does not include analytics, advertising, or third-party tracking scripts. See the [EZFurigana privacy policy](https://www.ezfurigana.com/privacy) for server-side data handling.
