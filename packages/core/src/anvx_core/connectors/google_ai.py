"""Google AI v2 connector — validates Gemini API keys, billing via GCP."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://generativelanguage.googleapis.com/v1beta"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class GoogleAIConnector:
    provider = "google_ai"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/models", params={"key": api_key})
            if resp.status_code == 400 or resp.status_code == 403:
                raise PermissionError("Invalid Google AI API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        logger.warning("Google AI standard keys don't expose per-call billing. Connect GCP for billing visibility.")
        return []

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch(client: httpx.AsyncClient, url: str, params: dict) -> httpx.Response:
        return await client.get(url, params=params)
