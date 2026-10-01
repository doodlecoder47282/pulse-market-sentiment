# Batcave: reliable evidence, precise AI and thumb-first experience

Version 1.0 • October 1, 2026 • Product and implementation framework

The product promise is a short, decision-ready explanation of what the evidence supports, what could invalidate it, and what to check next. Data acquisition, calculations, eligibility and risk remain deterministic; AI prioritizes approved findings rather than inventing certainty.

This document is a proposed target architecture and staged delivery contract, not a claim that every capability is implemented. It builds on the local `a49a1de` checkpoint and the preceding stock/crypto repair records. It authorizes no subscriptions, account creation, trading, public release or native iOS work.

## Problem statement

Batcave already collects useful observations, but source availability, historical continuity and calculation eligibility are uneven. A working API, a populated dashboard and a convincing explanation are three different things; none alone proves that a decision is accurate. The user needs the application to reduce uncertainty without hiding missing evidence or overwhelming a phone screen.

The current stock brief has a 29-listing universe, guarded quotes and structural references, ATR14, conditional volume/macro enrichment, partial cached news/earnings, fresh sampled options and opt-in AI curation. The crypto desk has grouped discovery, partial security and social evidence, liquid-market context and observational grading. Those are foundations, not complete execution systems.

The most consequential gaps are durable point-in-time evidence, exchange calendars and adjustments, consistent event/news coverage, genuine time-normalized volume, asset-specific seasonality, options interpretation, crypto exit capacity and ownership, continuous collection, and multi-user security. The prior 88 passing focused tests demonstrate bounded regression coverage, not future uptime or profitable signals.

## Goals

These are proposed product targets to measure, not current service promises. Baselines must be recorded before the first staged release.

- **Comprehension:** A user can identify the instrument, research posture, main reason, main risk and next step within 10 seconds.
- **Evidence integrity:** Every displayed factual claim resolves to admissible evidence; every number resolves to a versioned calculation or source field with units and observation time.
- **Operational honesty:** Every required gap changes the applicable output immediately. A failing provider must not silently become zero activity, a neutral verdict or another person's authorized data.
- **Useful brevity:** The default brief contains only decision-changing information, normally 120–180 words plus a compact reference strip. Critical risks are never removed to meet a word limit.
- **Phone and PC usability:** Primary actions work one-handed, without hover or mandatory swipes, while keyboard, screen-reader and enlarged-text workflows remain usable.

## Non-goals

- **Guaranteed accuracy or returns:** No system can promise flawless feeds, perfect forecasts, guaranteed stops or hack-proof operation. Testable controls replace those promises.
- **Autonomous execution:** No orders, wallet signatures, withdrawal permissions, personalized allocation or automatic position sizing in this framework's initial releases.
- **Cosmetic certainty:** No manufactured win probabilities, blended “AI confidence,” dealer-positioning claims from incomplete chains, or green badges awarded merely because an endpoint responded.
- **Unbounded expansion:** No collecting every available feed, repeated model councils, automatic AI polling, unofficial access bypasses or new paid services without approval.
- **Paused scope:** X remains disabled unless explicitly authorized. iOS/Xcode and SPY forecasts remain paused; phone-browser improvements do not require native work.

## User stories

- **Stock researcher:** As a stock/ETF user, I want a confirmed listing and horizon so that data from the wrong company, share class or period cannot shape my brief.
- **Liquid-crypto researcher:** As a BTC/ETH user, I want venue-specific market and derivatives context so that sampled observations are not mistaken for the entire market.
- **Meme-coin researcher:** As a token user, I want exact chain, contract and pool identity, supported security checks and size-specific exit evidence before enthusiasm influences the decision.
- **One-handed phone user:** As a mobile user, I want the decision and primary controls within comfortable reach, with smooth navigation that does not trigger accidentally while scrolling.
- **Returning user:** As someone reopening a brief, I want changes, expiry and broken assumptions identified rather than an old conclusion beside a new price.
- **Security-conscious user:** As a future connected-account user, I want authorization on the broker's own site and strict isolation from every other account.

## Requirements

### Current-to-target gap map

“P0” means required for the named release, not that every advanced metric must be built immediately. A capability may remain unavailable while unrelated, healthy research continues.

| Gap | Current boundary | Required repair | Observable completion gate |
|---|---|---|---|
| Source consistency | Mixed caches, timestamps and failure semantics | Shared source register, evidence envelope, freshness and correction policies | Expired, malformed, replayed and contradictory inputs cannot pass the same gates as usable observations |
| Instrument identity | Curated equities; crypto discovery identity separate | Canonical instrument registry and address/pool selection | Collisions, share classes, chain mismatches and symbol changes pass negative tests |
| Session history | Weekday approximation; holiday gaps suppress calculations | Venue calendar, early closes, timezones, corporate-action policy | Holiday, DST, split and incomplete-session fixtures pass without invented bars |
| Stock catalysts | Cold/partial cache; strict text matching misses legitimate stories | Incremental collection, reviewed entity mapping, event states and corrections | Available, empty-collected, incomplete and unavailable states are distinguishable |
| Volume and options | Full-day ratio is not RVOL; bounded chain only | Matched-time volume baseline and typed option-contract evidence | No direction, unusual flow or OI change inferred from missing or incompatible inputs |
| Seasonality | Asset-specific validation unavailable | Point-in-time history and fixed-window out-of-sample protocol | Sample size, uncertainty, selection bias and holdout results are inspectable |
| Liquid crypto | REST samples rather than continuous books | Sequence-aware streams and venue-specific reconciliation | Deliberate disconnect produces a gap state until reconstruction succeeds |
| Meme safety/capacity | Limited mint parser; reserves are not a sell route | Supported extension checks, verified vaults/owners and read-only route quotes | Unknown security or absent route blocks an actionable scenario |
| Social | Bounded attributed samples, incomplete networks | Comparable windows and an authorized incremental-coverage pilot | Sample caps/outages cannot become falling interest or stronger “organic” confirmation |
| Outcome grading | Observation coverage differs from executed returns | Persistent decision ledger, fill/cost assumptions and missing-outcome policy | Every evaluated result is reproducible; missing outcomes remain visible |
| AI and interface | Selection-only curator exists; dense evidence | Mandatory risk layer plus prioritized brief and progressive disclosure | Model cannot hide a hard blocker; users complete phone tasks without hidden controls |
| Security/operations | Personal prototype; multi-user release blocked | Isolation, token protection, auth, continuous hosting and recovery evidence | Security and operational release gates pass independently of UI/data tests |

