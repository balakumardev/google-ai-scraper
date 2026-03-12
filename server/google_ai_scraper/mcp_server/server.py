import argparse
import json
import os

import httpx
from mcp.server.fastmcp import FastMCP

DEFAULT_PORT = 15551
SERVER_URL = os.environ.get("GOOGLE_AI_SCRAPER_URL", f"http://127.0.0.1:{DEFAULT_PORT}")
REQUEST_TIMEOUT = 35.0

mcp = FastMCP("google-ai-scraper", port=8001)


async def _request(method: str, path: str, **kwargs) -> dict:
    """Make a request to the FastAPI server, returning a dict (never raises)."""
    try:
        async with httpx.AsyncClient(base_url=SERVER_URL, timeout=REQUEST_TIMEOUT) as client:
            resp = await client.request(method, path, **kwargs)
    except httpx.ConnectError:
        return {"error": "Cannot connect to FastAPI server at " + SERVER_URL}
    except httpx.ReadTimeout:
        return {"error": "Timed out waiting for scrape (server did not respond in time)"}

    if resp.status_code == 200:
        return resp.json()

    # Map known error codes
    try:
        detail = resp.json().get("detail", resp.text)
    except Exception:
        detail = resp.text

    match resp.status_code:
        case 503:
            return {"error": f"Extension not connected: {detail}"}
        case 504:
            return {"error": f"Timed out waiting for scrape: {detail}"}
        case 404:
            return {"error": f"Thread expired, start a new search: {detail}"}
        case 409:
            return {"error": f"Thread busy, wait and retry: {detail}"}
        case _:
            return {"error": f"Server error ({resp.status_code}): {detail}"}


@mcp.tool()
async def search(query: str) -> str:
    """Search Google AI Overview. Returns markdown + citations + thread_id for follow-ups. Threads auto-expire after 2 min inactivity."""
    result = await _request("GET", "/ask", params={"q": query})
    return json.dumps(result, indent=2)


@mcp.tool()
async def follow_up(query: str, thread_id: str) -> str:
    """Continue a conversation in an existing thread. Use the thread_id from a previous search result."""
    result = await _request("GET", "/ask", params={"q": query, "thread_id": thread_id})
    return json.dumps(result, indent=2)


@mcp.tool()
async def health() -> str:
    """Check system status: server, extension connectivity, queue depth."""
    result = await _request("GET", "/health")
    return json.dumps(result, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Google AI Scraper MCP Server")
    parser.add_argument("--sse", action="store_true", help="Run with SSE transport (default: stdio)")
    parser.add_argument("--no-server", action="store_true", help="Don't start embedded FastAPI server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"FastAPI server port (default: {DEFAULT_PORT})")
    args = parser.parse_args()

    if not args.no_server:
        import asyncio
        import threading

        import uvicorn

        from google_ai_scraper.app import app as fastapi_app

        def run_server():
            asyncio.run(
                uvicorn.Server(
                    uvicorn.Config(fastapi_app, host="127.0.0.1", port=args.port, log_level="warning")
                ).serve()
            )

        threading.Thread(target=run_server, daemon=True).start()

    if args.sse:
        mcp.run(transport="sse")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
