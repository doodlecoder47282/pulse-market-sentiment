#!/bin/bash
# ─── Pulse Batcave — Sandbox Restore Script ──────────────────────────────────
#
# Why this exists: sandbox VMs are ephemeral. /home/user/workspace gets recycled
# on inactivity, infra restarts, or session-boundary edges. This script rebuilds
# the entire Pulse Batcave stack from scratch in ~2 minutes.
#
# Three layers of defense against wipe:
#   1. GitHub repo is source of truth — every meaningful change committed + pushed
#   2. .env.local creds backed up in agent memory (not in git for security)
#   3. This script — single command to rebuild the world
#
# Usage:
#   bash /home/user/workspace/sentiment-app/RESTORE.sh
#   OR if workspace is wiped:
#   cd /home/user/workspace && git clone https://github.com/doodlecoder47282/pulse-market-sentiment sentiment-app && bash sentiment-app/RESTORE.sh

set -e

WORKSPACE="/home/user/workspace"
APP="$WORKSPACE/sentiment-app"

echo "[restore] Step 1/5 — checking workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

if [ ! -d "$APP/.git" ]; then
  echo "[restore] sentiment-app missing or not a git repo — cloning from GitHub"
  rm -rf "$APP"
  git clone https://github.com/doodlecoder47282/pulse-market-sentiment sentiment-app
fi

cd "$APP"

echo "[restore] Step 2/5 — pulling latest from GitHub"
git pull --rebase origin main 2>/dev/null || git pull --rebase origin master 2>/dev/null || echo "[restore] (no remote pull — using local state)"

echo "[restore] Step 3/5 — checking .env.local"
if [ ! -f "$APP/.env.local" ]; then
  # Pull from environment variables if set (preferred for CI / scripted restore),
  # otherwise look for a backup file in $HOME/.pulse-secrets/.env.local (untracked).
  if [ -n "$SCHWAB_CLIENT_ID" ] && [ -n "$SCHWAB_CLIENT_SECRET" ]; then
    cat > "$APP/.env.local" <<EOF
SCHWAB_CLIENT_ID=$SCHWAB_CLIENT_ID
SCHWAB_CLIENT_SECRET=$SCHWAB_CLIENT_SECRET
SCHWAB_REDIRECT_URI=${SCHWAB_REDIRECT_URI:-https://127.0.0.1}
EOF
    chmod 600 "$APP/.env.local"
    echo "[restore] .env.local created from environment variables"
  elif [ -f "$WORKSPACE/.pulse-secrets/.env.local" ]; then
    # Primary backup: inside workspace (survives sandbox wipes that preserve workspace)
    cp "$WORKSPACE/.pulse-secrets/.env.local" "$APP/.env.local"
    chmod 600 "$APP/.env.local"
    echo "[restore] .env.local restored from workspace/.pulse-secrets backup"
  elif [ -f "$HOME/.pulse-secrets/.env.local" ]; then
    # Secondary backup: home dir (rarely survives sandbox recycle, but try anyway)
    cp "$HOME/.pulse-secrets/.env.local" "$APP/.env.local"
    chmod 600 "$APP/.env.local"
    echo "[restore] .env.local restored from ~/.pulse-secrets backup"
  else
    echo "[restore] WARNING: .env.local missing and no credential source available"
    echo "[restore]   - Set SCHWAB_CLIENT_ID + SCHWAB_CLIENT_SECRET env vars, OR"
    echo "[restore]   - Place creds at $WORKSPACE/.pulse-secrets/.env.local (primary), OR"
    echo "[restore]   - Place creds at ~/.pulse-secrets/.env.local (secondary), OR"
    echo "[restore]   - Ask the agent: memory_search 'Schwab credentials recovery'"
  fi
else
  echo "[restore] .env.local already present — leaving alone"
fi

echo "[restore] Step 4/5 — npm install + build"
cd "$APP"
if [ ! -d "$APP/node_modules" ]; then
  npm install --no-audit --no-fund 2>&1 | tail -5
fi
npm run build 2>&1 | tail -5

echo "[restore] Step 5/5 — done"
echo ""
echo "─── Restore complete ────────────────────────────────────────────────────"
echo "Next steps:"
echo "  1. Start server via pplx-tool start_server (NOT nohup/bash & — those die on session end):"
echo "       pplx-tool start_server <<JSON"
echo "       {\"command\":\"node dist/index.cjs\",\"project_path\":\"$APP\",\"port\":5000,\"log_file\":\"/tmp/server.log\",\"wait_for_port\":true,\"timeout_seconds\":45}"
echo "       JSON"
echo "  2. Reauth Schwab via Settings → Schwab → Connect"
echo "  3. Deploy via pplx-tool deploy_website"
echo ""
echo "Sandbox-wipe defenses active:"
echo "  - Git: doodlecoder47282/pulse-market-sentiment"
echo "  - Creds: agent memory backup (call memory_search 'Schwab credentials')"
echo "  - This script: rerun anytime to rebuild from scratch"
