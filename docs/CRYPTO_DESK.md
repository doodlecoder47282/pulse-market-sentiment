# Crypto desk charter

Standing directive (owner, 2026-10-27): build a professional-grade, profitable
trading system for meme coins. "Profitable" is a measured result, never a
claim: the desk records what its rules would have done, net of cost, and
labels the result with the tests it passed. This file is the desk's memory:
what it is for, where every number comes from, how it is calibrated, how it
is verified, and how it is reviewed. Read it with AGENTS.md before touching
anything under the Crypto tab.

## 1. Goal and the standard

- Find Solana meme coins early enough, with enough exit liquidity, that a
  small fixed position can be ridden toward a stated target; grade every
  signal; let the graded record, not the narrative, decide whether the rules
  pay.
- Every number shown is correct arithmetic on a named source, labelled with
  its data state and its rule version. A reader must be able to recompute it.
- Missing, stale, blocked, partial and observed-zero are different states.
  Failed collection is never zero activity, never a healthy read.
- Scores are heuristics. A graded sample under the gate is counts, not a
  claim. Passing a predefined test is not a forecast.
- The desk reads and grades. It never places orders. Execution, if it ever
  exists, lives in a separate private executor with a stake-only wallet, a
  daily loss cap and a kill switch, and starts in approve-each-trade mode.
  No wallet key ever touches this repository (public).

## 2. Data: sources, retention, access

Public, keyless feeds only unless the owner approves a keyed service.

| Need | Source | Cadence | Retained as |
|---|---|---|---|
| New pools | GeckoTerminal new-pools | 60 s | `tracked` (memory, 220 cap) |
| Pair state (price, cap, FDV, liquidity, volume, buys/sells) | DexScreener pairs | ~75 s per 90-name batch | candidate fields; samples feed the peak |
| Price cross-check | Jupiter price v3 | per candidate | `jupState`, `jupGapPct` |
| On-chain facts | public Solana RPC (`getAccountInfo`, token largest accounts via indexed RPC when available) | once per candidate, retry 30 min while unread | mint/freeze authority, top-10 share + method |
| Named risks, LP lock | rugcheck summary | once per candidate | `rcRisks`, `rcLpLockedPct` |
| Majors | Coinbase and Kraken tickers (direct) | 60 s | majors snapshot; desk risk |
| Perpetual funding and open interest (BTC, ETH, SOL) | Bybit V5 tickers and OKX v5 public funding-rate / open-interest (keyless) | 120 s | memory only (open-interest history ~3 h); compact copy in every signal's `features_json.derivs` |
| Social | Bluesky search, pump.fun replies | 90 s | social score with coverage state |
| Narrative | RSS feeds + term list | 5 min | narrative heat |
| Signals | SQLite `crypto_signals` | on verdict change | one row per WATCH/ENTER with features and risk JSON and `rulesVersion` (rows before 2026-10-27 are unversioned; the expectancy basis states the version mix) |
| Grades | grader 10 min; horizon pass; momentum peak sampling | continuous | outcome, peak + depth, horizon mark + depth |

Retention: signals and grades are kept indefinitely (they are the sample).
Candidates leave memory after 48 h without a signal, or when the tracked set
is over its 220 cap: an unscored arrival inside its first momentum cycle
(5 min) ranks above every PASS and below every WATCH and ENTER, so a flood of
new pools can displace PASS names only; the lowest keep-rank goes first
(unscored and never answered, then PASS, then arrivals, then WATCH, then
ENTER, lower score first). Market cap has one basis everywhere
(`shared/cryptoCap.ts` capOf: DexScreener marketCap, else FDV, basis recorded
on the row as `features_json.mcapBasis`), and a row is sampled and graded on
the basis it was recorded on (`capOnBasis`): an FDV entry is never called
RUGGED against a marketCap that appears later, and a row whose basis stops
being reported is unpriced on that pass, never priced on the other number.
GeckoTerminal never overwrites the market cap or FDV of a DexScreener read
younger than one cycle (its price and liquidity still refresh every 60 s);
when DexScreener has been silent on a pair for longer than that (an outage or
a dropped batch), GeckoTerminal's market cap and FDV fill in as before, and the row records whichever basis that read carried. Rows the
horizon pass cannot price are marked NO_DATA, never deleted: survivorship is
measured, not hidden.

Where paid feeds get their data: the same chain and the same public
endpoints, indexed faster. The next keyless step up is a Solana RPC
websocket on the pump.fun and Raydium program logs (launches and
graduations the second they land). Keyed services (Helius, Birdeye, X API,
a Telegram bot token) need the owner's approval before any code reads them.

## 3. Rules: the versioned book

