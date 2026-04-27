# anvx MCP server

Thin MCP wrapper over the anvx public API. In v2 mode every tool is a single HTTP call to the hosted backend — no Supabase access, no keychain reads, no local business logic.

## Configuration

```bash
export ANVX_TOKEN=anvx_live_...                # required for v2 features
export ANVX_API_BASE=http://localhost:8000     # optional, defaults to https://anvx.io
```

Generate a workspace API token at [https://anvx.io/settings/connections](https://anvx.io/settings/connections).

Without `ANVX_TOKEN` the server boots in **v1 legacy mode**: local-only, keychain-based, with no policy, routing, or pack features. The startup banner makes the mode obvious.

## Migrating from v1

See [docs/migration/v1-to-v2.md](../docs/migration/v1-to-v2.md) for the full upgrade path. TL;DR: install the new release, generate a token at anvx.io, export `ANVX_TOKEN`, run as before.

## Tools

### Read-only

| Tool | Endpoint |
| --- | --- |
| `get_spend_summary(period)` | `GET /api/v2/spend/summary?period=...` |
| `get_insights(limit)` | `GET /api/v2/insights?limit=...&include_score=true` |
| `list_policies()` | `GET /api/v2/policies` |
| `list_routing_rules()` | `GET /api/v2/routing/rules` |
| `list_connectors()` | `GET /api/v2/connectors` |

### Propose-then-confirm

These never mutate workspace state directly. They return a URL the user opens in-browser to review and approve.

| Tool | Endpoint | Returns |
| --- | --- | --- |
| `propose_policy(scope, limit, action, period)` | `POST /api/v2/policies/proposals` | `{ confirm_url }` |
| `propose_routing_rule(name, models, quality_priority, cost_priority)` | `POST /api/v2/routing/rules/proposals` | `{ confirm_url }` |
| `generate_pack_preview(kind, period)` | `POST /api/v2/packs/previews` | `{ preview_url }` |

## Running

```bash
uv run python mcp/server.py
```

Communicates over stdio. Drop into Claude Desktop / ChatGPT MCP config as a stdio MCP server.

## Tests

```bash
uv run --with respx --with pytest pytest mcp/tests/
```

Mocks the v2 API with `respx` (httpx-native equivalent of `responses`). Covers all 8 tools, 401 (revoked token), 5xx, and missing-token paths.
