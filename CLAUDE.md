# Google AI Overview Scraper

Scrapes Google AI Overviews via a Chrome extension relay — no browser focus stealing.

## Architecture: Extension-Driven Relay

```
MCP Client (Claude Code, Cursor, etc.)
    ↕ stdio or SSE
MCP Server (server/google_ai_scraper/mcp_server/server.py)
    ↕ httpx (embedded FastAPI on port 15551)
FastAPI Server (server/google_ai_scraper/app.py)
    ↕ polling (1.5s)
Chrome Extension Background Worker
    → creates background tab (active: false)
    → content script scrapes AI Overview
    → POSTs result back to server
    ↓
MCP Client ← JSON response ← MCP Server ← FastAPI Server
```

Also usable directly via HTTP: `GET /ask?q=...` → FastAPI → Extension → result.

Each query gets a UUID. Fully parallel — concurrent queries each get their own tab.

Supports **conversational follow-ups** via thread IDs. First query creates a thread with a persistent tab; follow-ups reuse that tab by typing into Google's in-page follow-up textbox.

## Project Structure

```
server/
  pyproject.toml           # Package metadata + deps (published to PyPI)
  google_ai_scraper/       # Python package
    __init__.py            # __version__ = "0.2.0"
    app.py                 # FastAPI app
    mcp_server/
      __init__.py
      server.py            # MCP server — embeds FastAPI, entry point for `uvx google-ai-scraper`
  start-services.sh        # Launches FastAPI + MCP SSE together (used by LaunchAgent)
extension/
  manifest.json            # Manifest V3
  background.js            # Service worker: polls server, manages tabs
  content.js               # Scrapes AI Overview → Markdown (most complex file)
  options.html/js          # Settings page (server URL config)
  icons/                   # Extension icons (16, 32, 48, 128px)
  lib/turndown.js          # HTML→Markdown library (v7.2.0 from unpkg)
```

## Server Endpoints (app.py, default port 15551)

| Endpoint | Method | Purpose |
|---|---|---|
| `/ask?q={query}&thread_id={id}&close_thread=1` | GET | Main API. Returns `{query, query_id, thread_id, markdown, citations}`. Use `close_thread=1` to close the tab after this response (one-shot; extension closes tab on next poll). 503 if extension not connected, 404 if thread expired, 409 if busy |
| `/pending` | GET | Extension polls this (updates `last_poll_time`). Returns `{query_id, query, thread_id, type, close_threads}` |
| `/result/{query_id}` | POST | Extension posts scraped result. Body: `{markdown, citations, error}` |
| `/thread/{thread_id}` | DELETE | Close a thread and its tab. Extension picks up closure on next poll |
| `/health` | GET | Status with pending/queued/active_threads/extension_connected/last_poll_age_seconds |

## Extension Details

