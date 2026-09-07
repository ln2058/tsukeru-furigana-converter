# Security Policy

## Supported versions

Security fixes are made for the latest published Chrome, Edge, and Firefox releases. Update to the latest store version before reporting a problem found in an older release.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/ln2058/tsukeru-furigana-converter/security/advisories/new). Do not include exploit details or sensitive data in a public issue.

Include the affected browser and extension version, clear reproduction steps, the expected impact, and a minimal proof of concept when possible.

## Security model

Tsukeru runs content scripts on webpages so it can add furigana after the user activates it. Webpage content, messages, and API responses are treated as untrusted. The extension and its public API can be inspected, so backend validation and rate limits remain authoritative.

The extension uses `activeTab`, `scripting`, `storage`, and `contextMenus`. Its network host permissions cover EZFurigana endpoints. Backend requests use HTTPS, and audio proxy requests are restricted by protocol, host, and port checks.

## Content and response handling

Before a furigana request, the extension extracts text from eligible page nodes and divides it into bounded batches. It does not send the page's HTML structure. Backend markup passes through allowlist sanitizers before insertion, and generated dictionary content escapes untrusted text.

Other relevant controls include:

- Dictionary actions require trusted browser input rather than page-generated click events.
- Audio and ZIP responses have MIME and size checks before they are loaded into memory.
- CSV export neutralizes values that spreadsheet programs could interpret as formulas.
- Network requests use timeouts, and temporary caches have size or expiry limits.
- The extension stores and observes shared backend cooldowns instead of retrying blocked requests from every tab.

The backend enforces request and character quotas. When it returns a rate limit or temporary availability response, the extension preserves the retry deadline and shows it in the page notification and extension popup. Exact limits are controlled by the service and may change without an extension release.

## Data handling

Settings use browser sync storage. Vocabulary, API caches, and cooldown state use local browser storage. Browser vendors may synchronize settings according to the user's browser account configuration.

Tsukeru sends only the data needed for the requested feature:

- Japanese text for furigana processing.
- Words and readings for dictionary, example, kanji, and audio requests.
- Vocabulary terms for requested Anki audio exports.
- User-visible reading-report fields when a report is submitted.

The extension does not include analytics, advertising, or third-party tracking scripts. See the [EZFurigana privacy policy](https://www.ezfurigana.com/privacy) for server-side data handling.
