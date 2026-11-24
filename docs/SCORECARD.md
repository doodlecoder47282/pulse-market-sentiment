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

## Second pass, every tab read to the bottom (2026-11-23, 17:00 ET, window 978 px wide)

Measured on the Signals tab: 73% of the visible characters are set at 11px; the tools start 215 px down a
697 px window; at 978 px wide the terminal still shows the phone layout (bottom bar).

- **Edge Lab said "STRONG BEAR, score 75/100" at 5 PM on a day SPY rose 4.8%.** One of its inputs is "SPY
  week -8.56%", last week's figure. This is the clearest case of a hand-set score reading stale inputs.
- **Models is stale after the close.** Its ten-day cone and pivot projection still start from Friday's
  6,910 ("Broke below call wall 7,300") with the index at 7,237, because Schwab's daily bar for the day is
  not posted. The Trade Desk level board handles the same gap correctly from intraday bars.
- **Six gamma flips, two of them on one tab.** Heatseeker's map says walls 7,200 to 7,350 and flip 7,328;
  the Heatseeker card under it, same expiry, says call wall 7,400, put wall 7,180, flip 7,437. Models'
  pivot projection adds 7,357.
- **The flip follows the price.** The Trade Desk log shows the gamma flip at 7,219, 7,229, 7,235, 7,238 and
  7,240 through the session, then 7,329 at the close. A level that moves with the price is not a level.
- **Mapped levels are broken more often than they hold.** 39 touches over 11 sessions: 9 closed 10 points
  back first, 29 closed 10 points through first. Presenting levels as support and resistance is not what
  the record shows.
- **An oversold read for the index existed too, buried.** Models, far down: "RSI(14) 24.7 below 30", shown
  as "MAGNET DRIFT, score 50/100 hand-set".
- **A bullish flow read existed today, buried.** Bottom of Signals: calls bought at the ask $719M against
  $112M sold at the bid; "last-print net premium +$955M".
- **Flow alerts are noise on a trend day.** Fifteen "unusual volume" alerts, thirteen marked high, one per
  5-point strike from 7,175 to 7,230. The rule (volume at least 3 times open interest) is always true on a
  next-day chain. One line would say it: "call volume 3 to 15 times open interest across 7,175 to 7,230".
- **Heatseeker's pivot bands**: seven "ACCEL, FRESH 100" bands ten points apart, each with the same sentence.
- **Trade Desk's "levels crossed" log**: about 35 lines for one session, mostly VIX crossing its open.
- **Chart's AI Outlook** carries a third hand-set playbook (30/40/30), counts "gamma flip" and "zero gamma"
  as two agreeing sources when they are one number, and prints raw StockTwits posts ("is it impeachment
  time yet?", "Please give me a follow lol").
- **The record store on this service is four sessions old** ("4/20 sessions", "0 closed in the last 7
  days"), so most records cannot be judged yet. If the database does not survive a redeploy or a new
  service, they never will be.
- **Heatseeker's level odds table is the best thing in the terminal**: each level with its distance in
  one-day moves and the random-walk odds of touching it, and a scorecard that already beats the base rate
  (Brier 0.165 against 0.239, 5 scored days of the 50 it asks for).
- **Crypto's own record**: 4,158 coins tracked; of 1,342 graded, 1,035 rugged; 172 reached a $5M cap and 36
  doubled; the desk has never issued an Enter. It is honest and inert.
- **Regime's pullback list was seen live with the 2026-11-23 fix**: three names, real dollars per day
  ($419M, $316M, $1.1B), one thinner name left out.

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
| Crypto | Solana new-coin scanner: pools tracked, fixed ENTER rules, a record of graded entries | KEEP and refine (owner's decision 2026-11-23) | The owner wants it. Its own record is 0 of 50 graded, so the first job is to let the record fill and show it, then judge each rule by it. Runs through the same questions as every other tool. | yes |

## What has and has not been looked at (so the review itself can be checked)

"Top" means the first screen or two of the tab (about the first 3,000 characters of its text). "Full" means
every card on the tab was read. Nothing below has been seen during a live session, on a wide desktop
window, or checked against the owner's Excel formulas yet.

| Tab | Looked at | When | What is still unread |
|---|---|---|---|
| Signals | full | 2026-11-23 17:00 ET | the collapsed detail section |
| Outlook | full | 2026-11-22 (closed market) | a live chain |
| Chart | full text; the chart picture not judged | 2026-11-23 | the chart drawing itself |
| Models | daily view full | 2026-11-23 | weekly, monthly, 3M views; the chain audit (still loading) |
| Heatseeker | first half | 2026-11-23 | the strike table below the first rows, the map picture |
| Trade Desk | first 12,500 of 25,800 characters | 2026-11-23 | the lower half (tools, records, playbook) |
| Regime | full except the first sector rows | 2026-11-23 | none of note |
| Edge Lab | briefing top and skew | 2026-11-21 to 23 | the other sub-panels |
| News | feed, brief, header | 2026-11-21 | calendar and earnings lists |
| Crypto | summary card and desk text | 2026-11-23 | the coin lists and the detail section |
| Cosmos | top | 2026-11-23 | the reference sub-tabs |
| Take Five | top | 2026-11-23 | none of note |

Width: read at 978 pixels, which still shows the phone layout. Not yet judged at 1,280 or wider.

## What this points to

Five places, not twelve: **Today** (the index: price, levels, gamma, the day's range, stretch, events),
**Flow** (options activity with its record), **Chart** (with Heatseeker), **Outlook**, **News and
calendar**. Everything else lives under Lab until it passes the questions.

Order of work proposed: (1) readable text on desktop; (2) the tab bar cut to five plus Lab; (3) the Today
screen built from the physics, with the stretch read; (4) each kept tool taken to "accepted", one at a time.