`shared/cryptoRules.ts` holds every threshold with `CRYPTO_RULES_VERSION`.
The engine, the grader and the verdict import it; none carries its own copy
(tests/quant/crypto-rules-version.test.ts pins the content hash to the
version and greps the engine for literals). Every signal row stores the
version it was produced under. A changed number is a new version; grades
from different versions are never pooled without saying so. The exit-plan
record (`server/exitPlanBook.ts`, `shared/exitPlan.ts` planRecordByVersion)
headlines the current version and keeps every earlier version summarised on
its own, so a bump never erases the sample it was learning from; the desk card
lists the earlier versions under the headline. Each plan is priced with the
fees and size it started under (PlanState.pricing); the no-data cutoff and the
sample gate are the current book's; a plan still open across a bump keeps its
starting label but walks on under the current levels.

Verdict path, in order: hard kills (mint or freeze authority active;
liquidity missing, $0 or under the floor; exit door liq/mcap < 3%; 1 h
change <= -55%; honeypot pattern of >= 25 buys with zero sells observed) ->
PASS (code hard_kill) whatever the score. Above the entry cap ceiling ->
retrace WATCH from score 55, else PASS. Then the score and flow floors, then
the fail-closed gates in this order: flow sustained (accel floor on 2 of the
last 3 refreshes), security read, Jupiter agree or watch, sells observed in
the last hour, top-10 share read, pair data fresh (`freshness`), desk risk
on. Only then ENTER. Every
rejection carries a verdict code the card shows. The served feed re-applies
the desk-risk gate at read time, so a desk that went off between refreshes
never serves a stale ENTER. It also holds at WATCH (code stale_data) any
ENTER whose pair data was last refreshed more than
`freshness.enterMaxAgeMinutes` (10) ago: a pair DexScreener stopped
returning used to keep its last ENTER until the 48 h eviction. Normal
refresh reaches every tracked name in about 4 minutes (220 names, 90 per
75 s tick), so the limit is about two and a half missed cycles. The
refresh rotation orders on the last answered attempt (a chunk is stamped
only after its call returns), so a pair DexScreener stopped returning does
not hold a slot every tick and a failed call does not push its names back. The scorer applies the same
limit (a re-score on the security or social tick without a pair refresh is
WATCH stale_data and records no row at all), and the feed, the
autopsy's "tracked" line and the AI prompt read one served verdict
(shared/cryptoVerdict.ts servedVerdict: stale first, hold reasons first).
Version 2026.11.06-1.

Funding and open interest are a recorded, descriptive regime readout, not a
rule. Funding is the exchange's decimal rate per funding interval (positive:
longs pay shorts); a per-8-hour figure is shown only when the venue states its
interval; open interest is shown only as the change between the desk's own
successive reads about an hour apart (unit-free; "building" for the first hour
after a restart). A blocked or malformed venue is "unavailable" with its
reason, never zero. The replay can bucket `features_json.derivs` once rows
carry it; a gate on it would be a new pinned rule version chosen from that
record. OKX response shape follows its public docs and was not reachable from
the build sandbox: Settings -> Verify live data is the first live check.

## 4. Calibration: how a rule may change

