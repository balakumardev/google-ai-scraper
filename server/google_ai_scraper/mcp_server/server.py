import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from mcp.server.fastmcp import FastMCP, Image

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 15551
SERVER_URL = os.environ.get("GOOGLE_AI_SCRAPER_URL", f"http://{DEFAULT_HOST}:{DEFAULT_PORT}")
REQUEST_TIMEOUT = 75.0  # seconds — slightly above FastAPI query timeout
IMAGE_REQUEST_TIMEOUT = 185.0  # seconds — image generation takes 1-2 min
BACKEND_STARTUP_TIMEOUT = 10.0
HEALTHCHECK_TIMEOUT = 1.5

AUTO_MANAGE_SERVER = False
MANAGED_BACKEND_PORT: int | None = None

mcp = FastMCP("google-ai-scraper", port=8001)


def _server_url_for_port(port: int) -> str:
    return f"http://{DEFAULT_HOST}:{port}"


def _resolve_server_url(port: int) -> str:
    return os.environ.get("GOOGLE_AI_SCRAPER_URL", _server_url_for_port(port))


def _state_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))

    path = base / "google-ai-scraper"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _backend_lock_path(port: int) -> Path:
    return _state_dir() / f"backend-{port}.lock"


def _backend_log_path(port: int) -> Path:
    return _state_dir() / f"backend-{port}.log"


class _BackendLock:
    def __init__(self, path: Path):
        self.path = path
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        if self.handle.tell() == 0 and self.handle.read(1) == b"":
            self.handle.write(b"\0")
            self.handle.flush()
        self.handle.seek(0)

        if os.name == "nt":
            import msvcrt

            while True:
                try:
                    msvcrt.locking(self.handle.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    time.sleep(0.1)
        else:
            import fcntl

            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX)

        return self.handle

    def __exit__(self, exc_type, exc, tb):
        if not self.handle:
            return

        self.handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)

        self.handle.close()


def _manageable_local_port(server_url: str) -> int | None:
    parsed = urlparse(server_url)
    if parsed.scheme not in ("http", ""):
        return None
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        return None
    if parsed.path not in ("", "/"):
        return None
    if parsed.query or parsed.fragment:
        return None
    return parsed.port or DEFAULT_PORT


def _backend_healthy(server_url: str) -> bool:
    try:
        resp = httpx.get(f"{server_url.rstrip('/')}/health", timeout=HEALTHCHECK_TIMEOUT)
        if resp.status_code != 200:
            return False
        payload = resp.json()
    except Exception:
        return False
    return payload.get("status") == "ok"


def _wait_for_backend(server_url: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _backend_healthy(server_url):
            return True
        time.sleep(0.2)
    return False


def _spawn_backend_process(port: int):
    kwargs = {
        "args": [
            sys.executable,
            "-m",
            "google_ai_scraper.mcp_server.server",
            "--backend",
            "--port",
            str(port),
        ],
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }

    log_path = _backend_log_path(port)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        )
    else:
        kwargs["start_new_session"] = True

    with log_path.open("ab") as log_file:
        kwargs["stdout"] = log_file
        kwargs["stderr"] = subprocess.STDOUT
        subprocess.Popen(**kwargs)


def _ensure_local_backend(server_url: str, port: int):
    if _backend_healthy(server_url):
        return

    with _BackendLock(_backend_lock_path(port)):
        if _backend_healthy(server_url):
            return

        _spawn_backend_process(port)
        if _wait_for_backend(server_url, BACKEND_STARTUP_TIMEOUT):
            return

    raise RuntimeError(
        f"Could not start shared FastAPI backend at {server_url}. "
        f"Check {_backend_log_path(port)} for details."
    )


def _run_backend(port: int):
    import uvicorn

    from google_ai_scraper.app import app as fastapi_app

    asyncio.run(
        uvicorn.Server(
            uvicorn.Config(fastapi_app, host=DEFAULT_HOST, port=port, log_level="warning")
        ).serve()
    )


async def _request(method: str, path: str, **kwargs) -> dict:
    """Make a request to the FastAPI server, returning a dict (never raises)."""
    async def do_request():
        async with httpx.AsyncClient(base_url=SERVER_URL, timeout=REQUEST_TIMEOUT) as client:
            return await client.request(method, path, **kwargs)

    try:
        resp = await do_request()
    except httpx.ConnectError:
        if AUTO_MANAGE_SERVER and MANAGED_BACKEND_PORT is not None:
            try:
                _ensure_local_backend(SERVER_URL, MANAGED_BACKEND_PORT)
                resp = await do_request()
            except httpx.ConnectError:
                return {"error": "Cannot connect to FastAPI server at " + SERVER_URL}
            except httpx.ReadTimeout:
                return {"error": "Timed out waiting for scrape (server did not respond in time)"}
            except RuntimeError as exc:
                return {"error": str(exc)}
        else:
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
async def generate_image(prompt: str, save_path: str | None = None) -> list[Image | str]:
    """Generate an image using Google AI. Pass an image generation prompt. Returns the generated image. Optionally saves to disk when save_path is provided (e.g. '/tmp/cat.png'). Requires the user to be logged into Google in the Chrome browser."""
    async with httpx.AsyncClient(base_url=SERVER_URL, timeout=IMAGE_REQUEST_TIMEOUT) as client:
        try:
            resp = await client.get("/generate_image", params={"prompt": prompt})
        except httpx.ConnectError:
            if AUTO_MANAGE_SERVER and MANAGED_BACKEND_PORT is not None:
                try:
                    _ensure_local_backend(SERVER_URL, MANAGED_BACKEND_PORT)
                    resp = await client.get("/generate_image", params={"prompt": prompt})
                except Exception as exc:
                    raise ValueError(f"Error: {exc}") from exc
            else:
                raise ValueError("Cannot connect to FastAPI server at " + SERVER_URL)
        except httpx.ReadTimeout:
            raise ValueError("Image generation timed out")

    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise ValueError(f"Error ({resp.status_code}): {detail}")

    content_type = resp.headers.get("content-type", "image/png")
    fmt = content_type.split("/")[-1]  # "png", "jpeg", etc.
    image = Image(data=resp.content, format=fmt)

    if save_path:
        out = Path(save_path).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(resp.content)
        return [image, f"Image saved to {out}"]

    return [image]


@mcp.tool()
async def health() -> str:
    """Check system status: server, extension connectivity, queue depth."""
    result = await _request("GET", "/health")
    return json.dumps(result, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Google AI Scraper MCP Server")
    parser.add_argument("--sse", action="store_true", help="Run with SSE transport (default: stdio)")
    parser.add_argument("--no-server", action="store_true", help="Don't auto-start or reuse the shared FastAPI backend")
    parser.add_argument("--backend", action="store_true", help="Run only the shared FastAPI backend process")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"FastAPI server port (default: {DEFAULT_PORT})")
    args = parser.parse_args()

    global AUTO_MANAGE_SERVER, MANAGED_BACKEND_PORT, SERVER_URL

    if args.backend:
        _run_backend(args.port)
        return

    SERVER_URL = _resolve_server_url(args.port)
    MANAGED_BACKEND_PORT = _manageable_local_port(SERVER_URL)
    AUTO_MANAGE_SERVER = not args.no_server and MANAGED_BACKEND_PORT is not None

    if AUTO_MANAGE_SERVER:
        try:
            _ensure_local_backend(SERVER_URL, MANAGED_BACKEND_PORT)
        except RuntimeError as exc:
            raise SystemExit(str(exc)) from exc

    if args.sse:
        mcp.run(transport="sse")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
