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
uv run uvicorn main:app --port 8000 &
FASTAPI_PID=$!

# Start MCP SSE server
uv run google-ai-mcp --sse &
MCP_PID=$!

echo "FastAPI (PID $FASTAPI_PID) on :8000, MCP SSE (PID $MCP_PID) on :8001"

# Wait for both — if either exits, cleanup trap fires and kills the other
wait
