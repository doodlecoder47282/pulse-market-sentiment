#!/usr/bin/env bash
# Batcave auto-push: commits pending changes on main and pushes to origin.
# - Skips locked files defensively (never staged).
# - Skips generated/cache paths.
# - Refuses to push if HEAD contains secret-like strings.
# - Fast-forward pull with rebase before push; abort on conflict.
set -euo pipefail

cd "$(dirname "$0")/.."
BRANCH="${BRANCH:-main}"

# Ensure we're on main and clean of merge state.
git rev-parse --is-inside-work-tree > /dev/null
git checkout "$BRANCH" >/dev/null 2>&1 || true

# Locked files must never be modified/staged by automation.
LOCKED=(
  "server/regime.ts"
  "server/models.ts"
  "server/composite.ts"
  "client/src/components/PreMarketGate.tsx"
  # signals.ts and dfi.ts are locked-if-present; only add if they exist
)
for f in "${LOCKED[@]}"; do
  if [ -f "$f" ] && ! git diff --quiet -- "$f"; then
    echo "[auto-push] refusing: locked file modified: $f" >&2
    git checkout -- "$f"
  fi
done

# Only stage tracked-source changes + additive new files. .gitignore already
# blocks node_modules/, dist/, .env*, data.db*, backups/, *.log, data/cboe/.
# We still explicitly unstage the scheduler state file so it doesn't churn.
git add -A
git reset -- .discord-scheduler-state.json 2>/dev/null || true

# Nothing to commit? exit clean.
if git diff --cached --quiet; then
  echo "[auto-push] no changes"
  exit 0
fi

# Secret-scan the staged diff. If any hit, abort and unstage.
STAGED_DIFF="$(git diff --cached)"
if printf '%s' "$STAGED_DIFF" | grep -qEi \
  '(SCHWAB_CLIENT_SECRET=[A-Za-z0-9_-]{6,}|X_BEARER_TOKEN=[A-Za-z0-9_-]{6,}|refresh_token"\s*:\s*"[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[a-zA-Z0-9]{20,}|ghp_[A-Za-z0-9]{20,})'; then
  echo "[auto-push] secret-like content detected in staged diff — aborting" >&2
  git reset >/dev/null
  exit 2
fi

STAMP="$(date -u +%Y-%m-%dT%H:%MZ)"
MSG="${COMMIT_MSG:-chore(auto): sync $STAMP}"
git -c user.name="batcave-autopush" -c user.email="tankanthony6@gmail.com" commit -m "$MSG"

# Rebase on remote to avoid non-fast-forward.
git fetch origin "$BRANCH" >/dev/null
git rebase "origin/$BRANCH" || { echo "[auto-push] rebase conflict, aborting" >&2; git rebase --abort; exit 3; }

git push origin "$BRANCH"
echo "[auto-push] pushed $(git rev-parse --short HEAD)"
