# The 0DTE map: the day's plan from the dealer-gamma terrain

Status 2026-10-14. Code: `shared/odteMap.ts` (composer, text, comparison),
`shared/odteSettle.ts` (settle evaluation, tally), `server/odteForward.ts`
(the forward computation, moved out of routes.ts), `server/odteMapLedger.ts`
(morning plan, settle timer, ledger), `server/odteSettleInputs.ts`,
`client/src/components/OdteMapCard.tsx` (Trade Desk). Routes:
`GET /api/odte/map`, `GET /api/odte/map/ledger`, `POST /api/odte/map/compare`
(personal edition).

## 1. What the map is

The same per-strike 0DTE dealer gamma the Heatseeker's forward already
computes (Black-Scholes gamma on one clock, open interest plus a quarter of
today's volume, dealer long calls / short puts, $ per 1% move), composed into
the form a trader reads before the open:

- **Gap**: session open vs prior close, in points and percent; "flat" under
  0.15%.
- **Range**: spot plus or minus the ATM straddle mid (the straddle-range
  convention) and, beside it, spot plus or minus one standard deviation to
  the close from the same straddle (the forward's convention).
- **Strikes** within 2% of spot carrying at least 1% of the gross exposure,
  in $ per 1% move and $ per index point (per point = per 1% / (S/100)),
  labelled: **pin** (largest positive within 1.5%), **wall above** /
  **magnet below** (largest positive on each side), **pocket above / below**
  (largest negative on each side), up to four **shelves** (other positives
  over 35% of the pin) and four **pockets** (other negatives over 30%). A
  strike within 0.03% of spot is "at" spot and belongs to neither side.
- **Band**: the re-priced zero crossings of this expiry's net gamma nearest
  spot; with long gamma at spot they bound the long-gamma band, with short
  gamma they are where gamma turns positive.
- **Ladders**: the nearest eight levels above and below spot (straddle and
  sigma rails, labelled strikes, flip, band edges, session high / low, prior
  close), each on the side it is actually on.
- **Zones** (personal edition only; the server decides by edition): dip at
  the magnet below spot with the premise failing under the next positive
  strike; fade between the straddle-range top and the pocket or wall above
  when that sits past half a straddle; no-trade around the nearest
  short-gamma pocket within 1% that is at least a fifth of the pin. A
  no-trade pocket that overlaps the dip zone replaces it. These are rules on
  the map, labelled heuristic, not a forecast; investors see levels only.

The card has a $/1% and $/pt switch, the plan as a text block to copy, the
method, and the settle ledger.

## 2. The published map it was asked to match

The user supplied a friend's SPX 0DTE plan (Oct 12: gap, straddle range,
eleven strikes with signed $M values, long-gamma band, ladders, dip / fade /
no-trade zones). Batcave reproduces the *form* from its own numbers; it was
not tuned to that day's values (user decision). Two things stand out:

- The friend's magnitudes ($5M-$25M per strike) are the scale of **$ per
  index point**, not per 1%: the demo chain gives +$49M per point at the pin
  against +$3.4B per 1%. The per-point switch exists for that comparison.
- Several of his labels map one-to-one: dominant pin = pin, magnet = magnet
  below, ceiling = pocket above, pocket = pocket, long gamma = band, range
  straddle = straddle range, and the three zones. "Bull / base / bear
  ladders" are the above / below ladders.

To measure agreement on a live day, `POST /api/odte/map/compare` with
`{ levels: [{ level, value }], tolerancePts }` returns, for each of their
levels, our nearest strike within the tolerance, sign agreement, and the
Spearman rank correlation of magnitudes over matched rows (average ranks for
ties). It reports; it never changes the map.

## 3. Settle and lessons

The ledger keeps the morning plan (the map taken at 09:35 ET by the server's
timer, or the first one requested after the open) and the latest map. From
16:06 ET it settles the day from today's regular-session minute candles: the
last bar must start within five minutes of the close or the day stays
unsettled (partial is not settled). The evaluation records, against the
morning plan: settle inside the straddle range, the session inside it, the
same for the sigma range, settle minus pin, the nearest landmark, whether
the long-gamma band held the session, and each zone's outcome (touched;
dip premise held; fade top held; no-trade pocket crossed only when both
edges were exceeded). Investors get the level outcomes; zone outcomes and
zone tallies stay in the personal edition.

The tally is counts with denominators and a median |settle − pin|. Under 50
settled days the note says counts only, no claim of edge; at 50 it still
says these are not calibrated probabilities. "Settle inside the straddle
range" is the market staying inside its own expected move; it is not a
Batcave skill measure.

## 4. Verification

- `tests/quant/odte-map.test.ts` (7): the real forward on the demo chain
  with injected sources, label rules, zones, gap reads, unpriced / closed /
  short-gamma states, ladders, the comparison helper, helpers.
- `tests/quant/odte-settle.test.ts` (3): zone outcomes, ranges, pin
  distance, lesson line, tally, candle inputs on the demo tape.
- `tests/quant/odte-map-review.test.ts` (21): an independent reviewer's
  findings (band wording under short gamma, ladder units, zero-width fade,
  no-trade without a pin, one-sided poke counted as crossed, partial tape
  recorded as a settle, spacing from filtered rows, basis text on the
  fallback invalidation, at-spot rows labelled as a side, tie handling in
  the rank correlation, session high on the wrong ladder, overlapping
  zones, zone outcomes leaking to the investor ledger), all fixed.
- The forward move was checked line by line against the HEAD route body:
  only nowMs threading, injectable sources and four additive fields differ.
- CI demo smoke calls `/api/odte/map` on the sample chain (state ok, pin
  labelled, no zones in the demo, per-point consistent with per-1%).
- Live Schwab is not reachable from the development environment; the
  owner's check is the Trade Desk card during a session, then the ledger
  after 16:06 ET.
