# Scorecard: is each tool worth its place?

Started 2026-11-23 at the owner's request: judge every tool as a professional futures, options and quant
trader would, and as a product developer who cares what the customer sees. This file is the measure of
progress. A tool is "accepted" only when the owner has looked at it and said yes.

Status of this version: every tab except Cosmos and Take Five was opened on the live terminal on
2026-11-23 after the close (SPX 7,237, +4.7% on the day; VIX 26.6). The verdicts below include what was seen.

## The questions

Ask them in this order. A "no" on 1 ends the review: the tool is cut or moved to Lab.

As a trader:
1. What decision does this help with, in one sentence a trader would say out loud?
2. Is every number the output of a stated model from measured inputs (price, strike, time, implied
   volatility, open interest, volume)? Hand-set weights and scores fail this.
3. What time frame is it for, and does every number on the card share it? (The Edge Lab bull case paired a
   one-day move with walls from every expiry.)
4. Has it been checked against what happened, and is the count on screen? If it cannot be checked, why is
   it shown?
5. Is it better or faster here than in the platform the trader already has open? If not, what is the point?
6. Does it say when it is blind (stale, missing, market closed)?

As the person using the screen:
7. Is the answer readable in five seconds from the top of the card, without scrolling?
8. Can it be read at arm's length on a laptop? Body text at least 13px, the numbers that matter at least
   14px, and enough contrast.
9. One job per card, one place per fact. Is this number also shown, differently, on another tab?
10. Does colour mean one thing everywhere (green above or up, red below or down, amber caution or stale,
    one accent for information)?
11. Does it work with nothing set up but Schwab?
12. Does it alert when it matters and stay quiet otherwise?

Verdicts: KEEP (expand it), FIX (worth having, wrong today), LAB (move out of the main bar), CUT.

## Findings that cut across every tab

- **Text is too small for a desktop.** Of about 2,480 sized text uses in the client, 1,501 are 11px and 57
  are 9 or 10px; 560 are 12px, 321 are 14px, 44 are 16px. Most of the terminal is set in 11px.
- **Twelve tabs is too many**, and several repeat each other (levels on Chart, Trade Desk, Outlook and
  Models; a regime read on five tabs; three playbooks).
- **Hand-set scores sit on top of real calculations** (playbook weights, the composite score, the 0DTE alert
  grade, headline scores, regime label). None has been graded against outcomes.
- **The two outcome records that exist are poor**: 9 of 33 level touches turned back; 16 of 86 flagged
  whale contracts made money after costs, average result -41% (7 days, 3 flag days).
- **Fear is read as bearish everywhere.** Nothing reads a washout (index stretch, VIX curve inversion,
  expiration roll-off). Friday 2026-11-20 showed the gap.

## Seen live on 2026-11-23 (the day the index rose 4.7%)

- **The terminal contradicts itself on one screen.** Header: "Trend continuation, dealers short gamma,
  hedging adds to moves". Every tab's summary strip: "Heavy chop regime". Models: "POS gamma, hedging damps
  moves", "PATH: grind down into pin". Chart's AI Outlook: "NEUTRAL 32/100, a no lean stuck sideways call. No
  edge, pass."
- **Four different gamma flips and wall sets**: Signals 7,328 (nearest expiry), Models 7,047 (expiries within
  2 days), Regime's thermal map 7,440, Chart (SPY) 735.90. A note explains why they differ; a trader still
  cannot tell which one to use.
- **Three different one-day moves**: Signals "about plus or minus 95", Heatseeker "plus or minus 118.5",
  Models "plus or minus 58.2 (VIX fallback)".
- **The page furniture takes the screen.** Brand bar, read line, score bar, ticker tape, summary strip and a
  warning banner fill about 270 of 744 pixels before any tool starts, on every tab. On the Chart tab the
  chart comes after Mag 7, put/call, tick volume and the watchlist.
