# Batcave master fix list

Version 1 · written 2026-11-25, 3:20 AM ET, before the open · the working list for
`docs/OPERATING_FRAMEWORK.md`. Every fix still needed, tab by tab, the order to do them in, and what can
only be checked while the market is open. This file is added to as checks come back; nothing is removed
without a note saying why.

## How this list was made

- A fresh look at every tab on the live site at 1,440px wide, 3:15 to 3:20 AM ET on 2026-11-25
  (market closed, before the open). For each tab: all visible text, text sizes, 24-hour times, counts of
  option jargon, hand-set scores, input boxes, charts, and chart text that overlaps.
- The two full reads of 2026-11-23 and 2026-11-24 (`docs/SCORECARD.md`).
- What the owner asked for on the 2026-11-24 call and in chat.
- What the work on Signals turned up (`docs/tabs/SIGNALS.md`).

What it is not: a look at every tab during a live session, or at charts that only appear after a click or a
search. Those are in section 5. Each tab still gets its own full read, plan and scope check when its turn
comes; this list is the starting point for that, not a substitute.

Item status: OPEN (not started), PART (some of it live), DONE (seen live), OWNER (needs the owner).

## 1. Shared fixes (every tab depends on these)

These are done once and every tab gets them. They come first within the tab that first needs them.

