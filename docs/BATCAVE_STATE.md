# Batcave checkpoint

Updated: 2026-09-28. This is a compact handoff, not a live-health certificate.

## Current objective

Save the credit-conserving resume framework and assess reuse of the existing
GitHub app for iOS. No native implementation or new deployment authorized in
this checkpoint.

## Verified this session

- Repo: `doodlecoder47282/pulse-market-sentiment`.
- Local and remote `main` matched `1e9028809e371b73233ac33680db5b58692264ec` before this documentation change.
- GitHub reports PUBLIC visibility, contrary to older private-repo assumptions.
- Existing stack: React/Vite client, Express/Node server, SQLite/Drizzle.
- No tracked Swift, Xcode project, or Capacitor configuration was found.
- API transport uses the preview-specific `__PORT_5000__` mechanism. It needs an explicit secure backend URL and auth design for a bundled native client.
- Unrelated runtime changes exist in scheduler state and database/session files. They must not be staged with these docs.
- No runtime build, native build, or fresh market-feed validation was performed for this documentation-only task.

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

Proposed: bundled React UI through Capacitor plus the existing separately hosted
backend. Keep polling, SQLite, brokerage credentials, and grading on the server.
Do not simply point a released app at a temporary Computer preview.

Before implementation: confirm Mac/Xcode access and whether the first target is
personal-device use or TestFlight/App Store distribution. Choose persistent HTTPS
backend hosting, per-user authentication, origin policy, and OAuth redirect flow.

## Next step

Ask the user whether they have access to a Mac with Xcode and want personal-device
testing first. Resolve exposed credentials before broad distribution. Do not
start an iOS rewrite or unattended AI monitor while waiting.
