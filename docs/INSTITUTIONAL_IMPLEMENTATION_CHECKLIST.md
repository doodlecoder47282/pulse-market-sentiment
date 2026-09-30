# Batcave: staged implementation checklist

Created September 30, 2026. Planning baseline: local application commit `b4bb19c`. This checklist translates the institutional-readiness assessment into bounded implementation tasks; it does not certify the current system or authorize execution of the entire roadmap.

## Operating contract

- **Current milestone:** The user authorized starting the meme-coin area on September 30. The first scoring foundation is implemented; see `MEME_SCORING_HANDOFF.md` for tests, runtime evidence and limitations. Checked items below apply to that bounded scope, not the full institutional roadmap.
- **Product scope:** Crypto research and tracking, with separate liquid-crypto and meme/microcap logic, plus a stock/crypto quick-search Trade Brief. No automated trading, real-money sizing activation or additional brokerage users.
- **Paused work:** iOS/Xcode remains paused. Do not resume the older gold-panel proposal unless requested.
- **Source constraints:** Yahoo Finance news is allowed; Yahoo equities-price feeds are not. Preserve Schwab-primary pricing and honestly labeled existing fallbacks.
- **Access constraints:** Do not request the dismissed X connector again unless explicitly asked. No account creation, new paid plan, token/cookie import, provider spending, public publishing or destructive history changes without specific authorization.
- **Risk boundary:** No claim of calibrated probabilities, proven edge, complete social coverage, full security or institutional readiness merely because tests or builds pass.

