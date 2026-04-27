# v1 → v2 migration

## What changes

- v1 ran locally and read credentials from macOS keychain or env vars
- v2 runs against a hosted workspace at anvx.io
- The skill and MCP server authenticate via a workspace API token (env: ANVX_TOKEN) and call the v2 public API
- All pricing, policy, and routing logic now lives server-side

## What does not change

- ClawHub slug: anvx
- MCP listing URLs: unchanged across all directories
- v1 local installs: continue to function unmodified until users re-install

## How a v1 user upgrades

1. pip install -U anvx (or clawhub install anvx@latest)
2. Sign up at anvx.io if no workspace yet
3. Generate a workspace API token at https://anvx.io/settings/connections
4. export ANVX_TOKEN=anvx_live_...
5. Run as before — skill/MCP detect the token and route through the hosted API

## Deprecation timeline

- v2 published at the same slug, version 2.0.0
- Launch +6 months: v1 fallback code paths removed from the codebase
- v1 source remains in git history (search for commits before the v2 build started around April 2026)