- **The header overflows** when the SPY and VIX quotes carry STALE badges: the bell and settings buttons are
  pushed off the right edge.
- **The scoreboard has two rows with a real sample.** 139 of 276 regime calls matched (50%: a coin flip).
  38 of 161 option signals finished up 30% or more (24%). Every other row has 0 to 9 graded cases.
- **A washout read did exist, buried.** The bottom of Regime lists "largest relative drawdowns": XLK and SMH
  at 100/100 with RSI 25 and 26, 14% and 19% below their 20-day averages. It is a hand-set score on sector
  funds, far down one tab, with no alert, and nothing like it for the index.
- **Numbers to check:** NVDA shown +31.59% on the day; GLD shown +6.58% at 344 on Regime after 372.52 on
  Edge Lab the day before. One of each pair is wrong.
- **Crypto is a Solana new-coin scanner** (pump.fun launches, market caps in the tens of thousands of
  dollars, "ENTER rules", 0 of 50 graded). It is a different product for a different user.
- **Heatseeker is the clearest tool**: one model, a plain paragraph that says what it is and is not.
- **Trade Desk's level board is useful** but repeats one three-line caveat under each of five symbols.

## Tool by tool

| Tab | What it is | Verdict | Why | Seen live |
|---|---|---|---|---|
| Signals | The index card (price, wall, flip, range), then whale flow, flow alerts, put/call, ticker scan | FIX | The index card at the top is right and should become the Today screen. Below it the tab is a long stack; whale alerts need their record beside them. | yes |
| Outlook | Levels, expiries, implied range, events to the last expiry read | KEEP | One job, real inputs, clear after the trim. Add the index stretch read and what each expiration removes. | yes |
| Chart | SPX chart with dealer levels | KEEP | The core of a levels terminal. Show each level type's own record (turned back of touched). | yes |
| Heatseeker | 0DTE strikes, Greeks, the random-walk map | KEEP | Physics from measured inputs, explained in plain words. The model for the rest. | yes |
| Models | Composite score, "ML forward path", daily/weekly/monthly ranges | FIX, mostly CUT | A wall of unexplained terms (double zero zone, zomma, dom mag, decel 6.50). It said hedging damps moves while the header said it adds to them. Keep the option-implied odds and ranges; cut the rest. | yes |
| Trade Desk | Playbook, levels, releases today, tools | FIX | Releases card is sound. The playbook is the hand-set layer. The level board is useful; trim its repeated caveats. | yes |
| Regime | Regime label, sector rotation, pullback list | FIX | The label read "Value-led leadership, mid-cycle" in a week the index fell 8.6% with VIX at 36. Its calls match 139 of 276 times. The canary and sector tables are useful raw data. | yes |
| Edge Lab | Ticker briefing, skew, experiments | FIX | Skew is sound. The briefing's playbook is the hand-set layer again. | yes |
| News | Headlines, event calendar, earnings, rules brief | FIX | The calendar is the valuable part. The feed is mostly off-topic. The keyword brief adds little. | yes |
| Cosmos | Astronomy and financial astrology | LAB | Its own header says "for entertainment, not a trading signal". Fails question 1. | not this pass |
| Take Five | Breathing pacer and the owner's rules | KEEP, not as a tab | A personal tool with no data. A button, not a place in the tab bar. | not this pass |
| Crypto | Crypto prices, funding, narrative | CUT from this product (or its own app) | A new-coin scanner, nothing to do with index options. Owner's call. | yes |

## What this points to

Five places, not twelve: **Today** (the index: price, levels, gamma, the day's range, stretch, events),
**Flow** (options activity with its record), **Chart** (with Heatseeker), **Outlook**, **News and
calendar**. Everything else lives under Lab until it passes the questions.

Order of work proposed: (1) readable text on desktop; (2) the tab bar cut to five plus Lab; (3) the Today
screen built from the physics, with the stretch read; (4) each kept tool taken to "accepted", one at a time.
