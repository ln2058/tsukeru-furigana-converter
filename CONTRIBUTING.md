# Contributing to Tsukeru

Thanks for your interest in improving Tsukeru. Bug reports, ideas, and pull requests are welcome.

## Reporting problems

- Use the [issue templates](https://github.com/ln2058/tsukeru-furigana-converter/issues/new/choose) for bugs and feature requests.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Working on the code

Tsukeru has no build step, framework, or dependencies. Load `chrome/` or `firefox/` as an unpacked extension, as described in the [README](README.md#install-from-source).

- **Keep both browsers in step.** `chrome/` and `firefox/` are separate copies of the extension. Apply shared changes to both. A browser-specific difference needs a short comment explaining why.
- **Keep file headers accurate.** Every JavaScript file starts with a header (Module, Purpose, Inputs, Outputs, Side Effects, Failure Modes, Security Notes). Update it when behaviour changes.
- **Keep the backend contract compatible.** Older extension versions keep calling the EZFurigana service until they update, so request and response changes must be additive.
- **Treat page content and service responses as untrusted.** Sanitize or escape them before they reach the page.
- **Don't change permissions** or add host access without discussing it in an issue first.

## Checks

Run these before opening a pull request:

```bash
node --test scripts/*.test.mjs
node scripts/validate-locales.js
node --check path/to/changed-file.js
```

Pull requests run the same checks automatically. When a change affects page interaction or the popup, also try it by hand in Chrome or Edge and in Firefox.
