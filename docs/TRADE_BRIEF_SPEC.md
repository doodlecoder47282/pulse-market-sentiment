# Batcave: stock and crypto Trade Brief

Status: proposed feature specification, September 30, 2026. Companion to stage TB in `INSTITUTIONAL_IMPLEMENTATION_CHECKLIST.md`. No search bar, endpoint, AI integration or trade functionality was implemented in this planning step.

## Problem statement

The user wants one quick search that turns Batcave's applicable scripted data into a concise, professional trading-research brief on phone and PC. Today the requested synthesis spans separate quotes, levels, risk, earnings, news, options, volume, macro and crypto evidence; the new surface must reduce navigation without concealing contradictions or unavailable inputs.

The product promise is “one instrument, one explainable plan, one evidence snapshot,” not perfect predictions or omniscient live coverage. AI should explain verified calculations rather than invent prices, levels or certainty.

## Goals

- **Fast comprehension:** Let a user identify the asset, horizon, verdict, trigger, invalidation and main risk from the first screen.
- **Complete applicability:** Check every registered relevant data module and disclose whether it contributed, was excluded, is stale, is unsupported or is unavailable.
- **Numeric integrity:** All displayed trade levels and risk figures trace to a versioned deterministic calculation and timestamped inputs.
- **Cross-device usability:** Provide a touch-friendly phone browser and keyboard-friendly desktop experience without reviving native iOS work.
- **Controlled cost:** Perform ordinary data gathering and calculations deterministically; invoke AI only for explicit analysis or separately approved events.

## Non-goals

- Automated order placement, wallet signing, brokerage passwords, real-money allocation or trade execution authorization.
- Claiming validated probabilities, guaranteed exits, “perfect” trades or professional certification.
- Rebuilding every existing engine or showing every available metric on the first screen.
- Account creation, paid datasets, X reconnection or uncapped provider/AI polling.
- Capacitor/Xcode development, native push notifications or App Store work.

## User stories

- **Desktop researcher:** As a stock trader, I want to search a ticker and choose a horizon so I can see a concise conditional plan and its evidence without opening every tab.
- **Phone user:** As a mobile user, I want a readable one-screen summary and expandable details so I can understand what matters without pinching, horizontal scrolling or hover interactions.
- **Crypto researcher:** As a token researcher, I want chain/address confirmation, liquidity and security checks so similarly named or unsafe tokens cannot receive a misleading stock-style brief.
- **Cautious user:** As a user facing missing data, I want a clear WATCH/PASS or unavailable state rather than an AI-generated substitute.
- **Returning user:** As a user revisiting a brief, I want to know when its assumptions expired or price crossed invalidation rather than see an old plan beside a new quote.

## Requirements

### Must have: search and evidence

| ID | Requirement | Acceptance criterion | Dependency |
|---|---|---|---|
| P0-IDENTITY | Search stocks/ETFs by ticker/name and crypto by symbol or chain/address. | Given an ambiguous symbol, when submitted, then show canonical instrument choices and require selection; do not silently choose a token. | Instrument registry |
| P0-HORIZON | Require a visible horizon and instrument type. Default to research-only swing context when unselected; intraday mode must be deliberately chosen. | Given a horizon change, when analyzed, then recompute applicable inputs/levels and mark the prior brief superseded. | Horizon-aware calculators |
| P0-REGISTRY | Register relevant engines and their schemas, units, freshness, universe and dependence on other inputs. | Given a module that only supports SPX or a particular chain, when another instrument is selected, then mark it not applicable rather than reuse its values. | S2 |
| P0-SNAPSHOT | Aggregate data into an immutable analysis snapshot with per-source status. | Given fresh quote data but stale options, when a brief is generated, then expose both ages and suppress dependent options conclusions. | S2; source contracts |
| P0-CALC | Compute entry/stop/targets, scenario risk and costs outside the LLM. | Given a cited numerical result, when inspected, then resolve it to source observations, formula/version and compatible units. | S1/S6; reviewed stock calculators |
| P0-FAIL | Missing mandatory inputs prevent actionable output. | Given no usable price, invalid stop, failed critical safety check or unknown sell route where required, when Analyze runs, then return INSUFFICIENT DATA/WATCH/PASS with reasons, not fabricated levels. | Asset/horizon prerequisite map |

