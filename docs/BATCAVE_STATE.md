# Batcave checkpoint

Updated: 2026-09-30. This is a compact handoff, not a live-health certificate.

## Current objective

Latest completed request (2026-09-30): created the staged implementation checklist
at `docs/INSTITUTIONAL_IMPLEMENTATION_CHECKLIST.md` and the stock/crypto quick-search
AI Trade Brief specification at `docs/TRADE_BRIEF_SPEC.md`. Planning only: no new
integrations, scoring changes, subscriptions, migrations or deployment.
Every implementation item requires evidence before being marked complete.
The proposed next task is S0 baseline/boundary verification, followed by
S1-A/S1-B scoring isolation and duplicate-factor correction. Await an implementation
request; do not automatically execute the entire roadmap.
Trade Brief should aggregate applicable existing calculations into an evidence-bound
responsive phone/desktop output; native iOS remains paused.
X connector was dismissed: do not request it again without an explicit request.
Yahoo Finance NEWS is allowed; the no-Yahoo equities PRICE-feed constraint remains.
No new paid services, provider accounts or continuous AI monitoring were enabled.

Latest direction (2026-09-29): iOS/Xcode is PAUSED by the user.
Targeted crypto reliability repair is implemented and running in this workspace
with version `2026-09-29.1`; see `CRYPTO_RELIABILITY_HANDOFF.md`.
Additional gold-thesis coverage review is in `GOLD_SIGNAL_COVERAGE.md`.
Do not resume iOS without a new request. Its existing guide remains the handoff.

User authorized the Capacitor iPhone build and confirmed Mac/Xcode access.
First milestone is implemented on `feat/capacitor-ios`: bundled native shell,
read-only authenticated gateway, and Xcode source. User additionally requested
NIST-oriented multi-user security; that is a BLOCKED release requirement, not
implemented multi-user support. Read `SECURITY.md` before extending access.

The subsequent bounded source/calculation review is complete. Read
`docs/BATCAVE_REVIEW.md` for fixed versus unresolved findings and
`docs/XCODE_GUIDE.md` for the complete Mac walkthrough. Do not repeat the entire
review on resume; follow the current checklist and newest approved objective.

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
- Nine focused test groups pass: six calculation/source-health regression groups
  plus URL/session validation, gateway auth/routing, and rate limiting.
  Browser checks previously passed for setup/validation/401/fixture-login/
  disconnect/offline at 375 and 1280 widths, without page errors or horizontal overflow.
  This review rechecked setup viewport/HTTPS rejection/401 at 375 and 1280.
- Whole-repo TypeScript check still fails with 59 diagnostics after setting
  ES2022 and fixing a missing formatter import and duplicate object key.
  The earlier 182 count is obsolete; most of the reduction is configuration,
  not repaired business logic. The previous dependency audit reported
  15 findings (5 high); not re-audited or remediated this pass.
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

## Review fixes and remaining issues

Do not repeat prior “all green means complete coverage” claims:

- Fixed full-table crypto totals, false sample-count calibration flag,
  social failure/partial/stale handling, authority hard-kill reason, and peak timestamp.
- Fixed sizer target validation/nonfinite values/negative stops/cash cap,
  scenario weight normalization, and proxy target methodology labels.
- Restore no longer deletes nongit folders; synthetic reseed requires explicit
  opt-in and a separate existing test DB. Neither was run against production.
- Added 330-file lexical inventory plus six isolated calculation tests.
- Bluesky queries use cashtags and at most 25 returned posts. Common words/ticker
  collisions, sampling caps, repeated authors, bots, and incomplete pagination
  prevent interpreting these counts as comprehensive token-specific velocity.
- Pump reply count and linked socials are limited attention proxies, not coverage of X or Telegram.
- Holder concentration blindly excludes the largest account as a pool heuristic.
  That account is not verified as a vault; do not describe the remainder as verified ex-pool ownership.
- Calibration remains false; sampleThresholdMet does not authorize staking.
- Newest-60 grader selection can starve older open records. Zero liquidity,
  authority unknown-state display, holder identity, and correlated scoring need review.
- Previously observed 403 responses do not establish a permanent platform-wide ban or prove the cause.
- CBOE cache can serve up to seven-day stale data while adapter stamps 15-minute lag.
  Preserve real provider/fetch/cache timestamps and fail closed at consuming alerts.
- Models references nonexistent charmPerDay; existing charm has different units.
  Do not blindly rename it. Resolve price-drift mapping and expiry time conventions.
- Proxy touch rates and LLM scenario weights are not validated trading probabilities.
- This workspace snapshot had 26 terminal crypto outcomes and zero valid graded
  non-rejected 0DTE fires; do not claim calibrated execution returns.
- Optional X client already exists in server/x.ts/voices, separate from crypto social.
- Backend fixes are built/source-controlled, not proof of a restarted live engine.

## iOS direction

The bundled shell opens on a setup screen and mounts the existing terminal only
after `/api/mobile/health` authenticates. Mobile writes and broker-management
routes are denied. Read-only source status is redacted. The gateway is disabled
unless `BATCAVE_MOBILE_TOKEN` is configured. It is NOT multi-user authentication.

Keep legacy `/api/*` inaccessible from a public mobile proxy. Current shared
Schwab token row `id=1`, unencrypted token writes, missing OAuth state binding,
and broad response logging block multi-user release. See `SECURITY.md`.

Read `docs/XCODE_GUIDE.md` for complete Mac commands and deployment boundaries;
`docs/IOS_QA.md` for evidence and remaining device tests. Do not use a preview
URL as the mobile backend or embed brokerage credentials in any mobile artifact.

## Next step

Latest request: final Xcode-readiness verification. Completed a clean-source
Node 22 install, native build/sync, all nine tests, parsed project/SPM/plist/icon/
asset checks, and added a shared App scheme plus `ios:preflight` and `ios:verify`.
The native build now targets Safari 15 instead of Vite's newer default.
All 36 output files match the synced Xcode assets. No native compiler exists
in this Linux workspace; do not claim Debug/Release have compiled.
Fresh install still reports 15 dependency vulnerabilities, including five high.

The Mac commands above are a paused handoff, not the active next step.
Crypto now uses fair bounded grading, observation-window validity, explicit
UNOBSERVABLE outcomes, immediate recovery health, single-flight engines,
and stale-candidate PASS gates. Fifteen focused test groups pass.
The first post-repair snapshot: 102 total, 16 open, 59 unobservable, 27 graded.
Do not count unobservable rows as wins or losses; calibration remains false.

Older proposed objective, superseded by the current checklist unless re-requested: restore stock/macro
data authentication/freshness and implement a transparent gold confirmation
panel. Current Schwab status requires reauthentication; missing real-yield/
breakeven inputs and stale GLD/oil bars prevent confirming the supplied gold thesis.
Historical CBOE freshness, charm units, credential rotation and multi-user
architecture remain unresolved release blockers.

Current next proposed action: S0 baseline/boundary verification in
`INSTITUTIONAL_IMPLEMENTATION_CHECKLIST.md`. Preserve all native iOS work as paused.
Checklist and Trade Brief specification were reviewed as documents only; no tests,
build, runtime verification or security sign-off was performed for this planning turn.