Statuses: `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `PASSED`, or `DEFERRED`. “Deferred” is allowed only for optional scope; it is not a substitute for passing a required gate. Work can proceed on isolated fixtures while production access is blocked.

## Stage map

| Stage | Deliverable | Dependency | Current status |
|---|---|---|---|
| S0 | Baseline, scope and immediate security boundary | None | IN PROGRESS |
| S1 | Versioned, explainable scoring | S0 | IN PROGRESS |
| S2 | Point-in-time evidence and health contracts | S0 | NOT STARTED |
| S3 | Entity-aware news and social context | S1 + S2 | NOT STARTED |
| S4 | Liquid-crypto market, derivatives and macro context | S2 | NOT STARTED |
| S5 | Address-specific meme/on-chain evidence | S2; approved access where needed | NOT STARTED |
| S6 | Executable paper ledger and capacity model | S1 + S2; relevant S4/S5 feeds | NOT STARTED |
| TB | Stock/crypto search and AI Trade Brief | S0 + S2; validated asset-specific calculators and relevant S3–S6 inputs | NOT STARTED |
| S7 | Reproducible research and forward validation | S3–S6 for the declared strategy scope | NOT STARTED |
| S8 | Operational and security release review | Earlier gates for enabled scope | NOT STARTED |
| O1 | Optional licensed data or X upgrade | Quantified gap; specific approval | DEFERRED |

Complete one bounded objective per work session. S1 and S2 have independent dependencies, but this plan does not authorize parallel agents or unattended execution. A scoped release need not enable every proposed source; document excluded capabilities and never imply they are present.

Suggested responsibility: implementation agent/developer produces evidence; project owner approves scope, risk limits and spending; an independent qualified reviewer assesses high-risk release controls. Assign actual names before release rather than inventing a team.

## Baseline and immediate security boundary

Stage S0 establishes the exact code and data under review. It does not repeat the entire historical audit.

- [x] **S0-A:** Record branch, commit, working-tree changes and intended runtime. Preserve unrelated database, scheduler and session files. Evidence: `MEME_SCORING_HANDOFF.md`; baseline `4a0f7e1`, remote application baseline `b4bb19c`, unchanged feature branch.
- [x] **S0-B:** Verify the latest crypto-repair handoff against the inspected source. Run existing focused crypto/calculation tests and record build/type-check results, including pre-existing failures. Evidence: 20 focused groups pass; production build passes; 59 pre-existing TypeScript diagnostics remain.
- [ ] **S0-C:** Create a redacted source register: endpoint, data role, access requirements, permitted use, quota, coverage, cadence, upstream provider and known limitations.
- [ ] **S0-D:** Keep research collectors read-only and isolated from brokerage tokens, trading functions and withdrawal permissions. Confirm the actual deployment/access boundary before using sensitive data.
- [ ] **S0-E:** Record the status of previously exposed credentials as verified rotated/revoked or unverified. Obtain owner action through a secure process; do not print secrets or rewrite history.
- [ ] **S0-F:** Define the first release universe and horizon: BTC/ETH context, supported meme chains/programs, or another explicitly approved subset.

**Pass gate:** A reproducible baseline and written scope exist; current security uncertainties are visible. Unverified credential exposure blocks sensitive/public expansion, but need not block isolated fixture development.

**Evidence:** Baseline commit, command results, source register, risk register and approval boundaries.

## Scoring integrity

Stage S1 corrects the meaning of the score before adding new inputs. Initial touchpoints: `server/cryptoEngine.ts`, scoring tests and the consuming UI/API.

- [x] **S1-A:** Extract or isolate scoring into a deterministic, versioned function. Preserve a legacy fixture set for before/after comparison. Implemented in `shared/memeScoring.ts`; existing calculation regression fixtures retained.
- [x] **S1-B:** Remove duplicate confirmation from the same FOMO value appearing as both flow and FOMO. Define distinct transaction-flow and social-attention inputs.
- [x] **S1-C:** Separate paid promotion from organic attention. Remove any positive organic-confirmation contribution unless subsequently supported by a declared validation experiment.
- [x] **S1-D:** Treat name-based “memeability” as an unvalidated descriptive heuristic, not proven alpha. Keep it out of promoted decision logic unless it earns its role in S7.
- [x] **S1-E:** Separate hard safety/freshness gates from ranking. A high narrative/social score cannot override unsafe, unsupported or stale prerequisites. Revised output is WATCH/PASS only; token-program coverage remains future work.
- [x] **S1-F:** Define missing-input behavior explicitly; do not silently turn missing values into zero or reweight away missing required evidence.
- [ ] **S1-G:** Persist the score version, feature values, missingness, weighted contributions and gate reasons with every signal.

S1-G is partial: newly inserted signal JSON contains version, replay inputs,
contributions and reasons, but existing per-day deduplication still prevents
a complete decision-by-decision history. Full snapshot storage remains S2.
This stage is not fully passed or calibrated.

**Required tests:** Score bounds; zero versus null; duplicate-input handling; no organic uplift from promotion; safety-gate precedence; stale-input rejection; identical inputs produce identical outputs; versioned legacy/new comparisons.

**Pass gate:** Every score contribution is explainable without claiming independence twice. Thresholds and weights are labeled provisional, not calibrated probabilities; material ranking changes are documented before any promotion.

**Rollback:** Retain versioned configurations and records. Disable the new ranking or fall back to tracking-only, never silently reinterpret old signals with new weights.

## Evidence, identity and health foundation

Stage S2 provides the shared contract for all later adapters. Prefer additive migrations in the existing SQLite/Drizzle system before proposing a new infrastructure stack.

- [ ] **S2-A:** Define source, instrument/entity, raw-event, feature-snapshot, gap and decision records with stable IDs and schema versions.
- [ ] **S2-B:** Preserve event/publication/provider/first-seen/processing times separately when available. Missing timestamps remain null; preserve timezone and clock-skew diagnostics.
- [ ] **S2-C:** Store units, currency, chain, contract/mint, venue, instrument multiplier, finality and raw provenance where applicable.
- [ ] **S2-D:** Retain permitted raw evidence and payload hashes sufficient for replay. Apply source-specific retention, correction and deletion requirements; immutability must not override legal deletion obligations.
- [ ] **S2-E:** Implement idempotency, cursor checkpoints, bounded retries/backoff, rate-limit handling, schema validation and explicit unrepaired-gap records.
- [ ] **S2-F:** Distinguish `HEALTHY`, `PARTIAL`, `STALE`, `UNAVAILABLE`, `DISABLED` and `UNKNOWN`; keep observed zero as a value, not a source-health state.
- [ ] **S2-G:** Set freshness thresholds by source/data type. Separate collector success from the age of the underlying publication or observation.
- [ ] **S2-H:** Test additive migration, backup restoration and a compatible rollback path on an isolated database copy.

**Required tests:** Duplicate ingestion; out-of-order records; future timestamps; malformed HTTP-200 payloads; 429/timeout; restart mid-batch; unknown units; partial payload; stale cache; corrected/deleted content; required-source failure.

**Pass gate:** Replaying permitted stored inputs yields the same versioned decision. Missing evidence fails closed for dependent decisions without disabling unrelated healthy capabilities.

**Evidence:** Schema/migration, replay fixture, redacted health output, gap records and restore test.

## News and social context

Stage S3 consolidates existing ingestion rather than adding another independent headline loop. Initial touchpoints: `server/news.ts`, `server/cryptoEngine.ts` narrative logic and relevant news/crypto views.

- [ ] **S3-A:** Put existing crypto and financial feeds behind a shared parser/adapter contract. Validate format and per-feed health; HTTP success alone cannot mark a feed healthy.
- [ ] **S3-B:** Add a bounded initial set of Yahoo symbol-news and official Fed/BLS/BEA release sources after endpoint and usage checks. Quarantine stale/broken feeds rather than silently substituting proxies.
- [ ] **S3-C:** Store publication time, first-seen time, canonical URL, publisher, minimal permitted excerpt and correction/revision history.
- [ ] **S3-D:** Deduplicate exact stories and cluster syndicated versions of the same event. Preserve differing independent reporting rather than collapsing every similar headline.
- [ ] **S3-E:** Separate macro topics, liquid-crypto assets and token-specific claims. Names/tickers suggest candidates; verified project/address associations establish token relevance.
- [ ] **S3-F:** Include attributable protocol/exchange incidents, listings and governance announcements as primary-event categories. Label rumors and promotion.
- [ ] **S3-G:** Measure social velocity only across comparable observed windows, with unique authors, repost/text concentration, sampling limits and collection coverage. An outage cannot become declining interest.
- [ ] **S3-H:** Keep X optional and unavailable when not connected. Do not activate unofficial scraping or import session cookies under this checklist.
- [ ] **S3-I:** Treat ingested text as untrusted: sanitize display, constrain URL fetching, and prevent content from issuing tool instructions or accessing credentials.

**Required tests:** Ticker collisions; old story recirculation; same event across multiple outlets; article correction; future/absent timestamp; malicious text/URL; capped social sample; source outage during a velocity window.

**Pass gate:** A story cannot boost a token merely because its name shares a common word. Duplicated coverage does not masquerade as independent confirmation, and social coverage remains visibly bounded.

**Evidence:** Adversarial entity-matching fixtures, deduplication examples and source-health UI/API checks.

## Liquid-crypto market and macro context

Stage S4 builds a separate context model for liquid crypto. Start with a narrow eligible venue/instrument set and one exchange-library approach, not every available feed.

- [ ] **S4-A:** Evaluate a TypeScript-compatible adapter first; choose direct APIs or a single exchange library after verifying channel support, terms and geography. Keep private trading methods disabled.
- [ ] **S4-B:** Collect trades, bid/ask and necessary book depth. Test snapshots/deltas, sequence gaps, reconnects, crossed books, clock skew and cross-venue disagreement.
- [ ] **S4-C:** Add funding, basis and open interest only with explicit contract units, funding intervals and coverage. Add options IV/skew/term structure only when timestamps and instrument coverage support them.
- [ ] **S4-D:** Add selected crypto-native context such as stablecoin supply, protocol activity and DEX volumes through confirmed eligible endpoints; record methodology and revision caveats.
- [ ] **S4-E:** Preserve macro vintages alongside current values. Modify the current replacement-based FRED storage path without rewriting historical decision records.
- [ ] **S4-F:** Add release-calendar metadata and release/receipt times. Do not use later revisions or information published after a simulated decision.
- [ ] **S4-G:** Calculate release surprise only if pre-release consensus is legitimately available and timestamped. Otherwise display actual/prior/revision without a fabricated surprise score.
- [ ] **S4-H:** Keep macro and token signals separate. Verify units and cadence before combining nominal/real yields, dollar, credit, Fed/Treasury and crypto-native measures.

Candidate documentation: [CCXT](https://github.com/ccxt/ccxt), [Cryptofeed](https://github.com/bmoscon/cryptofeed), [Deribit market data](https://docs.deribit.com/api-reference/market-data/public-get_order_book), [DefiLlama](https://api-docs.defillama.com/) and [ALFRED vintages](https://alfred.stlouisfed.org/help/downloaddata). These are evaluation candidates, not established Batcave integrations.

**Pass gate:** Context is timestamped, unit-consistent and reproducible as of a decision. Sparse or slow-moving macro data is never displayed as a real-time release feed; unavailable derivatives coverage stays explicit.

## Meme and on-chain evidence

Stage S5 upgrades token evidence without treating “popular” as “safe.” Keyed providers require a separately approved secure credential path.

- [ ] **S5-A:** Verify chain/mint/program identity and pool vaults. Stop excluding the largest holder as a pool without evidence.
- [ ] **S5-B:** Check supported mint/freeze/transfer controls and supply changes. Unsupported token programs or failed checks return UNKNOWN, not SAFE.
- [ ] **S5-C:** Collect address-specific swaps, transfers and liquidity events with signatures, slot/block references and finality state.
- [ ] **S5-D:** Reconcile push events against retrievable chain history; detect duplicates, dropped events and reorgs. Keep unresolved gaps visible.
- [ ] **S5-E:** Compute unique buyers/sellers, concentration and suspected linked-wallet activity with explicit definitions. Distinguish heuristic clusters from verified common ownership.
- [ ] **S5-F:** Record paid boosts, creator funding, liquidity withdrawals and abnormal churn as separate evidence fields.
- [ ] **S5-G:** Query or simulate sell feasibility where supported, without signing trades. Preserve intended size, route, quote time, slippage assumptions and expiry.
- [ ] **S5-H:** Cross-check critical token risks through an independent route when available. Disagreement lowers confidence or blocks dependent decisions; it does not get averaged into “safe.”

Provider pilots may evaluate [Helius delivery behavior](https://www.helius.dev/docs/faqs/webhooks) and [GoPlus coverage](https://docs.gopluslabs.io/docs/getting-started). Verify actual entitlement and token-program support before activation.

**Pass gate:** No unverified pool exclusion, unsupported safety check or missing route is presented as verified exit safety. Reconciliation and provider-failure tests pass for the enabled chain/program subset.

## Paper execution and outcome ledger

Stage S6 separates observational tracking from trade performance. Initial touchpoints include `server/cryptoReliability.ts`, `crypto_signals` consumers and new additive paper-ledger records.

- [ ] **S6-A:** Preserve existing records and their original outcome semantics. Introduce versioned display mappings/new labels rather than silently rewriting history.
- [ ] **S6-B:** Separate market-cap milestones, liquidity-collapse observations, expired windows, unavailable outcomes and paper-trade P&L.
- [ ] **S6-C:** Record planned entry time, actual simulated eligibility time, venue/route, side, size, quote age, fill assumption and exit policy.
- [ ] **S6-D:** Model spread, fees, gas/priority fees where applicable, price impact, latency and failed/partial fills. Missing quotes produce non-executable cases, not invented fills.
- [ ] **S6-E:** Track coverage through the full holding path. A near-deadline observation does not prove that intrawindow targets were executable.
- [ ] **S6-F:** Reconcile balances, fills, costs and realized/unrealized paper P&L. Retain rejected, disappeared and unobservable candidates in the denominator appropriate to each metric.
- [ ] **S6-G:** Evaluate multiple declared position sizes and impose capacity limits. Never equate a sampled peak with an achievable exit.

**Required tests:** No fill; partial fill; expired quote; liquidity removed; token disappears; delayed observation; fee-unit error; ambiguous intrabar stop/target order; migration preserving old labels; restart during open paper position.

**Pass gate:** Every reported paper return has a reconstructible fill/cost path. Observational milestones cannot appear as trading wins, and cash remains disabled.

## Stock/crypto quick search and AI Trade Brief

Stage TB is the user-facing integration workstream. Detailed specification: `docs/TRADE_BRIEF_SPEC.md`. Deliver a responsive browser experience first; native iOS remains paused.

- [ ] **TB-A:** Build an applicability/dependency map for existing scripted outputs: quote, levels, volatility, risk, earnings, news, options, volume, macro, positioning, seasonality and crypto security.
- [ ] **TB-B:** Resolve ticker/name or crypto chain/address into a canonical instrument. Show a chooser for ambiguous results rather than guessing.
- [ ] **TB-C:** Add search, explicit Analyze action, asset identity and horizon controls to the existing terminal without removing tabs. Provide keyboard and touch access.
- [ ] **TB-D:** Assemble one timestamped evidence snapshot with per-input freshness, quality, provenance and explicit missing/unsupported states.
- [ ] **TB-E:** Reuse reviewed deterministic level/risk calculators; do not add another competing calculation in the AI prompt. Fix applicable stale-price and unit blockers before enabling actionable levels.
- [ ] **TB-F:** Produce a structured brief: verdict, reason, entry trigger/zone, invalidation, stop, targets, net scenario reward/risk, management rules, catalysts and risks.
- [ ] **TB-G:** Generate AI prose only from the bounded snapshot. Validate numeric claims and source references; reject unsupported values and fall back to a deterministic brief.
- [ ] **TB-H:** Invalidate an old brief on expiry, crossed invalidation/target conditions or material evidence changes. Never combine an old plan with a silently updated price.
- [ ] **TB-I:** Gate options-specific output on supported, fresh chains and verified units/expiry; otherwise provide a clearly limited underlying-only brief.
- [ ] **TB-J:** Make conditional earnings/event and liquidity constraints explicit. No invented earnings time, event surprise, trade probability or personalized position size.
- [ ] **TB-K:** Render one-column mobile and compact desktop layouts with expandable evidence, source links and no essential hover-only controls.
- [ ] **TB-L:** Test ambiguity, unsupported assets, earnings uncertainty, stale/missing quotes/chains, API/AI failure, race conditions, malicious headlines and mobile accessibility.
- [ ] **TB-M:** Cache identical snapshots and generate AI only on explicit analysis or approved meaningful changes; set bounded retries and per-request limits.
- [ ] **TB-N:** Run end-to-end UI/API and numeric-provenance tests; record usability results and deploy only the approved preview change.

**Pass gate:** A user can identify the instrument, thesis, trigger, invalidation, risk and freshness without reading every panel. Unsupported or stale critical inputs cannot produce an actionable-looking plan. Research readiness remains distinct from validated trading performance.

**Dependency rule:** A fixture-only UI can be developed earlier, visibly labeled as such. Live briefs require passing dependencies for their asset scope; a stock brief is not blocked by an optional meme-chain provider, and a crypto brief must not claim earnings coverage.

## Research and forward validation

Stage S7 promotes evidence, not appearances. Requirements apply to the declared strategy and enabled inputs, not to optional disabled providers.

- [ ] **S7-A:** Predeclare universe, horizon, benchmark, net-cost assumptions, primary metric, failure criteria, test period and method for uncertainty estimates.
- [ ] **S7-B:** Preserve point-in-time universe membership, including delisted, rugged and inactive tokens. Prevent survivor-only evaluation.
- [ ] **S7-C:** Use time-separated training/selection/holdout sets, addressing overlapping outcome windows. Record all tried configurations to expose repeated-testing risk.
- [ ] **S7-D:** Compare market-only baseline against plus-news, plus-social, plus-macro and combined variants; remove inputs that add no measured value.
- [ ] **S7-E:** Report net results, drawdown, tail loss, turnover, fill rate, capacity, source coverage, uncertainty and performance by declared regime.
- [ ] **S7-F:** Run prospective paper collection using frozen signal versions. Predeclare the required observation span and effective sample adequacy; do not use an arbitrary win count as proof.
- [ ] **S7-G:** Have someone other than the implementation author review the evidence when feasible. If independent review is unavailable, disclose it and withhold an independently-reviewed claim.
- [ ] **S7-H:** Decide explicitly: reject, continue research, or approve a limited read-only research release. Live trading requires a separate authorization and execution-risk review.

**Pass gate:** Results are reproducible, survive declared net-cost and adverse-case checks, and meet the predeclared criteria without changing the rules after seeing the holdout. Insufficient evidence means BLOCKED or continued research, not an invented success verdict.

## Operations and security release

Stage S8 is a release gate, not the first time security is considered. No production or multi-user readiness claim is permitted until its applicable controls have evidence.

- [ ] **S8-A:** Choose an approved always-on runtime and durable storage. Verify collector recovery independently of web-dashboard availability.
- [ ] **S8-B:** Freeze measurable source-specific freshness/latency, recovery-time and data-loss targets before the acceptance run. Label them internal targets, not vendor guarantees.
- [ ] **S8-C:** Measure latency distributions, missed events, backlog, clock skew and availability; test provider outage, disk/resource pressure, process restart and stale upstream data.
- [ ] **S8-D:** Test backups by restoring and reconciling records. Document incident response, rollback and source-disable procedures.
- [ ] **S8-E:** Verify credential rotation/revocation evidence, encrypted secret handling, least privilege, authentication/authorization, log redaction and dependency findings.
- [ ] **S8-F:** For any future multi-user brokerage scope, prove tenant isolation, per-user OAuth state binding, revocation/logout and cross-account access denial. Never collect brokerage passwords.
- [ ] **S8-G:** Map controls, evidence, owners and unresolved risks to a NIST-oriented Current/Target Profile; avoid claiming a product certification. NIST does not certify CSF implementations ([NIST FAQ](https://www.nist.gov/cyberframework/faqs)).
- [ ] **S8-H:** Complete independent security review for the intended exposure, including feed/parser trust boundaries and access-control tests.
- [ ] **S8-I:** Obtain explicit release approval with the enabled sources, known gaps, risk limits, deployment audience and rollback owner stated.

**Pass gate:** No unresolved critical security, data-integrity or recovery blocker for the intended release. A successful build, UI screenshot, uptime period or source subscription alone cannot satisfy this gate.

## Optional licensed data and X

O1 is deliberately outside the initial critical path. Missing X or a commercial provider does not block a correctly labeled, scoped research release.

- [ ] **O1-A:** Identify a quantified unresolved gap: missing history, unreliable repair, inadequate venue coverage, source rights or event latency.
- [ ] **O1-B:** Compare one suitable trial against the existing baseline, including upstream independence, entitlements, history, allowed use, retention and support terms.
- [ ] **O1-C:** Obtain owner approval for account/key access, cost cap, renewal terms and scope before enabling metered collection or subscriptions.
- [ ] **O1-D:** Enforce request/usage caps and disable optional collection at its cap. Never silently upgrade a tier or permit uncapped autoscaling.
- [ ] **O1-E:** Require measured incremental benefit and re-run affected S2/S7/S8 gates before promotion.

Candidates, not purchase instructions: [Coin Metrics](https://gitbook-docs.coinmetrics.io/market-data/market-data-overview), [Kaiko](https://www.kaiko.com/products/l1-l2-data), [RavenPack](https://www.ravenpack.com/products/edge/data/news-analytics) and [authorized X streaming](https://docs.x.com/x-api/posts/filtered-stream/introduction). Do not reopen the dismissed X connection or import scraper credentials without a new specific request.

## Evidence and completion rules

For each item, maintain this compact record:

```text
Item ID:
Status / owner:
Scope and relevant baseline commit:
Changed files / migration:
Fixture or runtime evidence:
Tests: command, date, result, known exceptions:
Source rights / credentials / spending approval if applicable:
Failure behavior and rollback:
Unresolved blockers:
Reviewer / approval:
Exactly one next action:
```

Proposed evidence location: `docs/evidence/<item-id>/`, containing redacted summaries and fixture references, not production tokens, account data or raw licensed content. Create it only as items are implemented. Do not mark an item complete because documentation or placeholder code exists.

Verification ladder for a code milestone:

1. Focused new tests plus relevant existing regressions.
2. Existing commands as applicable: `npm run test:crypto`, `npm run test:calculations`, `npm run check`, `npm run build`.
3. Record pre-existing failures separately; no new unexplained failures. Critical type/build issues must be resolved before release.
4. For UI/API changes, verify integration and affected desktop/mobile states, then update the existing preview through the normal deployment workflow.
5. Commit only scoped files; preserve runtime databases and unrelated changes. Push/publish only within verified authorization.

The original checklist/specification deliverable required no build or restart.
The subsequent authorized meme-scoring milestone has its own evidence and
runtime/preview verification in `MEME_SCORING_HANDOFF.md`.

## Credit-conserving resume protocol

- Read `AGENTS.md`, `docs/BATCAVE_STATE.md` and the next selected checklist section; do not reread the whole conversation or repeat the full audit.
- Confirm the next objective is authorized. Inspect the current diff and only relevant code paths.
- Use deterministic ingestion, calculations, caching and test scripts. No recurring AI polling, unrequested subagents or new monitoring schedules.
- Perform one bounded change, run focused checks first and build once per meaningful code milestone.
- After two failed attempts of the same approach, diagnose and record a blocker rather than repeatedly trying substitutes.
- Update the item evidence and compact state at completion. Never claim an exact Computer-credit budget or billing cap.

## Next proposed implementation

The first meme-scoring milestone is complete within its limited scope. Next
proposed objective: verify token-program/authority parsing and holder vault
identity, retaining UNKNOWN for unsupported or unverified cases.

Preserve iOS pause, optional X status, credential boundaries and cash-disabled
research mode. The authorization to start the meme area does not authorize
paid services, multi-user brokerage access or the entire roadmap at once.
