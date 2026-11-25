# Signals: plan and record

Tab 1 of the operating framework (`docs/OPERATING_FRAMEWORK.md`). This file is the plan the scope check
reads, and later the record of what was done and what the acceptance check found.

## Job

Tell the reader what the market is doing now, the levels that matter today and this week, and which
unusual option activity is worth a look.

## What the owner asked for (2026-11-24, his words summarised)

1. Unusual volume and flow alerts are good, but show how the volume built: per contract, in five-minute
   steps (for example 3,000, 3,000, 3,000, then tailing off 2,000, 1,000), and the position as a whole.
   Use Unusual Whales as the reference for how this reads.
2. Times the normal way in Eastern time: 4:54 PM, not 16:54.
3. The chain table (chain symbol SPX) is fine but the text is small.
4. The trade-level chart is not readable ("a red line then a green line") and says "Schwab stream not
   connected: not classified".
5. Everything readable by someone who can buy a call but does not know the Greeks; clear levels and the
   A to B to C path; data that is complete while Schwab is linked.

## What the live tab showed (2026-11-24, 6:09 PM ET, after the close, pane 719px wide)

Top of the tab
- Header: "SPX 7,201 · gap -0.89% · closed · 2026-11-25 chain · STALE · Schwab 1h 15m". After the close
  the last session's data is labelled STALE instead of "as of the close".
- Top read: "Model read: dealer hedging adds to moves on the next session's options, as last read."
  Tiles: "WALL ABOVE 7,300 +1.37% · 10% of map", "GAMMA FLIP 7,224 spot below · short γ",
  "MAGNET BELOW n/a none in band". Jargon; no level below; no path; no week levels; no record beside it.
- "WHY LEVELS DIFFER": a note explaining that other tabs show different walls and flip.
- "PROJECTED PATH ... THREE READS OF THE CENTRE": one line is a 60-word error about the options chain,
  one is "flat by construction", one is "a rule of thumb, not graded", and the card ends "None of these
  lines is a forecast."
- Scoreboard line: "0 of 7 rows that set a floor have reached it".
- Then two input boxes (stock research search, scan any ticker) before any flow.
- Strip: "heavy chop regime" here; the Regime tab header said "Strong trend regime" the same afternoon.

Flow
- Whale flow record: "1 of 5 closed positions made money after costs; the average result was -76%", all
  five from one day.
- Three long lists: 19 fresh whales, 106 clusters, 75 tracked positions. Rows carry BULLISH/BEARISH,
  "CONFLUX", "vol/OI 31.3x", "gate: $2.5M • 15x • 1-3DTE • AT_ASK".
- Flow alerts: 15 rows all stamped "16:54:10 ET"; near-identical.
- Put/call table: "NO BASELINE YET 5/20 sessions" on every row.
- Call/put flow chart: axis and stats in 24-hour time ("16:29 → 18:09", "@ 16:34").
- Trade-level side: "Schwab stream not connected: not classified".

Readability
- 66% of the tab's text is 11px; 18% is 12px. Phone layout at 719px.

## Scope check (2026-11-24): proceed with changes

An independent read-only agent checked this plan against the owner's words and the code. Its changes, all
taken:

- Ship a quick-win first (S0), because the owner's complaint is that nothing visible changes.
- Do the alerts (S2) before the top read (S1): it is his first and most specific ask.
- The alert he quoted ("48,000 contracts versus 623 OI") is not one contract. The panel sums volume and
  open interest per strike across every expiry within 7 days (`FlowAlertsPanel.tsx`, fed by `?dte=7`).
  S2 is a correctness fix, not only a layout change.
- No five-minute volume series per contract is stored anywhere. It has to be built from the difference in
  cumulative chain volume between polls and kept in a new table. Resolution is the 60-second chain cache;
  history starts at deploy; no buy/sell side without the stream.
- Write down which Unusual Whales fields we match and which we cannot (no sweep or exchange data) before
  building S2.
- Streaming is not build work. The client exists (`server/schwabStream.ts`); Schwab answers 401 on the
  stream sign-in, most likely because the developer app lacks the "Accounts and Trading Production"
  product. Only the owner can add that at developer.schwab.com. Until then the trade-level row says so in
  plain words.
