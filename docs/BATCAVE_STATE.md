# Batcave checkpoint

Updated: 2026-10-08. This is a compact handoff, not a live-health certificate.

## 2026-10-08: quant-fixes branch (PR to main)

Completed objective: apply the 37 fixes from the quant code review (Claude Doc
"Batcave Terminal - Quant Code Review"), with the user's priorities: Schwab is
always connected (no backup-data work: F1.1 and F12.3 dropped), and every
output, above all every dollar figure, must be accurate for any account size.
Cosmos kept as a tab with all trade instructions removed.

How: five workstream agents (data/time, options math, statistics,
validation/sizing/ML, labels/security), each reviewed by another, then an
integration pass (one expiry clock), a money-math audit of every $ output, and
an independent verifier that had not seen the work.

Evidence:
- Verifier: 33 of 37 DONE, F8.1 and F9.1 PARTIAL (no historical option chains,
  not enough real ML data yet; both relabeled and gated), F1.1 and F12.3
  dropped by the user. Five dollar checks match an independent Python
  recomputation (GEX per 1%, sizer at the ask with fees, 0DTE charm to
  settlement, theta to the close, Wilson and Kelly).
- Quant tests: 164 pass, 0 fail (`tests/quant`, run in CI and locally).
- CI (`.github/workflows/quant-fixes.yml`, report on branch
  `ci-reports-quant`): build passes; all 121 GET routes return the same status
  as main; no runtime errors; tsc error count checked per file vs main.

Visible behavior changes: sizers show 0 contracts until the new option-P&L
ledger has evidence; whale and 0DTE track records restart on real option
marks; many "calibrated" labels now read "not tested" or "no demonstrated
skill"; OU band and seasonal windows usually read "not significant"; Discord
cards are off until `PULSE_DISCORD_*` env vars are set; a public bind without
`BATCAVE_ACCESS_KEY` returns 503 on /api (override `BATCAVE_ALLOW_OPEN=1`).

Blockers (user action):
- Revoke and regenerate the Discord webhooks and the Schwab app secret: they
  are in public git history. Merging does not remove them.
- History cleanup is a destructive rewrite: only with explicit approval.

Known risks / not verified: live Schwab fields (settlementType, quoteTime on
$VIX, vega units), the SPX exchange fee (sizer requires it for index roots),
EOD brief still has hard-coded default weekly targets in routes.ts,
`data/greek_gradient.db*` still tracked.

Next step: user reviews and merges the quant-fixes PR.

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
