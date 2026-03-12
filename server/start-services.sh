#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
    echo "Stopping services..."
    kill "$FASTAPI_PID" "$MCP_PID" 2>/dev/null || true
    wait "$FASTAPI_PID" "$MCP_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Start FastAPI server
cd "$DIR"
uv run uvicorn google_ai_scraper.app:app --port 15551 &
FASTAPI_PID=$!

# Start MCP SSE server (--no-server since FastAPI runs separately above)
uv run google-ai-scraper --sse --no-server &
MCP_PID=$!

echo "FastAPI (PID $FASTAPI_PID) on :15551, MCP SSE (PID $MCP_PID) on :8001"

# Wait for both — if either exits, cleanup trap fires and kills the other
wait