1. The record decides. `summarizeExpectancy` grades first-ENTER-per-coin
   signals under three exit rules (graded = limit sell at the target or the
   grader's close; hold = the 72 h mark; peak = ceiling), net of pool fees and
   constant-product impact on both legs at the depth that existed.
2. Gate: 50 graded first-signals with a no-data share of 20% or less. Below
   it, INSUFFICIENT DATA, whatever the survivors did.
3. Labels: PASSES PREDEFINED TESTS (mean net > 0 and the share-positive
   Wilson lower bound > 50%), MIXED RESULTS, NO DEMONSTRATED EDGE,
   INSUFFICIENT DATA.
4. A rule changes only from accumulated evidence over a version, split
   in-sample / out-of-sample when the replay exists, never from one trade.
   The change is a new version with its pin, its reason in this file, and
   the old version's record kept.
5. Review cadence: every 25 graded first-signals, a written note from the
   ledger (hit rate, average win, average loss, drawdown, which lanes paid,
   recurring misses) goes into docs/BATCAVE_STATE.md.

## 5. Math that must stay exact

- Cost: Q = liquidityUsd / 2 (quote side); buy value `Q·x/(Q+x)`, sell
  proceeds `Q₂·v/(Q₂+v)`; dex 0.25% + platform 1.0% once per leg; $0.25
  priority once per leg (all from the rule book's `cost`); net = proceeds −
  size. Break-even by bisection.
- Sizing: floor(min(liquidity × 0.5%, $400)). The exit is the constraint.
- Desk risk: (BTC mid − Kraken 24 h VWAP) / VWAP; off at ≤ −5%; a stale or
  failed venue read, or a majors read older than 10 min, is unknown (fails
  closed, live and at restart).
- Grades: HIT_5M when the sampled peak reaches the target; RUGGED when
  liquidity < 15% of entry or cap < 10% of entry; DOUBLED when the peak
  reached 2× entry by the horizon; DEAD otherwise; NO_DATA when unpriced
  past the horizon or when the entry cap was missing.
- Wilson 95% interval for the share positive; survivorship share
  noData / (n + noData).

## 6. Verification: every run, on the owner's server

Settings -> Verify live data runs `/api/verify/live`. The crypto section
(shared/cryptoVerify.ts) runs whether or not Schwab is connected:

- reach: /api/crypto/feed, /signals, /community, /health answered (these
  payloads carry per-section states, not a top-level dataState; the
  arithmetic checks below read the states that matter);
- gates: no ENTER row with an active authority, an unread top-10, a missing
  Jupiter check, a desk that is off or unknown, liquidity under the floor,
  a cap above the ceiling, flow under the floors, or pair data older than
  the freshness limit (or with no read time);
- sizing and round-trip cost on every row equal the book's arithmetic on
  the liquidity the row was sized on (`risk.sizedOnLiquidityUsd`); a card
  whose served liquidity moved more than 1% from that basis (the scanner
  refreshed it without re-sizing) is counted as stale, and the card states
  the basis;
- desk risk on the signals payload equals the arithmetic on the majors
  payload of the same run;
- expectancy bookkeeping: shares, gate and label consistent with the book;
- funding and open interest: signs, per-8h arithmetic, units (a plausibility
  band that catches gross unit errors only) and freshness agree with the
  row's own fields;
- the rule version is on the payload.

Stale, unavailable and skipped are their own states, never pass.

## 7. Review: the standing reviewer

Every change under the Crypto tab gets an independent review by an agent
briefed with docs/REVIEWER_BRIEF.md (goal, approach, rules, sources, the
states, what counts as a wrong number). The reviewer reads code and runs
edge cases; it does not take the author's word. Findings are MUST-FIX
(wrong number or false state), SHOULD-FIX, VERIFIED-OK. MUST-FIX items are
fixed with a regression test before merge. Review reports are summarised in
docs/BATCAVE_STATE.md with the PR number.

## 8. Roadmap (in order, each a bounded PR with tests)

0. DONE 2026-10-27 (PR #32): funding and open interest recorded on every
   signal (descriptive; next step is bucketing it in the replay once rows
   carry it).
0b. DONE 2026-10-29 (feat/crypto-autopsy): contract autopsy + holder-dump
   stress test (`GET /api/crypto/autopsy?mint=`, `shared/cryptoAutopsy.ts`).
   Paste one mint; the desk reads it once, scores it with the same
   `scoreCandidate` and pinned rule book, and lists every kill, flag and
   entry gate as pass / fail / unread with the rule's own number. It stores,
   tracks and grades nothing. Sustained flow is always "unread" (one snapshot
   cannot decide a 2-of-3 rule). Stress test: closed-form constant-product
   arithmetic (quote side = liquidity / 2) for the top-10 holders selling
   25 / 50 / 100% of their stake; a stated model, not a forecast. Next in
   this lane: personal trade journal, then creator-wallet / block-0 checks.
0c. DONE 2026-11-07 (feat/crypto-history-cards): per-candidate observation
   history (liquidity, cap, top-10 per refresh; ring of 60 in memory, not
   served raw). Card readouts from it: liquidity velocity (measured percent
   change over the readings in the last hour with the span and worst single
   step; "insufficient" under 3 readings, never a number) and exit-cost stress
   (the sized round trip at 25/50/75/100% liquidity pulls, the same
   constant-product arithmetic as the card's cost; "no exit" at 100%). Both
   descriptive; no rule or threshold changed. Next in this lane: persist the
   path of each first-ENTER (so a post-mortem card can show what it did), then
   holder history.
1. Replay / backtest: run the current rule version over the logged history,
   split by date, report hit rate, average win, average loss, max drawdown,
   net of cost; fills the sample from history. (Fastest path to an answer.)
2. Launch-source facts: pump.fun / LetsBonk / Moonshot / Raydium origin,
   graduation time, bundled first buys, dev-wallet behaviour; gate ENTER.
3. Catalyst layer: calendar + news entities + social velocity -> "narrative
   attached" with the entity named; measured as its own lane in the record.
4. Jupiter quote for the stated size and liquidity velocity (LP added or
   pulled over 15-30 min); RPC websocket on launch programs.
5. Paper executor: simulated fills at real quotes with modelled priority
   fee and failed-transaction rate; grade those fills.
6. Only after the record passes out of sample: a private executor,
   approve-each-trade first.

## 9. What is not claimed

No win rate, no edge, no probability. The desk removes trades that lose by
construction and records the rest. "Profitable" is written on the card by
the sample, when the sample exists, and only for the rule version it was
measured on.
