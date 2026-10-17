# Batcave: crypto evidence review and grouped desk

September 30, 2026. Read-only research scope. Native iOS remains paused.
This is an implementation and source-quality review, not a profitability,
security certification, or institutional-readiness certificate.

## Verdict

The previous crypto page was about 5/10 for usability in my assessment.
It hid most rejected candidates, repeated cautions without explaining the
underlying gaps, and combined operational health with evidence completeness.
The replacement makes the decision, coverage and reasons visible first.
Visual polish does not upgrade the validity of a strategy.

## What the live audit found

The pre-change runtime snapshot reported 220 tracked pools but returned only
80 candidates. Of those 80, 59 lacked liquidity, 65 lacked a completed security
check, all 80 lacked the previous holder-concentration field, and 75 lacked a
social score. All 80 were PASS. Only two reported fully available sampled
social coverage. These are one observed snapshot's counts, not a stable SLA.

The old routine's successful heartbeat could therefore coexist with poor
token coverage. Unknown liquidity was also coalesced to zero in risk logic.
Gecko discovery could silently substitute FDV for circulating market cap.
Mint parsing treated an absent authority key as a revoked authority, without
requiring a supported program or an initialized mint account.

The bounded direct multi-pool test returned both requested exact Solana pools
and a reserve field for each. That justified an exact-pool liquidity repair
adapter, not a claim of executable exit liquidity.

## Implemented now

| Area | Change | Remaining boundary |
|---|---|---|
| Grouped UI | Overview, meme discovery, BTC/ETH, news/macro, data coverage, outcomes. Search, filters, sorting, expandable candidates and full returned-universe access. | Responsive browser, not a native iPhone build. |
| Discovery | Return the bounded tracked universe rather than the old 80-row slice; PASS candidates visible. | Discovery itself remains a limited Solana new/trending-pool window, not every token. |
| Liquidity | Preserve legitimate zero; maintain source and receipt time; repair missing reserve data by exact chain/pool in bounded Gecko batches; expire old evidence. | Reserves are not a sell-route quote, impact curve, net exit proceeds or independent beneficial-owner evidence. |
| Market cap | No silent FDV substitution in current research qualification. FDV stays separately labeled. | Provider circulating-supply methodology remains external evidence, not independently reconstructed. |
| Mint checks | Require original SPL program, initialized mint, explicit authority keys, valid supply and decimals. Record RPC slot; refresh all checks and fail closed on unsupported/stale/unknown inputs. | Token-2022 and other programs remain unsupported. Confirmed commitment is not finalized event history. |
| Holder concentration | Stop excluding the largest token account as an alleged pool. Use exact-integer arithmetic on raw top accounts and label pools/owners unverified. | No verified vault exclusion, wallet-owner aggregation or related-wallet clustering. No raw-account concentration trading score. |
| Social | Distinct authors, duplicate-post URI/text diagnostics, sampling cap, missing timestamps and comparable reply windows. Remove positive points for links/livestream flags; prioritize near-qualifying candidates. | Cashtags are not verified mint attribution; no comprehensive velocity, bot-proof signal or X coverage. |
| News | Shared crypto narrative/headline parser, attributed links, canonical-URL deduplication, per-feed health, separate publication/receipt/first-seen times, official release feeds. | First-seen tracking is bounded in memory, not a durable immutable news archive. Exact URL dedupe is not event clustering. |
| Liquid markets | BTC/ETH Coinbase spot observations and Deribit inverse-perpetual context, with units and timestamps. | Samples, not continuous book reconstruction, cross-venue consolidated flow or an execution engine. |
| Chain/macro | DefiLlama Ethereum/Solana TVL and dated existing FRED observations; receipt-only TVL is PARTIAL. | No net-flow inference, macro surprise, macro vintage guarantee, token unlock or stablecoin supply substitution. |
| Research ranking | Version `meme-research-2026-09-30.2`; conservative mint/liquidity gates and revised social evidence. | WATCH/PASS only; no calibrated odds, ENTER permission or validated strategy. |

## Source decisions and research

These source choices were checked against first-party documentation. Public
access is not a guarantee of service, complete coverage, geographic eligibility
or permission to redistribute a commercial dataset.

