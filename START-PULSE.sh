#!/bin/bash
# ─── Pulse Batcave — Mac/Linux Launcher ──────────────────────────────────────
# Usage: bash START-PULSE.sh
# Requirements: Node.js 18+ (https://nodejs.org), npm

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║      PULSE BATCAVE — LOCAL MODE      ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "[error] Node.js not found. Install from https://nodejs.org (v18+ required)."
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.version.match(/\d+/)[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[error] Node.js v18+ required. You have $(node -v). Upgrade at https://nodejs.org"
  exit 1
fi

# Check .env.local
if [ ! -f ".env.local" ]; then
  echo "[setup] .env.local not found."
  echo "  Copy .env.local.template to .env.local and add your Schwab credentials."
  echo ""
  echo "  cp .env.local.template .env.local"
  echo "  nano .env.local   (or open in any text editor)"
  echo ""
  read -p "  Open .env.local.template now to see instructions? (y/n): " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    cat .env.local.template
  fi
  echo ""
  echo "[error] Add your credentials to .env.local, then re-run START-PULSE.sh"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "[setup] Installing dependencies (this takes ~1 min on first run)..."
  npm install --no-audit --no-fund
  echo "[setup] Dependencies installed."
fi

# Build if dist is missing or stale
if [ ! -f "dist/index.cjs" ]; then
  echo "[setup] Building app..."
  npm run build
  echo "[setup] Build complete."
fi

echo ""
echo "[start] Starting Pulse Batcave on http://localhost:5000"
echo "[start] Press Ctrl+C to stop."
echo ""

# Load .env.local into env, then start
set -a
source .env.local
set +a

node dist/index.cjs
