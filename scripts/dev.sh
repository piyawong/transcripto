#!/usr/bin/env bash
# Starts Postgres + MinIO (docker), the Rust API and the Next.js dev server. Logs go to .run/.
#   scripts/dev.sh            real ElevenLabs + Gemini (keys from .env or .env.test)
#   scripts/dev.sh --fixture  replay docs/rust-implementation/fixtures, no API calls
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run

docker compose -p transcripto up -d db minio
until docker exec transcripto-db-1 pg_isready -U transcripto >/dev/null 2>&1; do sleep 1; done
until curl -sf localhost:9010/minio/health/live >/dev/null; do sleep 1; done

pkill -f "target/debug/transcripto-api" 2>/dev/null || true
(cd api && cargo build --bin transcripto-api)
if [ "${1:-}" = "--fixture" ]; then
  export AI_FIXTURE_DIR="$PWD/docs/rust-implementation/fixtures"
fi
(cd api && nohup ./target/debug/transcripto-api > ../.run/api.log 2>&1 &)

if ! lsof -iTCP:3010 -sTCP:LISTEN >/dev/null 2>&1; then
  (cd web && nohup npm run dev > ../.run/web.log 2>&1 &)
fi
until curl -sf localhost:8010/api/health >/dev/null; do sleep 1; done
echo "api  http://localhost:8010  (log .run/api.log)"
echo "web  http://localhost:3010  (log .run/web.log)"
