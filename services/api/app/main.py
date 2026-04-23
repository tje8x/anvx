from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import connectors as connectors_router
from .routers import insights as insights_router
from .routers import workspace as workspace_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eager-load settings on startup — fail fast if env vars missing
    from .settings import settings  # noqa: F841
    yield


app = FastAPI(title="ANVX API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://anvx.io"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(workspace_router.router, prefix="/api/v2")
app.include_router(connectors_router.router, prefix="/api/v2")
app.include_router(insights_router.router, prefix="/api/v2")


@app.get("/health")
async def health():
    return {"ok": True}
