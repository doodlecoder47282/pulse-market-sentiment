# Batcave checkpoint

Updated: 2026-09-30. This is a compact handoff, not a live-health certificate.

## Current objective

Latest authorized combined request (2026-09-30): improve the sparse crypto
screen and missing-data quality, delegate stock lookup, and audit/fix the
misleading SPY projection. Implemented in one existing-app release:

- Six-group crypto desk with candidate inspection, BTC/ETH context, news/macro,
  source coverage and observational outcomes. Public Coinbase/Deribit/DefiLlama
  context plus shared CoinDesk/The Block/Decrypt/Yahoo/Fed/BLS headline adapters.
- Exact-pool liquidity fallback, zero/null distinction, no FDV-to-cap substitution,
  explicit SPL program/authority parsing, unsupported/PASS gating, unfiltered
  largest-account share disclosure and sampled-author social evidence.
- Score version `meme-research-2026-09-30.2`; no ENTER promotion or staking.
- Stock/ETF lookup and manual deterministic brief. AI, full news/options/
  earnings/seasonality integration, actionable levels and sizing are NOT complete.
- Old SPY synthetic generator physically removed; forecast and dealer levels
  withheld. Only bounded verified observations may be shown. Predictive accuracy
  remains unestablished. Trainers and other ML paths were not repaired.
- 45 focused test groups pass; production build passes; 59 existing TypeScript
  diagnostics remain, none in the added/modified feature files. Browser QA
  includes real responses, mobile expanded-card clipping repair, outage/recovery
  and expired-context withdrawal. See `CRYPTO_DESK_RELEASE.md`.
- Read `CRYPTO_DESK_DATA_REVIEW.md`, `SPY_PROJECTION_REVIEW.md` and
  `TRADE_BRIEF_STOCK_HANDOFF.md` before resuming; do not repeat this full audit.

Native iOS stays paused. No new accounts, paid sources, X reconnection or AI
monitoring were added. Source quantity is not validation or institutional readiness.
The unresolved security blockers below still apply.

Previous authorized request (2026-09-30): queued visual edit for persistent tabs,
restrained iOS-style glass, and moderately larger desktop typography.
Implemented in dashboard.tsx/index.css with measured border-box header offset,
sticky desktop dock, fixed mobile dock, active-tab centering on resize,
deep-switch scroll reset and accessibility fallbacks.
Build passed; 59 pre-existing TypeScript diagnostics remain, none in dashboard.
Bounded Chromium QA passed at 375/390/820/1024/1440/1920px, including themes,
keyboard selection, internal overflow, deep scroll and header-height stress.
See `docs/UI_GLASS_NAVIGATION_HANDOFF.md`. Update the existing Batcave app at
`sentiment-app/dist/public`, not a copy. No native assets, providers, calculations,
brokerage settings or scoring changed. Native iOS remains paused.

Previous authorized request (2026-09-30): start the meme-coin area and clarify
reuse of existing level calculators. First bounded scoring foundation implemented:
`meme-research-2026-09-30.1`; see `docs/MEME_SCORING_HANDOFF.md`.
Flow is counted once, sampled social is separate, name/keyword/promotion bonuses
are removed, missing inputs stay unknown, and revised candidates are WATCH/PASS
only pending validation. Risk fields are labeled illustrative scenarios, not
calculated price levels or verified executable size. Newly inserted audit JSON
contains score version/breakdown/replay inputs; full immutable snapshots remain future work.
20 focused test groups and the production build pass; 59 old TypeScript
diagnostics remain. Desktop/375px browser QA passed using live policy/health
and isolated labeled fixtures for WATCH/stale details. Runtime restarted;
social and grader remain degraded. No provider accounts or paid feeds added.
Checklist: `docs/INSTITUTIONAL_IMPLEMENTATION_CHECKLIST.md`.
Trade Brief specification: `docs/TRADE_BRIEF_SPEC.md`; now partially implemented
for a finite stock/ETF universe, without AI or actionable trade plans.
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
- Former largest-account exclusion was removed in the September 30 desk release.
  Raw top-ten account share includes the largest and is not scored. Vault and
  beneficial-owner identity remain unverified.
- Calibration remains false; sampleThresholdMet does not authorize staking.
- Fair bounded grader selection was repaired in the September 29 reliability pass.
  Zero liquidity and authority unknown-state handling were tightened September 30.
  Verified ownership, sell feasibility and outcome execution semantics remain gaps.
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

Earlier paused milestone: final Xcode-readiness verification. Completed a clean-source
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

Next bounded choice: either restore SPY with a real-observation, instrument/unit
validation contract, or extend meme evidence with Token-2022 support, verified
vault identity and read-only sell feasibility. Do not activate predictions,
execution or full-roadmap scope without validation. Preserve native iOS pause
and research-only mode. Credential rotation and multi-user security are unresolved;
successful isolated Schwab reads do not certify continuous auth/entitlements.