The current repository includes candidate calculation paths such as `server/pivots.ts`, `server/masterAlpha.ts`, `server/news.ts`, `server/fredClient.ts`, `server/crossAsset.ts` and `server/cryptoEngine.ts`. Inventory their actual exports, supported universes and dependencies before reuse; presence in the codebase does not prove live data quality or general applicability.

### Must have: curated brief

The default card should contain roughly 150–250 words of narrative plus compact levels and evidence badges. This is a proposed presentation target, not a hard limit that may hide critical risk disclosures.

1. Instrument identity, asset class/chain, horizon and market-session context.
2. As-of time, per-input freshness access and overall coverage status.
3. Verdict: research setup, WATCH, PASS or INSUFFICIENT DATA; do not label an unvalidated heuristic an executable buy recommendation.
4. One-sentence thesis and the strongest contradictory evidence.
5. Conditional entry trigger and entry zone, invalidation/stop, targets and net scenario reward/risk where calculable.
6. Management rules: wait-for condition, expiry/cancellation rule, trim/exit logic and event-based restrictions.
7. Top catalysts and risks, including earnings/event timing when relevant.
8. Expandable evidence, calculation methodology, gaps and attributable source links.

**Acceptance:** Given contradictory bullish price evidence and a near-term unverified earnings event, when summarized, then the conflict and event uncertainty remain explicit; the AI cannot turn mixed evidence into an unqualified confident verdict.

### Must have: asset-specific input map

| Input family | Stock/ETF brief | Liquid-crypto brief | Meme/microcap brief |
|---|---|---|---|
| Price/structure | Session-aware quote, spread, VWAP/anchored VWAP where available, support/resistance, pivots, ATR/realized volatility, trend and relative strength. | Venue-aware quotes, spread/depth, trend/volatility and cross-venue disagreement. | Pool/route-specific quotes, age, depth, price impact and liquidity change. |
| Volume/flow | Relative volume normalized to time of day, trade/auction context and supported flow metrics. | Venue-volume coverage, funding, basis, open interest and reported liquidations where available. | Unique buyers/sellers, acceleration, concentration, suspected coordinated activity and promotion labels. |
| Options | Fresh chain, bid/ask quality, OI age, volume, expiry, IV/skew/term structure and reviewed Greek-derived context. | Supported listed crypto derivatives only, with exchange/instrument units. | Usually not applicable; never fill with unrelated options data. |
| Events/news | Verified earnings date and timing, guidance/news, dividends/splits, sector events, filings and halt status where sourced. ETFs require applicable fund-level treatment, not invented company earnings. | Regulatory/exchange/protocol events, token unlocks with attribution and chain incidents. | Project/address-specific events, mint/authority changes and liquidity withdrawals; generic headlines remain contextual. |
| Macro/regime | Rates, real yields, dollar, credit, breadth/sector strength and economic calendar where fresh and relevant. | Macro plus stablecoin/chain/DeFi context. | Secondary portfolio/chain-stress gate, never proof of token demand. |
| Seasonality/statistics | Only applicable, reproducible history with sample/window disclosure. | Only validated asset-specific histories. | Usually insufficient history; disclose rather than fabricate a seasonal pattern. |
| Security/execution | Spread, volatility, event gaps, short/borrow availability if proposing shorts, venue/session restrictions. | Venue risk, depth, costs and instrument constraints. | Contract/program checks, holder/vault verification, sell feasibility, taxes/restrictions if supported and chain execution risk. |

Additional safeguards: options volume/open interest alone cannot establish whether someone opened a bullish position; label observed activity separately from inferred intent. Preserve delayed chains as delayed, not live. Unknown earnings timing is not “no earnings risk”; absent halt data is not “not halted.”

