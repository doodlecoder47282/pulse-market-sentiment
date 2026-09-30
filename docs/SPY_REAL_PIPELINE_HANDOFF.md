# Batcave: SPY real-data feature pipeline

September 30, 2026. This release repairs data preparation and numerical feature
definitions. It does not retrain a model, restore a forecast or establish trading
accuracy. Native iOS remains paused.

## What changed

The guarded SPY route now consumes only its own real one-minute inputs.
Legacy SPX feature builders, synthetic trainers, snapshot-price substitutions
and fixed SPX-to-SPY conversion are not dependencies.

- **Session:** Exact-date Schwab equity regular-session hours, including a
  provider-declared early close. Missing calendar days are unknown, not assumed
  holidays. Halt status is not available.
- **Quote:** Exact SPY identity, USD-compatible fields, explicit realtime flag,
  positive finite price and last-trade age under 60 seconds. Receipt time cannot
  refresh stale provider data.
- **Bars:** Completed one-minute regular-session OHLC with positive finite
  prices, valid ranges, nonnegative or explicitly missing volume, no duplicates,
  future bars, off-grid times or missing intervals from the open. Forming bars
  are excluded, and no interpolation is permitted.
- **Prior close:** Daily OHLC whose date equals the preceding provider-open
  session. The history response's generic previousClose and intraday penultimate
  close are not used. Missing prior close leaves gap features null.
- **Features:** Seventeen versioned definitions with explicit units, warmups and
  null reasons. No missing-as-zero inputs, annualization ambiguity, daily ATR
  approximation, unfrozen morning denominator or mislabeled five-minute count.
- **Persistence:** Additive local SQLite table `spy_real_feature_snapshots`,
  storing normalized inputs, receipt/cutoff times, version, hash and feature
  output. Same content is deduplicated; changed inputs are retained separately.
- **Replay:** Live calculation and offline replay call the same pure function.
  Stored rows are hash checked and their feature values must match exactly.
- **UI:** Models shows input status, observation cutoff, prior-session date,
  archive state, feature values, units and definitions. Expired snapshots withdraw
  numerical cards. Forecast/levels remain unavailable, including when READY.

The provider API distinguishes history intervals, optional previous-close
metadata and date-specific market hours; this implementation also checked the
actual existing authenticated response schema rather than inferring fields
solely from a wrapper ([unofficial schwab-py client documentation](https://schwab-py.readthedocs.io/en/latest/client.html)).

## Contract and calculations

Contract: `spy-real-1m-2026-09-30.1`. The machine-readable definitions live next to
the pure implementation in `shared/spyFeatures.ts`; this is a new contract, not
backward-compatible input for a stored legacy model.

| Family | Definition and boundary |
|---|---|
| Returns | Log close-to-close sums over five or thirty 1m transitions; six or 31 completed closes required. Not percentages. |
| Realized volatility | Square root of the sum of squared 1m log returns in the named window. Not sample standard deviation of a single return and not annualized. |
| ATR14 | Arithmetic mean of fourteen actual one-minute true ranges, requiring fifteen bars. USD/share; not Wilder smoothing or daily ATR. |
| Gap | Session opening price divided by exact prior-session close, minus one. Raw provider-price basis; corporate-action treatment unverified. |
| VWAP proxy | HLC3 multiplied by each bar's share volume, divided by total volume. Missing volume or zero total makes it null. Not trade-level VWAP. |
| Morning anchor | First fifteen completed one-minute bars. High/low/anchor close and ATR14 denominator freeze at the anchor. Minutes since anchor use completed minutes. No whole-day future-volume normalization. |

Five-minute observed candles are aggregated from the same validated one-minute
bars used for features, not fetched or generated independently.

## QA inventory and results

Acceptance inventory: live provider identity/age/session checks; analytical
feature fixtures; missing/zero inputs; malformed/future/duplicate/gapped bars;
holiday/weekend/DST/early-close cases; unchanged earlier rows when later bars
change; frozen morning features; archive dedup/revisions/read-only failure;
exact replay; no route/model activation; UI loading/READY/PARTIAL/BLOCKED/expired/
error states, manual refresh, keyboard detail expansion and desktop/phone fit.

- **Automated:** 50 focused regression groups passed, including 13 SPY groups.
  Existing crypto, calculation, mobile-boundary and stock-brief groups are
  included. Test fixtures are isolated and not inserted into the production DB.
- **Build:** Production client/server build passed; bundle-size warnings remain.
  Existing whole-repository TypeScript debt remains 59 diagnostics, with none
  reported in the repaired feature files.
- **Live input:** An in-session probe accepted 379 completed SPY one-minute bars,
  with the September 29 daily close and no missing feature values. This is one
  data-integrity observation, not model validation or market advice.
- **Archive/replay:** That live snapshot was stored and the offline command
  reproduced all its saved feature values exactly. A local SQLite file alone
  does not establish always-on persistence or disaster recovery.
- **Browser:** Integrated Chromium checks at 1440px and 375px passed real READY
  rendering, keyboard feature expansion and manual refresh. Expiry withdrew
  numeric cards. A browser-only PARTIAL fixture preserved null gap/prior-close
  values and their reasons; error/legacy-contract rejection was also checked.
  No page errors or feature-region horizontal clipping were found. Dark/light
  checks and source-state changes did not enable a forecast.

The first restarted-server read was BLOCKED because existing boot-time jobs
used the shared Schwab request budget before calendar data loaded. A later
manual check recovered to READY with 382 completed minutes, archived successfully,
and both saved live snapshots replayed exactly. This transient is disclosed,
not hidden by bypassing provider limits. Provider scheduling across legacy
modules remains a separate operational reliability issue.

## Reuse without repeated research or AI cost

The route uses shared provider caches, a 30-second maximum response cache,
single-flight reads, an eight-second response deadline and a retained provider
slot after timeout. Calendar lookup is bounded to today plus ten days, stopping
at the previous verified open session. Normal weekdays require two calendar
dates; no new provider account or subscription is needed.

The UI performs an initial read on mounting and manual checks only. No AI calls,
background model polling, new scheduler, automatic training or unattended data
collection was added. Existing unrelated schedulers remain unchanged.

Run offline replay from the application directory:

```bash
npx tsx scripts/replay-spy-features.ts
```

The command opens the existing database read-only, validates stored input hashes,
and emits JSONL with feature values and missing masks. It emits no labels and
does not invoke training. Optional argument: path to an isolated database copy.
The pure prefix-replay helper is for parity tests and retrospective research;
later-retrieved bars must not be described as historically available at the time.

## Still required before any forecast

- **Dataset:** Enough independently observed point-in-time snapshots, with a
  declared eligible universe, missingness policy, corrections and retention.
  Today's archive is not a substitute for historical event-time records.
- **Target contract:** Defined forward horizon, label availability, overlapping
  windows, leakage controls and chronological train/validation/holdout splits.
- **Model validation:** Compare against simple baselines, including no-change;
  measure error, stability and quantile coverage where applicable. Neither
  READY nor successful replay is a predictive-accuracy result.
- **Additional inputs:** Native-SPY chain/level provenance only if the declared
  model requires it. VIX, dealer features and volume z-scores were omitted rather
  than populated with default zero or synthetic values.
- **Market semantics:** Halt/exceptional-session handling and corporate-action
  adjustment policy need separate verification.
- **Operations/security:** Current legacy provider helper may serve stale cached
  payloads during throttling; consuming quote/bar gates reject stale inputs.
  It cannot cancel underlying reads, so the pipeline retains that occupied slot.
  Credential rotation and multi-user isolation remain unresolved.

Forecast restoration remains a separate review and explicit release decision.
