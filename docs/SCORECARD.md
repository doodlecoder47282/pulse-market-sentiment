# Scorecard: is each tool worth its place?

Started 2026-11-23 at the owner's request: judge every tool as a professional futures, options and quant
trader would, and as a product developer who cares what the customer sees. This file is the measure of
progress. A tool is "accepted" only when the owner has looked at it and said yes.

Status of this version: PROVISIONAL. It is written from the code and from the screens seen live up to
2026-11-23. Chart, Heatseeker, Trade Desk, Cosmos, Take Five and Crypto have not been looked at live in this
pass (the address used for checking was removed and the live one needs the owner's access key).

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

## Tool by tool

| Tab | What it is | Verdict | Why | Seen live |
|---|---|---|---|---|
| Signals | Whale flow, flow alerts, put/call ratio, ticker scan | FIX | The first thing shown is whale alerts, whose own record says they lose. Lead with the state of the index; keep ticker scan and put/call; show whale alerts with their record, lower down. | yes |
| Outlook | Levels, expiries, implied range, events to the last expiry read | KEEP | One job, real inputs, clear after the trim. Add the index stretch read and what each expiration removes. | yes |
| Chart | SPX chart with dealer levels | KEEP | The core of a levels terminal. Show each level type's own record (turned back of touched). | not this pass |
| Heatseeker | 0DTE strikes, Greeks, the random-walk map | KEEP | Physics from measured inputs. | not this pass |
| Models | Composite score, "ML forward path", daily/weekly/monthly ranges | FIX, mostly CUT | Its own description says "hand-set weights, not a probability". The daily range seen was plus or minus 5.7% beside a one-day move of 2%. Keep the option-implied ranges; cut the composite. | partly |
| Trade Desk | Playbook, levels, releases today, tools | FIX | Releases card is sound. The playbook is the hand-set layer. Levels repeat Chart. | partly |
| Regime | Regime label, sector rotation, pullback list | FIX | The label read "Value-led leadership, mid-cycle" in a week the index fell 8.6% with VIX at 36. Sector rotation is useful. Pullback list fixed 2026-11-23. | partly |
| Edge Lab | Ticker briefing, skew, experiments | FIX | Skew is sound. The briefing's playbook is the hand-set layer again. | yes |
| News | Headlines, event calendar, earnings, rules brief | FIX | The calendar is the valuable part. The feed is mostly off-topic. The keyword brief adds little. | yes |
| Cosmos | Astronomy and financial astrology | LAB | Its own header says "for entertainment, not a trading signal". Fails question 1. | not this pass |
| Take Five | Breathing pacer and the owner's rules | KEEP, not as a tab | A personal tool with no data. A button, not a place in the tab bar. | not this pass |
| Crypto | Crypto prices, funding, narrative | LAB or its own app | A different market with different users. Owner's call. | not this pass |

## What this points to

Five places, not twelve: **Today** (the index: price, levels, gamma, the day's range, stretch, events),
**Flow** (options activity with its record), **Chart** (with Heatseeker), **Outlook**, **News and
calendar**. Everything else lives under Lab until it passes the questions.

Order of work proposed: (1) readable text on desktop; (2) the tab bar cut to five plus Lab; (3) the Today
screen built from the physics, with the stretch read; (4) each kept tool taken to "accepted", one at a time.
