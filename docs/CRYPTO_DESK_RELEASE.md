# Batcave: crypto desk, stock lookup and SPY containment release

Date: September 30, 2026. Scope is read-only browser research. Native iOS remains paused.

## QA inventory

- Crypto overview must show useful candidate coverage even when no token qualifies. Inspect all six groups, source health, known gaps, methodology and observational outcomes.
- Exercise token search, no results/reset, ALL/PASS/WATCH/PUMP filters, score/liquidity/age sorting, expansion and pagination. Inspect long identities and missing-field layouts.
- Confirm timestamped live adapter responses; provider errors must not be zero values or fabricated replacements. Unit tests cover missing/zero/future/unsupported/capped samples.
- Test desktop and 375px layouts, dark/light, keyboard focus, persistent navigation, no horizontal overflow and refresh/error paths.
- Stock lookup must require explicit listing confirmation and analysis; inspect supported/unknown search, horizon changes, missing data and evidence details. Agent's isolated fixture tests additionally cover races, expiry, offline and 200% text.
- SPY must show unavailable, not a synthetic or neutral forecast. Test the integrated route/panel, refresh and strict rejection of legacy payloads. Useful observations remain separate from predictions.
- Run focused regression tests and production build. Record existing TypeScript debt without claiming the whole repository passes.

## Results

- **Focused tests:** 45/45 groups passed across crypto desk parsers, meme scoring,
  crypto reliability, calculation review, mobile security boundaries, stock
  briefs and SPY guard/physical-route replacement. Missing derivative funding
  or invalid mark/index fields now report PARTIAL, never HEALTHY.
- **Build:** coordinated production client/server build passed. Final
  frontend-only wrapping adjustment also built successfully. Bundle-size
  warnings remain; no native build was performed.
- **Type checking:** 59 pre-existing diagnostics remain. None were reported
  in the new/modified feature components, adapters or contracts. This is not
  a clean whole-repository type check.
- **Runtime:** production server restarted with the coordinated backend.
  A bounded 15:19 ET observation returned all 105 tracked candidates, including
  68 with GeckoTerminal liquidity evidence; 19 still lacked liquidity.
  Mint states were 1 CHECKED, 12 UNSUPPORTED, 92 not yet checked during warm-up.
  These are a point-in-time startup snapshot, not a matched before/after study.
- **Context:** live response contained 150 bounded attributed headlines.
  Coinbase BTC/ETH, Deribit BTC/ETH and all six RSS feeds passed at observation.
  DefiLlama stayed PARTIAL without provider event time; cached CPI was STALE.
  Core token collectors remained PARTIAL and X DISABLED. A healthy collector
  is not complete token evidence or guaranteed future availability.
- **Desktop/mobile:** integrated Chromium checks at 1440px and 375px passed
  all six group switches, token search/no-match/reset, four filters, three
  sorts, expansion, pagination, source/methodology/outcome views and refresh.
  Expanded token cards initially clipped internally; min-width/grid/wrapping
  fixes were applied and rechecked by screenshot and descendant bounds.
- **Failures and expiry:** injected discovery 503 displayed an explicit warning
  and recovered with Retry. A deliberately expired context response withdrew
  quote cards; manual retry restored them. These were isolated browser fixtures,
  not deployed data.
- **Stock:** live Alphabet search produced both share classes; explicit GOOG
  selection returned a deterministic partial research brief. Evidence opened,
  horizon changes withdrew the old output and unknown search showed no match.
  Separate delegated fixture QA covers five widths, races, expiry, offline,
  malicious input and 200% text enlargement.
- **SPY:** integrated route returned UNAVAILABLE; the UI displayed verified
  observations separately, no synthetic chart or directional forecast. Manual
  refresh and observation detail expansion worked. Desktop and phone layouts
  were reviewed. No predictive-accuracy claim is made.
- **Navigation/accessibility:** persistent main navigation, keyboard group
  activation and dark/light modes were exercised. No page errors were captured;
  final 375px expanded-card and SPY regions had no horizontal clipping.
  Native Safari/device behavior is untested while iOS remains paused.

Unrelated API calls were deliberately isolated during browser QA to avoid
triggering existing expensive analysis paths. Feature APIs used the actual
running backend except the explicitly labeled outage/expiry cases above.
No claim is made that every legacy dashboard module passed this review.

## Boundaries

The stock brief is deterministic, not an AI trade recommendation. News, earnings,
options and seasonality coverage is explicitly incomplete. SPY prediction
accuracy is unestablished; its former misleading display has been removed,
not transformed into a validated forecast. Crypto remains WATCH/PASS research.
No paid providers, accounts, X reconnection, trading, native build or new AI loop.
Credential rotation, multi-user isolation and broader security review remain blocked.