### background.js
- Server URL configurable via options page (default `http://localhost:15551`), cached in memory, refreshed on `chrome.storage.onChanged`
- Polls `GET /pending` every 1.5s (recursive setTimeout keeps service worker alive)
- Creates tabs with `chrome.tabs.create({url, active: false})`
- Tracks active tabs in `Map<tabId, {queryId, threadId, timeoutId}>`
- Tracks thread-to-tab mapping in `Map<threadId, tabId>` (threadTabs)
- 28s timeout per tab (2s less than server's 30s) as safety net
- **New queries:** Create tab, store in both maps. Try/catch posts `tab_create_failed` error if `chrome.tabs.create` fails
- **Follow-ups:** Look up tab from `threadTabs`, send `FOLLOW_UP_QUERY` message to content script. Checks `sendMessage` response — if content script rejects (e.g. `follow_up_in_progress`), posts error immediately
- **Tab lifecycle:** Tabs stay alive after result (for follow-ups). Closed via `close_threads` from server (TTL expiry or explicit DELETE)
- Processes `close_threads` array from `/pending` response — closes tabs for expired/deleted threads
- `chrome.tabs.onRemoved` listener posts `tab_closed_externally` error to server, then cleans up both maps
- Listens for `chrome.runtime.onMessage` from content scripts, relays via `POST /result/{queryId}`

### content.js
- **Gate:** Only activates when `udm=50` is in URL params
- **Container detection (3 fallback strategies):**
  1. Data attributes: `[data-subtree="aimc"]` or `[data-attrid="ai_overview"]`
  2. Heading text walk-up: find h2/h3/[role=heading] with "AI Overview", walk up to content-rich ancestor
  3. TreeWalker text scan: find "AI Overview" text node, walk up to content-rich ancestor
- **Streaming completion:** MutationObserver on body, 3s stability timer resets on mutations, 25s absolute max
- **Content extraction (from `[data-container-id="main-col"]`):**
  - Strips UI elements: buttons, SVGs, badges, `[data-subtree="aimba"]` inline attributions
  - Removes source card clusters (direct children with >3 links AND >3 images)
  - Removes feedback section (contains `policies.google.com` link)
  - Removes base64 placeholder images (1x1 GIFs used for math formulas)
  - Keeps only first heading removed (query title), preserves section headings
  - Turndown rules: `[role="heading"]` → `### markdown`, data: images skipped, Google redirects unwrapped
- **Citations:** From full `[data-subtree="aimc"]` container. Filters internal Google links, `policies.google.com`, empty/short hrefs, strips `#:~:text=` fragments, deduplicates
- **Follow-up handling:** `chrome.runtime.onMessage` listener for `FOLLOW_UP_QUERY` messages
  - Finds `div[role="textbox"][contenteditable="true"]` (Google's follow-up input)
  - Falls back to clicking expand buttons matching `/follow.?up|ask.+question|show\s*more|ask\s*a/i`
  - Types via `document.execCommand("insertText")` for proper contenteditable event firing
  - Submits via nearby button or Enter keydown
  - Delta extraction: snapshots child count before submit, extracts only new children after stability
  - `followUpInProgress` flag prevents concurrent follow-ups at content script level — sends `AI_OVERVIEW_RESULT` with error (not just `sendResponse`) so server resolves immediately
- **Error handling:** `scrapeAndSend` wrapped in try/catch — sends `extraction_error` if Turndown or DOM extraction throws

### manifest.json
- Permissions: `tabs`, `scripting`, `alarms`, `storage`
- Host permissions: `google.com`, `localhost/*` (all ports, since port is configurable)
- Options page for server URL configuration
- Content scripts inject `turndown.js` + `content.js` on `google.com/search*` at `document_idle`

## Running

### Quick Start (PyPI — recommended)

```bash
# Install and run (starts FastAPI + MCP server in one process)
uvx google-ai-scraper

# Or with pip
pip install google-ai-scraper && google-ai-scraper
```

### Development (Direct HTTP)

```bash
# Start server
cd server && uv run uvicorn google_ai_scraper.app:app --port 15551

# Install the published extension from the Chrome Web Store:
# https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en
# Default server URL already matches http://localhost:15551

# Test
curl -s "http://localhost:15551/health"
curl -s "http://localhost:15551/ask?q=what+is+photosynthesis" | python3 -m json.tool

# Follow-up using thread_id from previous response
curl -s "http://localhost:15551/ask?q=how+does+it+work+in+plants&thread_id=THREAD_ID" | python3 -m json.tool

# Close a thread
curl -s -X DELETE "http://localhost:15551/thread/THREAD_ID"
```

## MCP Server

The MCP server (`server/google_ai_scraper/mcp_server/server.py`) wraps the FastAPI endpoints as 3 MCP tools. By default it embeds the FastAPI server in a daemon thread (port 15551), so a single `uvx google-ai-scraper` starts everything.

### MCP Tools

| Tool | Params | Description |
|---|---|---|
| `search` | `query: str` | Search Google AI Overview. Returns markdown + citations + thread_id. Threads auto-expire after 2 min. |
| `follow_up` | `query: str, thread_id: str` | Continue a conversation in an existing thread. |
| `health` | none | Check server, extension connectivity, queue depth. |

### Prerequisites

1. **Chrome** with the published extension installed: https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en

### Setup

```bash
# From PyPI (recommended)
uvx google-ai-scraper

# Or from source
cd server && uv sync && uv run google-ai-scraper
```

### Option A: Stdio (Recommended for MCP clients)

Single command starts FastAPI (port 15551) + MCP stdio. No separate server needed.

**MCP client config (stdio):**

Claude Code / Claude Desktop / Cursor:
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

### Option B: Background Service (SSE)

Runs both FastAPI + MCP SSE as a single background service via `start-services.sh`. LaunchAgent auto-starts at login and restarts on crash.

**Start manually:**
```bash
cd server && ./start-services.sh
# FastAPI on :15551, MCP SSE on :8001
```

**Or install as LaunchAgent (macOS):**
```bash
cp com.google-ai-scraper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.google-ai-scraper.plist

# Verify
curl -s http://localhost:15551/health
curl -s http://localhost:8001/sse --max-time 2  # should print "event: endpoint"

# Logs
tail -f /tmp/google-ai-scraper.log /tmp/google-ai-scraper.err

# Stop
launchctl unload ~/Library/LaunchAgents/com.google-ai-scraper.plist
```

**MCP client config (SSE) — connect to the running server:**

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

### CLI Options

```
google-ai-scraper [--sse] [--no-server] [--port PORT]
```

| Flag | Default | Description |
|---|---|---|
| `--sse` | off | Use SSE transport instead of stdio |
| `--no-server` | off | Don't start embedded FastAPI (if running separately) |
| `--port` | 15551 | FastAPI server port |

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_AI_SCRAPER_URL` | `http://127.0.0.1:15551` | FastAPI server URL (if running on a different port/host) |

## Key Design Decisions

- **asyncio.Event per query** for async request-response matching between `/ask` and `/result`
- **`finally` block** in `/ask` cleans up from both `pending_queries` dict and `query_queue` deque
- **`udm=50`** parameter forces Google's AI Overview mode
- **Background tabs** (`active: false`) avoid stealing browser focus
- **Turndown.js** bundled locally (not CDN) since extensions can't load remote scripts in MV3
- **Thread lifecycle:** Tabs persist after first result for follow-ups. Server auto-expires threads after 2 min inactivity (THREAD_TTL=120s). Extension closes tabs when server signals via `close_threads`
- **Busy flag** on threads prevents concurrent follow-ups (409 Conflict)
- **Extension liveness detection:** Server tracks `last_poll_time` via `/pending`. `/ask` checks staleness (>5s = stale) and returns 503 instantly instead of waiting 30s for a timeout
- **Delta extraction** for follow-ups: snapshots wrapper child count before submission, extracts only new content blocks

## Error Scenarios

| Scenario | Behavior |
|---|---|
| Server not running | Extension silently retries polling |
| Extension not connected | `/ask` returns **503 immediately** with "extension not connected" (liveness check via `last_poll_time`) |
| No AI Overview on page | 200 with `error: "no_ai_overview"`, empty markdown |
| Tab timeout (28s) | Returns `error: "tab_timeout"` |
| Tab closed externally | Returns `error: "tab_closed_externally"` immediately (background.js `onRemoved` posts result) |
| Tab creation failed | Returns `error: "tab_create_failed: <message>"` (try/catch in `handleNewQuery`) |
| Extraction error | Returns `error: "extraction_error: <message>"` (try/catch in `scrapeAndSend`) |
| Google changes DOM | Container detection has 3 fallback strategies — may need updating |
| Thread expired | Follow-up returns 404. Client should start a new thread |
| Thread busy | Concurrent follow-up returns 409. Wait for current query to finish |
| Follow-up in progress | Returns `error: "follow_up_in_progress"` immediately (content script guard + background.js defense-in-depth) |
| Follow-up textbox not found | `error: "follow_up_textbox_not_found"`. Google may have changed DOM or no follow-up available |
| Thread tab crashed | `error: "thread_tab_crashed"`. Tab was closed/crashed. Start new thread |
| Content script unreachable | `error: "content_script_unreachable"`. Content script may have been unloaded |

## Changing Server Port

The default port is **15551**. To change it:
1. MCP server: `google-ai-scraper --port XXXX` (or set `GOOGLE_AI_SCRAPER_URL` env var)
2. Extension: Options page → change Server URL
3. `host_permissions` in manifest.json already allows all localhost ports

## Browser Testing with Chrome DevTools MCP

### Quick Start

1. **Start Chrome with debugging:**
   ```bash
   chrome --user-data-dir=~/.chrome-debug-google-ai-scraper \
          --remote-debugging-port=9222 &
   ```

2. **Start the server:**
   ```bash
   cd server && uv run google-ai-scraper --no-server & uv run uvicorn google_ai_scraper.app:app --port 15551
   # Or simply: cd server && uv run google-ai-scraper
   ```

3. **Install the extension:** https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en

4. **Start Claude Code** in this directory

### Self-Testing the Extension via MCP

Use these MCP tools to test the full scraping pipeline without manually opening Chrome:

**1. Verify extension is loaded:**
```
navigate_page → https://chromewebstore.google.com/detail/google-ai-overview-scrape/oidaeopefkgfpeigcjapebhppnbcocpc?authuser=1&hl=en
take_snapshot → look for "Remove from Chrome" or "Added to Chrome"
```

**2. Verify the extension options page:**
```
navigate_page → chrome-extension://oidaeopefkgfpeigcjapebhppnbcocpc/options.html
take_snapshot → look for the server URL field
```

**3. Test the scraping pipeline (end-to-end):**
```bash
# Server must be running. Then:
curl -s "http://localhost:15551/ask?q=your+query" --max-time 35 | python3 -m json.tool
```
The extension polls `/pending`, opens a background tab, scrapes, posts result, closes tab.

**4. Inspect Google AI Mode DOM directly:**
```
navigate_page → https://www.google.com/search?q=test+query&udm=50
evaluate_script → test container detection strategies:
  - document.querySelector('[data-subtree="aimc"]')       // main container
  - container.querySelector('[data-container-id="main-col"]')  // AI response column
```

**5. Debug content extraction without the extension:**
```
evaluate_script → run findAIOverviewContainer() logic manually
evaluate_script → check what elements would be stripped
evaluate_script → verify TurndownService is available (if extension loaded)
```

**6. Monitor server-extension communication:**
```bash
# Watch server logs for polling activity:
# GET /pending (every 1.5s from extension)
# GET /ask (from your curl)
# POST /result/{id} (from extension after scrape)
```

### Key DOM Structure (Google AI Mode, udm=50)

```
[data-subtree="aimc"]              ← findAIOverviewContainer() returns this
  ├── div.pWvJNd                   ← response wrapper
  │   └── div[data-container-id="main-col"]  ← extractContent() uses this
  │       └── wrapper div          ← direct children are content blocks
  │           ├── div.Y3BBE        ← text paragraphs (data-sfc-cp, data-hveid)
  │           ├── div.otQkpb       ← section headings (role="heading")
  │           ├── ul.KsbFXc        ← bullet lists
  │           ├── div[data-subtree="aimba"]  ← inline source attributions (stripped)
  │           ├── div (links>3, imgs>3)      ← source card clusters (stripped)
  │           └── div (policies.google.com)  ← feedback section (stripped)
  ├── div                          ← source cards sidebar (citations extracted from here)
  └── div                          ← empty
```

### Troubleshooting

| Symptom | Check |
|---|---|
| Extension not polling | Service worker may be inactive — disable/re-enable the extension in Chrome, then confirm its server URL still matches the local server |
| Polling stops after one request | Bug: early `return` skipping `setTimeout` — ensure all returns are inside `if` blocks |
| Empty markdown but citations exist | Source card removal too aggressive — check `links > 3 && imgs > 3` heuristic against wrapper direct children only |
| Section headings missing | `[role="heading"]` being stripped — only first heading (query title) should be removed |
| Source cards in markdown | `main-col` includes them — check wrapper child removal loop |
| base64 images in output | Add `img[src^="data:"]` removal + Turndown skipDataImages rule |
