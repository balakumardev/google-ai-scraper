# Privacy Policy — Google AI Overview Scraper

**Last updated:** March 2026

## What this extension does

Google AI Overview Scraper extracts AI Overview content from Google search result pages and converts it to structured Markdown. It works by communicating with a server running on your own computer (localhost).

## Data collection

**This extension does not collect, store, or transmit any personal data.**

- No analytics or tracking of any kind
- No telemetry, crash reports, or usage statistics
- No data is sent to any third-party server

## Data flow

1. The extension connects to a server running on **your own machine** (default: `http://localhost:15551`)
2. When a search query is received from your local server, the extension opens a Google search page in a background tab
3. The AI Overview content is extracted from the page and sent back to **your local server only**
4. No data leaves your computer beyond the normal Google search request

## Permissions

| Permission | Why it's needed |
|------------|----------------|
| `tabs` | Create background tabs for Google searches |
| `scripting` | Inject content script to extract AI Overview from search pages |
| `alarms` | Keep the service worker alive for server communication |
| `storage` | Save the server URL configuration |

## Host permissions

| Host | Why it's needed |
|------|----------------|
| `https://www.google.com/*` | Access Google search pages to extract AI Overviews |
| `http://localhost/*` | Communicate with the local relay server |

## Local storage

The extension stores only:
- **Server URL** (user-configurable, default `http://localhost:15551`) — via `chrome.storage.sync`
- **Active thread/tab mappings** (temporary, cleared on browser restart) — via `chrome.storage.session`

## Contact

For questions or concerns, open an issue at [github.com/balakumardev/google-ai-scraper](https://github.com/balakumardev/google-ai-scraper/issues) or email [mail@balakumar.dev](mailto:mail@balakumar.dev).