- S1 must also settle the two regime labels ("heavy chop" here, "strong trend" on Regime).
- S3 must decide the whale list under framework section 2: fixed or removed, not kept as is with a
  record of 1 of 5 and an average of -76%.

## Plan (small pull requests, in this order)

S0. Quick wins (this pull request). Times the normal way in Eastern time on the flow panels and the
    flow chart ("4:54 PM"); after the close the top card says "last session" instead of STALE; the
    trade-level row says in plain words why it is empty; small labels are at least 13px on a computer.

S2. Alerts per contract with a five-minute build. Key = symbol, expiry, strike, side. A new stored
    five-minute volume table filled from the scanner's polls. One row per contract: first seen, volume
    per five-minute step, total against that contract's own open interest, premium, still building or
    tailed off. Preceded by the short Unusual Whales comparison.

S1. Top read for the reader. One sentence of what is happening; today's levels (ceiling above, flip,
    floor below) and the week's; the path in if-then form; the level record beside it; one regime label.
    Remove the apology note and the projected-path card from this tab. Built on the shared source for
    price, walls, flip and one-day move ("Today" and "Structure" views).

S3. One list that matters. The three long lists become one "worth a look" list with the build, the rest
    behind "show all". Plain words for every label, or the label goes. The whale list is fixed or removed.

S4. Remaining readability: desktop layout from 1,024px, the chain table, the call/put flow chart redrawn
    with labelled series and an end at the close, input boxes below the reads.

Owner action (not build work): enable the Schwab product that allows the stream, at developer.schwab.com.

## Not in this tab's plan

- Removing the whale tracker, clusters or put/call table outright (owner called the alerts "nice").
- Any new score.

## Unusual Whales as the reference: what we match and what we cannot

Written before S2 was built, from general knowledge of that product's flow feed (not from its code or a
current account; check against the live product before treating any line as exact).

| What their flow row shows | Ours after S2 | Why / limit |
|---|---|---|
| One row per contract (ticker, expiry, strike, call or put) | yes | the key is the OCC symbol |
| Volume against open interest for that contract | yes | per contract, no longer summed across expiries |
| Premium in dollars | approximate | contracts added between reads x last price x 100; excludes volume before the first read |
| When it traded | five-minute steps | from the terminal's own chain reads, as fine as the gap between two reads |
| Repeated hits on the same contract through the day | yes | this is the build: steps, biggest step, still building or slowing |
| Each individual trade (time, size, price) | no | a chain total has no trade list; needs Schwab's stream |
| Bought at the ask or sold at the bid, per trade | no | same; the existing day-level "last print" side is a different, weaker measure |
| Sweep, block, multi-leg, exchange | no | not in Schwab's chain or stream data |
| Spot at the time of the trade | no (could be added per step) | not stored yet |

## Record

- S0: pull request #158 opened 2026-11-24.
- S2 part 1: recorder, rule per contract, build list on the flow alerts panel. History starts at deploy.
  After review: a lower read between two higher ones is ignored (overlapping chain requests), open interest
  is taken after the hold and 0 is "not known", the shape compares completed steps only, reads are recorded
  from the open to 30 minutes after the close.
- S0 and S2 seen live 2026-11-24 7:55 PM ET (bundle index-DbMJohRv): alert times "4:54 PM ET", top chip
  "LAST SESSION", the contract list present and empty after hours as expected. Found on the way: the browser
  kept an old page after a deploy (fixed in #160).
- S1a: the top card's sentence, tile labels and an if-then path for the reader (`shared/todayPlan.ts`),
  from the nearest-expiry map already on the card. Still to do in S1: the week's levels (the map is
  nearest-expiry only; needs a second read for the week's last expiry), one regime label, a record for
  option levels (the existing level record covers calendar levels only, not option levels), and removing
  the projected-path card and the apology note.
  To check live at the next open: whether Schwab's per-contract day volume has already reset by 9:30 (if
  not, the first read's baseline would hold yesterday's volume and could raise a false alert).
