#!/bin/sh
# Nuke local DB and reseed from fixtures/bundestag.xml.
# Usage: sh scripts/reset-db.sh [runId]  (default runId: seed)
set -eu
cd "$(dirname "$0")/.."

docker compose up -d --wait
pnpm exec prisma migrate reset --force
pnpm build:test
node --env-file-if-exists=.env dist/scripts/seed.js "${1:-seed}"
