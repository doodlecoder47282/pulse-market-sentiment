# Batcave checkpoint

Updated: 2026-09-28. This is a compact handoff, not a live-health certificate.

## Current objective

User authorized the Capacitor iPhone build and confirmed Mac/Xcode access.
First milestone is implemented on `feat/capacitor-ios`: bundled native shell,
read-only authenticated gateway, and Xcode source. User additionally requested
NIST-oriented multi-user security; that is a BLOCKED release requirement, not
implemented multi-user support. Read `SECURITY.md` before extending access.

## Verified this session

- Repo: `doodlecoder47282/pulse-market-sentiment`.
- Feature branch is based on `main` commit `9f4ea2093147bf2e00ce3b9e057aa75d2c061486`.
- GitHub reports PUBLIC visibility, contrary to older private-repo assumptions.
- Existing stack: React/Vite client, Express/Node server, SQLite/Drizzle.
- Capacitor 8.5.2, Swift Package Manager project at `ios/App/App.xcodeproj`,
  Node 22+, Xcode 26+, native assets at `dist/native`. Build with `npm run ios:sync`.
- Native transport uses a user-entered HTTPS backend origin plus a separate
  session-memory owner token. Web transport retains `__PORT_5000__`.
- Unrelated runtime changes exist in scheduler state and database/session files. They must not be staged with these docs.
- Native frontend build and Capacitor iOS sync passed; web frontend build passed.
- Three focused test groups pass: URL/session validation, gateway auth/routing,
  and rate limiting. Browser checks pass for setup/validation/401/fixture-login/
  disconnect/offline at 375 and 1280 widths, without page errors or horizontal overflow.
- Whole-repo TypeScript check still fails with 182 errors outside touched mobile
  files. Capacitor/Vite configs typecheck separately. Dependency audit reports
  15 findings (5 high); no broad dependency update attempted.
- No Xcode compilation, signing, physical-device testing, or live mobile backend
  integration has occurred. Existing running server was not restarted or exposed.

## Security blocker

`RAILWAY-DEPLOY.md` contained literal Schwab client ID/secret assignments.
This change replaces those assignments with placeholders in the current file.
Previous commits still contain the values. Treat them as exposed; removing text
does not revoke a credential.

User/account-owner action: revoke/rotate affected credentials and review OAuth
tokens/authorizations. Do not display values. Repository privacy changes and
history rewriting require approval and coordination; neither has been performed.
Do not redistribute an unreviewed full-history archive.

## Product context

- T1/T2 target derivation and audit persistence work are in the repo.
- Crypto includes scanner, momentum, narratives, security, social, grader, and watchdog routines.
- These routines are deterministic software, not independent reasoning agents.
- Earlier successful build/deploy claims apply to that earlier run, not today's runtime.
- Existing crypto implementation is experimental tracking, not proof of positive expected value.

## Known crypto issues from focused source inspection

Do not repeat prior “all green means complete coverage” claims:

- `socialTick` swallows individual source errors, then can assign `socialScore = 0`
  and update `socialCheckedAt` even when collection failed. Fix source-level
  health, timestamps, missing-value handling, and stale-data expiry before trusting social scoring.
- Bluesky queries use cashtags and at most 25 returned posts. Common words/ticker
  collisions, sampling caps, repeated authors, bots, and incomplete pagination
  prevent interpreting these counts as comprehensive token-specific velocity.
- Pump reply count and linked socials are limited attention proxies, not coverage of X or Telegram.
- Holder concentration blindly excludes the largest account as a pool heuristic.
  That account is not verified as a vault; do not describe the remainder as verified ex-pool ownership.
- `calibrated: graded >= 50` is a sample-count flag, not statistical calibration.
- Previously observed 403 responses do not establish a permanent platform-wide ban or prove the cause.

## iOS direction

The bundled shell opens on a setup screen and mounts the existing terminal only
after `/api/mobile/health` authenticates. Mobile writes and broker-management
routes are denied. Read-only source status is redacted. The gateway is disabled
unless `BATCAVE_MOBILE_TOKEN` is configured. It is NOT multi-user authentication.

Keep legacy `/api/*` inaccessible from a public mobile proxy. Current shared
Schwab token row `id=1`, unencrypted token writes, missing OAuth state binding,
and broad response logging block multi-user release. See `SECURITY.md`.

Read `docs/IOS_QUICKSTART.md` for Mac commands and deployment boundaries;
`docs/IOS_QA.md` for evidence and remaining device tests. Do not use a preview
URL as the mobile backend or embed brokerage credentials in any mobile artifact.

## Next step

Have the owner open the feature branch in Xcode and verify the setup screen on
their iPhone, without connecting additional brokerage users. Credential rotation
and secure multi-user architecture are mandatory before any broader test.
