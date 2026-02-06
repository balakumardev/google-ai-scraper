import asyncio
import uuid
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


class PendingQuery:
    __slots__ = ("query_id", "query", "event", "result")

    def __init__(self, query: str):
        self.query_id: str = uuid.uuid4().hex[:12]
        self.query: str = query
        self.event: asyncio.Event = asyncio.Event()
        self.result: dict | None = None


# Shared state
pending_queries: dict[str, PendingQuery] = {}
query_queue: deque[PendingQuery] = deque()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    pending_queries.clear()
    query_queue.clear()


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
    }


@app.get("/ask")
async def ask(q: str):
    if not q.strip():
        raise HTTPException(400, "query is required")

    pq = PendingQuery(q.strip())
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

    return {
        "query": pq.query,
        "query_id": pq.query_id,
        **(pq.result or {"markdown": "", "citations": [], "error": "no result"}),
    }


@app.get("/pending")
async def get_pending():
    if query_queue:
        pq = query_queue.popleft()
        return {"query_id": pq.query_id, "query": pq.query}
    return {"query_id": None, "query": None}


@app.post("/result/{query_id}")
async def post_result(query_id: str, payload: ResultPayload):
    pq = pending_queries.get(query_id)
    if not pq:
        raise HTTPException(404, "query not found or expired")

    pq.result = payload.model_dump()
    pq.event.set()
    return {"status": "ok"}
