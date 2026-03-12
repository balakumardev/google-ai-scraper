# Chrome Web Store Listing — Copy & Paste Reference

## Extension Name (in manifest.json, max 75 chars)
Google AI Overview Scraper

## Short Description (in manifest.json, max 132 chars)
Extracts Google AI Overviews as structured markdown via a local MCP server

## Detailed Description (Store Listing tab, max 16,000 chars)

Scrape Google AI Overviews and get structured Markdown — no API keys needed.

This extension works as a relay between your local MCP server and Google Search. AI coding tools like Claude Code, Cursor, and Claude Desktop can search Google AI Overviews through MCP (Model Context Protocol) and get clean, structured results.

HOW IT WORKS
1. Your AI tool sends a search query via the MCP server
2. The extension opens a background tab on Google (no focus stealing)
3. The AI Overview content is extracted and converted to Markdown
4. Results are sent back to your AI tool with citations

FEATURES
• No API keys or accounts needed — uses your own Chrome browser
• Background tabs — never steals focus from your work
• Structured Markdown output with source citations
• Conversational follow-ups via thread IDs
• Configurable server URL via options page
• Works with Claude Code, Cursor, Claude Desktop, and any MCP client

QUICK START
1. Install the extension
2. Run: uvx google-ai-scraper
3. Add to your MCP config:
{
  "mcpServers": {
    "google-ai-scraper": {
      "command": "uvx",
      "args": ["google-ai-scraper"]
    }
  }
}

MCP TOOLS
• search — Query Google AI Overview, get Markdown + citations
• follow_up — Continue a conversation in an existing thread
• health — Check server and extension connectivity

PRIVACY
• All data stays on your machine (localhost only)
• No analytics, tracking, or data collection
• No data sent to third-party servers
• Open source: github.com/balakumardev/google-ai-scraper

REQUIREMENTS
• Python 3.10+ (for the MCP server)
• Chrome browser

## Category
Developer Tools

## Language
English

## Single Purpose Description (Privacy Practices tab)
Extracts Google AI Overview content from search result pages and sends it to a server running on the user's own machine (localhost) for use by local development tools.

## Permission Justifications

### tabs
Required to create background tabs for Google searches. The extension opens google.com/search pages in inactive background tabs to scrape AI Overview content without interrupting the user's browsing.

### scripting
Required to inject the content script that extracts AI Overview content from Google search result pages. The script parses the DOM to find AI Overview containers and converts them to structured Markdown.

### alarms
Required to keep the service worker alive for continuous polling of the local server. The extension polls localhost every 1.5 seconds to check for new search queries from the user's MCP client.

### storage
Required to persist the user's server URL configuration (set via the options page) and temporary thread-to-tab mappings that survive service worker restarts.

### Host Permission: https://www.google.com/*
Required to access Google search result pages where AI Overviews appear. The content script runs only on google.com/search pages with the udm=50 parameter.

### Host Permission: http://localhost/*
Required to communicate with the user's local MCP/FastAPI server. The extension polls for pending queries and posts scraped results back to localhost.

## Data Collection Disclosures
- Does NOT collect: Personally identifiable information, Health information, Financial information, Authentication information, Personal communications, Location, Web history, User activity, Website content
- All data processing happens locally on the user's machine
- No data is transmitted to any server other than localhost

## Privacy Policy URL
https://github.com/balakumardev/google-ai-scraper/blob/main/docs/privacy-policy.md

## Homepage URL
https://github.com/balakumardev/google-ai-scraper

## Support URL
https://github.com/balakumardev/google-ai-scraper/issues
