# Batcave: calculation, source, and script review

VERDICT: Improve trust in the existing outputs before adding more indicators.
The terminal already has substantial analytical breadth. The biggest missing pieces
are reliable freshness metadata, consistent units, genuine out-of-sample validation,
and a secure multi-user backend. Small correctness fixes are included in this review;
the remaining issues below are not silently represented as solved.

## Scope and limits

Reviewed on 2026-09-28 on `feat/capacitor-ios`. Static inventory scanning covered
330 tracked source/script files: 139 server, 152 client, 8 ML service, 4 iOS,
20 root, 3 build/maintenance scripts, 2 shared, and 2 test files.
See `REVIEW_INVENTORY.md` for the file-level inventory.

This was a bounded engineering review, not a line-by-line audit of every formula,
a penetration test, a live-provider entitlement test, or a profitability study.
Manual inspection focused on crypto collection/grading, position sizing, Greek
primitives and time units, target derivation, chain freshness, scenario weights,
source adapters, startup/restore scripts, and mobile/security boundaries.
Inventory tags and hosts include lexical matches and comments; they do not prove
that a source currently works. No new provider accounts or paid subscriptions
were created. Tests use isolated fixtures, not live trading or brokerage requests.

## Correctness fixes made

| Area | Confirmed issue | Change |
|---|---|---|
| Crypto audit totals | Combining a full-table count with a latest-100 outcome sample could overstate graded history. | Outcome totals now aggregate the entire table; the visible signal list remains capped. |
| Crypto calibration claim | A sample count of 50 was treated as calibration. | Separate `sampleThresholdMet`; `calibrated` remains false until an actual validation process exists. |
| Social data quality | Failed collection could become zero activity with a fresh timestamp. | Attempt time and successful observation time separated; pending/partial/unavailable/stale states explicit; old data expires. |
| FOMO weighting | Missing social sources could penalize the score as if observed activity were zero. | Partial or failed social coverage does not reweight FOMO. A valid zero remains different from missing data. |
| Crypto rejection explanation | Active mint/freeze authority could trigger a kill without its explanation being selected. | Include the authority reason in the displayed hard-kill explanation. |
| Crypto peak tracking | Grader read `peak_at` without selecting it. | Select the stored peak timestamp so it can be preserved. |
| Position sizing | A below-minimum target was raised before its rejection check; invalid inputs and premium outlay needed guards. | Preserve/reject low targets, reject nonfinite inputs/negative stops, and cap purchased premium at the supplied cash budget. |
| Scenario arithmetic | Bull and bear weights could sum above 100. | Normalize finite, nonnegative bull/base/bear weights to 100. This does not calibrate them. |
| Target provenance | Proxy backtest language could imply historical dealer-chain validation. | Label historical price/volatility proxy touch rates and their limits explicitly. |
| Decision-support route | `formatDecisionBlock` was used without an import. | Import the existing formatter. This repairs the reference, not its investment assumptions. |
| Discord card | Duplicate `mainPivot` object key. | Remove the duplicate, preserving the same display label. |
| Restore/reseed | Restore could delete a non-repository folder; synthetic reseed could contaminate production-shaped data. | Restore fails rather than deleting, pulls the selected branch with `--ff-only`; reseed requires explicit opt-in and a separate existing test DB, rejecting `data.db`. |
| Mobile viewport | Safe-area CSS lacked viewport cover; zoom was constrained. | Add `viewport-fit=cover` and remove `maximum-scale=1`. |
| TypeScript configuration | Compiler target caused downlevel iteration diagnostics. | Set ES2022. Do not confuse disappearing configuration errors with repaired business logic. |

Relevant code: `server/cryptoAuditStats.ts`, `server/cryptoEngine.ts`,
`server/positionSizer.ts`, `server/scenarioWeights.ts`, `server/tickerOutlook.ts`,
`server/targetDerivation.ts`, `server/routes.ts`, `server/discordBatcaveCard.ts`,
`client/src/components/CryptoPanel.tsx`, `client/index.html`, `RESTORE.sh`,
`scripts/reseed.cjs`, and `tests/calculation-review.test.ts`.

## Highest-priority work still missing

### Data freshness is a release gate

`server/cboeCache.ts` permits a stale fallback for up to seven days.
`server/cboeChainAdapter.ts` stamps an adapted chain as approximately
15 minutes delayed using the current clock. The cache entry's age is not carried
through that contract. A much older observation can therefore appear only
15 minutes delayed.