### Must have: risk and level contract

- **Levels:** Use existing reviewed calculators and explicit structure/invalidation rules. Do not let the language model select unsupported precision or substitute targets from a different ticker/horizon.
- **Risk units:** For a cash long, a simple planned per-unit risk is `entry - stop + estimated round-trip cost`; for a cash short it is `stop - entry + estimated round-trip cost`, provided the level ordering is valid. Use route/size-specific impact when available.
- **Reward/risk:** Compute target net reward divided by planned risk using consistent units and costs. Label it scenario reward/risk, not expected return or win probability.
- **Sizing:** If a user supplies an explicit paper risk budget, cap illustrative size by planned stop risk, cash, liquidity and concentration. Without that budget, show per-unit and percentage risk only; never invent account equity.
- **Tail risk:** A stop is a plan, not a guaranteed fill or maximum loss. Display earnings gaps, halt/illiquidity, chain failure and short-position risks where applicable.
- **Options:** Do not apply stock-distance formulas to options P&L. Options-specific planning requires fresh contracts, multiplier, expiry, bid/ask and a reviewed scenario model including volatility/time assumptions.
- **Existing calculation blockers:** Recheck known freshness, duplicated pivot logic and Greek-unit limitations in the affected path before using its outputs in a brief. An earnings or options entitlement gap limits the output even if the rest of the dashboard loads.

**Acceptance:** Given zero/negative risk distance, mixed currencies, non-finite inputs, an expired quote or unsupported options P&L, when calculations run, then suppress the invalid result and explain the missing prerequisite.

### Must have: AI boundary and lifecycle

Proposed architecture:

```text
Search and disambiguation
  -> canonical instrument + horizon
  -> relevant engine registry
  -> bounded cached retrieval + quality checks
  -> immutable evidence snapshot
  -> deterministic levels/risk + safety gates
  -> schema-constrained AI explanation
  -> numeric/source validation
  -> responsive brief + evidence drawer
```

Minimum response contract:

```text
brief_id, instrument_id, horizon, mode, snapshot_id, created_at, expires_at
source_statuses[], coverage_gaps[], observed_at_range
verdict, thesis, counterevidence[], prerequisites[]
levels[{kind, value, unit, formula_id, evidence_ids}]
risk{basis, planned_loss, scenario_reward_risk, assumptions, limitations}
events[], management_rules[], invalidation_rules[]
claims[{text, evidence_ids}], model_version, calculation_version
```

- Validate model output against a schema and an allowlist of snapshot evidence IDs; every numerical claim must match an allowed calculation or observation.
- Never send brokerage tokens, account identifiers, raw credentials or irrelevant personal data to the model.
- Do not expose retrieval/tools capable of trading, signing, code changes or arbitrary URL access to the explanation model.
- Discard responses for an old symbol/horizon after the user changes selection; use cancellation/request IDs to prevent races.
- If the LLM times out or fails validation, return the deterministic brief with a clear explanation-status label.
- Refresh ordinary metrics deterministically. Regenerate prose only on explicit Analyze/Refresh or a separately authorized meaningful-change policy.
- Cache by instrument, horizon, evidence version and model/calculation version. Keep account-dependent outputs tenant-scoped; never cache private briefs globally.
- Reaching a target, crossing invalidation, a material event, required-source staleness or expiry must visibly invalidate the plan. Do not relabel old calculations as newly generated.

**Acceptance:** Given an injected headline telling the model to ignore risk rules or reveal secrets, when summarized, then it remains untrusted text and cannot change the schema, verdict gates or tool permissions.

### Must have: phone and PC usability