### Source admission and purchasing policy

Reputation is necessary but insufficient. A primary company announcement can still be incomplete, an exchange can have an outage, and several publishers can repeat the same underlying story. Admission therefore happens per endpoint and data product, not just by brand.

Every proposed source needs a record containing owner, endpoint, permitted use, storage/display rights, authentication scope, upstream lineage, instrument coverage, timestamps, correction semantics, request limits, tested latency, observed failure modes, retention policy and fallback compatibility. A source remains `EVALUATING` until these fields and representative tests are complete; undocumented rights or guarantees remain unknown.

| Data role | Preferred route and verified documentation | Admission conditions and fallback |
|---|---|---|
| US quotes, bars and raw option chains | Retain the existing Schwab-primary implementation; inspect the current adapter and authorized account capabilities rather than changing providers by default | Confirm per-user entitlement and commercial redistribution scope before expansion. No Yahoo equities-price fallback; missing real-time permission stays visible. A compatible licensed secondary feed requires a separate decision |
| Filings and reported fundamentals | SEC EDGAR documents filer submissions and XBRL APIs, with metadata including tickers/exchanges and no API-key requirement ([SEC API documentation](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)) | Fetch server-side under SEC access rules. Map CIK, listing, filing acceptance time, period and amendments; EDGAR is not a comprehensive future earnings calendar or a tradable quote feed |
| Company news and earnings | Keep admissible existing cached events; evaluate Benzinga as one licensed structured candidate, not several overlapping subscriptions. Its news API exposes article IDs, created/updated fields and delta queries; its earnings API exposes event records, updates and a confirmed/tentative indicator ([news API](https://docs.benzinga.com/api-reference/news-api/get-news-items), [earnings API](https://docs.benzinga.com/api-reference/calendar-api/get-earnings)) | Verify trial access, exact coverage, correction delivery and display/storage rights. Cross-check material events with issuer filings/announcements. Provider-confirmed does not automatically mean independently issuer-confirmed |
| Exchange sessions | Version calendar rules against official venue schedules; NYSE publishes holiday dates and trading hours in Eastern Time ([NYSE calendar](https://www.nyse.com/trade/hours-calendars)) | A published schedule is not a live halt feed. Require separate instrument/session status and unscheduled-closure handling; never infer “open” from weekday alone |
| Listing history and corporate actions | Evaluate one reference-data service only if existing verified inputs cannot close the gap. Databento documents listing-level corporate actions with an explicit PIT option, adjustment factors and listing-status history ([reference API](https://databento.com/docs/api-reference-reference/client/reference)) | Confirm universe, rights and entitlement. Corporate-action PIT is not the default, and the documented adjustment-factor method does not expose the same PIT option; do not assume every reference endpoint is point-in-time safe |
| Macro observations and revisions | Retain FRED; use its real-time-period parameters to distinguish today's revised history from information known at a past date ([FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html)) | Store series, units, observation date, known-at/vintage and release metadata. Add consensus surprises only after a point-in-time consensus feed is approved |
| BTC/ETH spot microstructure | Upgrade eligible Coinbase observations through documented market-data channels; Coinbase describes per-product sequence numbers and gap/out-of-order handling ([WebSocket overview](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview)) | Implement each channel's actual synchronization contract. Do not generalize sequence rules between channels, promise gap-free delivery or label one venue consolidated |
| Crypto derivatives | Retain typed Deribit observations; its ticker provides instrument identity, provider timestamps and instrument-dependent OI units ([Deribit ticker](https://docs.deribit.com/api-reference/market-data/public-ticker)) | Keep inverse/linear/options units, funding periods, mark/index and expiry explicit. A second venue is additive only after units and timing reconcile |
| DEX discovery and pool observations | Retain existing discovery with exact-pool reconciliation. GeckoTerminal documents pool-address OHLCV and distinguishes null/unverified market cap from FDV ([GeckoTerminal FAQ](https://apiguide.geckoterminal.com/faq)) | Never select a different pool silently, treat FDV as market cap or infer exit capacity from reserve size. Preserve source lineage; two aggregators are not automatically independent observations |
| On-chain account/event evidence | Retain reviewed Solana methods and program allowlists; evaluate dedicated RPC service for production, since Solana says its public endpoints are rate-limited and not intended for production applications ([Solana clusters](https://solana.com/docs/references/clusters)) | Provider choice requires authorization and fault tests. Store slot/commitment/signature; compare eligible endpoints for high-risk discrepancies. Dedicated hosting is not proof of correct parsing |
| Solana size-specific route estimates | Evaluate Jupiter's quote-only mode: its documented order endpoint returns a quote without a transaction when `taker` is omitted, and exposes route/output/fee fields ([Jupiter order API](https://developers.jup.ag/docs/api-reference/swap/order.md)) | Authorized API access required; omit taker and never call build/execute/signing paths. Preserve smallest-unit amounts, fee conventions and percentage-point impact units. RFQ `expireAt` is not a universal route guarantee; a walletless quote does not prove a particular account can transfer or fill |
| Social attention | Keep exact-contract sample receipts; test Neynar only if authorized. Its cast search documents hashes, authors, timestamps, cursors and literal/time-filtered queries ([Neynar search](https://docs.neynar.com/reference/search-casts)) | Require incremental exact-contract coverage, matched windows and clear quotas. Prior pricing documentation conflicted; confirm actual entitlement. Social is sampled attention, not proof of token identity, demand or safety |
| Supplemental public news | Keep permitted Yahoo Finance news, issuer/protocol announcements and reviewed publisher feeds as attributed context | No assumption that public visibility permits scraping, full-text storage or redistribution. Unverified text cannot enter numerical risk calculations or impersonate primary evidence |

Start with the existing stack plus official reference data. If incremental collection still fails the measured catalyst-coverage gate, evaluate one licensed news/events provider. If RPC reliability still fails the on-chain gate, evaluate one dedicated provider with a tested contingency path. Buying data is a response to a demonstrated gap, not a substitute for validation.

### Evidence architecture and recovery

The proposed flow is:

```text
Approved providers
  -> bounded, authenticated collectors
  -> schema + identity + time + rights validation
  -> persistent evidence and correction log
  -> deterministic feature calculations
  -> asset/horizon eligibility and risk gates
  -> ranked approved claims + mandatory warnings
  -> optional AI selection
  -> mobile/desktop decision card
  -> paper observation ledger and quality monitoring
```

Retain React/Vite, Express and the existing data model while extending the schema additively. Use the current SQLite environment for bounded development; choose production storage after concurrency, durability, isolation and restore requirements are measured. Do not operate multiple independent writable SQLite copies as if they were one consistent service.

Each evidence record must contain these fields or an explicit null/reason:

```text
evidence_id, schema_version, instrument_id, asset_class
venue, chain, contract_or_mint, pool_id, quote_currency
source_id, upstream_lineage_id, endpoint_version, permitted_use
provider_event_id, event_time, published_at, provider_updated_at
received_at, first_seen_at, known_at, expires_at, time_precision
value_or_text, unit, adjustment_basis, session_id
status, reason_codes, observed_coverage, gap_ids
block_or_slot, commitment, correction_of, payload_hash
raw_evidence_location_if_permitted
```

- **Time discipline:** An observation date, publication time and receipt time are different fields. Point-in-time research uses what the system could know then, not a later corrected record disguised as original knowledge.
- **Persistence:** Store decision snapshots, calculation inputs, formula/config versions, source states and correction links. A hash verifies consistency of stored content; it does not prove the source was truthful or the log tamper-proof.
- **Collector behavior:** Use idempotent writes, persistent cursors, bounded pagination, per-source token buckets, backoff with jitter and circuit breakers. Never retry a denied endpoint through another identity or proxy.
- **Revision behavior:** Invalidate dependent claims when a source correction changes a material input. Retain permitted historical versions for replay; apply retention/deletion rules rather than an unconditional “keep forever” policy.
- **Recovery:** On restart, restore cursors, mark the interruption, reconcile retrievable events and retain an explicit unrepaired gap. A recent sample cannot erase a missing historical interval.
- **Fallback discipline:** Switch only when instrument, venue meaning, units, time basis and rights are compatible. Display the source change; do not average conflicting prices or select the provider that supports the desired thesis.

Proposed freshness policies below are initial test settings, not provider SLAs:

| Evidence | Research-display rule | Stronger use rule |
|---|---|---|
| Equity last trade | Preserve existing intraday 60-second and swing 300-second gates; disclose session and entitlement | A scenario needs contemporaneous executable bid/ask and verified session/halt status, not merely a recent last trade |
| Option contracts | Preserve under-60-second contract and underlying gates for descriptive samples | Tighten by strategy/market conditions; all legs, multipliers, expiry and costs must be compatible |
| Crypto spot/book | Initial stale threshold 5 seconds for a streaming research view, tested against actual feed behavior | Any sequence gap suppresses book-derived features until repaired; route quote expiry governs capacity |
| Completed bars | Eligible only after the authoritative session/bar closes and expected observations reconcile | Require declared adjustment basis and corporate-action handling before cross-session inference |
| News and events | Refresh collector health on a bounded schedule; retain material events beyond a simple “last 24h” cutoff | Block “no known event” claims unless collection scope, coverage interval and update status are sufficient |
| Macro | Use series-specific expected releases and vintage semantics | Do not force monthly series into a daily TTL or pretend every dated observation is intraday |
| Chain/security | Match slot, commitment, parser version and check age to the operation | Refresh critical mutable permissions and route conditions immediately before any future scenario use |
| Social | Comparable complete windows only; identify query limits and sampling caps | Outage, truncation or incompatible collection scope makes velocity unknown, not negative |

### Calculation registry

Every variable gets a formula ID, input evidence IDs, units, horizon, supported assets, adjustment/session basis, minimum-data rule, expiry policy and tests. These definitions are proposed contracts, not claims of predictive power. Missing dependencies produce null with a reason; formulas must never substitute arbitrary prices, zero Greeks or inferred timestamps.

#### Stocks and ETFs

| Variable | Deterministic definition | Gate and proper interpretation |
|---|---|---|
| Spread | With bid \(b\), ask \(a\), midpoint \(m=(a+b)/2\): \(10{,}000(a-b)/m\) basis points | Same instrument/session, positive uncrossed quotes and compatible timestamps; indicative transaction friction, not guaranteed fill cost |
| Classic structure | \(PP=(H+L+C)/3\), \(S1=2PP-H\), \(R1=2PP-L\) | Use the declared completed session/week and calendar; references, not automatic entries or targets |
| ATR14 | \(TR_t=\max(H_t-L_t,\lvert H_t-C_{t-1}\rvert,\lvert L_t-C_{t-1}\rvert)\); existing \(ATR14=\sum TR/14\) | Fifteen compatible completed bars; preserve simple-mean naming. A future Wilder variant requires its own formula/version and tests |
| Distance from structure | \(d=P-L\); percentage \(100(P-L)/P\); normalized \(d/ATR14\) | Fresh compatible price and reference inputs. Sign means location relative to the reference, not trade direction |
| Historical trend | \(r_k=C_t^{adj}/C_{t-k}^{adj}-1\); optional close versus a fixed moving average | State price-return versus total-return basis. Choose a small predefined horizon set; do not cherry-pick the strongest lookback |
| Matched-time relative volume | \(RVOL_\tau=V_{today,0:\tau}/median(V_{j,0:\tau})\) over the chosen prior comparable sessions | Proposed minimum 20 eligible sessions; match elapsed session, auction/extended-hours policy and partial/early closes. Current full-day ratio retains its NOT-RVOL label |
| Bar-based VWAP | \(\sum_i ((H_i+L_i+C_i)/3)V_i \,/\, \sum_i V_i\) | Complete interval coverage and real volume. Explicitly label an OHLCV approximation, not transaction VWAP; zero denominator means unavailable |
| Earnings proximity | Event timestamp minus snapshot timestamp | Distinguish date-only, tentative, provider-confirmed and issuer-confirmed. Unknown timing creates an uncertainty window, never an exact countdown |
| Earnings surprise | Where comparable consensus exists: \((actual-consensus)/\sigma_{\text{historical surprise}}\) | Require metric/period/basis consistency and pre-release consensus. Zero/insufficient dispersion or missing consensus suppresses standardized surprise |
| Options context | Same-scope call/put volume counts, bid/ask, IV percentile from comparable observations, and daily \(\Delta OI\) where timestamped OI history exists | Sampled chain is not the market. Volume/OI is not buyer intent; prior-close OI is not intraday OI; vendor IV needs method/units |
| ATM straddle reference | Same-expiry call mid plus put mid; percent of underlying if both quotes qualify | Label option-premium reference, not a calibrated forecast interval. Do not convert it into a success probability |
| Seasonality | Fixed-window adjusted returns, sample count, median, dispersion, hit fraction and uncertainty interval | Independent seasonal cycles, point-in-time constituents and corrections; disclose short history. No optimized-window “edge” without untouched validation |

For seasonality, a proposed research-display minimum is 10 eligible annual occurrences, with the actual count and uncertainty shown; less history stays “insufficient seasonal sample.” Ten observations are not evidence of robust edge. Promotion requires a preregistered window, selection-bias controls and an out-of-sample test rather than adding more decimal places to a win rate.

#### Macro and cross-asset context

Use a small, asset-relevant set: nominal rates, real yields, inflation expectations, dollar, credit spreads, equity risk and event timing. The FRED vintage model exists precisely because observation values can be revised; a historical backtest must not simply read today's revised values ([FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html)).

- **Yield slope:** Same-date 10-year minus 2-year yield, reported in percentage points; changes in yield levels may be converted consistently to basis points.
- **Real-yield/dollar change:** Fixed-horizon changes from explicit series or instrument observations. Gold/GLD research should inspect real yields, inflation expectations, dollar and gold's own structure separately; falling oil does not prove gold must rise.
- **Macro surprise:** Actual minus a documented pre-release consensus, optionally normalized against comparable historical surprises. If consensus is absent, display change from prior release and call it that.
- **Cross-asset correlation/beta:** Match return intervals, market sessions, currency and sample window; exclude missing intervals rather than filling them with zero. Display sample size and instability, not causal certainty.
- **Asset relevance:** Macro is a contextual risk layer for BTC/ETH and equities. For meme coins, safety, exit capacity and verified activity dominate; macro cannot rescue a failed local risk gate.

#### Liquid crypto and meme coins

| Variable | Definition or computation | Mandatory caveat/gate |
|---|---|---|
| Per-venue market state | Midpoint, spread and fixed-window return; realized volatility \(\sigma_{ann}=sd(\ln(P_t/P_{t-1}))\sqrt{A}\), with \(A\) the declared observations per year | Maintain venue identity and synchronization. Match interval/calendar and disclose annualization; no zero-filled gaps, mixed-frequency returns or consolidated label before a tested multi-venue adapter |
| Depth imbalance | For an explicit depth band: \((B-A)/(B+A)\), with bid/ask quantities converted to compatible notional units | Gap-free reconstructed book, nonzero denominator and disclosed band. Orders may cancel; imbalance is not guaranteed liquidity |
| Price impact/capacity | Difference between size-specific executable quote and contemporaneous reference, with direction, size, fees and expiry | Obtain read-only route quotes/simulation; reserves alone are insufficient. A quote is not a signed or filled transaction |
| Derivative premium | \(10{,}000(mark/index-1)\) basis points for a declared instrument | Mark/index premium is not automatically dated-futures basis. Preserve funding interval and instrument-specific OI units ([Deribit schema](https://docs.deribit.com/api-reference/market-data/public-ticker)) |
| Futures annualized basis | Where applicable: \((F/S-1)\times365/d\) | Compatible spot/contract denomination, positive days to expiry and clear simple annualization; not for perpetual funding by substitution |
| OI and funding change | Same-instrument OI difference/percentage change; reported funding rate with its actual period | Price effects and contract-unit changes must be distinguished; rising OI alone does not identify longs |
| Mint controls | Supported program and extension decoding; authority, mutability, transfer restrictions, delegates, fees and account state | Unsupported or unknown means UNKNOWN, not safe. CHECKED means the named controls were inspected, not rug-proof |
| Owner concentration | Aggregate verified token-account balances by owner; report top-\(k\) owner share of declared total supply | Identify pool/escrow vaults before exclusions; preserve numerator/denominator policy. Wallets are not necessarily independent people |
| Token transaction activity | Deduplicated swaps/transfers with signature, slot, direction, token amounts and declared USD conversion | Distinguish swaps from transfers and heuristic buyer classification from beneficial-owner knowledge; handle failed/reverted/unfinalized records |
| Liquidity change | Same-pool reserve/depth change across observed states, with valuation timestamp | USD reserve changes can reflect price moves; not automatically net deposits or investor inflows |
| Exact-contract social rate | \(r_t=U_t/\Delta t\), where \(U_t\) is distinct observed authors in a complete non-overlapping window | Rate is for the collected sample, not the network; aliases require reviewed contract mapping |
| Social change | \(r_t-median(r_{t-1},\ldots,r_{t-k})\); robust standardization only with sufficient nonzero baseline dispersion | Zero-baseline growth, capped queries, missing bins or too few authors produce an unscored observation, not infinite momentum |
| Repetition/concentration | Duplicate-content fraction and largest-author share within the collected sample | Diagnostic of concentration, not a definitive bot or manipulation classification |

Preserve existing social sample gates until a separately versioned experiment supports changes. Track exact contract links separately from ticker-only chatter, cross-network reposts separately from independent sources, and paid promotion separately from organic evidence. Sentiment is not required for the first reliable release.

### Decision logic and concise AI output

The output engine has four independent layers. Do not compress them into one opaque score:

1. **Admissibility:** Does the input meet source, identity, rights, timing, schema and unit requirements?
2. **Evidence coverage:** Which applicable domains are usable, partial, stale, missing, unsupported or unavailable?
3. **Research posture:** What can the current rules support, including contradictory evidence and mandatory blockers?
4. **Presentation:** Which approved statements best explain that posture to this user and horizon?

For internal diagnostics, define coverage as the sum of eligible domain weights divided by applicable domain weights, using frozen versioned weights. Missing required domains stay in the denominator; “not applicable” is determined by the asset contract, not provider failure. The user sees plain-language coverage and concrete gaps, not that internal percentage masquerading as a probability.

| Asset mode | Mandatory evidence for a useful research card | Additional blockers before any future trade scenario |
|---|---|---|
| Stock/ETF | Confirmed listing, usable price or explicitly historical context, compatible structure, event coverage status | Current spread/session/halt checks, corporate-action handling, material event window, reviewed strategy rules and cost model |
| BTC/ETH | Exact instrument/venue, market freshness, declared spot/derivative context and relevant incident/event status | Reconciled depth, venue/custody risk, costs, instrument funding rules and execution assumptions |
| Meme coin | Exact chain/mint/pool, supported current mint evidence, attributable market observations and explicit gaps | Verified size-specific sell route, transfer constraints, ownership/vault policy, costs, event continuity and conservative capacity limits |

Keep WATCH, PASS and INSUFFICIENT DATA until the appropriate validation gates pass. A PASS caused by risk is not the same as INSUFFICIENT DATA caused by collection failure. Neither becomes an ENTER merely because more news or social posts arrive.

The candidate-claim ordering is deterministic: mandatory blockers first, then material horizon-relevant events, then the strongest eligible structural/activity finding, then the strongest contradiction, then a useful next check. Correlated indicators belong to one evidence family, so five transformations of the same price series cannot become five independent confirmations.

#### Default decision card

```text
Instrument • asset / chain • horizon
As of [time] • [coverage state] • expires [time]

VERDICT    WATCH / PASS / INSUFFICIENT DATA
REASON     One sentence: strongest supported finding
RISK       One sentence: strongest contradiction or blocker
NEXT       One concrete research check or wait condition

[up to 3 relevant reference values, with units]
[Why this?] [Sources and gaps]
```

The first view contains at most three supporting facts and one primary risk, with every mandatory blocker still accessible and visibly flagged. No generic market essay, redundant caveats, irrelevant indicators, unverified causal story or jargon without a short explanation. If the missing information is essential, the main answer says so rather than placing the warning behind a drawer.

#### AI contract

Retain the present selection-only architecture as the first production candidate. The model receives approved claim IDs, materiality/eligibility labels, mandatory-warning IDs and source status, not credentials, account balances, unrestricted article bodies or access to external tools.

```text
snapshot_id
lead_claim_id
supporting_claim_ids[0..3]
counterevidence_ids[1..2]
next_check_ids[1..2]
```

The server adds all mandatory warnings independently of the model, resolves selected IDs to exact approved text, and rejects unknown, repeated, stale or mismatched references. Listing/horizon changes invalidate pending output. Source corrections and expiry invalidate dependent claims; cached model selections are not reused merely because the ticker is the same.

Free-form prose is optional later work, not necessary for sophistication. If introduced, it must be sentence-linked to evidence, preserve mandatory uncertainty, prohibit unsupported numbers and undergo adversarial evaluation. A fluent model's preference is not a validation result.

#### Trade scenarios and “edge”

Descriptive references can ship before executable scenarios. A later scenario engine requires a reviewed strategy, explicit direction and horizon, independently determined entry/invalidation/target rules, event/session and capacity gates, and an approved cost model.

For a hypothetical long scenario with compatible USD/share values, define entry \(E\), stop reference \(S\), target \(T\), conservative round-trip costs \(c\), and require \(S<E<T\). Planned per-share loss is \(E-S+c\); net target reward is \(T-E-c\); scenario reward/risk is their ratio when both denominators and rewards are valid. Costs must not be counted twice if already included in executable quotes.

A future risk-budget calculation could use \(\lfloor B/(E-S+c)\rfloor\), constrained by capacity and exposure limits, only after the user supplies a budget and the relevant release is approved. It is a planned-loss calculation, not a maximum-loss guarantee; gaps, failed fills and liquidity disappearance can exceed it.

Only prospective, after-cost, version-specific validation against a relevant baseline can justify an edge claim. Report uncertainty, sample size, market regimes and missing outcomes. A minimum sample count alone never proves profitability.

### Thumb-first interface specification

The visual direction is the existing restrained Batcave dark-and-gold identity, not a new animated trading theme. Use one accent for the primary action, neutral information surfaces and separately labeled warning/error states; preserve light mode and reduced-motion support.

#### Information architecture

- **Global navigation:** Propose four stable destinations: Search, Watchlist, Crypto and Activity. Place advanced tools in a labeled “More” surface rather than forcing a thumb to traverse a dozen primary tabs; validate this simplification with the owner before replacing established navigation.
- **Within an instrument:** Summary, Structure, Catalysts and Risk are visible tabs and optional swipe destinations. Evidence details open in an accessible sheet or inline disclosure, never as an unlabeled gesture.
- **Persistent context:** Keep instrument, horizon and freshness recognizable. Use one compact sticky header and one bottom dock; avoid competing sticky stacks.
- **Reachable actions:** Place Analyze/Refresh and optional AI near the lower reach zone when relevant. Keep selection confirmation close to the search field and keyboard; do not duplicate active buttons across overlays.
- **First useful screen:** Make the verdict and reason visible without a compulsory animation or daily ritual. Preserve any motivational routine as an optional feature rather than a blocking prerequisite.

#### Touch, swipe and motion contract

Apple recommends simple gestures with onscreen alternatives for core functionality and gives 44×44 pt as the default iOS/iPadOS control size; web CSS pixels and native points must not be conflated ([Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility)). WCAG 2.2 specifies a 24×24 CSS-pixel AA target-size minimum with exceptions and a 44×44 enhanced target, alongside gesture alternatives, visible focus and 200% text resizing requirements ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).

- **Product target:** Use 48×48 CSS-pixel hit areas for primary web controls and at least 8 CSS pixels of separation where practical. These are Batcave design targets, not a claim that WCAG mandates 48 pixels.
- **Swipe scope:** Horizontal swipes switch instrument subviews only. Vertical scrolling remains native; charts, range sliders, text selection and nested horizontal lists do not bubble into page changes.
- **Intent detection:** Start with a prototype threshold of roughly 40 CSS pixels and horizontal movement greater than 1.5 times vertical movement. Treat these as tunable usability settings; test slow thumbs, diagonal motion, accidental touches and cancellation.
- **System edges:** Do not capture gestures beginning in the browser/system back-navigation edge zone. No invisible swipe to place a trade, delete data, disconnect an account or spend a model request.
- **State preservation:** Keep instrument/horizon fixed during a tab swipe, remember each view's scroll position in transient state, and do not move cards under an active touch when data refreshes.
- **Sheet behavior:** Source/risk details must have a visible Close action, correct focus trapping/return, Escape support and enough bottom padding above the dock. Drag-to-close remains optional.
- **Motion:** Aim for 160–220 ms transitions, compositor transforms rather than layout animation, and no decorative particles or pulsing figures during research. Reduced motion removes nonessential transitions.
- **Safe areas:** Respect device insets and keyboard height. The dock must not cover a focused field, final list item, risk disclosure or the active button.
- **Alternative controls:** Every swipe action has a visible tap and keyboard equivalent; no hover-only tooltips. Screen-reader users receive clear tab names and restrained status announcements.

#### Typography and layout

Use 16–18 CSS-pixel body copy, compact 20–24 pixel headings and a 12-pixel absolute floor for secondary metadata. Use tabular numerals, explicit units and “as of” labels; reserve large numbers for two or three values that materially affect the decision. Do not display tiny numeric grids to simulate sophistication.

Aim for 4.5:1 normal-text contrast and 3:1 required non-text UI contrast, consistent with WCAG AA; glass effects must not compromise these thresholds ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)). Provide opaque/high-contrast fallbacks, reliable line wrapping and enlarged-text layouts without hidden labels or horizontal document scrolling.

On desktop, show the decision column and an evidence/structure column side by side with a readable maximum line length. On phone, render one column and progressively reveal secondary details; do not simply shrink the desktop dashboard. Give the search a visible button and explicit Enter handler to preserve the repaired embedded-preview behavior.

#### User-testing acceptance

Test Safari on a physical iPhone, Chrome on Android, desktop browsers and the actual embedded preview. Browser emulation is useful but not proof of thumb comfort or native-device behavior.

Use at least five representative testers for an initial directional usability pass, including left- and right-handed use. Test search, listing confirmation, interpreting a gap, switching views, finding the strongest risk and returning after expiry. Record completion time, missed targets, accidental transitions, accessibility problems and whether the user misunderstood WATCH as a recommendation.

### Security, source safety and account boundaries

The existing `SECURITY.md` records unresolved exposure and architecture issues: historical credentials, shared brokerage-token identity, unencrypted token strings in the inspected path, incomplete legacy API authentication, OAuth session binding and broad response logging. This framework does not re-audit or certify their current remediation; verified closure is required before adding users or widening sensitive access.

NIST CSF 2.0 organizes risk outcomes into Govern, Identify, Protect, Detect, Respond and Recover; it does not prescribe a particular implementation or guarantee security ([NIST CSF 2.0](https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf)). Apply SSDF to development practices, software protection and vulnerability response rather than treating a checklist as certification ([NIST SSDF](https://csrc.nist.gov/projects/ssdf)).

| Control area | Required work | Release evidence |
|---|---|---|
| Exposure and governance | Verify affected credentials revoked/rotated; inventory data rights, secrets and owners; document restricted research boundary | Redacted rotation/revocation receipts, reviewed history-scan findings and approved source register |
| Broker authorization | Authenticate users first; broker-hosted consent; server-bound one-time OAuth transaction; exact redirect validation and PKCE where supported by the approved flow | State/replay/redirect tests and provider capability approval. Never collect Schwab passwords |
| Tenant isolation | Server-derived owner on private records, caches, jobs, exports and streams; per-user broker grants and entitlements | Two-user negative tests across every legacy and new route; no cross-user fallback |
| Token protection | Managed encryption keys outside the DB, least privilege, rotation and revocation; no secrets in JavaScript, source history or build artifacts | Key/access review, artifact/secret scans and rotation drill |
| Untrusted sources | Allowlisted outbound destinations, redirect checks, private-network/metadata blocking, size/type/time limits, text sanitization and inert links | SSRF, malicious-feed, prompt-injection and malformed-200 fixtures; model has no execution tools |
| Application controls | Default-deny authorization, request/schema limits, CSRF protection appropriate to the session design, safe headers and restrictive content policy | Auth bypass, injection, origin, session expiry and abuse tests; independent review |
| Delivery and logging | Safe-field logs, dependency/SAST triage, SBOM, reviewed migrations and signed/reproducible release process where adopted | No raw broker/model secrets or personal financial payloads in logs; vulnerability dispositions and rollback record |
| Detection and recovery | Access/anomaly alerts, source-quality alerts, incident playbooks, encrypted backups and tested restore | Revocation exercise, restore test and recorded recovery time/data loss |

OAuth Security BCP recommends authorization-code approaches, restricted token privileges and exact redirect matching, and disallows the resource-owner password credentials grant; these are design requirements to reconcile with the broker's supported flow, not proof that the current integration meets them ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.pdf)).

Assume the repository and delivered client code can be inspected. Security must depend on server-enforced authorization, protected secrets and isolation, never on hidden routes or obscurity. A reputable upstream does not make untrusted article text safe to execute or a third-party package safe to install.

### Delivery stages and implementation ownership

Owners below are responsibilities to assign, not an invented staffed team. One bounded stage or ticket is executed at a time by default; source approvals, security remediation and user testing may have external dependencies.

| Stage | Scope and concrete outputs | Code/data touchpoints | Exit gate |
|---|---|---|---|
| A: boundary and contracts | A01 verify exposure status; A02 source register; A03 shared evidence/identity schema; A04 baseline quality dashboard | `SECURITY.md`, `shared/schema.ts`, new evidence contracts, existing source adapters | Owner approves release scope; private expansion blocked until security evidence exists; every source has a declared contract |
| B: history and persistence | B01 venue calendars; B02 adjustments policy; B03 evidence/decision/correction ledger; B04 cursor recovery and backups | `stockBarsCache.ts`, `tradeBrief.ts`, storage migrations and collector checkpoints; consult `spyFeaturePipeline.ts` replay contracts as a read-only reference | Replay identical snapshots; holiday/split/gap tests pass; restore on isolated copy works. No SPY forecast work or restoration |
| C: useful stock brief | C01 incremental news cache; C02 event status/corrections; C03 matched-time RVOL; C04 options metadata; C05 conditional seasonality research | `news.ts`, `earnings.ts`, `tradeBriefEnrichment.ts`, `shared/tradeBrief.ts` | Same-input replay and source freshness pass; missing calendars/rights/coverage never turn into no-event claims |
| D: crypto prerequisites | D01 venue stream reconstruction; D02 supported-program/security expansion; D03 owners/vaults; D04 read-only exit quotes; D05 attributed social pilot | `cryptoEngine.ts`, `cryptoContext.ts`, `cryptoSocial.ts`, mint parser, pool/owner/route adapters | Fault injection and exact-identity gates pass; denied/unsupported sources remain explicit; no ENTER promotion |
| E: concise AI and thumb UI | E01 mandatory-warning layer; E02 ranked claim families; E03 four-part decision card; E04 tab/swipe/sheet prototype; E05 device testing | `tradeBriefAi.ts`, `shared/tradeBriefAi.ts`, `TradeBriefSearch.tsx`, `TradeBriefAi.tsx`, crypto views and CSS | AI adversarial suite and usability tasks pass; no automatic model request or hidden material risk |
| F: paper validation | F01 preregister one strategy/universe; F02 execution/capacity assumptions; F03 prospective ledger; F04 out-of-sample evaluation | Versioned strategy config, outcome ledger, replay/validation jobs | After-cost results, uncertainty, missingness and baseline comparisons reviewed; no automatic success threshold based only on sample count |
| G: production gate | G01 always-on deployment; G02 tenancy/OAuth security; G03 independent test; G04 monitored burn-in and incident drill | Auth/storage/runtime, CI, secret manager, observability/runbooks | Product, security, operations and data-rights approvals all pass for the enabled scope |

Stage E can prototype its interface using clearly labeled fixtures after Stage A, without waiting for every optional feed. It cannot label unavailable Stage C/D evidence as live. A restricted single-user research release may ship earlier than multi-user brokerage or trade-scenario features.

#### Initial implementation queue

| Ticket | Priority / responsibility | Given / When / Then acceptance |
|---|---|---|
| A01 Security boundary | P0 for sensitive expansion / owner + security reviewer | Given previously recorded exposure, when expansion is proposed, then require verified revocation and an approved isolation plan; otherwise keep expansion blocked |
| A02 Source contract register | P0 / data engineering | Given an unregistered endpoint, when an adapter submits evidence, then reject it with a reason rather than displaying it |
| A03 Typed evidence | P0 / backend | Given wrong identity, unknown units, missing observation time or disallowed use, when processing an input, then suppress dependent claims and retain diagnostics |
| B01 Calendar/adjustments | P0 for historical inference / data engineering | Given a holiday, early close, DST shift, split or partial bar, when calculating a baseline, then use the declared policy or return unavailable without invented bars |
| B03 Replay ledger | P0 / backend | Given a saved snapshot and exact versions, when replayed offline, then reproduce values, gates, reasons and claim text |
| C01 News deltas | P0 for catalyst completeness / data engineering | Given a corrected or syndicated story, when ingested, then update its event lineage and invalidate affected claims without counting repetition as corroboration |
| C02 Event uncertainty | P0 for scenario gating / backend | Given an unconfirmed or date-only event, when assessing proximity, then expose an uncertainty window and withhold a false precise countdown |
| D04 Exit capacity | P0 before meme scenarios / on-chain engineering | Given a failed, stale, unsupported or over-capacity sell quote, when evaluating the token, then no positive social score can override the blocker |
| E01 Mandatory warnings | P0 / AI integration | Given a model that omits the principal risk, when rendering its valid ID selection, then the deterministic mandatory risk is still displayed |
| E04 Thumb navigation | P0 for redesigned UI / frontend + usability reviewer | Given diagonal scroll, chart pan, keyboard focus or system-edge gesture, when navigating, then no unintended tab switch or covered control occurs |
| F03 Honest outcomes | P0 before edge claims / research reviewer | Given a collection gap or ambiguous fill, when grading, then retain unknown/partial classification and include it in coverage reporting |
| G02 Tenant isolation | P0 for multi-user release / security reviewer | Given users A and B, when A changes IDs or replays B's callback, then no read/write/export/disconnect of B's records is possible |

### Validation, operations and credit discipline

Validation has three independent tracks: data/software correctness, decision usefulness, and interface comprehension. Passing one cannot substitute for another.

- **Correctness:** Golden formula fixtures, dimensional/unit checks, zero/null distinctions, adversarial identity tests, cross-source disagreement, schema changes, timestamp boundaries, corrections and deterministic replay.
- **Route safety:** Test quote-only operation without a wallet, integer amount conversion, direction-specific price-impact semantics, included-versus-additional fees, route expiry and unsupported transfer restrictions. No test may sign or submit a transaction; account-specific transferability remains unknown without a separately authorized validation path.
- **Research:** Freeze strategy/version before evaluation; use point-in-time data, costs and liquidity assumptions; account for survivorship, overlapping labels and multiple-window selection. Separate exploratory work from untouched and prospective evaluation.
- **Outcome accounting:** Calculate net return from eligible modeled or observed fills, explicit fees and impact, rather than from the next convenient quote. Path-dependent maximum favorable/adverse excursion requires adequate path coverage; a missing path cannot be recorded as a clean win, loss or safe drawdown. Report abstentions and unobservable outcomes beside evaluated trades.
- **Observability:** Record successful collections, expected/received observations, ingest delay, gap age, eligible-claim coverage, correction lag, model attempts and release version. Provider heartbeat and asset coverage are separate metrics.
- **Continuous service:** Collection must run in an approved always-on environment with checkpoints and alarms. A live preview is not proof of continuous history or an availability SLA.
- **Model budget:** Retain explicit-click AI, cached attempts, no automatic retries and the existing 6/hour and 30/day shared caps until usage evidence and owner approval justify a change. Add per-user ceilings before multi-user operation.
- **Provider budget:** Batch by endpoint, share public evidence only where rights permit, cache by exact identity/contract/version, prioritize watched instruments fairly, and stop pagination at documented caps with a truncation flag.
- **Agent workflow:** Read this framework and the latest checkpoint first; inspect only relevant changed files, run focused tests, then one coordinated build/QA/deploy where practical. Do not repeat the council or full audit by default.
- **Rollback:** Preserve versioned schemas/configurations and a kill switch for each adapter/feature. Roll back to a clearly labeled narrower research mode, not to synthetic data or a hidden stale cache.

Before promoting a stage, attach its tests, redacted live examples, source-rights review where applicable, remaining gaps and rollback procedure. Updating a status requires that evidence, not merely an agent's completion message.

## Success metrics

Targets below are initial acceptance proposals. Measure the current baseline during Stage A, then review scope and feasibility before setting contractual service commitments.

| Outcome | Proposed target | Measurement and evaluation window |
|---|---|---|
| Traceable output | 100% of displayed numeric/factual claims resolve to evidence and versions | Automated contract checks on every release; sampled replay in the restricted pilot |
| Safety-gate integrity | Zero stale/unknown mandatory inputs promoted by tested paths | Adversarial fixtures, outage drills and correction tests before every relevant release |
| Data availability | At least 99.5% scheduled collection success and 95% eligible required-domain coverage within the declared supported universe | Separate denominators; track across a 14-day burn-in including applicable market sessions. Do not remove failing assets from scope to improve the metric |
| News/events quality | At least 98% measured attribution precision on a reviewed sample of at least 200 candidate items, with critical wrong-entity errors blocking promotion | Stratify common-word tickers and share classes; report sampling uncertainty and test missed events against an independently curated reference set |
| Brief speed | Cached deterministic brief p95 under 1 second; cold partial-result response p95 under 3 seconds with explicit slow-source status | Real server/browser telemetry over burn-in; slow optional sources must not block usable evidence |
| AI reliability | All accepted outputs satisfy ID/expiry/warning contracts; zero automatic calls on search, swipe or refresh | Server attempt ledger and UI integration tests; report fallback rate rather than hiding failed calls |
| Comprehension | At least 90% task completion in the initial usability pass; median main-answer recognition under 10 seconds | Representative users, not only the builder; small pilot results remain directional |
| Thumb interaction | Accidental tab changes below 2% of tested navigation attempts; all primary actions have reachable tap alternatives | At least 100 scripted/observed gesture attempts across devices, handedness and accessibility modes |
| Accessibility | No relevant WCAG AA failures in tested flows; 200% text and visible focus preserved | Automated checks plus manual keyboard, VoiceOver/screen-reader and real-device review |
| Recovery | Initial research-pilot target: restore within 60 minutes and at most 15 minutes unrecoverable durable research state | Measured restore drill; zero silent continuity claims after an outage. Reassess tighter needs before any future execution use |
| Research value | Better after-cost decision outcomes or useful risk filtering than the preregistered baseline, with uncertainty and abstention rates reported | Strategy-specific prospective period and power analysis; no fixed universal trade count substitutes for evidence |

## Open questions and decisions

Defaults below allow the first specification and fixture work to proceed without purchases or unnecessary clarification. Blocking questions are resolved before the affected release, not by silently broadening assumptions.

| Decision | Default / recommendation | Owner and blocking point |
|---|---|---|
| First supported release | Existing 29 equities/ETFs, BTC/ETH context and the explicitly supported Solana token subset | Product owner; approve expansion before adding universes |
| News/events spending | Existing plus official sources first; one licensed structured candidate only if measured gaps remain | Owner; blocks purchase/access, not fixture development |
| Social pilot | Conditional authorized Neynar trial; no X reconnection or fabricated completeness | Owner + data reviewer; blocks credentialed pilot |
| Production RPC/hosting | Select after capacity and recovery requirements are measured; public endpoints remain prototype-only for this purpose | Owner + operations/security; blocks continuous-service claim |
| Schwab multi-user rights and OAuth capabilities | Confirm directly under the approved application/product agreement | Owner + qualified security/legal review; blocks additional accounts and public rollout |
| Credential-exposure closure | Treat as unverified until evidence of revocation/rotation is recorded securely | Account owner; blocks sensitive expansion |
| UI navigation simplification | Prototype four global destinations and four instrument subviews with tap and swipe parity | Product owner + testers; approve before replacing familiar primary tabs |
| Risk budget and live orders | Not part of the initial release | Owner; requires a separate scoped request and reviewed controls |
| Native iOS and SPY forecasts | Remain paused/disabled | Only a new explicit authorization and their independent validation gates can change this |

The next bounded work package is Stage A's source/evidence contract register plus Stage B's calendar and replay design. This removes repeated ambiguity before adding another feed or a more persuasive AI paragraph, while the thumb-first layout can be prototyped against honest fixtures without changing live financial conclusions.
