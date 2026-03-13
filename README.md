# Google AI Overview Scraper

Scrapes Google AI Overviews via a Chrome extension relay. Available as an HTTP API and an MCP server for AI agents (Claude Code, Claude Desktop, Cursor, etc.).

No browser focus stealing — queries run in background tabs.

```
MCP Client / HTTP Client
        ↕
   MCP Server (optional, stdio or SSE)
        ↕ httpx
   FastAPI Server (:8000)
        ↕ polling
   Chrome Extension
        → background tab → scrape → result
```

## Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Chrome (or Chromium-based browser)

## Quick Install

```bash
uvx google-ai-scraper
```

Install the published extension from the Chrome Web Store:

https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en

The published extension defaults to `http://localhost:15551`, which matches `uvx google-ai-scraper`.

## Local Development Setup

### 1. Install dependencies

```bash
cd server
uv sync
```

### 2. Install the Chrome extension

Install the published extension from the Chrome Web Store:

https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en

Then open the extension's options page and set the server URL to `http://localhost:8000`.

### 3. Start the FastAPI server

```bash
cd server
uv run uvicorn main:app --port 8000
```

### 4. Verify

```bash
# Check server + extension connectivity
curl -s http://localhost:8000/health

# Run a query
curl -s "http://localhost:8000/ask?q=what+is+photosynthesis" | python3 -m json.tool
```

## HTTP API

The FastAPI server exposes these endpoints directly:

| Endpoint | Method | Description |
|---|---|---|
| `/ask?q={query}` | GET | Search. Returns `{query, query_id, thread_id, markdown, citations}` |
| `/ask?q={query}&thread_id={id}` | GET | Follow-up in existing thread |
| `/thread/{thread_id}` | DELETE | Close a thread and its tab |
| `/health` | GET | Server status, extension connectivity, queue depth |

```bash
# Search
curl -s "http://localhost:8000/ask?q=what+is+rust+programming" | python3 -m json.tool

# Follow-up (use thread_id from previous response)
curl -s "http://localhost:8000/ask?q=how+does+ownership+work&thread_id=abc123def456" | python3 -m json.tool

# Close thread (or just let it auto-expire after 2 min)
curl -s -X DELETE "http://localhost:8000/thread/abc123def456"
```

## MCP Server

The MCP server wraps the HTTP API as 3 tools for AI agents. It connects to the FastAPI server via httpx — both must be running.

### MCP Tools

| Tool | Params | Description |
|---|---|---|
| `search` | `query` | Search Google AI Overview. Returns markdown, citations, and a `thread_id` for follow-ups. |
| `follow_up` | `query`, `thread_id` | Continue a conversation in an existing thread. |
| `health` | — | Check server and extension connectivity. |

Threads auto-expire after 2 minutes of inactivity.

### Option A: SSE Transport (Recommended)

Runs a persistent MCP server on port 8001. Start it once, connect from any client.

**Start both servers together:**

```bash
cd server
./start-services.sh
# FastAPI on :8000, MCP SSE on :8001
```

**Client configuration:**

Claude Code — add to `.mcp.json` in your project, or run:
```bash
claude mcp add --transport sse google-ai-scraper http://localhost:8001/sse
```

Or add manually to `.mcp.json`:
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

Claude Desktop — add to `claude_desktop_config.json`:
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

Cursor — add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "google-ai-scraper": {
      "url": "http://localhost:8001/sse"
    }
  }
}
```

### Option B: Stdio Transport

The client spawns a new MCP server process per session. The FastAPI server must be running separately.

```bash
# Start FastAPI server first
cd server && uv run uvicorn main:app --port 8000
```

Claude Code — add to `.mcp.json` in your project, or run:
```bash
claude mcp add google-ai-scraper -- uv run --directory /absolute/path/to/server google-ai-mcp
```

Or add manually to `.mcp.json`:
```json
{
  "mcpServers": {
    "google-ai-scraper": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/server", "google-ai-mcp"]
    }
  }
}
```

Claude Desktop — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "google-ai-scraper": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/server", "google-ai-mcp"]
    }
  }
}
```

Replace `/absolute/path/to/server` with the full path to the `server/` directory.

### SSE vs Stdio

| | SSE | Stdio |
|---|---|---|
| Process lifecycle | Persistent, start once | New process per session |
| Config | Just a URL, no paths | Requires absolute path to `server/` |
| FastAPI server | Bundled via `start-services.sh` | Must run separately |
| Best for | Always-on setups, multiple clients | Quick testing, CI |

## LaunchAgent (macOS)

Auto-start both servers at login with restart on crash. The included plist runs `start-services.sh`.

```bash
# Edit the plist if your clone path differs from /Users/balakumar/personal/google-ai-scraper
cp com.google-ai-scraper.plist ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.google-ai-scraper.plist
```

Verify:
```bash
curl -s http://localhost:8000/health          # FastAPI
curl -s http://localhost:8001/sse --max-time 2  # MCP SSE (prints "event: endpoint")
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
| `GOOGLE_AI_SCRAPER_URL` | `http://localhost:8000` | FastAPI server URL (for MCP server to connect to) |

### Changing the FastAPI port

If you change from port 8000, update all three:
1. `server/main.py` — uvicorn startup
2. `extension/background.js` — `SERVER` constant
3. `extension/manifest.json` — `host_permissions`
