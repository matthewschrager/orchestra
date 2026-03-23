#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${ORCHESTRA_PORT:-3847}"

# ── Check prerequisites ──────────────────────────────────

if ! command -v bun &>/dev/null; then
  echo "bun is required. Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# ── Kill existing Orchestra server on this port ──────────

if lsof -ti :"$PORT" &>/dev/null; then
  echo "Stopping existing process on port $PORT..."
  kill "$(lsof -ti :"$PORT")" 2>/dev/null || true
  sleep 1
fi

# ── Install dependencies ─────────────────────────────────

echo "Installing dependencies..."
cd "$ROOT"
bun install --frozen-lockfile 2>/dev/null || bun install

# ── Build frontend ───────────────────────────────────────

echo "Building frontend..."
cd "$ROOT/client"
bun run build

# ── Start server ─────────────────────────────────────────

echo ""
echo "Starting Orchestra on http://localhost:$PORT"
echo "Press Ctrl+C to stop."
echo ""
cd "$ROOT/server"
exec bun run src/index.ts
