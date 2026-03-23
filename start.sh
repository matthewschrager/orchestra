#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ORIG_CWD="$PWD"

# ── Parse arguments ─────────────────────────────────────

usage() {
  echo "Usage: $0 [-p|--port PORT] [-d|--data-dir DIR]"
  echo "  -p, --port PORT       Port for the UI (default: 3847, or ORCHESTRA_PORT env var)"
  echo "  -d, --data-dir DIR    Data directory for DB + auth token (default: ~/.orchestra)"
  exit 0
}

CLI_PORT=""
CLI_DATA_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      CLI_PORT="$2"
      shift 2
      ;;
    -d|--data-dir)
      CLI_DATA_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

PORT="${CLI_PORT:-${ORCHESTRA_PORT:-3847}}"

# ── Check prerequisites ──────────────────────────────────

if ! command -v bun &>/dev/null; then
  echo "bun is required. Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# ── Kill existing Orchestra server on this port ──────────

if lsof -ti :"$PORT" &>/dev/null; then
  echo "Stopping existing process on port $PORT..."
  lsof -ti :"$PORT" | xargs kill 2>/dev/null || true
  # Wait up to 5s for processes to exit
  for i in $(seq 1 10); do
    lsof -ti :"$PORT" &>/dev/null || break
    sleep 0.5
  done
  # Force kill if still alive
  if lsof -ti :"$PORT" &>/dev/null; then
    echo "Force-killing process on port $PORT..."
    lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

# ── Install dependencies ─────────────────────────────────

echo "Installing dependencies..."
cd "$ROOT"
bun install --frozen-lockfile 2>/dev/null || bun install

# ── Build frontend ───────────────────────────────────────

echo "Building frontend..."
cd "$ROOT/client"
bun run build

# ── Export env vars for server ────────────────────────────

export ORCHESTRA_PORT="$PORT"

DATA_DIR="${CLI_DATA_DIR:-${ORCHESTRA_DATA_DIR:-}}"
if [[ -n "$DATA_DIR" ]]; then
  # Resolve relative paths against user's original CWD
  if [[ "$DATA_DIR" != /* ]]; then
    DATA_DIR="$(cd "$ORIG_CWD" && realpath -m "$DATA_DIR")"
  fi
  export ORCHESTRA_DATA_DIR="$DATA_DIR"
fi

# ── Start server ─────────────────────────────────────────

echo ""
echo "Starting Orchestra on http://localhost:$PORT"
echo "Press Ctrl+C to stop."
echo ""
# Final port check before starting
if lsof -ti :"$PORT" &>/dev/null; then
  echo "ERROR: Port $PORT is still in use after cleanup."
  echo "PIDs: $(lsof -ti :"$PORT")"
  exit 1
fi

cd "$ROOT/server"
exec bun run src/index.ts
