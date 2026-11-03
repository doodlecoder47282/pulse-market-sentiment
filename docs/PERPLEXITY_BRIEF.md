# Batcave: brief for an outside assistant (Perplexity or any other)

Paste this whole file as the first message. It says what Batcave is, how it
models things, where the truth lives in the repository, and what to check
before saying anything "aligns". Repository:
https://github.com/doodlecoder47282/pulse-market-sentiment (public; branch
`main` is what runs).

---

## What you are looking at

Batcave is a private market terminal: a React client (`client/`), an Express
server (`server/`), shared pure modules (`shared/`), SQLite storage, and an
iPhone shell (`ios/`) that loads the UI live from the owner's server. Tabs:
Signals, Chart, Models, Heatseeker, Trade Desk, Regime, Cosmos, News, Take
Five, Edge Lab, Crypto. Equities and options data comes only from Schwab's
Market Data API through the owner's own login. Crypto comes only from public
keyless feeds. Nothing in the app places orders.

## The standard every number is held to

1. Every number shown is correct arithmetic on a named source, labelled with
   its data state and, for the crypto desk, the rule version that produced it.
2. Missing, stale, blocked, partial and observed-zero are different states.
   A failed read is never shown as zero, quiet or healthy.
3. Scores are heuristics, not probabilities. A graded sample under its gate
   is counts, not a claim. Passing a predefined test is not a forecast.
4. Copy is descriptive: no "expect", "will", "edge", "high probability",
   no advice verbs.
5. No brokerage secret or wallet key ever appears in code, docs or the
   phone build. The repo is public.

## How the equities side models things

- Dealer gamma per strike: open interest (plus a quarter of the day's volume
  on the 0DTE map), each contract's gamma re-priced with Black-Scholes from
  the chain's implied volatility on a clock that runs to the real settlement
  instant (SPX AM-settled at the 09:30 SOQ, SPXW PM at 16:00), calls
  positive and puts negative (dealers short customer longs). Wall above =
  largest positive exposure above spot; magnet below = largest positive
  below; flip = re-priced zero crossing nearest spot; pin = largest positive
  within 1.5% of spot. Code: `server/gammaProfile.ts`,
  `server/odteForward.ts`, `shared/odteMap.ts`.
- Flow: a print counts when premium clears the floor, volume is at least 15
  times open interest or the strike is new, 1-3 days to expiry, bought at
  the ask (calls up) or hit on the bid (puts down). `server/schwabFlow.ts`,
  `server/flowAlertEngine.ts`.
- Setups: a stated condition met at an instant (spot at a landmark, the
  gamma sign the rule needs, a confirming print, a quiet tier-1 calendar, a
  session window, target clearing the cost model by 3x and the invalidation
  by 2x). Rule book `shared/setupRules.ts` (versioned, pinned); detector
  `shared/setupDetect.ts`; engine `server/setupEngine.ts`. No grade letter
  until a rule version has 100 graded setups.
- Term structure: three conventions exist and each screen names its own
  (VIX9D/VIX, VIX/VIX3M, VIX3M/VIX).
- Live verification: Settings -> Verify live data (`server/liveVerify.ts`,
  `shared/liveVerify.ts`) reaches every panel route and recomputes the key
  numbers from the raw chain, quotes and bars.

## How the crypto desk models things

Read `docs/CRYPTO_DESK.md` in full; it is the charter. In short: GeckoTerminal
new pools -> DexScreener pair state -> Jupiter price cross-check -> on-chain
facts over public Solana RPC (mint/freeze authority, top-10 holder share) ->
rugcheck -> verdict (hard kills -> PASS; score and flow floors; fail-closed
gates: flow sustained, security read, Jupiter agree/watch, sells observed,
top-10 read, desk risk on) -> ENTER. Sizing = 0.5% of pool liquidity capped
at $400; cost = constant-product impact plus fees on both legs. Every
threshold lives in `shared/cryptoRules.ts` under `CRYPTO_RULES_VERSION`.
Every signal is graded (HIT_5M / DOUBLED / DEAD / RUGGED / NO_DATA) and the
expectancy card reports three exit rules net of cost, with a 50-signal gate
and a survivorship check (over 20% unpriced past the horizon ->
INSUFFICIENT DATA). Desk risk: BTC vs its Kraken 24 h VWAP, off at -5%,
stale -> unknown (fails closed).

## Where the truth lives (check these, in this order)

1. `AGENTS.md` — the standing rules and the owner's decisions.
2. `docs/BATCAVE_STATE.md` — dated log of every objective, what was verified,
   what remains unverified. The newest entries are the current state.
3. `docs/CRYPTO_DESK.md`, `docs/REVIEWER_BRIEF.md` — the crypto charter and
   the brief given to independent reviewers.
4. `shared/cryptoRules.ts`, `shared/setupRules.ts` — the rule books. If a
   number on screen or in a claim is not in a rule book, ask where it came
   from.
5. `tests/quant/*.test.ts` — 780+ tests; the ones named `*-version`,
   `schwab-semantics`, `audit-pass-2`, `crypto-verify`, `live-verify` pin
   the behaviours above. CI (`.github/workflows/quant-fixes.yml`) runs them
   on every push plus a demo smoke test and a 7-viewport UX audit.
6. `client/src/pages/method.tsx` — the Method & disclosures page the end
   user sees; it must agree with the code.

## What to check before saying something aligns

- Does the claim name its source and its state? If a value could be missing,
  what does the code show then — look for `?? 0` and `|| 0` on feed fields.
- Is the formula the one the charter states? Recompute one example by hand.
- Is the threshold in the rule book, and is the version on the row or the
  payload?
- Does the copy describe, or does it predict/advise?
- Does the test suite pin it? If not, say so; a behaviour without a test is
  unverified.
- For Schwab payloads: `volatility` is percent, `-999` is a sentinel,
  `daysToExpiration` is in the chain key, index quotes have no bid/ask.
- For crypto payloads: DexScreener and GeckoTerminal fields are nullable;
  GeckoTerminal may write FDV where it has no market cap (`mcapBasis` says
  which).

## What not to do

- Do not propose yfinance, CBOE, OpenBB or any non-Schwab equities source.
- Do not propose a keyed or paid crypto service without flagging that it
  needs the owner's approval.
- Do not propose LLM "committees" that vote on trades; the desk is
  deterministic rules with a graded record.
- Do not propose execution. The desk reads and grades.
- Do not describe anything as an edge, a probability or a forecast unless
  the graded record in the app says so for that rule version.

## The goal, stated once

A professional-grade, profitable trading system for meme coins and a
correct, honest read of the options market — where "profitable" is a label
the record earns, out of sample, net of cost, and never a sentence anyone
writes first.
