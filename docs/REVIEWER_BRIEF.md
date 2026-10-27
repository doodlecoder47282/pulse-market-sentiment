# Reviewer brief: Batcave crypto desk

Give this file, whole, to any agent asked to review a change under the
Crypto tab (and to any agent reviewing the equities tabs, with the Schwab
notes at the end). The reviewer reads code and runs the edge cases against
the real modules; it never takes a description for proof. Report only.

## The product in one paragraph

Batcave is a private market terminal (web + iPhone shell loading the UI live
from the owner's server). Equities and options data is Schwab only.
Crypto is public, keyless feeds only (GeckoTerminal, DexScreener, Jupiter
price, public Solana RPC, rugcheck, Coinbase, Kraken, Bluesky, pump.fun,
RSS). The desk scans new Solana pools, gates them on on-chain facts and flow,
emits WATCH / ENTER / PASS with a verdict code, sizes by exit liquidity,
and grades every signal net of pool cost under three exit rules. It never
places orders. The owner's goal is a professional-grade, profitable system
for meme coins where "profitable" is a measured label on a graded record,
never a claim.

## Rules a change must not break

1. Missing, stale, blocked, partial and observed-zero are different states.
   A failed read is never 0, never "quiet", never "healthy". Look for
   `?? 0`, `|| 0`, `Number(x ?? 0)` on feed fields and ask what a null means.
2. Every number is the stated arithmetic on a named source. Recompute it.
   Sources: docs/CRYPTO_DESK.md section 2; rule book shared/cryptoRules.ts;
   math section 5.
3. Fail closed. An unread gate (top-10, Jupiter, sells, desk risk, majors
   age) blocks ENTER; it never passes by absence.
4. Rule book: every threshold comes from shared/cryptoRules.ts; a changed
   number is a new CRYPTO_RULES_VERSION with a new pin
   (tests/quant/crypto-rules-version.test.ts). Grades from different
   versions are not pooled silently.
5. Grading: first signal per coin; NO_DATA rows stay in the denominator of
   survivorship; INSUFFICIENT DATA under 50 graded or over 20% no-data; a
   label never says more than the sample supports.
6. Copy: descriptive. No "expect", "will", "edge", "high probability", no
   advice verbs. Heuristic scores are called heuristic.
7. Phone: tap targets >= 44 px, no hover-only method notes, no truncated
   numbers, 10 px minimum text.
8. Security: no keys in code or docs; the repo is public; no new keyed
   service without the owner's approval; the desk never executes.

## Known traps (found before; check they stay fixed)

- DexScreener and GeckoTerminal fields are nullable: `openInterest`-style
  absence on `totalVolume`, `liquidity.usd`, `marketCap`, `fdv`. GT writes
  FDV where it has no cap; the row records `mcapBasis`.
- Schwab sends `-999` sentinels for greeks and IV; `schwabNum` drops them.
- The grader read a missing entry cap as 0 (always "DOUBLED"); now NO_DATA.
- Desk risk once used a stale venue mid; venue `state` is read now.
- Top-10 concentration was never retried after a skipped indexed call.
- The graded HIT_5M exit was the grader's later sample; now
  min(peak, target) at the peak-sample depth.
- Flow alerts re-fired every poll with random ids; ids are deterministic.

## What to deliver

MUST-FIX (wrong number or false state): file:line, what, why it matters
live, the concrete fix, a test that pins it.
SHOULD-FIX (misleading or unclear): same shape.
VERIFIED-OK: what was checked and holds, briefly.
Mark feed behaviour you could not confirm "verify against live payload".
Do not modify files. Do not commit.

## Schwab notes (equities reviews)

Chain keys `YYYY-MM-DD:dte`; `volatility` in percent; `$SPX` symbol with
SPX (AM) vs SPXW (PM) roots and settlement at 09:30 SOQ vs 16:00; index
quotes have no bid/ask/volume; three gamma bases (snapshot OI-only 0-45
DTE re-priced; 0DTE forward OI + 0.25 x volume single expiry; per-ticker on
the shared basis); quote stale after 2 min in session; chains carry
asOfMs / stale / servedFromCache which every card must show.
