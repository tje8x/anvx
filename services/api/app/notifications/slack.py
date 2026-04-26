"""Slack incoming webhook poster."""
from __future__ import annotations

import httpx


async def send_slack(webhook_url: str, blocks: list[dict]) -> None:
    """POST Block Kit blocks to a Slack incoming webhook. Raises on non-2xx."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(webhook_url, json={"blocks": blocks})
        if res.status_code >= 300:
            raise RuntimeError(f"Slack HTTP {res.status_code}: {res.text[:200]}")
