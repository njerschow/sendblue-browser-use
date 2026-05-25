#!/usr/bin/env bash
# Quick curl-only demo. Requires BROWSER_USE_API_KEY in env.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="Authorization: Bearer ${BROWSER_USE_API_KEY:?set BROWSER_USE_API_KEY}"
JSON="Content-Type: application/json"

curl -fsS -X POST "$BASE/sessions" -H "$TOKEN" -H "$JSON" -d '{"name":"curl-demo"}'
curl -fsS -X POST "$BASE/sessions/curl-demo/navigate" -H "$TOKEN" -H "$JSON" -d '{"url":"https://example.com"}'
curl -fsS "$BASE/sessions/curl-demo" -H "$TOKEN"
curl -fsS "$BASE/sessions/curl-demo/screenshot?fullPage=true" -H "$TOKEN" -o /tmp/curl-demo.png
echo "saved /tmp/curl-demo.png"
curl -fsS -X POST "$BASE/sessions/curl-demo/purge" -H "$TOKEN"
curl -fsS -X DELETE "$BASE/sessions/curl-demo" -H "$TOKEN"
