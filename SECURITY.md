# \# Security \& Privacy

# 

# This extension is designed with a privacy-first, minimal-permissions philosophy.

# It processes only the data required to generate furigana and does not collect or

# store personal or browsing information.

# 

# ---

# 

# \## Data Handling

# 

# \- Text is sent to the backend only when the user explicitly clicks

# &nbsp; “Apply Furigana” or uses the keyboard shortcut on the active tab.

# \- Only visible Japanese text in the active tab is processed.

# \- No background scraping or passive content collection occurs.

# 

# \### Content Injection \& Sanitization

# 

# \- Backend responses are strictly sanitized before being injected into the page.

# \- Only the following elements are allowed:

# &nbsp; - ruby

# &nbsp; - rt

# &nbsp; - plain text

# \- All other HTML, attributes, scripts, styles, and event handlers are rejected.

# \- This prevents script injection, DOM clobbering, and XSS vulnerabilities.

# 

# ---

# 

# \## Storage

# 

# \- User settings are stored in Chrome Sync Storage.

# \- Optional vocabulary data is stored locally using Chrome Local Storage.

# \- No browsing history, page content, or personal data is stored or logged.

# 

# ---

# 

# \## Network Access

# 

# \- The extension makes network requests only to the EZFurigana API domain

# &nbsp; declared in host\_permissions.

# \- No wildcard URL access is used.

# \- No third-party analytics, trackers, ads, or telemetry are included.

# \- All requests are initiated by explicit user actions.

# 

# ---

# 

# \## Permissions

# 

# \- Uses activeTab to operate only on the currently active page.

# \- Does not request access to all URLs or background page content.

# \- Permissions are limited to the minimum required for functionality.

# 

# ---

# 

# \## User Control

# 

# \- Users can remove injected furigana from the page at any time.

# \- Dynamic content watching can be disabled from the extension settings.

# \- The extension performs no actions when disabled.

# 

# ---

# 

# \## Reporting Security Issues

# 

# If you discover a security or privacy issue, please report it responsibly by

# opening a private GitHub issue or contacting the maintainer directly.

# 

