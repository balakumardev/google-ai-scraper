# Google AI Overview Scraper

Scrapes Google AI Overviews via a Chrome extension relay — no browser focus stealing.

## Architecture: Extension-Driven Relay

```
User → GET /ask?q=... → FastAPI Server (holds connection via asyncio.Event)
                              ↕ polling (1.5s)
                     Chrome Extension Background Worker
                         → creates background tab (active: false)
                         → content script scrapes AI Overview
                         → POSTs result back to server
                              ↓
User ← JSON response ← FastAPI Server (returns)
```

Each query gets a UUID. Fully parallel — concurrent queries each get their own tab.

## Project Structure

```
server/
  main.py           # FastAPI app (Python 3.13, uv)
  pyproject.toml    # fastapi + uvicorn deps
extension/
  manifest.json     # Manifest V3
  background.js     # Service worker: polls server, manages tabs
  content.js        # Scrapes AI Overview → Markdown (most complex file)
  lib/turndown.js   # HTML→Markdown library (v7.2.0 from unpkg)
```

## Server Endpoints (main.py)

| Endpoint | Method | Purpose |
|---|---|---|
| `/ask?q={query}` | GET | Main API. Holds connection up to 30s via asyncio.Event. Returns `{query, query_id, markdown, citations}` or 504 |
| `/pending` | GET | Extension polls this. Pops oldest query from FIFO deque |
| `/result/{query_id}` | POST | Extension posts scraped result. Body: `{markdown, citations, error}` |
| `/health` | GET | Status with pending/queued counts |

## Extension Details

### background.js
- Polls `GET /pending` every 1.5s (recursive setTimeout keeps service worker alive)
- Creates tabs with `chrome.tabs.create({url, active: false})`
- Tracks active tabs in `Map<tabId, {queryId, timeoutId}>`
- 28s timeout per tab (2s less than server's 30s) as safety net
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

### manifest.json
- Permissions: `tabs`
- Host permissions: `google.com`, `localhost:8000`
- Content scripts inject `turndown.js` + `content.js` on `google.com/search*` at `document_idle`

## Running

```bash
# Start server
cd server && uv run uvicorn main:app --port 8000

# Load extension
# chrome://extensions → Developer Mode → Load unpacked → select extension/

# Test
curl -s "http://localhost:8000/health"
curl -s "http://localhost:8000/ask?q=what+is+photosynthesis" | python3 -m json.tool
```

## Key Design Decisions

- **asyncio.Event per query** for async request-response matching between `/ask` and `/result`
- **`finally` block** in `/ask` cleans up from both `pending_queries` dict and `query_queue` deque
- **`udm=50`** parameter forces Google's AI Overview mode
- **Background tabs** (`active: false`) avoid stealing browser focus
- **Turndown.js** bundled locally (not CDN) since extensions can't load remote scripts in MV3

## Error Scenarios

| Scenario | Behavior |
|---|---|
| Server not running | Extension silently retries polling |
| Extension not installed | `/ask` returns 504 after 30s |
| No AI Overview on page | 200 with `error: "no_ai_overview"`, empty markdown |
| Tab timeout (28s) | Returns `error: "tab_timeout"` |
| Google changes DOM | Container detection has 3 fallback strategies — may need updating |

## Changing Server Port

If you change from port 8000, update both:
1. `server/main.py` — uvicorn startup command
2. `extension/background.js` — `SERVER` constant
3. `extension/manifest.json` — `host_permissions`

## Browser Testing with Chrome DevTools MCP

### Quick Start

1. **Start Chrome with debugging:**
   ```bash
   chrome --user-data-dir=~/.chrome-debug-google-ai-scraper \
          --remote-debugging-port=9222 &
   ```

2. **Start the FastAPI server:**
   ```bash
   cd server && uv run uvicorn main:app --port 8000
   ```

3. **Load the extension:** `chrome://extensions` → Developer Mode → Load unpacked → select `extension/`

4. **Start Claude Code** in this directory

### Self-Testing the Extension via MCP

Use these MCP tools to test the full scraping pipeline without manually opening Chrome:

**1. Verify extension is loaded:**
```
navigate_page → chrome://extensions
take_snapshot → look for "Google AI Overview Scraper" with "On, extension enabled"
```

**2. Reload extension after code changes:**
```
navigate_page → chrome://extensions
take_snapshot → find the Reload button uid
click → uid of Reload button
wait_for → "Reloaded"
```

**3. Test the scraping pipeline (end-to-end):**
```bash
# Server must be running. Then:
curl -s "http://localhost:8000/ask?q=your+query" --max-time 35 | python3 -m json.tool
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
| Extension not polling | Service worker may be inactive — reload extension on chrome://extensions |
| Polling stops after one request | Bug: early `return` skipping `setTimeout` — ensure all returns are inside `if` blocks |
| Empty markdown but citations exist | Source card removal too aggressive — check `links > 3 && imgs > 3` heuristic against wrapper direct children only |
| Section headings missing | `[role="heading"]` being stripped — only first heading (query title) should be removed |
| Source cards in markdown | `main-col` includes them — check wrapper child removal loop |
| base64 images in output | Add `img[src^="data:"]` removal + Turndown skipDataImages rule |
