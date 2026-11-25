# Batcave operating framework

Set by the owner on 2026-11-24 (voice call and chat). Every session that works on the terminal reads this
file first and follows it. It replaces ad-hoc fixing: one tab at a time, the same steps every time, and a
tab is finished only when the builder, the independent agents and the owner all say so.

Where this file and an older document disagree, this file wins. `AGENTS.md` still holds the security and
data-source rules; `docs/FIX_PLAN.md` holds the engineering packages this framework is carried out through.

## 1. What the terminal is for

The terminal exists so the person using it can make trading decisions quickly and clearly.

It is tuned for three kinds of trade, in this order (owner, 2026-11-25): same-day options (0DTE), swings that
run for the week, and a longer-term model forecast alongside. Every tab says which of the three a number is
for.

The reader is someone who knows how to buy and sell a call or a put and nothing more. They do not know the
Greeks and should not need to. Every card must make sense to that person on a laptop screen.

Every card answers four things in plain words:

1. What is happening right now.
2. Which levels matter today and this week.
3. The path: if this level is hit, the next level is that one, for this reason. A to B to C.
4. How often this kind of read has been right, as a simple count.

The user never has to type anything in to get an answer. The terminal computes it and shows it.

## 2. Change of direction (2026-11-24)

Earlier rules said the terminal describes conditions and gives no direction. The owner now wants direction,
levels, and entry and exit points on screen. The rule that replaces the old one:

- Direction and levels are allowed when they come from stated rules on measured inputs and carry their
  track record beside them.
- The terminal never promises profit and never reads as if it does. A read with a poor record is fixed or
  removed, not dressed up.
- No hand-set scores presented as odds. A count is always shown with its n.
- Still not allowed: claims about who traded or why, and anything that places an order.

## 3. The roles

Four checks stand between a request and "done". No one grades their own work.

| Role | Who | When | What it answers |
|---|---|---|---|
| Builder | the working session | throughout | does the work |
| Scope check | independent agent, read-only | before building a tab | Is this the right thing? Is anything the owner asked for missing from the plan? Is anything in the plan not asked for? |
| Code review | independent agent, read-only, briefed by `docs/REVIEWER_BRIEF.md` | before every merge | Is the change correct? Confirmed defects only, with file and line. |
| Acceptance check | independent agent, read-only | after the deploy | Given the text and screenshots of the live tab, does each checklist line pass or fail? |
| Owner | the owner | last | A tab is finished only when the owner looks at it and says so. |

The scope check exists because of the gap the owner named: nothing was checking whether the work was the
right work. The acceptance check exists because a merged change is not a finished tab.

Disagreement between agents is settled by evidence from the live site or the code, not by rewording.

## 4. The steps for every request

The same nine steps, in this order.

1. Say back what was asked in one sentence.
2. Look at the live screen first, so the work starts from what the user sees.
3. Write the plan for the tab: its one job, the defects found, what will change. Scope check.
4. Find the cause in the code, not the symptom.
5. Fix it in the one place that number is computed, so every tab gets the fix.
6. Test it. Code review. Fix what is confirmed.
7. Merge only when CI passes.
8. Open the live site and confirm the change is there. Acceptance check against section 6.
9. Report in plain words: what changed on screen, what is still wrong, what comes next.

Small bounded pull requests stay the rule. A tab usually takes several.

## 5. Order of work

One tab at a time, each taken to finished before the next starts.

1. Signals
2. Outlook
3. Chart
4. Models
5. Heatseeker
6. Trade Desk
7. Regime
8. News and the Alpha run
9. Edge Lab
10. Crypto

Take Five is fine as it is. Cosmos is not in the owner's list and is left alone until asked.

The shared source (section 7) is built as part of the first tab that needs it and reused by the rest.

## 6. The checklist every tab must pass

- One job, stated at the top in one sentence.
- Every number comes from the single server source, so no two tabs disagree.
- Every number is dated, and old data is labelled as old.
- Levels for today and for the week are shown, with the if-then path between them.
- Plain words. A term a new options trader would not know is removed or explained in a few words next to it.
- Text is at least 13px from 1,024px wide, the desktop layout shows from 1,024px, and charts read at a glance.
- Times are shown the normal way in Eastern time, such as 4:54 PM, never 16:54.
- The track record for the read is shown beside it.
- Nothing requires the user to enter values.
- No contradiction with any other tab on price, walls, flip, one-day move or direction.

## 7. Data rules

- One source on the server holds price, walls, the gamma flip and the one-day move. Every tab reads it.
  Two named views only: "Today" (nearest expiry) and "Structure" (to 45 days). Each number says which.
