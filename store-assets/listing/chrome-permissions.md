# Chrome Web Store: fields that CI cannot set

Paste these into the Developer Dashboard. Graphics are in `store-assets/dist/`
(rebuild with `python3 store-assets/build.py`); the long description is
`store-assets/listing/description.txt`.

## Short description (comes from `extension/manifest.json`)
Google AI Overviews as clean Markdown with citations for Claude Code, Cursor & MCP clients. No API keys, 100% local.

## Category / language
Developer Tools / English

## Graphics
- Store icon 128x128: `icon-128.png`
- Screenshots 1280x800: `screenshot-1.png` ... `screenshot-5.png`
- Small promo tile 440x280: `promo-small-440x280.png`
- Marquee promo tile 1400x560: `promo-marquee-1400x560.png`

## Single purpose
Extracts Google AI Overview content from search result pages and sends it to a server running on the user's own machine (localhost) for use by local development tools.

## Permission justifications
- **tabs**: opens inactive google.com/search tabs to run queries without interrupting the user, and tracks them so results and follow-ups reach the right tab.
- **scripting**: probes the signed-in Google accounts so the user can choose which one answers.
- **alarms**: wakes the background worker so it keeps polling the local server for work.
- **storage**: keeps the server URL, the selected Google account, cached account info and in-flight tab/thread state that must survive worker restarts.
- **https://www.google.com/***: the content script reads AI Overviews from google.com/search pages.
- **localhost / 127.0.0.1 / [::1]**: the extension polls the user's own MCP/FastAPI server and posts scraped results back to it.

## Data disclosures
Collects nothing. All processing is local; the only network peers are google.com and localhost.

## URLs
- Homepage: https://github.com/balakumardev/google-ai-scraper
- Support: https://github.com/balakumardev/google-ai-scraper/issues
- Privacy policy: https://github.com/balakumardev/google-ai-scraper/blob/main/docs/privacy-policy.md
