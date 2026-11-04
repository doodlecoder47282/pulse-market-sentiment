# Batcave: meme scoring foundation

Date: September 30, 2026. Version: `meme-research-2026-09-30.1`.
Scope: first bounded meme-coin scoring milestone. Native iOS and the AI Trade Brief remain unimplemented/paused for this change.

## Implemented behavior

- Pure, deterministic scoring module in `shared/memeScoring.ts`.
- Flow contributes once; sampled social is separate and cannot change the flow value.
- Original retained budgets: flow 35, risk-screen structure 25, sampled social 10. Removed name/narrative allocation is not redistributed. Research points have a 70-point budget and are not comparable to legacy 100-point scores or calibrated probabilities.
- Paid boost and trending-discovery bonuses removed. Promotion still receives an explicit risk flag.
- Name-based memeability and headline keyword matches are contextual only, not ranking contributions.
- Missing/partial/stale social stays null; missing or inconsistent required flow inputs produce no ranking. Observed zero volume is preserved; no invented acceleration for an absent baseline.
- All revised candidates are WATCH/PASS. ENTER is deliberately disabled because the changed score has not been validated; WATCH retains a provisional research cutoff, not a calibrated trade threshold.
- Existing hard-kill checks and market freshness precede watchlist qualification. Incomplete authority checks are explicitly disclosed; no authority boolean null is displayed as revoked/safe.
- Newly inserted signal records include score version, breakdown and replay inputs in the existing JSON fields. No historical records or grading outcomes were rewritten.
- Existing risk fields are labeled illustrative scenarios, not executable levels or verified size/slippage. The fixed percentage stop and market-cap milestone remain research heuristics, not new price calculations.

## Existing levels: answer to the user's question

The existing stock code includes classic/Fibonacci/Camarilla pivots and trade-level consumers. The Trade Brief is intended to reuse reviewed applicable calculators rather than duplicate them in an AI prompt.

That does not imply every calculator is appropriate for a meme token. The meme engine currently uses fixed research scenarios and liquidity-size proxies. This milestone did not add a route-quoted entry/exit engine, calculate new price targets, fix stock authentication, or establish reliable live coverage for stock levels.

## QA inventory

### Automated

- Decomposition, independent social contribution and versioned replay.
- No score uplift from renamed tokens, trending discovery or paid boosts.
- Missing versus zero flow, unusable baselines and inconsistent windows.
- Partial/stale/future social and market inputs.
- Score bounds, deterministic output and hard-kill precedence.
- Engine WATCH-only behavior, unknown-authority disclosure and signal JSON replay.
- Existing crypto-reliability, calculation and gateway regressions.

### Browser sign-off

- Crypto tab and feed/signal-log toggles; token expand/collapse.
- Visible scoring policy, version, component contributions and missing-social label.
- Illustrative-risk explanation and unknown authority state.
- Desktop and phone viewport fit.
- Empty shortlist and stale/no-ranking candidate, using explicitly isolated browser fixtures where necessary.
- Live backend version and WATCH/PASS-only output checked separately from fixtures.

## Verification status

Automated: 11 crypto/scoring groups, six calculation groups and three gateway groups passed.
Production build passed. Whole-project TypeScript still reports 59 existing diagnostics; none refer to the changed crypto/scoring files. This is not a clean whole-repository type-check.

Browser checks passed at 1440px desktop and 375px phone widths with no horizontal
overflow or page errors after isolating unrelated API calls. Feed/log switching,
expand/collapse, missing social contributions, unknown authorities and a stale
no-ranking candidate were exercised. The detailed WATCH and stale cases used
browser-only fixtures labeled QA ONLY, never inserted into the backend.
Screenshots were inspected; long cards remain vertically scrollable.

The restarted live backend reports the new scoring version. The final observed
feed returned 80 candidates, zero ENTER and zero WATCH; this is one snapshot, not
a forward validation result. Scanner, momentum, narrative and security routines
reported `ok`; social and grader reported `degraded`. Healthy routine completion
does not establish complete candidate coverage. Existing Schwab authentication
and some CBOE fallback failures were also observed at startup and were not repaired.

## Remaining limitations and next objective

- Social matching remains sampled cashtag/reply evidence, not verified contract-specific organic activity.
- Holder concentration still uses an unverified largest-account exclusion; UI/flags now disclose the proxy instead of claiming verified ex-pool holdings.
- Authority parsing/program coverage and refresh policy require separate token-program-specific work.
- Existing per-day signal deduplication remains; not every reevaluation is an immutable saved decision. Full point-in-time audit storage remains S2 work.
- The pace ratio uses a five-minute interval within its one-hour baseline, not independent windows.
- Research thresholds, market-cap grading, liquidity proxies and executable exits remain unvalidated.
- No new provider/account, paid source, X access, trade execution, AI polling or native iOS work was added.

Next bounded proposal: replace the unverified holder-exclusion/authority assumptions with explicit token-program and vault-identity checks, retaining UNKNOWN when they cannot be verified. Do not expand into new providers or general Trade Brief implementation without selecting that scope.

## Rollback

Keep the prior code commit and existing records. Reverting source/build restores the prior behavior but also restores the old ranking defects; do not reactivate legacy ENTER signals as a safety workaround. Prefer disabling the experimental ranking while preserving research records. This milestone adds JSON metadata without a destructive schema migration.
