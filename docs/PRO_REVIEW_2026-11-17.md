# Practitioner review, 2026-11-17

Two independent read-only reviews of main at e2217031: one as a professional options trader, one as a
professional Solana meme-coin trader. Each questioned what every tab shows, checked the calculation behind
it and listed what is missing. This file is the backlog from both. Items are confirmed by reading code
unless marked "unverified". Status is kept in docs/BATCAVE_STATE.md.

## The live record on 2026-11-17 (rule book v2026.11.16-1)

Crypto: 4,170 coins logged (4,462 rows), 0 ever ENTER; of the watched coins 104 hit the $5M cap, 27 doubled,
1,017 rugged, 75 dead, 1,785 no data (59% of resolved). Replay: 0 of 3,008 graded first signals pass the
current rules (score blocks 3,008; top-10 unread 3,008; flow not sustained 2,858; authorities unread 2,749;
Jupiter unchecked 2,621). Median age at signal 2.5 min, median cap about $37k, median 24 min to the sampled
peak; under $100k cap the median net result is -100%. Score medians: winners 54, losers 53.
Whale flow: 22 tracking, 0 closed in 7 days. Put/call baseline: 0 of 20 sessions on every symbol.

## Options side

### Defects (O1-O6)
- O1 Whale direction flips between polls. The preview rebuilds each hit every 30 s and labels it from the
  latest print against the current quote (server/schwabFlow.ts deriveSentiment), while the gate passes on the
  day's ask-side share (flowAttribution askSideRead). A call that passed as ask-side shows BEARISH when its
  latest print is at the bid. Fix: one basis (the gate's), fixed at first detection; last print as detail.
- O2 "% mid" and "% if sold at bid" use different entries. entry.mark = premium / (volume x 100) is the
  day's average traded price; entry.ask is the quote at detection. Fix: entry.mark = mid at detection.
  The "premium blown" and CLOSING tests inherit the wrong base.
- O3 Whale positions never show as closed. The closed list asks for TERMINAL without includeExpired, so
  EXPIRED rows are dropped; expiry is only stamped inside the next session's scan, with that timestamp.
  Unverified: whether positions survive a restart on the deployed volume. Fix: expiry pass on a timer after
  the close, stamped at the expiry close; includeExpired=true.
- O4 Put/call baseline "0/20 sessions". Outside the session the comparison minute is 1440 and no stored
  point is that late, so every session is dropped (reproduced: n 0 at minute 1440, n 30 at 390). The
  recorder also starts only after the first panel request. Fix: compare each day's last point; start at
  boot; report stored and usable sessions separately.
- O5 Unrounded "net-delta momentum" (FlowPanel fmtVol falls through to String(v) for negatives and values
  under 1,000). Audit item S24.
- O6 "NET BIAS +$350.7M BULL" beside P/C 1.53 and "DOMINANCE 1.7% P". Net bias re-tags each contract's whole
  day premium by its latest print, is dollar-weighted, and calls a bid-side put bullish though it may be a
  closing sale. Fix: "last-print net premium", no BULL/BEAR, unit and window stated on all three.

### Wrong or unstated (O7-O16)
- O7 Intraday GEX, walls and flip use last night's open interest; only Heatseeker's weekend banner says so.
- O8 Three weights for the same quantity: Signals/Models OI only; 0DTE map OI + 0.25 x volume; Killbox
  switches at volume > 5 x OI. The same strike can differ by tab.
- O9 "Dealers long gamma" stated as fact on Signals and the Exposure footnote (it is a convention).
- O10 Exposure footnote says 262 trading days; the code uses calendar time.
- O11 Signals regime band is a fixed +-$50M per 1%, not scaled to the symbol.
- O12 Wiener scorecard pools every level of a day; levels on one day are correlated, so n overstates.
- O13 Scenario odds: no spread-width filter, zero-bid wings enter at mid.
- O14 Edge Lab backtest calls a result "promising" at 20 trades with no out-of-sample split.
- O15 "IV30" is one listed expiry between 25 and 35 days, not interpolated to 30: history jumps on the roll.
- O16 Spread detection is only "another hit, same expiry, same scan, premium within 2.5x".
Confirmed correct: GEX formula and units ($ per 1% move), exact straddle-implied sigma, exact first-passage
touch odds, SVI-smoothed Breeden-Litzenberger labelled risk-neutral, Wilson-bound Kelly with a 5% cap.

### Missing, ranked (all from Schwab unless noted)
1. A graded record of every emitted signal with one entry basis and one expiry rule.
2. Intraday OI estimate per strike with error bounds, checked each morning against posted OI.
3. Gamma split 0DTE / 1-7 / 8-45 days, one weight everywhere, with an "OI as of" stamp.
4. Trade-level tape for watched contracts (stream; partial: limited symbols, no condition codes).
5. Greeks and a scenario P&L grid for a user-entered idea, entered at the ask.
6. Constant-maturity IV30, IV rank and percentile (forward only; no history endpoint).
7. Skew and term-structure history (forward only).
8. Net premium per strike by expiry from attributed prints.
9. Event implied move vs past realised moves (no earnings dates from Schwab).
10. Session levels: VWAP with bands, opening range, prior day and overnight high/low.
11. Alerts on level touches, gamma sign change and whale detection, each logged into item 1.
12. Quote age and spread quality on every tile that prices an option.

## Crypto side

### Why ENTER has never fired (C1-C6)
- C1 The score ceiling. Flow up to 35, structure 25 minus 5 per flag, name up to 15, narrative up to 15,
  attention up to 10; ENTER needs 70. A zero-flag coin with no name or narrative hit tops out at 60. At
  minute 2 "under 10 min old" and "Jupiter unchecked" are near-universal, so the typical score is 51-56.
- C2 volAccel is an age artifact: (vol5m / 5) / (vol1h / 60) is exactly 12 for any coin under 5 minutes
  old, for winners and losers alike.
- C3 Jupiter: one call of 50 mints against a batch of 90, highest score first; a mint outside the 50 is
  reset to "unchecked" on every refresh, loses 5 points and stays at the back.
- C4 Security: 2 tokens per 45 s, one holder read per tick, against up to about 1,200 arrivals an hour;
  the second token of a tick is retried after 30 min, past the 24-minute median peak. No row with
  authorities read has a top-10 value (unverified: the public RPC call may be failing or cooling down).
- C5 Sustained flow needs 2 of 3 polls about 225 s apart, so the earliest ENTER is about minute 10; 35% of
  coins have peaked by then.
- C6 The replay grades only each coin's first signal and the log keeps one WATCH row per pair per day, so
  later, better-informed states are never stored: a first row cannot pass the sustained, authority or
  top-10 gates. Part of "0 of 3,008" is built in.

### Wrong or assumed (C7-C16)
- C7 "Graduate" was true for any dex id containing "pump", bonding-curve pairs included.
- C8 Honeypot hard kill (25+ buys, 0 sells) fires on bonding-curve coins, which cannot block sells.
- C9 "Win" (DOUBLED) is a sampled touch of 2x within 72 h; the graded return exits at the horizon, so a
  "win" can be down 90%. Feature tables rank on the touch.
- C10 Once a coin is untracked the grader samples it about once every 3 hours, not every 4 minutes.
- C11 No-data 59%: the grader asks for the original pair only; a coin that graduates to a new pool loses
  its upside. Biased against winners. Recoverable from GeckoTerminal OHLCV (unverified for dead pools).
- C12 Exit plans exist only for ENTER rows, so none has ever been graded; within one sample trims are
  credited before the stop; the time stop is 24 h against a 24-minute median peak; size assumes a 35%
  loss while the median loss is 100%.
- C13 Costs: 1.25% per leg plus $0.25 is likely low for the curve (unverified); failed transactions,
  sandwiching and tip variance are not modelled.
- C14 Look-ahead in stored features: candles are back-filled onto the first row; the bundle field is
  rewritten on open rows later.
- C15 The LP-lock flag penalises the bucket that wins more in the record (trivially 100% on the curve).
- C16 No flag for serial relaunches of one name or deployer (the listener already stores both).

### Not read today, ranked
1. Graduation as the entry universe (no new source).
2. Deployer history from the desk's own outcomes (no new source; listener keeps 3 days).
3. Curve progress and time to graduation (listener).
4. Dev wallet sells (listener; creator side is currently excluded).
5. Unique buyers vs wash, buy-size distribution (listener).
6. Same-name relaunch count in 24 h (listener).
7. Bundled share and still-held share at signal time (already read; timing fix needed).
8. DexScreener paid orders, CTO, profile (keyless, one call per coin).
9. Holder-count growth, fresh-wallet share (keyed source).
10. Smart-money buys (keyed, or a home-grown list from past winners' launch windows).
11. X / Telegram / KOL calls (paid).
12. Time of day (already stored).
A per-trade read from the listener would give true peaks and make stops and trims gradeable.

### Candidate rule set to test on the record (no claim of edge)
Drop the score gate; block top-10 only when read and over 45%; block Jupiter only on diverge or no price;
treat pump mints' authorities as revoked (assumption to verify); replace sustained flow with a two-sided
tape on one reading (at least 5 sells and 30 buys in the hour, 5-minute buy ratio 0.55-0.90); age at least
10 minutes; at least one attention confirmation (boost, narrative hit, or 3+ Bluesky mentions); block a name
seen twice in the prior 24 h. The reviewer's arithmetic: the plan needs a 2x touch rate of about 44% (67% if
losers go to -100%) to break even; the best bucket in the record is about 23%. On these numbers nothing is
positive yet and the minute-2, under-$1M universe looks like the wrong one.
