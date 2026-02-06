import asyncio
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

THREAD_TTL = 120  # seconds of inactivity before auto-cleanup


class Thread:
    __slots__ = ("thread_id", "created_at", "last_activity", "busy")

    def __init__(self, thread_id: str):
        self.thread_id = thread_id
        self.created_at = time.monotonic()
        self.last_activity = time.monotonic()
        self.busy = False


class PendingQuery:
    __slots__ = ("query_id", "query", "event", "result", "thread_id", "query_type")

    def __init__(self, query: str, thread_id: str | None = None):
        self.query_id: str = uuid.uuid4().hex[:12]
        self.query: str = query
        self.event: asyncio.Event = asyncio.Event()
        self.result: dict | None = None
        if thread_id:
            self.thread_id = thread_id
            self.query_type = "follow_up"
        else:
            self.thread_id = uuid.uuid4().hex[:12]
            self.query_type = "new"


# Shared state
pending_queries: dict[str, PendingQuery] = {}
query_queue: deque[PendingQuery] = deque()
active_threads: dict[str, Thread] = {}
close_queue: deque[str] = deque()  # thread IDs for extension to close


async def _cleanup_expired_threads():
    """Periodically expire idle threads."""
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        expired = [
            tid
            for tid, t in active_threads.items()
            if not t.busy and (now - t.last_activity) > THREAD_TTL
        ]
        for tid in expired:
            active_threads.pop(tid, None)
            close_queue.append(tid)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_cleanup_expired_threads())
    yield
    task.cancel()
    pending_queries.clear()
    query_queue.clear()
    active_threads.clear()
    close_queue.clear()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ResultPayload(BaseModel):
    markdown: str = ""
    citations: list[str] = []
    error: str | None = None


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "pending": len(pending_queries),
        "queued": len(query_queue),
        "active_threads": len(active_threads),
    }


@app.get("/ask")
async def ask(q: str, thread_id: str | None = None):
    if not q.strip():
        raise HTTPException(400, "query is required")

    # Thread validation
    if thread_id:
        thread = active_threads.get(thread_id)
        if not thread:
            raise HTTPException(404, "thread not found or expired")
        if thread.busy:
            raise HTTPException(409, "thread is busy with another query")
        thread.busy = True
    else:
        thread = None

    pq = PendingQuery(q.strip(), thread_id)

    # Create new thread if this is a new query
    if not thread_id:
        thread = Thread(pq.thread_id)
        thread.busy = True
        active_threads[pq.thread_id] = thread

    pending_queries[pq.query_id] = pq
    query_queue.append(pq)

    try:
        await asyncio.wait_for(pq.event.wait(), timeout=30.0)
    except asyncio.TimeoutError:
        raise HTTPException(504, "extension did not respond in time")
    finally:
        pending_queries.pop(pq.query_id, None)
        try:
            query_queue.remove(pq)
        except ValueError:
            pass
        if thread:
            thread.busy = False
            thread.last_activity = time.monotonic()

    return {
        "query": pq.query,
        "query_id": pq.query_id,
        "thread_id": pq.thread_id,
        **(pq.result or {"markdown": "", "citations": [], "error": "no result"}),
    }


@app.get("/pending")
async def get_pending():
    # Drain close_queue
    threads_to_close = []
    while close_queue:
        threads_to_close.append(close_queue.popleft())

    if query_queue:
        pq = query_queue.popleft()
        return {
            "query_id": pq.query_id,
            "query": pq.query,
            "thread_id": pq.thread_id,
            "type": pq.query_type,
            "close_threads": threads_to_close,
        }
    return {
        "query_id": None,
        "query": None,
        "close_threads": threads_to_close,
    }


@app.post("/result/{query_id}")
async def post_result(query_id: str, payload: ResultPayload):
    pq = pending_queries.get(query_id)
    if not pq:
        raise HTTPException(404, "query not found or expired")

    pq.result = payload.model_dump()
    pq.event.set()
    return {"status": "ok"}


@app.delete("/thread/{thread_id}")
async def delete_thread(thread_id: str):
    thread = active_threads.pop(thread_id, None)
    if not thread:
        raise HTTPException(404, "thread not found or expired")
    close_queue.append(thread_id)
    return {"status": "ok"}
