# google-ai-scraper

MCP server for scraping Google AI Overviews via a Chrome extension relay. No API keys needed — uses your own Chrome browser.

## How it works

```
MCP Client (Claude Code, Cursor, etc.)
    ↕ stdio
MCP Server + embedded FastAPI (this package)
    ↕ HTTP polling
Chrome Extension (installed separately)
    → opens background tab on google.com
    → scrapes AI Overview → Markdown
    → posts result back
```

## Install

```bash
# Via uvx (recommended)
uvx google-ai-scraper

# Or pip
pip install google-ai-scraper
```

### Prerequisites

1. **Chrome** with the [Google AI Overview Scraper extension](https://github.com/balakumardev/google-ai-scraper) installed
2. **Python 3.10+**

## MCP Client Configuration

### Claude Code

Add to your project's `.mcp.json` or run `claude mcp add`:

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

### Claude Desktop

Add to `claude_desktop_config.json`:

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

### Cursor

Add to `.cursor/mcp.json`:

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

## MCP Tools

| Tool | Params | Description |
|------|--------|-------------|
| `search` | `query` | Search Google AI Overview. Returns markdown + citations + thread_id |
| `follow_up` | `query`, `thread_id` | Continue a conversation in an existing thread |
| `health` | — | Check server + extension connectivity |

## Options

```
google-ai-scraper [--sse] [--no-server] [--port PORT]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--sse` | off | Use SSE transport instead of stdio |
| `--no-server` | off | Don't start embedded FastAPI (if running separately) |
| `--port` | 15551 | FastAPI server port |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_AI_SCRAPER_URL` | `http://127.0.0.1:15551` | FastAPI server URL |

## License

MIT