Fix this before trusting live alerts: preserve provider observation time,
fetch time, cache age, and fallback reason end to end. Add a freshness gate to
every consuming model and alert. An HTTP response received now is not necessarily
market data observed now. A closed-market quote also needs session context.

### Charm and time units need a deliberate correction

`server/models.ts` references `cur.charmPerDay`, which is absent from the
exposure-point contract. The fallback can reduce this input to zero and leave
the base target at spot. The available `charm` field is an aggregate exposure,
not automatically a price drift. Blindly renaming it would conceal a units bug.

Document each quantity's units before changing this path: per-share Greek,
contracts, multiplier, dollar exposure, percent move, price points, and time basis.
The Greek engine uses a trading-year convention while exposure time is derived
from calendar time with rounding/floors; charm also uses a daily conversion.
Near-expiry options need actual minutes to expiration and a consistent convention.
The passing Black-Scholes tests below do not validate that downstream time mapping.

Pivot selection is also duplicated between `masterAlpha.ts` and `pivots.ts`,
with differing level coverage. Consolidate the level contract, document the
chosen Camarilla variant, and test the Fibonacci level set before presenting
the two surfaces as equivalent calculations.

### Calibration must match the outcome being promised

`targetDerivation.ts` consumes historical price/volatility proxy level touches,
then maps that evidence to current named levels. This is not a reconstruction
of historical dealer positioning or evidence that the live option trade wins.
Distance-adjusted percentages are heuristics, not fitted conditional probabilities.

Before promoting those outputs to tradeable odds:

- **Prediction ledger:** Freeze input data, source times, model version, direction,
  horizon, target, invalidation, and uncertainty at prediction time.
- **Chronological holdouts:** Keep training, threshold selection, and final evaluation
  separate; prevent overlapping event windows from leaking across boundaries.
- **Effective sample size:** Report dependence, cohort counts, missing observations,
  confidence intervals, and regime coverage, not only total rows.
- **Calibration:** Compare predicted probability with the exact settled event.
  Include reliability bins, Brier score, and a simple baseline.
- **Execution:** Include bid/ask, fill rules, fees, slippage, latency, stop gaps,
  liquidity, and drawdown. Underlying touching a level is not an option return.

Related paths include `backtest.ts`, `targetDerivation.ts`, `gradeCalibration.ts`,
`odteAlertEngine.ts`, and `decisionSupport.ts`. Multiple sizing/decision surfaces
should resolve to one documented risk authority rather than display unrelated
Kelly-style percentages.

### Crypto outcomes and social coverage are still incomplete

The grader selects the newest 60 open signals. Older open records can starve
when new discovery volume is high. Add a last-checked cursor or due-work queue,
bounded retries, and an explicit unobservable outcome rather than preferentially
grading what is easiest to fetch.

Zero liquidity is also vulnerable to `Number(value) || null` treatment, and the
holder calculation excludes the largest account without proving it is a pool
vault. Verify account identity and token controls rather than describing a
heuristic as verified safety. Some flow and FOMO components reuse correlated
inputs; two successes across three short overlapping polls are not independent
confirmations.

Bluesky queries return at most 25 posts in the inspected path and use cashtags.
Ticker collisions, bots, repeated authors, incomplete pagination, and sampling
caps prevent treating the result as comprehensive token-specific velocity.
Pump reply counts are limited attention proxies. Neither establishes X or
Telegram coverage. Previously observed 403s do not prove a permanent platform-wide ban.

### Multi-user security remains blocked

The mobile owner-token gateway is not a user-account system and does not secure
legacy `/api/*`. The existing shared Schwab token row, token storage, OAuth
state binding, authorization, and logging need a separate remediation workstream.
Previously exposed brokerage client credentials must be rotated by the owner;
removing them from the current file does not revoke copies in repository history.