- Live prices move to Schwab's streaming feed, leaving the request budget for chains and history.
- If Schwab is linked and a number is missing, that is a bug to fix, not a state to explain. Until it is
  fixed the screen says what is missing and why.
- Stored daily bars are completed sessions (`server/dailyBarsSettled.ts`).
- No fixed SPY-to-SPX multiplier.

## 8. Tab by tab

For each tab: its job, what the owner asked for, what is known to be wrong, and when it is done. "Known"
items come from the live reviews of 2026-11-23 and 2026-11-24 (`docs/SCORECARD.md`).

### Signals
- Job: tell the reader what the market is doing now and which unusual option activity matters.
- Owner asked: unusual volume alerts show how the volume built in five-minute steps per contract (when it
  started, how fast, when it tailed off, the whole position); Unusual Whales as the reference for how it
  reads; normal Eastern times; the trade-level chart redrawn so it is readable; the chain table larger;
  "Schwab stream not connected, not classified" fixed by the streaming feed.
- Known: header and card disagree on gamma (short vs long); two regime labels at once; 15 near-identical
  flow alerts; the ask-side call premium read is buried; 73% of text is 11px; tools start 215px down.
- Done when: one top read, alerts grouped per contract with a five-minute build, times as 4:54 PM, trade
  chart readable, checklist passes.

### Outlook
- Job: the plain-words read for today and this week with its levels.
- Known: "Neutral 34/100 stuck sideways" on a +4.7% day; a hand-set score.
- Done when: the read comes from stated rules, shows today's and the week's levels with the path, and
  carries its record.

### Chart
- Job: price with the levels that matter drawn on it.
- Owner asked: pivot magnet labels such as "A+", "Q-S1", "VN2" written in plain words.
- Known: its gamma label and flip differ from other tabs.
- Done when: every label is plain words, levels match the shared source.

### Models
- Job: where price is likely to travel today, this week and this month, from the option map.
- Owner view: close to right. It must agree with every other tab.
- Known: evening starting price from an old daily bar; pivot card multiplies SPY walls by 10; its flip
  differs from Heatseeker's.
- Done when: starting price is live or dated, levels come from the shared source, record shown.

### Heatseeker
- Job: the option map by strike: where the walls and the flip are.
- Owner view: looking good; the strike table is useful; decide whether the 3D view earns its place; make
  the full map visible.
- Known: map and card show different flips for the same expiry; two one-day moves.
- Done when: one flip per named view, full map visible, 3D view kept only if it reads at a glance.

### Trade Desk
- Job: today's plan: levels, scheduled releases, and the if-then rules.
- Known: lower half not yet reviewed live; browser-clock dates in two places.
- Done when: reviewed in full and the checklist passes.

### Regime
- Job: what kind of market this is and which groups lead or lag.
- Known: washout reads (sector RSI extremes) buried; thermal flip differs; bounce list fixed in #153.
- Done when: the stretch read is at the top with its history count, checklist passes.

### News and the Alpha run
- Owner view: the news looks good, but it does not say what to trade on. The Alpha run must give a
  direction read and levels for the same reader.
- Done when: the Alpha run states direction, today's and the week's levels, the path, and its record.

### Edge Lab
- Owner asked: a daily to weekly briefing, not a monthly outlook: the daily levels and the weekly levels,
  fully computed.
- Known: the five-vote "strong bear 75/100" label (called strong bear on a +4.7% day).
- Done when: the label is replaced by the measured inputs and the two level sets with their paths.

### Crypto
- Owner asked: no manual inputs. For each coin worth showing: a buy level, what to look for before
  entering, the market cap to sell at, and when to get out. Fewer, better coins. Best available sources.
- Known: the scanner has never issued an Enter (0 of 50 needed); most coins it graded were rugs; the
  record is on a volume and survives redeploys.
- Done when: inputs are gone, each shown coin has entry, target cap and exit from the rule book with the
  record beside it, and the intake is narrowed with the reason stated.

## 9. Records to beat (2026-11-24)

- Mapped levels: 39 touches, 9 held, 29 broken.
- Option signals: 38 of 161 finished up 30% or more.
- Regime calls: 139 of 276 matched.
- Crypto: no Enter issued yet.

These are the honest starting point. Each tab's read is tied to one of these counts or starts its own.

## 10. What a session reports

At the end of a piece of work: what changed on screen (seen live, with the commit), what is still wrong,
what comes next. No claim of "fixed" without a live look. Earlier misstatements are corrected by name.
