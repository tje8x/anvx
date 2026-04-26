"""Resend HTTP API client. Async via httpx."""
from __future__ import annotations

import httpx

from ..settings import settings


async def send_email(to: str, subject: str, text: str, html: str) -> None:
    """Send a single email via Resend. Raises on non-2xx response.

    `to` may be a single address ("a@b.com") or a comma-separated list
    ("a@b.com, c@d.com"). All non-empty addresses are passed to Resend in a
    single API call (one email, all recipients on the To: header).
    """
    if not settings.resend_api_key:
        raise RuntimeError("RESEND_API_KEY not set")
    if not settings.resend_from:
        raise RuntimeError("RESEND_FROM not set")

    recipients = [addr.strip() for addr in (to or "").split(",") if addr.strip()]
    if not recipients:
        raise RuntimeError("no email recipients")

    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.resend_from,
                "to": recipients,
                "subject": subject,
                "text": text,
                "html": html,
            },
        )
        if res.status_code >= 300:
            raise RuntimeError(f"Resend HTTP {res.status_code}: {res.text[:200]}")
