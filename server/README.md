# google-ai-scraper

MCP server for scraping Google AI Overviews via a Chrome extension relay. No API keys needed. It uses your own browser session and a shared local FastAPI backend.

## How it works

```
MCP Client (Claude Code, Cursor, etc.)
    ↕ stdio or SSE
MCP Server (this package)
    ↕ HTTP
Shared FastAPI Backend (:15551)
    ↕ polling
Chrome Extension
    → opens background tab on google.com
    → scrapes AI Overview → Markdown
    → posts result back
```

In default stdio mode, each MCP client process auto-reuses or auto-starts the shared backend on `127.0.0.1:15551`.

## Install

```bash
# Via uvx (recommended)
uvx google-ai-scraper

# Or pip
pip install google-ai-scraper
```

### Prerequisites

1. **Chrome** with the [Google AI Overview Scraper extension](https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en) installed
2. **Python 3.10+**
3. Extension options pointed at `http://localhost:15551`

## MCP Client Configuration

### Claude Code

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

### Local Source Checkout

```json
{
  "mcpServers": {
    "google-ai-scraper": {
      "command": "uv",
      "args": [
        "run",
        "--directory",
        "/absolute/path/to/server",
        "google-ai-scraper"
      ]
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

## CLI Options

```
google-ai-scraper [--sse] [--no-server] [--backend] [--port PORT]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--sse` | off | Run the MCP server with SSE transport instead of stdio |
| `--no-server` | off | Do not auto-start or reuse the shared FastAPI backend |
| `--backend` | off | Run only the shared FastAPI backend |
| `--port` | 15551 | FastAPI backend port |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_AI_SCRAPER_URL` | `http://127.0.0.1:15551` | FastAPI backend URL |

## Advanced Modes

### Explicit Shared Backend

```bash
uv run google-ai-scraper --backend --port 15551
```

### SSE Server

```bash
uv run google-ai-scraper --sse --no-server
```

### Shared Backend + SSE Helper Script

```bash
cd server
./start-services.sh
```

This starts the shared backend on `:15551` and the SSE endpoint on `:8001`.

## License

MIT
