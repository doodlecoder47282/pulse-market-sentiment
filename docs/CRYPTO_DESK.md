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
| Social | Bluesky search, pump.fun replies | 90 s | social score with coverage state |
| Narrative | RSS feeds + term list | 5 min | narrative heat |
| Signals | SQLite `crypto_signals` | on verdict change | one row per WATCH/ENTER with features and risk JSON and `rulesVersion` (rows before 2026-10-27 are unversioned; the expectancy basis states the version mix) |
| Grades | grader 10 min; horizon pass; momentum peak sampling | continuous | outcome, peak + depth, horizon mark + depth |

Retention: signals and grades are kept indefinitely (they are the sample).
Candidates leave memory after 48 h without a signal. Rows the horizon pass
cannot price are marked NO_DATA, never deleted: survivorship is measured,
not hidden. Market-cap basis (marketCap vs FDV) is recorded per row.

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
from different versions are never pooled without saying so.

Verdict path, in order: hard kills (mint or freeze authority active;
liquidity missing, $0 or under the floor; exit door liq/mcap < 3%; 1 h
change <= -55%; honeypot pattern of >= 25 buys with zero sells observed) ->
PASS (code hard_kill) whatever the score. Above the entry cap ceiling ->
retrace WATCH from score 55, else PASS. Then the score and flow floors, then
the fail-closed gates in this order: flow sustained (accel floor on 2 of the
last 3 refreshes), security read, Jupiter agree or watch, sells observed in
the last hour, top-10 share read, desk risk on. Only then ENTER. Every
rejection carries a verdict code the card shows. The served feed re-applies
the desk-risk gate at read time, so a desk that went off between refreshes
never serves a stale ENTER.

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
  a cap above the ceiling, or flow under the floors;
- sizing and round-trip cost on every row equal the book's arithmetic;
- desk risk on the signals payload equals the arithmetic on the majors
  payload of the same run;
- expectancy bookkeeping: shares, gate and label consistent with the book;
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