| Need | Source decision | Why and limits |
|---|---|---|
| Spot price, spread and volume | Coinbase Exchange public ticker and stats for BTC-USD and ETH-USD. | The ticker supplies last-trade time, bid, ask and volume; stats use base-currency volume and quote-currency prices. Use receipt time only for untimestamped 24h statistics. This is REST sampling, not a streaming book ([ticker documentation](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker), [stats documentation](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-stats)). |
| Missing pool reserves | Exact-pool GeckoTerminal fallback beside DexScreener, not an unrelated token pool. | The public API documents a 30-call/minute limit; bounded 20-pool batches avoid individual per-token request storms. The implementation test verified the multi-pool response and reserve field, but is not a throughput guarantee ([GeckoTerminal FAQ](https://apiguide.geckoterminal.com/faq)). |
| FDV vs market cap | Keep them separate; missing market cap blocks market-cap-dependent qualification. | CoinGecko's on-chain documentation warns that unverified market cap can be null and that displayed FDV-like values may not be accurate circulating market cap ([token-data documentation](https://docs.coingecko.com/demo/reference/tokens-data-contract-addresses)). |
| Funding and open interest | Deribit BTC/ETH inverse perpetual ticker observations. | The public ticker specifies provider timestamps and USD amount units for perpetual/inverse-futures open interest. Raw `funding_8h` is retained without inventing annualization. Mark/index premium is calculated separately, never called consolidated futures basis ([Deribit ticker schema](https://docs.deribit.com/api-reference/market-data/public-ticker)). |
| Chain activity | DefiLlama chain TVL is integrated; stablecoin supply is a distinct next adapter. | The free API documents chain TVL and separate stablecoin/circulation endpoints. TVL cannot stand in for inflows, stablecoin supply or a token's demand. Current chain response lacks an observation timestamp, so this adapter exposes PARTIAL receipt-time context ([DefiLlama free API](https://api-docs.defillama.com/llms-free.txt)). |
| Mint and token accounts | Native Solana parsed-account evidence, supported-program allowlist, unknown-state gates. | A mint account differs from a token account, and a token-account owner differs from the program owner. A top account is therefore not inherently a verified AMM vault or beneficial owner ([Solana token/account documentation](https://solana.com/docs/core/tokens)). |
| Headlines and macro | Attributed publisher RSS plus official releases and existing dated FRED observations. | Feed parsing rejects HTML success pages, disallows credential-bearing or executable links, preserves absent dates and constrains redirect hosts. No article text can execute tools or change risk logic. Detailed live provider state is visible in Data coverage. |

## Missing data: what must happen next

- **Executable liquidity:** Obtain a read-only, size-specific sell quote or simulation with route, fees, slippage, quote age, expiry and failure reason. Never use reserve size alone to estimate what can actually be sold.
- **Verified ownership:** Parse supported DEX pool accounts to identify real vault addresses, resolve token accounts to owners, and only then calculate concentration with a disclosed pool-exclusion policy.
- **Token-2022 controls:** Add program-specific extension decoding and tests for transfer hooks, permanent delegates, freeze/default state, transfer fees and unsupported extensions. An unsupported program stays UNKNOWN/PASS meanwhile.
- **Event continuity:** Record swaps/transfers/liquidity events with signatures and slots, repair gaps from retrievable history, and track confirmation/finality. Aggregate five-minute transactions do not establish unique buyers or durable demand.
- **True social velocity:** Match known project/address identities, preserve comparable windows, authors, repost concentration and query coverage. An outage or incomplete sample cannot become falling interest. X remains disabled unless explicitly authorized.
- **Liquid-market depth:** Reconstruct an eligible venue's depth stream with sequence checks, reconnect/repair tests and timestamps. Add a separate venue before using a cross-venue confirmation label.
- **Crypto-native macro:** Validate the stablecoin supply endpoint/coverage and chain accounting before computing changes. Add attributed unlock/protocol incident sources, not generic keyword matches.
- **Point-in-time storage:** Persist source/event/receipt times, hashes, versions and gaps with decision snapshots. Current caches and a hashed response are not a durable immutable audit ledger.
- **Validation:** Freeze a strategy/version, model realistic costs and unavailable outcomes, and run prospective out-of-sample comparison against market-only baselines. A larger feed count is not evidence of profitable decisions.
- **Operations/security:** Verify always-on hosting, restart recovery, backups, credential rotation and tenant isolation independently. This UI/data work does not resolve existing multi-user release blockers.

## QA inventory and release boundary

Required checks: production build; unchanged TypeScript baseline; focused
crypto parser/scoring/reliability regressions; exact pool identity, zero/missing,
unsupported mint, capped social and stale quote fixtures; live adapter status.
Browser checks cover all six groups, token search/filter/sort/expansion,
source details, outcomes, refresh, no-result/error states, keyboard access,
light/dark themes and desktop/phone overflow.

Results are recorded in `CRYPTO_DESK_RELEASE.md` after the coordinated build.
No new accounts, paid feeds, wallet permissions, X reconnection, trading or
unattended AI monitoring are authorized or enabled by this change.
