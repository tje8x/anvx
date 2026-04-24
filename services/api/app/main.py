from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import anomalies as anomalies_router
from .routers import connectors as connectors_router
from .routers import insights as insights_router
from .routers import models as models_router
from .routers import policies as policies_router
from .routers import routing as routing_router
from .routers import routing_rules as routing_rules_router
from .routers import shadow as shadow_router
from .routers import tokens as tokens_router
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
app.include_router(tokens_router.router, prefix="/api/v2")
app.include_router(shadow_router.router, prefix="/api/v2")
app.include_router(routing_rules_router.router, prefix="/api/v2")
app.include_router(models_router.router, prefix="/api/v2")
app.include_router(policies_router.router, prefix="/api/v2")
app.include_router(routing_router.router, prefix="/api/v2")
app.include_router(anomalies_router.router, prefix="/api/v2")


@app.get("/health")
async def health():
    return {"ok": True}
