#!/usr/bin/env bash
set -euo pipefail
MODEL="${1:-gpt-4o-mini}"
if [ -z "${ANVX_TOKEN:-}" ] || [ -z "${ROUTING_URL:-}" ]; then
  echo "Export ANVX_TOKEN and ROUTING_URL first." >&2; exit 1
fi
SENT=0; N200=0; N429=0
for i in $(seq 1 500); do
  code=$(curl -s -o /tmp/last_response.json -w "%{http_code}" \
    "$ROUTING_URL/v1/chat/completions" \
    -H "Authorization: Bearer $ANVX_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Summarize: hello\"}],\"max_tokens\":20,\"stream\":false}")
  SENT=$((SENT+1))
  [ "$code" = "200" ] && N200=$((N200+1))
  if [ "$code" = "429" ]; then
    N429=$((N429+1))
    echo; echo "First 429 at request $SENT:"
    cat /tmp/last_response.json | python3 -m json.tool || cat /tmp/last_response.json
    break
  fi
  printf "."
  [ $((i%50)) = 0 ] && echo " ($i)"
done
echo; echo "Sent=$SENT 200=$N200 429=$N429"
