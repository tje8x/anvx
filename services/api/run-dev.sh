#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
set -a
[ -f .env ] && source .env
set +a
uv run uvicorn app.main:app --reload --port 8000