| # | Fix | Why | Status |
|---|---|---|---|
| X1 | One server source for price, ceiling, floor, turning point and expected move, with two named views: Today (nearest expiry) and This week (week's last expiry). Every tab reads it. | Six different turning points and three different one-day moves were on screen on 2026-11-23. Tonight the strip said "dealers short gamma: hedging adds to moves" while the line under the tabs said "calmer side (smaller swings)". | PART: Signals top card has both views; other tabs still compute their own |
| X2 | Hold levels still when no new option data has arrived. | With the same option data, the top card read ceiling 7,300 / turning point 7,224 / no floor at 6:09 PM, 7,310 / 7,238 / 7,150 at 9:19 PM and 7,250 / 7,208 / 7,150 at 3:16 AM, and went from "bigger-swing side" to "calmer side" overnight. | OPEN |
| X3 | One regime label, from stated rules, used by the strip, every tab's summary line, Regime and Edge Lab. | Strip "Volatility expansion", Signals "Rotation: value-led", Edge Lab "Strong bear 75/100", summary line "heavy chop" or "strong trend". | OPEN |
| X4 | The strip above the tabs in plain words. | Reads "Volatility expansion — VIX backwardation (26.7/28.3/25.5) + dealers short gamma", "NET GEX -16%", "RULE TIER: HIGH", "read 03:17 AM". | Built (`shared/stripRead.ts`), not yet merged or seen live. It now says it counts SPX options out to 30 days, which is why it can differ from the top card (today's expiry only). The six states are still fixed rules: X3 decides whether they stay. |
| X5 | One set of names everywhere: ceiling, turning point, floor, expected move. | Signals and the line under the tabs use them; Outlook says "wall above" and "gamma flip"; Edge Lab "CALL WALL / PUT WALL / ZERO Γ"; Models "DOM MAG", "0-Γ FLIP"; Heatseeker "PIN · WALLS · FLIP". | PART |
| X6 | Times the normal way in Eastern time on every tab, no leading zero. | Trade Desk shows 45 24-hour times, Models 22, Crypto 8; the strip says "03:17 AM". | PART: Signals done; every "read at" note on every tab is Eastern time with no leading zero (built, not yet seen live) |
| X7 | A record for option levels (how often a ceiling, floor or turning point held or broke), shown beside every read that uses them. | The existing level record counts calendar levels only. No option-level read has a record. | OPEN |
| X8 | Remove hand-set scores, or show the measured inputs they were built from. | "x/100" scores on screen tonight: Regime 16, Trade Desk 9, Edge Lab 3, Signals 2. None is graded. | OPEN |
| X9 | Before the open, the data chip says how old the data is in words. | At 3:16 AM the top card's chip read "OK · Schwab 10h 21m": ten-hour-old data labelled OK. | PART: before the open, the top card and Chart's level card read "last session" when the option data is more than 30 minutes old and "ok" for a fresh pre-market read; the sentence says when the data was read (not yet seen live); other tabs' chips not checked |
| X10 | Less page furniture: tools start 220px down a 900px window on every tab, and the top card plus stock search repeat above every tab. | Measured tonight on all twelve tabs. | OPEN |
| X11 | Desktop layout from 1,024px. | Below that the phone layout shows. Text size on a computer is fixed (0% under 13px on ten tabs; Cosmos 21%, Take Five 14%). | PART |
| X12 | Live prices from Schwab's stream. | Trade-by-trade buy/sell marking and live quotes depend on it. The client exists; Schwab refuses the sign-in. | OWNER (section 4) |
| X13 | Seasonality dates from one calculation. | The hover date and the "best buy and sell dates" on the same panel are worked out two ways and can differ by days. | OPEN |
| X14 | Nothing asks the user to type to get a read. | Trade Desk has 36 input boxes, Crypto 12. | OPEN |

## 2. Tab by tab

Order of work is fixed by the framework: Signals, Outlook, Chart, Models, Heatseeker, Trade Desk, Regime,
News and the Alpha run, Edge Lab, Crypto.

### 2.1 Signals (in progress)

Job: what the market is doing now, the levels that matter today and this week, and which unusual option
activity is worth a look.

Live now: normal Eastern times; "last session" chip after the close; the plain top read with if-then steps;
the week's levels; unusual volume per contract with a five-minute build (recorder running, no real data
seen yet); the page reloads to the new version after a deploy.

| # | Fix | Status |
|---|---|---|
| S1 | The strip and one regime label (X3, X4). | OPEN |
| S2 | Record for option levels beside the top read (X7). Decide how "held" is scored. | OPEN, needs owner's view |
| S3 | Hold levels still without new data (X2). | OPEN |
| S4 | Remove "Why levels differ" and the "Projected path · three reads of the centre" card (it ends "None of these lines is a forecast"). | PART: path card removed (merged, not yet seen live); "Why levels differ" stays until the other tabs read the shared source (X1), because until then it is true |
| S5 | A plain line for the case where the week's ceiling sits below its turning point (seen: 7,250 under 7,278). | Merged, not yet seen live |
| S6 | One "worth a look" flow list in place of Fresh whales, UOA clusters and Tracking. Plain words for "CONFLUX", "vol/OI", "gate: $2.5M • 15x • 1-3DTE • AT_ASK", "BURN". | OPEN |
| S7 | Decide the whale list: its record is 1 of 5 after costs, average -76%, all from one day. Fix the rule or remove the list. | OPEN, needs owner's view |
| S8 | Flow alerts: the remaining kinds (heavy strike, put/call shift, wall) still repeat one line per strike. Group them. | OPEN |
| S9 | Put/call table says "NO BASELINE YET 5/20 sessions" on every row: show it once, not per row. | OPEN |
| S10 | Call/put flow chart redrawn: labelled series, stops at the close, readable at a glance. | OPEN |
| S11 | Chain table at a readable size. | OPEN |
| S12 | Trade-level row: empty until the stream works (X12). | OWNER |
| S13 | Move stock search and "scan any ticker" below the reads. | OPEN |
| S14 | "STALE · 11.3H" on tracked positions overnight: say "last price from yesterday's close". | OPEN |
| S15 | Acceptance check against the framework checklist, then the owner's sign-off. | OPEN |

### 2.2 Outlook

Job: the plain read for today and this week with its levels.

Seen tonight: "Outlook · SPX · now to Jan 22 ... Not a forecast." A price-and-time ladder ("7,296 straddle
high", "7,250 wall above", "7,237 pivot R1", "7,208 gamma flip"), every mapped level, option expiries
ahead in five windows. One chart, no overlaps, no scores, no inputs.

| # | Fix | Status |
|---|---|---|
| O1 | Same names as Signals (X5): "wall above", "gamma flip", "straddle high", "pivot R1" in plain words. | OPEN |
| O2 | Lead with the read and the if-then path, then the ladder. Today it opens with a description of itself. | OPEN |
| O3 | Levels from the shared source (X1), each marked Today or This week. | OPEN |
| O4 | The stretch read (index washout: how far below its averages, how the VIX curve sits, what expires) with a count of what followed such days. Missing on Friday 2026-11-20. | OPEN, needs the owner's Friday factors |
| O5 | What each coming expiry removes, in plain words. | OPEN |
| O6 | Record beside the read (X7). | OPEN |
| O7 | Full live read, plan and scope check at the start of its turn. | OPEN |

### 2.3 Chart

Job: price with the levels that matter drawn on it.

Seen tonight: the chart comes after Mag 7, breadth, put/call flow, signed tick volume and the watchlist.
"FEED OFFLINE" on one panel. Toggles "GREEKS", "FLOW", "GAMMA ON", "GRANULARITY". Earlier reads: an AI
Outlook card with a hand-set 30/40/30 playbook, "gamma flip" and "zero gamma" counted as two agreeing
sources, raw StockTwits posts.

| # | Fix | Status |
|---|---|---|
| C1 | The chart first; the other panels below or moved. | OPEN |
| C2 | Pivot magnet labels ("A+", "Q-S1", "VN2") in plain words (owner). | OPEN |
| C3 | Levels from the shared source with the shared names (X1, X5). | OPEN |
| C4 | Its data chip maps "last session" correctly (same fix as the Signals card). | Merged, not yet seen live |
| C5 | AI Outlook card: remove the hand-set playbook and score; stop counting one number as two sources; drop raw social posts. | OPEN |
| C6 | "FEED OFFLINE": say what is missing and why, or fix it. | OPEN, check at open |
| C7 | Each level type shows its own record (X7). | OPEN |
| C8 | Full live read, plan and scope check. | OPEN |

### 2.4 Models

Job: where price is likely to travel today, this week and this month, from the option map.
Owner's view: close to right; it must agree with every other tab.

Seen tonight: 11 charts, 22 24-hour times, heavy jargon (gamma 55 mentions, implied-volatility terms 45,
other Greeks 34). Headings "PIVOT LADDER — BY HORIZON", "VOL STRUCTURE", "STRONG MAG", "UP VOMMA", "DOM MAG".
Side panel text such as "touch not stated: implied distribution not centred on spot (spot sits at its 60%
quantile; the 2x reflection rule needs about 50%)". Chip "LAST SESSION · SPY chain 7h 16m".

| # | Fix | Status |
|---|---|---|
| M1 | Levels from the shared source (X1). It builds SPX levels from a SPY chain; the pivot card multiplies SPY walls by 10. No fixed multiplier. | OPEN |
| M2 | Evening starting price: live or dated, never yesterday's bar shown as now. | OPEN, check at 4:30 PM |
| M3 | Plain words for every level name and the side panel; or the term goes. | OPEN |
| M4 | Times the normal way (X6). | OPEN |
| M5 | Path percentages: say where they come from; remove if hand-set (X8). | OPEN |
| M6 | The buried oversold read (index RSI under 30, shown as "MAGNET DRIFT 50/100") moves to the stretch read (O4). | OPEN |
| M7 | Label fixes from 2026-11-25 are live (three overlaps gone). | DONE |
| M8 | Record for its ranges and paths. | OPEN |
| M9 | Full live read, plan and scope check. | OPEN |

### 2.5 Heatseeker

Job: the option map by strike: where the walls and the turning point are.
Owner's view: looking good; the strike table is useful; decide on the 3D view; make the full map visible.

Seen tonight: "0DTE WIENER MAP · TODAY", "LONG GAMMA AT SPOT", "1Σ TO THE CLOSE", "EXPECTED HIGH LEFT",
"PIN · WALLS · FLIP", "MORNING ODDS SCORECARD", "CHAIN'S OWN SETTLE DISTRIBUTION". Jargon: gamma 41,
other Greeks 29, 0DTE 14. Two input boxes (ticker, expiry).

| # | Fix | Status |
|---|---|---|
| H1 | One turning point per named view; the map and the card under it showed different ones for one expiry. | OPEN |
| H2 | Shared names (X5); "SPOT" becomes "price" across the whole tab together. | OPEN |
| H3 | Its expected move agrees with Signals for the same expiry (118 on both for Nov 27 so far, not checked at one moment). | OPEN, check at open |
| H4 | The level odds table (each level with its distance and touch odds, and a scorecard that beats the base rate) moves up: it is the best record in the terminal. | OPEN |
| H5 | Pivot bands: seven "ACCEL, FRESH 100" bands ten points apart with one sentence each. Group them. | OPEN |
| H6 | 3D view: keep only if it reads at a glance. | OPEN, needs owner's view |
| H7 | Full map visible (owner). | OPEN |
| H8 | Greek profile labels stacked in rows. | DONE |
| H9 | Full live read, plan and scope check. | OPEN |

### 2.6 Trade Desk

Job: today's plan: levels, scheduled releases, and the if-then rules.

Seen tonight: the longest tab (25,254 characters), 6 charts, 36 input boxes, 45 24-hour times, 9 scores.
Headings "REPLAY ON PAST SESSIONS · NOT THE LIVE RECORD", "PROTOCOL LOG", "LEVELS CROSSED", "LEVEL RECORD",
"SETTLE LEDGER", "$ / 1%", "$ / PT". A trigger card on SPY: "Spot 2.38% below zero-gamma (735.9) — in
negative-gamma zone", "intensity 63/100 · NEUTRAL · 0-2 sessions (imminent)".

| # | Fix | Status |
|---|---|---|
| T1 | Remove or relabel the trigger card's hand-set "intensity" and its claims ("dealers sell into weakness", "bear squeeze if hedges unwind"). | OPEN |
| T2 | No inputs needed for a read (X14): 36 boxes. Find which are needed at all. | OPEN |
| T3 | Times the normal way (X6): 45. | OPEN |
| T4 | "Levels crossed" log: about 35 lines a session, mostly VIX crossing its open. Keep what matters. | OPEN |
| T5 | The level board repeats one three-line caveat under each of five symbols. Say it once. | OPEN |
| T6 | Shared names and source (X1, X5): "wall above", "magnet below", SPY 735.9 zero-gamma. | OPEN |
| T7 | Two places use the browser's clock for the date (expiry day and quick picks). | OPEN |
| T8 | Lower half of the tab has never been read in full. | OPEN |
| T9 | "Prev" label moved clear of "PP" on the price charts. | DONE |
| T10 | Full live read, plan and scope check. | OPEN |

### 2.7 Regime

Job: what kind of market this is and which groups lead or lag.

Seen tonight: 16 "x/100" scores, sigma mentioned 20 times, a "CANARY" card reading "CHIRPING", a Greek
surface with "GRID / 2.5D / PER-DATE / GLOBAL" and "VANNA / CHARM / VOMMA / ZOMMA", "REACTIVE SECTOR WEB".
Its calls matched 139 of 276 (a coin flip). The pullback list was fixed in #153.

| # | Fix | Status |
|---|---|---|
| R1 | One regime label from stated rules (X3); the old one read "value-led, mid-cycle" in a week the index fell 8.6%. | OPEN |
| R2 | The washout read (sector RSI extremes, distance below averages) to the top, with a count of what followed. | OPEN |
| R3 | 16 hand-set scores: remove or show inputs (X8). | OPEN |
| R4 | Canary card in plain words ("chirping", "z vs own 20d vol"). | OPEN |
| R5 | Greek surface: plain words, or move to a Lab. | OPEN |
| R6 | Seasonality: one date calculation (X13); hover now shows a date. | PART |
| R7 | Correlation map legend no longer shows names through it. | DONE |
| R8 | "Stretched" badge missing in the all-dumps view. | OPEN |
| R9 | Full live read, plan and scope check. | OPEN |

### 2.8 News and the Alpha run

Owner's view: the news looks good, but it does not say what to trade on. The Alpha run must give a
direction read and levels.

Seen tonight: 204 headlines sorted OTHER 136, GEO 32, FED 19, INFLATION 6, EARNINGS 6, RATES 4, GROWTH 1.
Two thirds are "OTHER".

| # | Fix | Status |
|---|---|---|
| N1 | The Alpha run states direction, today's and the week's levels and the path, from the shared source, with its record. | OPEN |
| N2 | "OTHER" hidden by default, or sorted better: 136 of 204. | OPEN, needs owner's view |
| N3 | The event calendar (the most useful part) nearer the top. | OPEN |
| N4 | Week-ahead buckets use Eastern dates; the first-Friday jobs chip uses the published dates. | OPEN |
| N5 | Full live read, plan and scope check. | OPEN |

### 2.9 Edge Lab

Owner asked: a daily to weekly briefing, not a monthly outlook: daily levels and weekly levels, fully computed.

Seen tonight: still headed "STRONG BEAR" with a score. "KEY LEVELS · SPY · SPOT 716.37" with "CALL WALL /
PUT WALL / ZERO Γ / UPSIDE / DOWNSIDE / VOMMA↑ / VOMMA↓ / CHARM", most of them a dash (13 dashes). A
three-path playbook with weights. No chart on first view.

| # | Fix | Status |
|---|---|---|
| E1 | Replace "STRONG BEAR 75/100" (five hand-set votes; it said strong bear on a day SPY rose 4.7%) with the measured inputs. | OPEN |
| E2 | Daily and weekly levels from the shared source (X1), with the path. | OPEN |
| E3 | Remove the empty tiles: a dash is not information. | OPEN |
| E4 | The playbook's weights are hand-set: say so or remove (X8). | OPEN |
| E5 | Cross-asset table carries its close date. | DONE |
| E6 | Other panels (skew, experiments) not yet read at desktop width. | OPEN |
| E7 | Full live read, plan and scope check. | OPEN |

### 2.10 Crypto

Owner asked: no manual inputs. For each coin worth showing: a buy level, what to look for before entering,
the market cap to sell at, and when to get out. Fewer, better coins. Best available sources.

Seen tonight: "Nothing clears the bar right now. 220 pools tracked." "Record so far: 0 of 50 graded
first-ENTER coins needed." 12 input boxes. 8 24-hour times. Earlier: of 1,342 coins graded, 1,035 rugged.

| # | Fix | Status |
|---|---|---|
| K1 | Remove the 12 inputs (X14); the rules decide. | OPEN |
| K2 | Test the entry bar against the log: which rules did the coins that ran pass and fail at the time. The bar has never produced an Enter. | OPEN |
| K3 | For each coin shown: entry, what to see first, target market cap, exit, with the record beside it. | OPEN |
| K4 | Narrow the intake and state the reason for each cut. | OPEN |
| K5 | Confirm the data sources are the best available. | OPEN |
| K6 | Times the normal way (X6). | OPEN |
| K7 | The owner's friends' entry rules as a comparison. | OWNER |
| K8 | Full live read, plan and scope check. | OPEN |

### 2.11 Left as they are

Take Five: fine as it is (owner). Cosmos: not in the owner's list; its own header says "for entertainment,
not a trading signal". Both carry small text on a computer (14% and 21% under 13px), fixed with X11.

## 3. Orchestration

Per tab, the same loop (framework section 4): say back the ask · live read · plan · scope check · find the
cause · fix in one place · test · code review · merge on green CI · look at it live · acceptance check ·
report · owner's sign-off.

Order and what unlocks what:

1. **Finish Signals.** S1 to S15. It carries X2, X3, X4, X7 and X9 for everyone.
2. **Shared source (X1) completed during Outlook**, because Outlook is nothing but levels. After that
   Chart, Models, Heatseeker, Trade Desk and Edge Lab switch to it one by one (O3, C3, M1, H1, T6, E2).
3. **Outlook** adds the stretch read (O4), which Regime (R2) and Models (M6) then reuse.
4. **Chart, Models, Heatseeker, Trade Desk** in that order: mostly switching to the shared source and
   names, plain words, and removing hand-set layers.
5. **Regime** reuses the regime label (X3) and the stretch read.
6. **News and the Alpha run**, **Edge Lab**: both read the shared source and the regime label, so they
   come after those exist.
7. **Crypto** runs on its own track: nothing above blocks it, and it blocks nothing.

Rules of the road: small pull requests; one tab at a time; a problem seen on a later tab is noted here for
that tab's turn unless the owner sends a screenshot or says it is urgent; every change is seen on the live
site before it is called done; branches are named `feat/...` so the checks run.

## 4. Owner decisions and actions

| # | What | Needed for |
|---|---|---|
| D1 | Enable the Schwab product that allows the stream, at developer.schwab.com (the likely cause of the refused sign-in; not confirmed). | X12, S12 |
| D2 | How an option level "held" is scored: reversed by a set number of points, or closed on the same side. | X7, S2 |
| D3 | The whale list: fix the rule or remove it. | S7 |
| D4 | Which factors were watched on Friday 2026-11-20. | O4 |
| D5 | News "OTHER" hidden by default? | N2 |
| D6 | Heatseeker 3D view: keep or cut. | H6 |
| D7 | Friends' meme-coin entry rules. | K7 |
| D8 | Railway volume usage figure (Metrics tab). | housekeeping |
| D9 | Is the wording of the Signals top read at the right level for the reader. | every tab copies it |

## 5. To check at the open and during the session

Results are written here as they come in.

| # | When (ET) | Check | Result |
|---|---|---|---|
| L1 | 9:33 AM | Contract list has rows; no row carries a huge "traded before the first read" at the open (that would mean Schwab's day volume had not reset). | |
| L2 | 9:33 AM | "Open interest not posted" line: does it show, and for how long. | |
| L3 | 9:35 AM | Top card during a live session: chip, sentence, levels, steps. | |
| L15 | 8:00 and 9:20 AM | Before the open: does Schwab re-read the index option chain, and do the option prices (and so the expected move) change between the two times. Decides how the pre-open chip should be worded. | |
| L4 | 9:35 AM | Week block against Heatseeker for the same expiry at the same moment: expected move, ceiling, turning point. | |
| L5 | 10:00 AM | Do the top card's levels move while price moves (the turning point followed price through the session on 2026-11-23). | |
| L6 | 10:00 AM | A contract's five-minute bars against a second source for the same contract. | |
| L7 | session | Chart tab "FEED OFFLINE": still there with the market open? | |
| L8 | session | Flow chart: does it stop at 4:00 PM. | |
| L9 | session | SPY, XLE, XLC daily bars: stuck again? The Regime warning now states the cause. | |
| L10 | session | Each tab at 1,440px with live data: overlaps, empty panels, anything labelled stale that should not be. | |
| L11 | 4:25 PM | Today's daily bars arrive the same evening (did on 2026-11-24). | |
| L12 | 4:30 PM | Models starting price after the close. | |
| L13 | 4:30 PM | Top card chip turns to "last session"; levels then hold still (after X2). | |
| L14 | session | Charts behind a click or a search: seasonality, Edge Lab panels, News, Crypto. | |

## 6. Records to beat (2026-11-24)

- Calendar levels: 39 touches, 9 held, 29 broken.
- Option signals: 38 of 161 finished up 30% or more.
- Regime calls: 139 of 276 matched.
- Whale list: 1 of 5 after costs, average -76% (one day).
- Option levels: no record yet.
- Crypto: no Enter issued yet.

## 7. Count

Shared fixes 14. Tab fixes: Signals 15, Outlook 7, Chart 8, Models 9, Heatseeker 9, Trade Desk 10, Regime 9,
News 5, Edge Lab 7, Crypto 8: 87 in all. Seen live and done: 5. Part done: 4 shared, 1 tab. Owner
decisions: 9. Live checks waiting: 14.
