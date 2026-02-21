# Security Policy

---

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 3.0.1   | ✅        |

---

## Permissions & Host Access

The Chrome, Edge, and Firefox builds explicitly avoid `<all_urls>` permissions. The extension operates under `activeTab` only — no DOM scanning occurs until the user explicitly triggers it via the popup or keyboard shortcut.

All outbound network traffic is restricted by `host_permissions` to `https://www.ezfurigana.com/*`. No other domains are contacted at any point.

---

## XSS Mitigation

### DOM Traversal

The extension uses a native `DOMParser` to read and traverse the page. No regex-based HTML parsing is used at any stage.

### Payload Handling

Before sending text to the API, the DOM is dismantled into raw text chunks paired with positional markers. No HTML structure is forwarded to the server.

### Sanitization on Injection

API responses are passed through a strict allowlist sanitizer before being written back to the page. The sanitizer uses a `<template>` element and a recursive walker that permits only:

- `<ruby>`, `<rt>` — furigana annotations
- `<mark>` — search highlights
- `<span data-jlpt>` — JLPT level indicators

All other elements, attributes, event handlers, and inline scripts are stripped. This covers XSS, DOM clobbering, and attribute injection from malformed or malicious API responses.

---

## Rate Limiting

The service worker enforces a token-bucket rate limit before dispatching API requests. The ceiling is **50,000 characters per 10-second window**. Requests that would exceed this are dropped, preventing accidental API flooding on unusually large DOM structures.

---

## Data & Storage

**No passive collection.** The extension performs no background scanning. Page content is only read from the active tab when explicitly triggered by the user.

**IndexedDB caching.** API results are cached locally via IndexedDB to reduce repeat network requests. Cached dictionary entries expire after a fixed TTL.

**Local storage only.** All user settings are written to `chrome.storage` (Sync or Local). No data leaves the browser except for the Japanese text sent to the EZFurigana API during an explicit apply action.

**Zero telemetry.** The codebase contains no analytics, telemetry, or third-party tracking of any kind.

---

## Reporting a Vulnerability

If you find a security issue, open a private GitHub issue or contact the maintainer directly. Please do not disclose vulnerabilities publicly before they have been addressed.

