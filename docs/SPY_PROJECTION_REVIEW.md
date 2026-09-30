# SPY projected path — bounded correctness review

Decision: **the former display was not a reliable decision aid**. It could present
simulated history, unvalidated mixed-instrument levels/features and a FLAT badge
without a forecast. The old path remains disabled. The September 30 follow-up
repairs the real-data feature foundation only; no forecast has been restored.

## Real-data feature pipeline repair

Implemented after the containment review:

- Added an exact-symbol, exact-currency SPY contract at
  `shared/spyFeatures.ts`, version `spy-real-1m-2026-09-30.1`. It accepts only
  completed, contiguous one-minute Schwab regular-session OHLC, a recent
  explicitly real-time quote, provider market hours and separately validated
  daily OHLC for the prior provider-open session.
- Provider market-hours responses establish the actual open/close. Weekdays,
  holidays and early closes are not guessed. Halt status remains unverified.
- Removed the prior-close ambiguity from this path. The response-level
  `previousClose` field is not consumed because it can describe the beginning
  of a requested multi-day history window. The prior close must be a daily bar
  whose date equals the preceding provider-declared open session.
- Defined 17 versioned SPY features with explicit units and warmups. Five- and
  30-minute returns and volatility use one-minute close-to-close log returns.
  Volatility is square-root sum of squared returns and is not annualized.
  ATR14 is mean one-minute true range across 14 transitions. No single-return
  sample-standard-deviation zero, daily approximation or silent floor.
- Morning features use the first 15 completed one-minute bars. Their high, low,
  anchor close, ATR denominator, range and drive freeze at 09:45. The live
  elapsed value is minutes, not a count of five-minute bars.
- VWAP is explicitly labeled an HLC3 bar-volume-weighted proxy. Any missing bar
  volume or zero aggregate volume leaves it null; it is not called trade VWAP.
- `calculateSpyFeatures` is the only numerical implementation used by live and
  replay. It has no network, wall clock, random generator or model dependency.
  Prefix-invariance tests prevent future bars from changing an earlier row.
- Added a hash-deduplicated local SQLite archive of normalized inputs and feature
  output plus an offline read-only JSONL replay command. It is an additive local
  research record, not an immutable external audit ledger or historical backfill.
- The guarded API and Models panel display feature status, contract version,
  units, missing reasons and archive status. Five-minute observation cards are
  aggregated from the same accepted one-minute input. READY means the input and
  calculations passed, not that any model is approved.

The former SPX/synthetic feature builders and stored models were not relabeled
or reused. The guarded SPY route has no import of those builders or the ML
service and still returns `status: UNAVAILABLE`, `levels: null`, and
`predictionValidation: not_established`.

## Original findings

1. **The tape was generated, not observed.** The original inline SPY handler
   generated additive seeded random candles/volume when real bars were absent,
   then forced the final close to snapshot spot. Its `prevClose ?? fallback`
   accepted a numeric zero, allowing a near-zero-to-spot ramp. That is a code
   mechanism consistent with the supplied screenshot, not proof of the exact
   runtime input that produced it. The whole generator has now been removed
   from [the SPY route](../server/routes.ts).

2. **“FLAT” did not require a prediction.** The former panel set `lean="FLAT"`
   when `leanPct` was null, then displayed a warming-up explanation. It also
   equated narrow quantile width with high confidence and extrapolated short
   horizons toward the close with an arbitrary cap. These display behaviors
   were removed, not relabeled, in [MLProjectionPanel](../client/src/components/MLProjectionPanel.tsx).

3. **SPX/SPY price and feature units were mixed.** The old SPY route called the
   SPX feature builder, separately loaded SPY candles and fed the SPX ATR into
   the SPY morning fingerprint. Its level branch divided enhanced
   computed/user-target levels by ten without a native-SPY chain source contract.
   The feature builder explicitly retrieves SPX bars, and the level object mixes
   computed values with user weekly references. See [mlGreekFeatures](../server/mlGreekFeatures.ts),
   [mlMorningFingerprint](../server/mlMorningFingerprint.ts) and
   [gammaLevels](../server/gammaLevels.ts).

