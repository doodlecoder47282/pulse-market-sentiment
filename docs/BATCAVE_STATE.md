# Batcave checkpoint

Updated: 2026-10-01. This is a compact handoff, not a live-health certificate.

## Current objective

Latest authorized follow-up (2026-10-01): three-model council diagnosed
Trade Brief adapter exclusions, then bounded enrichment and opt-in AI
curation were implemented. Calculation `stock-brief-2026-10-01.2`; ATR14
simple mean, structure distances, NOT-RVOL full-day volume ratio and
matched-date yield spread; cached exact-attribution news, real-row earnings
and fresh raw Schwab option samples only. Visible reasons and evidence.
AI selects prewritten IDs from immutable server snapshots, cannot generate
new claims/numbers/verdicts; explicit click only, no automatic AI on lookup.
Isolated credentialed worker port5002, IPC-authenticated; main5000 remains
without model credentials. Persistent6/hour30/day attempt budget, no SDK
retries; runtime key/ledger in gitignored data/brief-ai/. 88 focused tests,
production build and live/manual AI succeeded; 59 unrelated TS errors remain.
See TRADE_BRIEF_ENRICHMENT_RELEASE.md and TRADE_BRIEF_QA_INVENTORY.md.
News can be missing, earnings cold until existing cache warms, options stale
after60seconds, holiday gaps suppress prior20volume; seasonality unsupported.
Research-only and NIST/multi-user security gates unchanged. Native/SPY paused.
Social provider evaluation favors a conditional authorized Neynar pilot;
its published quotas conflict, so actual entitlement must be checked.
No provider connected, account/subscription created or X reconnected.
Read SOCIAL_PROVIDER_EVALUATION.md; do not repeat council/provider research.

Latest follow-up (2026-10-01, morning ET): iterate the remaining social gap.
Added exact-contract Bluesky search plus separate unscored ticker context,
bounded source-post receipts, gated non-overlapping 10-minute activity
comparisons, fair four-mint sampling, cross-pool reuse and a 25-second batch
deadline. UI has social coverage and one-tap sample inspection; expired
counts/pace withdraw. Version `social-attribution-2026-10-01.1`; research score
`meme-research-2026-10-01.2`. Pump.fun denial still makes coverage partial;
X stays disabled. Farcaster considered but not added without verified live
node/index access. 77 tests and production build passed; 59 unrelated type
diagnostics remain. Real-response and fixture mobile/desktop QA passed.
See `CRYPTO_SOCIAL_ATTRIBUTION.md`; resume there without repeating audits.
No new accounts, credentials, paid sources, AI loops or native/forecast work.
Implementation `cc7dc02` deployed in place. Fresh opaque-iframe mobile touch
checks passed startup, Intel lookup and one-tap social inspection. At the
deployed checkpoint 16/131 tracked mints had current samples, with no exact
contract matches; this is not complete or validated social coverage.

Latest authorized repair (2026-10-01): crypto security, social and grading.
Implemented bounded eight-mint RPC batches, reviewed immutable Token-2022
metadata parsing, exact-match one-hour Bluesky samples, explicit pump.fun
403/cooldown without bypass, exact-pool/mint grading fallback, durable retry
and observation-gap/provenance fields, and coverage/idle UI disclosure.
Reliability `2026-10-01.1`, parser `mint-fields-2026-10-01.1`, research score
`meme-research-2026-10-01.1`. All 66 focused tests and production build pass;
59 existing unrelated TypeScript diagnostics remain. Real checks accepted the
reviewed Token-2022 subset and recovered reserve observations for four older
missing pools. Existing liquidity-collapse labels are sampled thresholds,
not proof of fraud or realized losses. Public-access denial and unsupported
contracts remain explicit gaps. See `CRYPTO_THREE_COMPONENT_REPAIR.md` for
scope and verification; do not repeat the full audit. No new accounts,
credentials, paid APIs, X reconnection, AI loops, ENTER promotion or native
build. iOS stays paused and SPY forecasts remain disabled.
Implementation commit `84bb9f6` deployed to the existing Batcave preview.
Fresh opaque-iframe mobile touch QA passed startup, Intel listing, crypto
coverage and outcomes; 390/1440px checks found no overflow or page errors.
Final runtime grading batch: 17 complete observations, none missing. Social
remains partially blocked by pump.fun, not fully repaired provider access.

Latest follow-up (2026-09-30, 23:27 ET): Find listing did nothing for Intel.
Reproduced zero requests for form submit inside the actual deployed opaque
iframe; standalone form worked but Intel was absent. Replaced native form
submission with explicit tap/Enter handlers and visible result/error status;
added canonical Intel Corporation/INTC to lookup and brief validation. 35 tests,
full production build and ten local browser scenarios passed. Same 59 old
TypeScript diagnostics. See `TRADE_BRIEF_SEARCH_REPAIR.md`; retain the curated
universe disclosure and explicit selection. No calculation/source expansion.

Latest follow-up (2026-09-30 ET): user reported blank screen/spinner. Startup
repair adds independent HTML recovery, committed-mount detection, root/lazy
error boundaries, optional-animation skip, dashboard mounting only after
acknowledgment, stylesheet deadline recovery, and a 15-second web snapshot GET
deadline with read-only retry. Reproduced the old permanent blank screen by
blocking LaunchSplash. 32 focused automated tests and 12 local Chromium
scenarios passed; frontend build passed; 59 unrelated TypeScript errors remain.
See `STARTUP_RELIABILITY_HANDOFF.md`. Update the same deployed app, never a copy.
Backend process was kept running; no provider warm-up/retraining. iOS remains
paused; the repaired SPY projection remains unavailable pending validation.

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

Follow-up authorized September 30: repair SPY's real-data feature pipeline
before any forecast. Implemented `spy-real-1m-2026-09-30.1`: provider-verified
session hours, contiguous completed one-minute SPY bars, dated prior-session
daily close, 17 explicit-unit features, one live/replay numerical core, hash-
deduplicated local snapshots and offline replay. The guarded API displays this
status but still returns no forecast or levels. Legacy SPX/synthetic models were
not retrained or reconnected. See the updated `SPY_PROJECTION_REVIEW.md`.

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

The SPY real-observation contract is now implemented and isolated from legacy
models. Its next bounded step is a paper-only, point-in-time dataset/label and
forward-validation harness, not forecast restoration. See
`SPY_REAL_PIPELINE_HANDOFF.md`: 50 focused tests, production build, live/replay
parity and desktop/phone checks passed; 59 existing type diagnostics remain.
Existing boot-time jobs can exhaust the shared provider budget temporarily;
the new path reports BLOCKED and recovered on a later manual check.
Meme Token-2022 support, vault identity and sell feasibility remain separate
future work. Preserve native iOS pause and research-only mode. Credential
rotation and multi-user security remain unresolved; successful isolated
Schwab reads do not certify continuous availability or entitlements.
