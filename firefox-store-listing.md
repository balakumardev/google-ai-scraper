# Firefox Add-ons Listing — Copy & Paste Reference

## Extension Name
Google AI Overview Scraper

## Short Description
Extracts Google AI Overviews as structured markdown via a local MCP server

## Summary
Scrape Google AI Overviews and get structured Markdown in Firefox with no API keys.

## Detailed Description

This Firefox add-on works as a relay between your local MCP server and Google Search. AI tools like Claude Code, Cursor, and Claude Desktop can query Google AI Overviews through MCP (Model Context Protocol) and get clean, structured results with citations.

HOW IT WORKS
1. Your AI tool sends a search query through the local MCP/HTTP server.
2. The add-on opens a background Google tab without stealing focus.
3. The page content is extracted and converted to Markdown.
4. Results are sent back to your local tool with citations and thread support for follow-ups.

FEATURES
- Background tabs with no browser focus stealing
- Structured Markdown output with deduplicated citations
- Conversational follow-ups through persistent thread tabs
- Google account selection and quota fallback handling
- Image generation capture support
- Configurable server URL via the built-in options page
- Works with local MCP clients and direct HTTP calls

QUICK START
1. Install the add-on from AMO or load `firefox-extension/` temporarily through `about:debugging`.
2. Run `uvx google-ai-scraper`.
3. Open the add-on settings and confirm the server URL is `http://localhost:15551`.
4. Add this MCP config:

```json
{
  "mcpServers": {
    "google-ai-scraper": {
      "command": "uvx",
      "args": ["google-ai-scraper"]
    }
  }
}
```

## Categories
other

## Reviewer Notes
This add-on only communicates with:
- `https://www.google.com/*` to open and scrape search results
- `http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*`, and HTTPS localhost equivalents to talk to the user's own local server

No analytics, telemetry, remote code loading, or third-party network calls are used.

## Permission Justifications

### tabs
Required to open and manage inactive Google search tabs for scraping without interrupting the user.

### scripting
Required to execute the account probing logic on Google pages and support the content extraction flow.

### alarms
Required to wake the background context so it can keep polling the local server for work.

### storage
Required to persist the configured server URL, selected Google account, cached account metadata, and temporary tab/thread state.

### Host permissions
`https://www.google.com/*` is required to load Google search pages where AI Overviews and image generation results appear.

`http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*`, `https://localhost/*`, `https://127.0.0.1/*`, and `https://[::1]/*` are required so the add-on can talk only to the user's local MCP/HTTP server.

## Privacy
- All processing stays on the user's machine
- No analytics, tracking, or data resale
- No data sent to any server other than the user's own localhost service

## URLs
- Homepage: https://github.com/balakumardev/google-ai-scraper
- Support: https://github.com/balakumardev/google-ai-scraper/issues
- Privacy policy: https://github.com/balakumardev/google-ai-scraper/blob/main/docs/privacy-policy.md
