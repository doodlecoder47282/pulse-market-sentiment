# Batcave checkpoint

Updated: 2026-10-07. This is a compact handoff, not a live-health certificate.

## Completed objective

iOS Xcode project (Capacitor 8) and hosted-deployment readiness, on branch
`ios-capacitor` (PR to `main`). No deployment was performed.

## Verified (GitHub Actions run 37574061566, sha 5459fc1)

- Web: `npm ci`, `npm run build` pass on Node 20. Production server boots;
  smoke tests pass: UI served, `/api/health`, iOS CORS preflight/header,
  foreign origin rejected, `BATCAVE_ACCESS_KEY` gate (no key 401, wrong key 401,
  right key 200), `BATCAVE_DATA_DIR` creates `data.db` in the volume path.
- Headless Chromium (desktop 1440x900 and 393x852): dashboard renders past the
  splash and pre-market gate with 0 page errors; FX/crypto ticker populated;
  Schwab shows DISCONNECTED (expected, no credentials in CI).
- iOS: Xcode 26.3, Capacitor 8.5.2 (SPM, iOS 15.0 minimum). `cap add ios`
  succeeded; `xcodebuild` Debug for iOS Simulator: BUILD SUCCEEDED (unsigned).
  App installed and launched in the Simulator; shows the server-connect screen.
- `npx tsc --noEmit`: 182 pre-existing errors (largest: odteAlertEngine 46,
  chainAudit 33, cryptoEngine 14). None in files changed this session. The
  build does not type-check, so these do not block it.

## Changes

- `client/src/lib/queryClient.ts`: API base = saved server URL, then
  `VITE_API_BASE`, then the legacy port token, then same origin; `x-batcave-key` header.
- `client/src/components/ConnectionGate.tsx` (+ mounted in `App.tsx`).
- `server/index.ts`: `/api/health`, `/api/health/auth`, CORS allowlist for
  Capacitor origins (+ `BATCAVE_ALLOWED_ORIGINS`), optional `BATCAVE_ACCESS_KEY`
  gate on `/api`, bind `0.0.0.0` when `RAILWAY_ENVIRONMENT`/`RENDER`/`FLY_APP_NAME`
  is set or `HOST` given (was hard-coded `127.0.0.1`, unreachable on Railway).
- `server/dbPath.ts`: `BATCAVE_DATA_DIR` relocates `data.db`, backups and
  `greek_gradient.db` (seeded from repo copy) for persistent volumes.
- `capacitor.config.json` (appId `com.batcave.terminal`), `ios/` project,
  `npm run ios:sync` / `ios:open`.
- CI `.github/workflows/batcave-build.yml`. Reports are force-pushed to branches
  `ci-reports-web` / `ci-reports-ios` because agent sessions cannot read
  Actions log/artifact storage. Read them with a shallow clone of those branches.
- Docs: `docs/IOS.md`, `RAILWAY-DEPLOY.md` (access key, volume, hosting notes).

## Security blockers (unchanged, user action required)

- Repo is PUBLIC. Schwab client ID/secret exist in git history. Rotate them in
  the Schwab developer portal before deploying.
- Four Discord webhook URLs are hard-coded in `server/discord.ts`,
  `server/calibrationCard.ts`, `server/discordBatcaveCard.ts`. Anyone can post to
  those channels. Regenerate the webhooks in Discord, then move them to env vars.
- Runtime DB files `data/greek_gradient.db{,-wal,-shm}` are tracked.

## Known gaps

- Python ML sidecar (`ml_service/`, LightGBM) is not installed by the Railway
  Node build; ML panels report unavailable there.
- Social-score failure-to-zero, cashtag matching, and `graded >= 50` "calibrated"
  issues from the 2026-09-28 checkpoint are unchanged.
- Score calibrator models are `BOOTSTRAP` with n_train = 80.
- iOS app not signed or tested on a physical device.

## Next step

User deploys `ios-capacitor` (or `main` after merging the PR) to Railway with
rotated Schwab credentials, `BATCAVE_ACCESS_KEY`, and a volume at
`/app/persist` (`BATCAVE_DATA_DIR=/app/persist`), then enters that URL in the iOS app.
