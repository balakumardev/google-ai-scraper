# Google AI Overview Scraper

Scrapes Google AI Overviews via a Chrome extension relay. Available as an HTTP API and an MCP server for AI agents such as Claude Code, Claude Desktop, and Cursor.

No browser focus stealing. Queries run in background tabs.

```
MCP Client / HTTP Client
        ↕
   MCP Server (stdio or SSE)
        ↕ httpx
   Shared FastAPI Backend (:15551)
        ↕ polling
   Chrome Extension
        → background tab → scrape → result
```

## Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Chrome or another Chromium-based browser

## Quick Install

```bash
uvx google-ai-scraper
```

Install the published extension from the Chrome Web Store:

https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en

Then open the extension's options page and set the server URL to `http://localhost:15551`.

For MCP clients, the simplest config is:

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

Each MCP client process auto-reuses or auto-starts the shared backend on `127.0.0.1:15551`, so multiple Claude Code windows can use the same config without manual SSE setup.

## Local Development Setup

### 1. Install dependencies

```bash
cd server
uv sync
```

### 2. Install the extension

Install the published extension from the Chrome Web Store:

https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en

Then open the extension's options page and set the server URL to `http://localhost:15551`.

### 3. Start a local backend for direct HTTP testing

```bash
cd server
uv run google-ai-scraper --backend --port 15551
```

If you prefer raw FastAPI during development, this also works:

```bash
cd server
uv run uvicorn google_ai_scraper.app:app --port 15551
```

### 4. Verify

```bash
# Check server + extension connectivity
curl -s http://localhost:15551/health

# Run a query
curl -s "http://localhost:15551/ask?q=what+is+photosynthesis" | python3 -m json.tool
```

## HTTP API

The FastAPI backend exposes these endpoints directly:

| Endpoint | Method | Description |
|---|---|---|
| `/ask?q={query}` | GET | Search. Returns `{query, query_id, thread_id, markdown, citations}` |
| `/ask?q={query}&thread_id={id}` | GET | Follow-up in an existing thread |
| `/thread/{thread_id}` | DELETE | Close a thread and its tab |
| `/health` | GET | Server status, extension connectivity, queue depth |

```bash
# Search
curl -s "http://localhost:15551/ask?q=what+is+rust+programming" | python3 -m json.tool

# Follow-up (use thread_id from previous response)
curl -s "http://localhost:15551/ask?q=how+does+ownership+work&thread_id=abc123def456" | python3 -m json.tool

# Close thread
curl -s -X DELETE "http://localhost:15551/thread/abc123def456"
```

## MCP Server

The MCP server wraps the HTTP API as 3 tools for AI agents. In default stdio mode, each MCP client process auto-reuses or auto-starts the shared backend on port `15551`.

### MCP Tools

| Tool | Params | Description |
|---|---|---|
| `search` | `query` | Search Google AI Overview. Returns markdown, citations, and a `thread_id` for follow-ups. |
| `follow_up` | `query`, `thread_id` | Continue a conversation in an existing thread. |
| `health` | — | Check server and extension connectivity. |

Threads auto-expire after 2 minutes of inactivity.

### Option A: Stdio Transport

Recommended for most users. This is the simplest setup and works well even with multiple Claude Code windows.

**Using the published package:**

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

**Using a local checkout from source:**

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

Replace `/absolute/path/to/server` with the full path to the `server/` directory.

### Option B: SSE Transport

Still supported for explicit always-on setups. Run the shared backend and the MCP SSE server once, then connect clients by URL.

**Start both services:**

```bash
cd server
./start-services.sh
# FastAPI on :15551, MCP SSE on :8001
```

**Client configuration:**

```json
{
  "mcpServers": {
    "google-ai-scraper": {
      "type": "sse",
      "url": "http://localhost:8001/sse"
    }
  }
}
```

### Stdio vs SSE

| | Stdio | SSE |
|---|---|---|
| MCP process lifecycle | New process per client session | Persistent shared MCP server |
| FastAPI backend | Auto-started or reused on `:15551` | Usually started explicitly alongside SSE |
| User setup | Simplest | Best for always-on shared service setups |
| Recommended for | Most users | Advanced/shared infrastructure |

## LaunchAgent (macOS)

Auto-start the shared backend and SSE server at login with restart on crash. The included plist runs `start-services.sh`.

```bash
# Edit the plist if your clone path differs from /Users/balakumar/personal/google-ai-scraper
cp com.google-ai-scraper.plist ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.google-ai-scraper.plist
```

Verify:

```bash
curl -s http://localhost:15551/health
curl -s http://localhost:8001/sse --max-time 2
```

Logs:

```bash
tail -f /tmp/google-ai-scraper.log /tmp/google-ai-scraper.err
```

Stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.google-ai-scraper.plist
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `GOOGLE_AI_SCRAPER_URL` | `http://127.0.0.1:15551` | FastAPI backend URL for the MCP process |

## Changing the FastAPI Port

If you change from port `15551`:

1. Start the backend or MCP process with `--port XXXX`, or set `GOOGLE_AI_SCRAPER_URL`.
2. Update the extension's options page to the same `http://localhost:XXXX` URL.
3. `manifest.json` already allows all localhost ports, so no host permission change is needed.
