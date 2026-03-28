import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from mcp.server.fastmcp import FastMCP, Image

from google_ai_scraper import __version__

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


def _backend_pid_path(port: int) -> Path:
    return _state_dir() / f"backend-{port}.pid"


def _backend_version(server_url: str) -> str | None:
    """Get the version of the currently running backend, or None if unreachable."""
    try:
        resp = httpx.get(f"{server_url.rstrip('/')}/version", timeout=HEALTHCHECK_TIMEOUT)
        if resp.status_code == 200:
            return resp.json().get("version")
    except Exception:
        pass
    return None


def _kill_stale_backend(port: int):
    """Kill a running backend whose version doesn't match the current code."""
    pid_path = _backend_pid_path(port)
    if pid_path.exists():
        try:
            pid = int(pid_path.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            # Wait for it to die
            for _ in range(20):
                try:
                    os.kill(pid, 0)
                    time.sleep(0.25)
                except OSError:
                    break
        except (ValueError, OSError):
            pass
        pid_path.unlink(missing_ok=True)


def _kill_backend_by_port(port: int):
    """Last resort: find and kill the backend process listening on a port."""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.strip().splitlines():
            try:
                pid = int(line.strip())
                os.kill(pid, signal.SIGTERM)
            except (ValueError, OSError):
                pass
        # Wait for port to free up
        for _ in range(20):
            try:
                resp = httpx.get(f"http://{DEFAULT_HOST}:{port}/health", timeout=0.5)
                time.sleep(0.25)
            except Exception:
                break
    except Exception:
        pass


def _ensure_backend_current(server_url: str, port: int):
    """If the running backend is outdated, kill and respawn it."""
    running_version = _backend_version(server_url)
    if running_version == __version__:
        return
    if not _backend_healthy(server_url):
        # Not running — _ensure_local_backend will handle spawning
        return
    # Backend is running but version is wrong or missing (no /version endpoint = very old)
    _kill_stale_backend(port)
    # If PID file kill didn't work (old backend without PID file), kill by port
    if _backend_healthy(server_url):
        _kill_backend_by_port(port)
    # Wait for the port to free up
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if not _backend_healthy(server_url):
            break
        time.sleep(0.25)


def _run_backend(port: int):
    import uvicorn

    from google_ai_scraper.app import app as fastapi_app

    # Write PID file so we can kill stale backends on version mismatch
    pid_path = _backend_pid_path(port)
    pid_path.write_text(str(os.getpid()))

    try:
        asyncio.run(
            uvicorn.Server(
                uvicorn.Config(fastapi_app, host=DEFAULT_HOST, port=port, log_level="warning")
            ).serve()
        )
    finally:
        pid_path.unlink(missing_ok=True)


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
async def search(query: str, mode: str = "pro", authuser: int | None = None) -> str:
    """Search Google AI Overview. Returns markdown + citations + thread_id for follow-ups. Threads auto-expire after 2 min inactivity.

    Args:
        query: The search query.
        mode: "pro" (default) uses Google's advanced AI model for detailed, multi-source responses.
              "fast" uses the standard AI model — faster but less detailed.
              Use "fast" for simple fact lookups (definitions, dates, conversions).
              Use "pro" for research, comparisons, or questions needing multiple sources.
        authuser: Google account index (0, 1, 2, ...) to use for this search.
                  If omitted, uses the account selected in the browser extension.
                  On quota exhaustion, the extension auto-rotates through available accounts.
    """
    params = {"q": query, "mode": mode}
    if authuser is not None:
        params["authuser"] = authuser
    result = await _request("GET", "/ask", params=params)
    return json.dumps(result, indent=2)


@mcp.tool()
async def follow_up(query: str, thread_id: str) -> str:
    """Continue a conversation in an existing thread. Use the thread_id from a previous search result."""
    result = await _request("GET", "/ask", params={"q": query, "thread_id": thread_id})
    return json.dumps(result, indent=2)


@mcp.tool()
async def generate_image(prompt: str, save_path: str | None = None):
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


def _parent_watchdog():
    """Exit when the parent process dies (MCP client session ended).

    When Claude Code exits, `uv run` (our parent) gets killed.  The OS
    reparents us to launchd (PID 1).  Detect that and exit so we don't
    accumulate as zombie MCP stdio servers.
    """
    original_ppid = os.getppid()
    while True:
        time.sleep(5)
        if os.getppid() != original_ppid:
            os._exit(0)


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
            _ensure_backend_current(SERVER_URL, MANAGED_BACKEND_PORT)
            _ensure_local_backend(SERVER_URL, MANAGED_BACKEND_PORT)
        except RuntimeError as exc:
            raise SystemExit(str(exc)) from exc

    if args.sse:
        mcp.run(transport="sse")
    else:
        # Start watchdog to clean up when the MCP client (parent) exits
        watchdog = threading.Thread(target=_parent_watchdog, daemon=True)
        watchdog.start()
        mcp.run()


if __name__ == "__main__":
    main()