4. **Prior close was not a prior-session close.** The shared OHLC adapter takes
   the second-to-last candle close for intraday data. That cannot safely supply
   a session-gap feature. The repaired SPY path does not consume that field or
   invent a replacement; the shared helper remains unchanged for its other
   callers. See [ohlc.ts](../server/ohlc.ts).

5. **Training/inference units and windows are not equivalent.** Live
   `realized_vol_5m` computes sample deviation of a one-element return array,
   which the helper returns as zero; the live volatility fields are annualized.
   The v3 trainer uses simulated one-minute returns and different proxies/windows.
   Morning training counts one-minute intervals since the anchor while the live
   builder uses a count of five-minute bars. Merely rescaling a forecast does
   not repair these input contracts. See [live features](../server/mlGreekFeatures.ts),
   [v3 trainer](../ml_service/train_quantile_impl.py),
   [morning trainer](../ml_service/train_quantile_morning_impl.py) and
   [live morning features](../server/mlMorningFingerprint.ts).

6. **TRAINED is not forward validation.** The trainer explicitly synthesizes
   intraday paths from daily data, including synthetic dealer-level features;
   morning-model metadata expressly describes synthetic intraday/Greek inputs.
   The stored training status and pinball loss are not evidence of reliable
   live-SPY directional usefulness or calibrated confidence. See
   [training implementation](../ml_service/train_quantile_impl.py),
   [overlay metadata](../ml_service/models/quantile_overlay_v4_meta.json) and
   [morning metadata](../ml_service/models/quantile_overlay_morning_v1_meta.json).

7. **Observation timing was not gated.** The old client placed candles by ET
   minute-of-day without a date filter and anchored paths at bar-open timestamps
   while using bar closes. The old route lacked a fail-closed real-tape,
   same-session, quote-age and complete-interval gate. Its replacement uses
   exact-symbol raw fields and validates completed five-minute intervals rather
   than trusting fetch time. See [guarded SPY service](../server/spyProjection.ts).

## Earlier containment implementation

- Replaced the old inline GET route with `spyProjectionRoute`, physically removing
  its automatic GBM generation, snapshot fallback, model blending and fixed-ratio
  SPY dealer-level branch. Parent's crypto-context changes remain intact.
- No automatic ML inference, synthetic tape, directional forecast, dealer levels,
  gamma-snap or linear extrapolation in this SPY endpoint/panel.
- Bounded cached Schwab reads, exact SPY identity, USD compatibility, explicit
  real-time flag and provider last-trade timestamp; quote max age one minute.
- Positive finite OHLC, consistent high/low ordering, nonnegative/missing volume,
  no marked synthetic input, same-day regular-clock window, unique aligned
  five-minute intervals, no missing intervals from session open, minimum three
  completed bars and latest expected completed bar. Forming bars are excluded.
- Real bars can be inspected as observations only after these checks. No chart
  is generated to make an unavailable prediction appear plausible.
- Projection and levels remain UNAVAILABLE even when the observational tape is
  usable, with specific reasons and restoration requirements. Missing data is
  never a neutral/FLAT signal.
- Strict shared response schema; a stale backend/legacy synthetic payload is
  rejected by the UI. Snapshot expiry withdraws price observations.
- Manual checks only, with a short cache and deduplicated bounded provider reads.

Implementation: [server guard](../server/spyProjection.ts),
[shared contract](../shared/spyProjection.ts),
[replacement panel](../client/src/components/MLProjectionPanel.tsx),
[focused tests](../tests/spy-projection.test.ts).

## Still blocked / deliberately unchanged

No trainer, stored model, training dataset, other ML endpoint or other module's
feature math was modified. The new contract is intentionally incompatible with
legacy feature names so no stored model can silently consume it.

Restoration requires sufficient point-in-time real snapshots; a predeclared
target/horizon; chronological holdout and forward evaluation against simple
baselines; quantile-order/coverage checks if quantiles are retained; declared
costs and failure criteria; and independent review where feasible. Native-SPY
timestamped options/levels are required only if a declared model uses them.
Corporate-action adjustments and halt status still need contracts. No promise
of predictive accuracy, validated probability, execution readiness or return.

The screenshot's exact runtime quote/prevClose values were not reconstructed.
The follow-up used existing authorized read-only provider access; it did not
change OAuth, entitlements or credentials. Shared authentication and legacy
logging are not repaired by this release. Native iOS remains paused.
