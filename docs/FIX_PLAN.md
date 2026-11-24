# Fix plan: how the terminal gets from the scorecard to "accepted"

Written 2026-11-24. `docs/SCORECARD.md` says what is wrong. This file says how it gets fixed, in what order,
and how anyone can tell a fix is finished. `docs/REFERENCE_LIBRARY.md` lists the sources.

## What existed before this file, and what was missing

Existed: the twelve questions; the list of faults seen live; the review, CI and live-check routine.
Missing, and supplied here: the rules every fix follows, one definition for each number the terminal
shows, the work in order with a test for each piece, and what "done" means.

## Five rules

1. **Physics and simple variables.** A number on screen is the output of a stated model from measured
   inputs: price, strike, time to expiry, implied volatility, open interest, volume. No hand-set weights.
2. **One definition, one place.** Each quantity is computed by one module. Every tab reads that module.
   When a second implementation is found it is deleted, not fixed.
3. **Every number names its time frame and its inputs' age.** A card whose inputs are older than the
   session it describes says so and gives no verdict.
4. **Describe, then count.** The terminal states what is measured, and beside any read that has a record it
   shows the count (for example: touched 39, turned back 9). No count, no claim.
5. **Delete before adding.** Nothing new goes on a screen until what it replaces is gone.

## The quantities, defined once

These are the definitions to build to. Each gets a row in a spec table (formula, source, one worked
example with real numbers) before code changes.

| Quantity | Definition | Open point |
|---|---|---|
| Price | Last regular-session trade from Schwab; after the close, that session's last print | none |
| Session clock | `shared/exchangeCalendar.ts` (holidays, half days, New York time) | none |
| One-day move | At-the-money straddle of the nearest expiry, scaled to the time left; when no straddle is readable, VIX / sqrt(252), labelled as the fallback | today three tabs show three values |
| Gamma exposure at a strike | gamma x open interest x 100 x price squared x 1%, calls positive and puts negative (the owner's Excel convention) | which volume weighting, if any |
| Wall above, wall below | Strike with the largest call (above) or put (below) gamma exposure within two one-day moves of the price | none after the reach rule |
| Gamma flip | Price where the summed exposure profile crosses zero, by re-pricing the chain across a grid of prices | it moves with price intraday: show as a state ("short gamma here"), not as a fixed level |
| Expiry view | Exactly two, each named on screen: **Today** (nearest expiry) and **Structure** (all expiries to 45 days) | today there are six unnamed variants |
| Level odds | Random-walk chance of touching a level before the close, from the one-day move (Heatseeker's table) | none: this is the model for the rest |
| Stretch | Five measured values for the index, each with its own history count: 5-session change, distance from the 20-day average, RSI(14), VIX 9-day against VIX, share of sector funds at a 20-day low | the owner's list of Friday factors |

## How one fix is done

1. Write the spec row: formula, source, worked example.
2. Put the calculation in one shared module, with the worked example as its test.
3. Point every consumer at it. Delete the other implementations.
4. Independent review, then CI.
5. Look at it on the live terminal, at phone and desktop width.
6. The owner looks and says yes or no. Only a yes moves the tool to "accepted" in the scorecard.

## The work, in order

Each package is finished when its test passes on the live terminal.

| # | Package | Finished when |
|---|---|---|
| 0 | Records survive | The database is on storage that outlasts a redeploy; the "sessions recorded" counts keep rising across deploys |
| 1 | No verdict from stale inputs | After the close on any day, no card shows a price or return from before that session; Edge Lab and Models either use the session just ended or say they cannot |
| 2 | One truth | One module supplies price, one-day move, walls, flip and exposure for the two named views; every tab shows the same number for the same view; a test compares every endpoint |
| 3 | Remove the hand-set layers | The three playbooks, the composite score, AI Outlook's score, the regime label and the 0DTE alert grade are gone from the main screens or moved to Lab; what they summarised is shown as measured state |
| 4 | Today | One screen answers: where is price, what are the levels and the odds of reaching each, how big is a normal day, is the index stretched, what is flow doing, what is scheduled. Alerts of one kind are one line |
| 5 | Readable | From 1,024 px wide: no text under 13px, the tools start within 120 px of the top, the desktop layout is used. Phones unchanged |
| 6 | Five places and Lab | Today, Flow, Chart (with Heatseeker), Outlook, News and calendar; the rest under Lab |
| 7 | Accept each kept tool | Scorecard shows "accepted" with the date, tool by tool |

Crypto runs beside this as its own track: first its record (it has never issued an Enter; 1,035 of 1,342
graded coins rugged), then its rules judged against that record.

## How counts become estimates: hierarchical Bayes (owner's suggestion, 2026-11-24)

Every record here is small: 39 level touches, 5 scored days, 2 graded protocol arms. A raw rate from a
handful of cases swings wildly; a hand-set weight ignores the data altogether. A Bayesian hierarchical model
sits between the two. Each group (a level type, a ticker, a rule) gets its own rate, and the groups share a
common prior learned from all of them, so a group with 3 cases leans on the others and a group with 300
speaks for itself. The output is a rate with a range that is honest about the sample: "put walls: turned
back 3 of 7; estimate 31%, plausible range 12% to 55%".

Use it as an input to a read, never as a signal by itself. Where it goes, in order of fit:
1. **Level record** (Trade Desk, Chart, Heatseeker): turned-back rate by level type, pooled across types.
2. **Level odds** (Heatseeker): a correction to the random-walk touch odds by time of day, learned from
   the scorecard.
3. **Stretch** (Today): the chance of an up week given the stretch values, with a range, in place of any
   weights.
4. **Flow** (whale alerts): hit rate by ticker and by rule, pooled.
5. **Crypto**: outcome rates by rule and by coin age.

The first version is a beta-binomial with the prior fitted from the data, which needs no sampling library
and can be checked by hand. It comes after packages 0 to 2: it needs records that survive and one
definition of each quantity. Rule 4 still holds: the count is always shown beside the estimate.

## What will not be done while this plan runs

No new tabs, no new scores, no new alert types except the stretch read in package 4. No wording passes on
screens that packages 3 and 6 will remove.

## Decisions the owner still has to make

1. Is the database on a Railway volume? (Package 0.)
2. For Today, is the nearest expiry the right view, with Structure as the second? (Package 2.)
3. Which factors pointed to Friday 2026-11-20 as a bounce? (Stretch, package 4.)
4. The Excel sheet with the Greeks and exposure formulas, to check the spec rows against. (Every package.)
