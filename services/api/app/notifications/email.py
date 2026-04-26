"""Resend HTTP API client. Async via httpx."""
from __future__ import annotations

import httpx

from ..settings import settings


async def send_email(to: str, subject: str, text: str, html: str) -> None:
    """Send a single email via Resend. Raises on non-2xx response."""
    if not settings.resend_api_key:
        raise RuntimeError("RESEND_API_KEY not set")
    if not settings.resend_from:
        raise RuntimeError("RESEND_FROM not set")

    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.resend_from,
                "to": [to],
                "subject": subject,
                "text": text,
                "html": html,
            },
        )
        if res.status_code >= 300:
            raise RuntimeError(f"Resend HTTP {res.status_code}: {res.text[:200]}")
