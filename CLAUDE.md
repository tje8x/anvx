## What is this project?
Token Economy Intelligence is a multi-surface financial intelligence tool for AI-native businesses. It connects to users' LLM billing APIs, crypto wallets, and payment processors to provide unified cost visibility and optimisation recommendations across all "tokenized" value flows.

## Architecture
Three distribution surfaces share one core engine:
1. OpenClaw skill (SKILL.md + Python scripts) — distributed via ClawHub
2. MCP server (JSON-RPC 2.0) — works with Claude Desktop, ChatGPT
3. Analytics backend (Vercel serverless + Supabase) — receives anonymised events

The core engine lives in engine/ and is imported by both the skill scripts and the MCP server. Never duplicate logic between surfaces.

## Tech stack
- Python 3.12+ with uv for dependency management
- Anthropic Claude API for intelligence (categorisation, recommendations)
- httpx for API calls (async)
- Pydantic for data models and validation
- MCP server uses the official mcp Python SDK
- Analytics backend is a separate Node.js/Vercel project

## Key design principles
- NEVER store or transmit user financial data to analytics. Only anonymised event types are sent.
- All connectors are READ-ONLY. No transaction execution.
- Crypto is READ-ONLY balance checks. No swaps, no transfers.
- Support synthetic data mode for testing without real API keys.
- Graceful error handling — failed API calls degrade to cached data, never crash.
- Financial model persists locally as JSON.

## Coding conventions
- Type hints everywhere. Pydantic models for all data structures.
- Async connectors (httpx.AsyncClient) for API calls.
- All amounts in USD. Dates as ISO 8601.
- Every external API call wrapped in try/except.

## File structure
- engine/ — Core intelligence (shared library)
- connectors/ — API connectors (OpenAI, Anthropic, Stripe, crypto)
- intelligence/ — Categoriser, anomaly detector, recommender
- analytics/ — Event tracking
- testing/ — Synthetic data, test suite
- openclaw-skill/ — OpenClaw wrapper (SKILL.md + scripts/)
- mcp-server/ — MCP wrapper (server.py + tools)
- analytics-backend/ — Hosted event collection (Vercel + Supabase)

## Security rules
- NEVER hardcode or log API keys
- NEVER send financial data to analytics
- ALL connectors are READ-ONLY
- Crypto connector has ZERO execution capability
- Error messages must not leak sensitive information
