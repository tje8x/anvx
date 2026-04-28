import os
import re
import uuid
from contextlib import asynccontextmanager

import sentry_sdk
import structlog
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from .logging import configure_logging, get_logger

configure_logging()
log = get_logger(__name__)

SECRET_PATTERN = re.compile(
    r"(sk[-_](live|test)?[a-zA-Z0-9_-]{16,}"
    r"|anvx_(live|test)_[a-zA-Z0-9_-]{16,}"
    r"|whsec_[a-zA-Z0-9]{16,})"
)

_SCRUB_HEADERS = {
    "authorization", "cookie", "x-anvx-token",
    "stripe-signature", "svix-signature",
}


def _walk(obj):
    if isinstance(obj, str):
        return SECRET_PATTERN.sub("***SCRUBBED***", obj)
    if isinstance(obj, dict):
        return {k: _walk(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_walk(i) for i in obj]
    return obj


def scrub(event, hint):
    headers = event.get("request", {}).get("headers")
    if headers:
        for k in list(headers):
            if k.lower() in _SCRUB_HEADERS:
                headers[k] = "***SCRUBBED***"

    extra = event.get("extra") or {}
    contexts = event.get("contexts") or {}
    workspace_id = (
        extra.get("workspace_id")
        or contexts.get("workspace", {}).get("id")
    )
    request_id = (
        extra.get("request_id")
        or (headers or {}).get("x-request-id")
        or (headers or {}).get("X-Request-ID")
    )
    tags = event.setdefault("tags", {})
    if workspace_id:
        tags["workspace_id"] = workspace_id
    if request_id:
        tags["request_id"] = request_id

    return _walk(event)


if os.environ.get("SENTRY_DSN"):
    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        traces_sample_rate=0.1,
        send_default_pii=False,
        environment=os.environ.get("ENV", "development"),
        integrations=[FastApiIntegration(), StarletteIntegration()],
        before_send=scrub,
    )

from .routers import anomalies as anomalies_router
from .routers import attribution as attribution_router
from .routers import billing as billing_router
from .routers import connectors as connectors_router
from .routers import copilot as copilot_router
from .routers import dashboard as dashboard_router
from .routers import documents as documents_router
from .routers import incidents as incidents_router
from .routers import reconcile as reconcile_router
from .routers import insights as insights_router
from .routers import models as models_router
from .routers import notifications as notifications_router
from .routers import onboarding as onboarding_router
from .routers import packs as packs_router
from .routers import policies as policies_router
from .routers import routing as routing_router
from .routers import routing_rules as routing_rules_router
from .routers import observer as observer_router
from .routers import tokens as tokens_router
from .routers import workspace as workspace_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eager-load settings on startup — fail fast if env vars missing
    from .settings import settings  # noqa: F841
    yield


app = FastAPI(title="ANVX API", version="0.2.0", lifespan=lifespan)


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Bind request_id (and workspace_id/user_id when set later by auth)
    into structlog's contextvars for the duration of the request, and
    echo X-Request-ID back in the response.
    """

    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = request_id

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
        )

        try:
            response = await call_next(request)
        except Exception:
            log.exception("request_failed")
            raise
        finally:
            structlog.contextvars.clear_contextvars()

        response.headers["X-Request-ID"] = request_id
        return response


app.add_middleware(RequestContextMiddleware)

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
app.include_router(observer_router.router, prefix="/api/v2")
app.include_router(routing_rules_router.router, prefix="/api/v2")
app.include_router(models_router.router, prefix="/api/v2")
app.include_router(policies_router.router, prefix="/api/v2")
app.include_router(routing_router.router, prefix="/api/v2")
app.include_router(anomalies_router.router, prefix="/api/v2")
app.include_router(incidents_router.router, prefix="/api/v2")
app.include_router(copilot_router.router, prefix="/api/v2")
app.include_router(documents_router.router, prefix="/api/v2")
app.include_router(reconcile_router.router, prefix="/api/v2")
app.include_router(attribution_router.router, prefix="/api/v2")
app.include_router(dashboard_router.router, prefix="/api/v2")
app.include_router(packs_router.router, prefix="/api/v2")
app.include_router(billing_router.router, prefix="/api/v2")
app.include_router(notifications_router.router, prefix="/api/v2")
app.include_router(onboarding_router.router, prefix="/api/v2")


@app.get("/health")
async def health():
    return {"ok": True}
