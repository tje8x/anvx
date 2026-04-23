"""
Daily refresh of the `models` reference table from OpenRouter's public pricing API.
Run via cron in production; run manually during build.
"""

import asyncio
import httpx
from app.db import sb_service

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

POOL_HINTS = {
    # map OpenRouter's model IDs to our pool_hint taxonomy
    "openai/gpt-4o": "chat-quality",
    "openai/gpt-4o-mini": "chat-fast",
    "openai/gpt-4.1": "chat-quality",
    "openai/gpt-4.1-mini": "chat-fast",
    "openai/gpt-4.1-nano": "chat-fast",
    "openai/o3": "chat-quality",
    "openai/o3-mini": "chat-fast",
    "openai/o4-mini": "chat-fast",
    "anthropic/claude-sonnet-4": "chat-quality",
    "anthropic/claude-3.5-sonnet": "chat-quality",
    "anthropic/claude-3-haiku": "chat-fast",
    "anthropic/claude-3.5-haiku": "chat-fast",
    "google/gemini-flash-1.5": "chat-fast",
    "google/gemini-pro-1.5": "chat-quality",
    "google/gemini-2.0-flash": "chat-fast",
    "google/gemini-2.5-pro": "chat-quality",
    "google/gemini-2.5-flash": "chat-fast",
    "meta-llama/llama-3.1-70b-instruct": "chat-quality",
    "meta-llama/llama-3.1-8b-instruct": "chat-fast",
    "meta-llama/llama-4-scout": "chat-quality",
    "meta-llama/llama-4-maverick": "chat-quality",
    "mistralai/mistral-large": "chat-quality",
    "mistralai/mistral-small": "chat-fast",
    "deepseek/deepseek-chat": "chat-quality",
    "deepseek/deepseek-r1": "chat-quality",
    "cohere/command-r-plus": "chat-quality",
    "cohere/command-r": "chat-fast",
}


async def main():
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(OPENROUTER_MODELS_URL)
        resp.raise_for_status()
        data = resp.json()["data"]

    sb = sb_service()
    rows = []
    for m in data:
        # OpenRouter model id format: "provider/model", e.g. "openai/gpt-4o"
        if "/" not in m["id"]:
            continue
        provider, model = m["id"].split("/", 1)
        pricing = m.get("pricing", {})
        rows.append({
            "provider": provider,
            "model": model,
            "pool_hint": POOL_HINTS.get(m["id"]),
            "input_price_per_mtok_cents": int(float(pricing.get("prompt", 0)) * 100 * 1_000_000),
            "output_price_per_mtok_cents": int(float(pricing.get("completion", 0)) * 100 * 1_000_000),
            "context_window": m.get("context_length"),
        })

    # Upsert
    sb.table("models").upsert(rows, on_conflict="provider,model").execute()
    print(f"Refreshed {len(rows)} models from OpenRouter")


if __name__ == "__main__":
    asyncio.run(main())