- Persistent accessible search entry, explicit Analyze button, keyboard submit and optional desktop shortcut.
- A single-column phone card, comfortable touch controls, visible labels and expandable evidence; no essential hover-only action.
- On desktop, a compact plan with an adjacent evidence area rather than a full-width paragraph dump.
- Visible loading, partial-data, offline, invalid-symbol, empty-result, stale and AI-failure states.
- Source freshness and research-mode labels remain visible even when detail sections collapse.
- Verify representative 375/390/430-pixel phone widths and 1280/1440-pixel desktop widths, keyboard navigation, screen-reader labels and text enlargement without clipped essential content.
- “iPhone support” here means the responsive browser interface. Native Xcode compilation/device validation remains out of scope.

### Should have and could have

- **P1:** Copy/export a brief with timestamps and gaps; compare the current brief with a previous snapshot; show bullish/base/bearish conditional paths without invented probabilities.
- **P1:** Offer a user-confirmed paper-position view with position-specific invalidation and risk, after privacy and input checks.
- **P2:** Saved watchlist, side-by-side instruments and user-defined significant-event alerts. Persistent alerts require a separate scheduling request.
- **Won't have:** Automatic order submission, AI-generated certainty scores, background narration on every tick, or an unbounded “collect every source” request.

## Success metrics

All targets below are proposed acceptance targets, not measured performance. Establish a baseline in the first implementation pilot and freeze agreed thresholds before the acceptance run.

| Metric | Proposed target | Measurement |
|---|---|---|
| Numeric traceability | Every displayed level/risk number resolves to evidence/formula; zero unsupported numeric claims in acceptance fixtures. | Schema/provenance checks on every generated fixture brief. |
| Safety/freshness gating | Zero actionable-looking outputs for mandatory-stale/unsafe/ambiguous fixture cases. | Adversarial and outage suite before preview promotion. |
| Comprehension | User can identify verdict, trigger and invalidation without opening evidence; aim within 15 seconds. | Timed phone and PC task in first user pilot; collect feedback before fixing final target. |
| UI responsiveness | Search responds without waiting for the model; cached structured result target p95 at most 2 seconds in the declared test environment. | Instrument the first pilot, separate backend/cache/AI timing. No promise for untested provider latency. |
| Model failure handling | Every induced AI failure produces an honest deterministic fallback or insufficient-data state. | Timeout, malformed-schema and mismatched-number tests. |
| Cost behavior | One explicit analysis action makes at most one generation attempt by default; identical unchanged requests reuse cache. | Request logs, cancellation and deduplication tests; no Computer-credit estimate. |
| Ongoing quality | Track brief usefulness ratings, stale-plan incidents and fallback rate after preview release. | Review the first approved pilot period; no autonomous AI monitoring is implied. |

Research profitability remains an S7 requirement, not a UI success metric or a claim derived from engagement.

## Open questions

- **Owner, blocking only for live intraday output:** Which asset/horizon combination ships first? Suggested bounded slice: one supported stock/ETF and BTC/ETH research briefs using existing verified inputs.
- **Developer, blocking for each adapter:** Which current endpoints and calculation paths meet freshness, instrument scope and unit requirements? Inspect targeted code/tests rather than infer availability from module names.
- **Owner, blocking for personalized sizing:** What explicit paper risk budget and concentration limits should apply? Until supplied, keep sizing absent and risk per unit.
- **Owner/security reviewer, blocking for multi-user exposure:** Is the release owner-only or tenant-isolated? Default to existing restricted research scope; do not expand exposure silently.
- **Owner, non-blocking:** Preferred default horizon and whether the final card should favor shorter summary or additional scenario detail. Use concise swing-research context provisionally.

## Implementation slices and next step

1. Inventory applicable engines and write the canonical evidence/brief schema with fixtures.
2. Add deterministic aggregation, quality gates and numeric calculation references for one declared scope.
3. Build the responsive search and deterministic result card.
4. Add schema-constrained AI explanation, validation, caching and fallback.
5. Run boundary/race/accessibility tests, then preview the existing app update.
6. Expand asset coverage only after the initial slice passes; apply S7/S8 before broader decision-grade or multi-user claims.

Next implementation remains subject to the staged checklist and the newest user instruction. This specification preserves the requested clean stock/crypto search experience without bypassing scoring, freshness, security or validation prerequisites.
