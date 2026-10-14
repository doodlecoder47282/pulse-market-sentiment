# Meme structure: what Batcave took from the "community coins" thread, and what it did not

Status 2026-10-14. Code: `shared/memeStructure.ts` (pure, 14 author tests +
20 independent review tests), `server/cryptoCommunityCore.ts` and
`server/cryptoCommunity.ts` (community watch: resolve, candles, derived
fields), `client/src/components/MemeStructure.tsx` (cards),
`server/cryptoEngine.ts` (structure fields on every tracked launch).

## 1. The source, read as evidence

A trader's X article (handle withheld here; the user supplied it) claims
$150k to $420k in 30 days on a public wallet, and argues:

1. Social trading made wallets public, attention into liquidity, and
   rotation visible.
2. New launches are structurally negative for a public buyer: devs,
   insiders, snipers/bots and popular traders are all ahead ("5th in line"),
   and fees plus slippage compound ($1,000 at 6% per round trip is $2 after
   100 zero-edge trades).
3. Memes split into speculative (news trigger), meta (copy of a template) and
   community (settled, deep, supply distributed, survived a -70% dip).
4. Launchpad tokens with revenue buybacks "own the casino".
5. Hold community coins and rotate from the top of one range to the bottom
   of another; the worked example turns $10k into $270k against $27k.

What the article is: a strategy essay with a referral funnel (fee-discount
link, Telegram, "upgrade to premium"). The P&L is on a third-party app and
was not verified here. The categories and the cost arithmetic are sound and
checkable; the rotation example assumes perfect timing and zero cost; the
"launchpad revenue" claim needs fee data this build does not fetch.

Verdict: not useless, but only parts of it are a data product. The parts
below are deterministic, testable from public keyless data, and descriptive.
The rest (copy-trade feeds, wallet-share-on-app, "trade people") is either
unavailable without that app's data or is advice, which the investor edition
does not give.

## 2. What was built

### Execution cost (`tradeCost`, `zeroEdgeBalance`, `maxSizeAtImpact`)

Constant-product pool with quote reserve Q = liquidity / 2 (DexScreener's
`liquidity.usd` is both sides). A buy of x after fees gets tokens worth
Q·x/(Q+x) at the quote, so the buy's price impact is x/(Q+x) (the Uniswap /
Jupiter definition); the pool's price after it is (1+x/Q)^2. The zero-edge
sell (quote back at the entry, same depth) returns Q·x/(Q+2x) before fees,
so the all-in round trip is 100·(size − net)/size. The break-even move is the
quote at which that sell returns the size spent; above the depth's cap there
is none and the field is null. Defaults: 0.25% pool fee and 1% app fee per
swap, $0.25 priority; stated on the card, editable in the calculator.

The published table reproduces: $1,000 at 2 / 4 / 6 / 10% for 100 trips is
$133 / $17 / $2 / $0.03. The old scanner guess `(size / liquidity) x 200`
is replaced by this on every WATCH / ENTER row.

### Line position (`linePosition`)

By pool age: under an hour, all four groups are ahead and a public buyer is
fifth; first day, launch-day holders ahead; first week, dev / insider /
sniper supply may still sit; after that, "settled", and the top-10 holder
share is the measurable residue. Public data cannot show who has exited; the
chip says so.

### Three categories (`classifyMeme`)

Speculative = narrative hit on a pool under 30 days; meta = template name
(sequel, derivative, chain port, fork, fee-share, launchpad, pyramid,
ai-agent) on a pool under 30 days; new-launch under 7 days; maturing 7-30;
community = 30+ days, $100k+ liquidity, top-10 at or under 30% where read,
mint authority not active, and firm only when every input was present and
history shows a 70% dip reclaimed to a new high. Missing inputs are listed,
never assumed: a watch token with no holder read is "community?" (tentative).

### Range and survival (`rangeStats`)

Daily closes, 90 calendar days: position in the close range, drawdown from
the window high, calendar days since the latest bar at that high, deep dips
(70%+ from a running high) reclaimed to a new high, an open deep dip, max
drawdown, 30-day realized vol, median daily volume. Fewer than 7 bars is no
data, fewer than 30 is partial, and both are shown as such.

### Hold vs rotate (`rotationIllustration`)

The published steps (A 3x; A −70% while B 3x; A 3x) with two things the
article leaves out: a timing-capture slider (what fraction of each top and
bottom the rotator catches) and the round-trip cost from the chosen pool.
At 100% capture and zero cost it gives the published $270k vs $27k; at 50%
capture and 2% cost it is about 4x, and at 0% the rotator is a holder paying
fees. It is arithmetic on entered moves, not a record of any coin.

### Community watch (`server/cryptoCommunity.ts`)

The owner lists Solana mint addresses (personal edition; 403 elsewhere; the
demo shows a labelled sample set). For each: deepest Solana pool from
DexScreener (`/latest/dex/tokens`), 120 daily candles from GeckoTerminal
(`/networks/solana/pools/{pool}/ohlcv/day`, 30 rpm shared with the scanner,
at most 4 history calls a minute, refreshed every 6 h), then the range,
cost and category fields above. Quote state and history state are separate:
not found, unavailable, partial and no data are different rows.

## 3. What was not built, and why

- Holder concentration and mint authority for watch tokens: the discovery
  desk reads these over public Solana RPC with cooldowns; wiring the same
  check to the watch is the next step. Until then the structural read for
  watch tokens is tentative by construction.
- Launchpad revenue / buyback yield: needs a fee source (DefiLlama is public
  and keyless) and a token-to-protocol map; not fetched yet, so no claim is
  made.
- Copy-trade feed, wallet share held on the trading app, leaderboard
  rotation: that app's data, not public market data.
- Any "rotate now" / range-bottom trigger: a trade instruction, excluded by
  the no-advice rule. The range figures are shown; the reader decides.

## 4. Verification

- `tests/quant/meme-structure.test.ts`: impact derived from reserves, the
  published compounding table, size-at-impact consistency, data states,
  categories with missing inputs, range counts on hand-built series,
  realized vol against a hand computation, the rotation example.
- `tests/quant/meme-structure-review.test.ts`: an independent reviewer's 20
  tests. Its 13 findings (round-trip double count, divergent break-even
  iteration, size under fees reported as ok, firm with missing inputs, NaN
  holder share, partial history treated as missing, name-pattern false
  positives, duplicate timestamps, days-since-high off by one, cost over
  100%, ratio on a wiped-out holder, even-count median, negative inputs)
  were fixed and the tests now pass.
- `tests/quant/crypto-community.test.ts`: pool choice, candle parsing, data
  states, derived fields, sample series.
- Live DexScreener / GeckoTerminal calls are not reachable from the
  development environment; the response shapes follow the published
  CoinGecko on-chain API reference (ohlcv_list rows: unix seconds, o, h, l,
  c, v; newest first) and the DexScreener pair fields already used by the
  scanner. First live run is the owner's check: a watch row should move from
  "quote pending" to a market cap within a minute and from "history pending"
  to a range within a few minutes.

## Sources

- Uniswap v2 core whitepaper (constant-product pricing).
- CoinGecko on-chain API reference, "Pool OHLCV chart by Pool Address"
  (GeckoTerminal data; `ohlcv_list` shape, limit 1000, `currency`, `token`).
- DexScreener API reference, pair object (`liquidity.usd/base/quote`,
  `txns`, `volume`, `priceChange`, `pairCreatedAt`).
- The user-supplied X article (community coins / rotation thesis).