Treat NIST as a control/evidence framework, not a badge obtained by building an
app: use a documented risk profile and development controls, then collect test
evidence for the selected requirements ([NIST CSF](https://www.nist.gov/cyberframework),
[NIST SSDF](https://csrc.nist.gov/pubs/sp/800/218/final)).
This review makes no NIST-conformance or “fully secure” claim. See `../SECURITY.md`.

## Source map: code presence versus actual coverage

| Feed family | Inspected path | What to tell the user |
|---|---|---|
| Equities/options | Schwab modules and wrappers | Primary intended source; a wrapper does not prove current authentication or options entitlement. |
| Options fallback | CBOE cache/adapter | Delayed fallback with an unresolved cache-age labeling issue. Do not call it live. |
| Crypto discovery/market activity | GeckoTerminal/DexScreener paths in `cryptoEngine.ts` | Public discovery/liquidity/transaction proxies; not consolidated exchange coverage. |
| Crypto social | Bluesky and pump paths | Limited sampled attention; source status is now explicit. |
| X voices | `server/x.ts`, voices integration | An optional X v2 client already exists with credential gating. It is not proof of an active, comprehensive crypto-velocity feed. |
| News/macro | Source, news, macro, FRED/COT/economic-calendar modules | Mixed adapters and derived interpretation; add consistent observation times and attribution to outputs. Not all endpoints were live-tested. |
| AI interpretation | `masterAlpha`, `tickerOutlook`, `edgeLabBrief`, `alphaNews`, routes | Separate generated interpretation from measured facts. Numeric scenario weights are not automatically empirical probabilities. |
| Yahoo wording | Legacy naming and external links | Some legacy names/links remain; the inspected legacy quote wrapper routes to Schwab. A Yahoo news link is not proof of Yahoo price ingestion. |
| ML service | Eight files inventoried | Presence of training/inference code does not establish current model availability, holdout quality, or live accuracy. Further model-specific review is needed. |

More feeds can broaden coverage, but they cannot repair ambiguous identifiers,
stale timestamps, biased grading, or uncalibrated weights. Add a new social source
only with its access permission, symbol/entity mapping, timestamp contract,
deduplication, failure state, and measured incremental value.

## Presentation improvements worth doing next

Every actionable card should show a compact evidence strip:
`source | observed time | age | live/delayed/proxy | sample size | model version`.
Separate four concepts: measured input, derived statistic, heuristic score,
and validated probability. A number on a 0–100 scale is not necessarily a probability.

Show PASS when a required input is stale or absent, with the exact failing gate.
Report spread and liquidity alongside any option target. Make “historical touch
rate” and “net realized return” visibly distinct. Preserve the existing tab order;
this needs better labeling and shared contracts, not a visual redesign.

## Verification and local sample snapshot

- **Regression tests:** Six calculation/source-health groups pass: full-table
  crypto totals, scenario normalization, Black-Scholes parity/derivatives/IV
  round trip, failed/partial/stale social collection, winter/summer ET conversion,
  and sizing validation/cash caps.
- **Mobile tests:** Three existing gateway/session/rate-limit groups pass.
- **Numerical limits:** Greek tests use three spot levels around one strike and
  a moderate expiry, with a documented tolerance for the approximate normal CDF.
  Extreme strikes, 0DTE time mapping, and higher-order Greeks are not comprehensively certified.
- **Builds:** Web/server build, native frontend build, and Capacitor iOS sync pass.
  A transpiling build is not a clean TypeScript check.
- **TypeScript:** 59 diagnostics remain after target correction and two small
  reference/key fixes, versus 182 before this review. Most of that reduction
  is compiler configuration, not 123 repaired calculations.
- **Scripts:** Shell syntax checks and reseed syntax check pass; restore/reseed
  were not executed against production. Older start/watchdog scripts are not
  the recommended iPhone setup path.
- **Dependency risk:** The preceding mobile review reported 15 dependency
  findings, including five high severity. This pass did not remediate or re-audit them.
- **Native limits:** No Swift compilation, signing, physical iPhone test, or live
  gateway setup occurred in this Linux workspace.

Read-only inspection of this workspace database found 94 crypto signals:
68 OPEN and 26 terminal outcomes (19 RUGGED, 5 DEAD, 1 DOUBLED, 1 HIT_5M).
The checked valid, graded, non-rejected 0DTE alert pool had zero rows.
No synthetic-prefix prediction rows were present in the checked table.
These are local snapshots, not claims about every deployment or a fresh live feed;
they do not establish returns, calibration, or absence of synthetic data elsewhere.

## Credit-conserving next sequence

Keep `AGENTS.md` and `BATCAVE_STATE.md` as the resume contract. Use deterministic
tests and the inventory rather than rereading the entire chat or repeatedly
running a full audit. No recurring AI monitoring or additional provider account
is needed for the fixes described here.

Computer usage and the app's own paid-provider calls are different cost surfaces.
Some GET endpoints can run AI interpretation; read-only does not mean cost-free.
Before wider use, add provider-level budgets/quotas, request deduplication,
cache keys and TTLs, and explicit on-demand generation. Existing local caches
do not prove a global cost ceiling. No exact credit estimate is promised.

Recommended next implementation objective: repair the CBOE freshness contract
and fail-closed alert gates. In parallel with that decision, the owner can follow
`XCODE_GUIDE.md` to run the already-generated setup screen locally, without
adding brokerage credentials or opening the server to other users.
