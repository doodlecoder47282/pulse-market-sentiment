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

## Plan (small pull requests, in this order)

S1. Top read for the reader. One sentence of what is happening; today's levels (ceiling above, flip,
    floor below) and the week's; the path in if-then form; the level record beside it. Remove the
    apology note and the projected-path card from this tab (its three lines give no usable read; the
    Models tab owns projection). After the close, label the data "as of the close", not STALE.
    Depends on the shared source for price, walls, flip and one-day move ("Today" and "Structure" views).

S2. Alerts per contract with a five-minute build. One row per contract instead of one row per poll:
    first seen, volume per five-minute step since then, total against open interest, premium, whether it
    is still building or has tailed off. Needs a stored five-minute volume series per flagged contract
    (from the scanner's own polls; verify whether Schwab serves option minute bars). Times as h:mm AM/PM ET
    everywhere on the tab.

S3. One list that matters. The three long lists become one "worth a look" list (top contracts by
    premium with their build), the rest behind "show all". Plain words for every label, or the label goes.
    The record ("1 of 5 made money, average -76%") stays beside the list.

S4. Readability. Minimum 13px, desktop layout from 1,024px, the chain table at readable size, the
    call/put flow chart redrawn with labelled series and normal times, input boxes moved below the reads.

S5. Streaming. Schwab's streaming feed for quotes and option prints, so trade-level side is classified
    trade by trade and the "not connected" state goes away. Shared infrastructure for every tab.

## Not in this tab's plan

- Removing the whale tracker, clusters or put/call table outright (owner called the alerts "nice").
- Any new score.

## Open questions for the scope check

- Is anything the owner asked for missing above?
- Is anything above not asked for and not needed for the checklist?
- Is the order right, given S1 needs the shared source and S5 is infrastructure?
