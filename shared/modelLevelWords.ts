// The words for every level line on the Models chart (owner, 2026-11-25, pointing at "TURN PT" on the live
// chart: a tag nobody explains is no use to a reader). One table: the tag drawn on the line, written out in
// full, and one sentence on what the line means. The chart, the ladder under it and the legend all read it.

export interface LevelWords { tag: string; means: string }

export const MODEL_LEVEL_WORDS: Record<string, LevelWords> = {
  zeroGamma:     { tag: "TURNING POINT",   means: "Above this price swings tend to be smaller; below it they tend to be bigger." },
  callWall:      { tag: "CEILING",         means: "The heaviest level above the price. Rallies tend to stall here; a break above it opens the upside target." },
  putWall:       { tag: "FLOOR",           means: "The heaviest level below the price. Drops tend to slow here; a break below it opens the downside target." },
  dominantMag:   { tag: "STRONGEST PIN",   means: "The price with the most calming positioning. Price is often drawn toward it and can stick there." },
  strongMag:     { tag: "SECOND PIN",      means: "The next strongest such price; a common resting point on the way to the strongest pin." },
  upsidePivot:   { tag: "UPSIDE TARGET",   means: "Where the bull path aims once the ceiling gives way." },
  downsidePivot: { tag: "DOWNSIDE TARGET", means: "Where the bear path aims once the floor gives way." },
  extremeVac: { tag: "FAST-MOVE ZONE", means: "The heaviest positioning of the kind that adds to moves; price tends to move through here quickly." },
  zommaBridge: { tag: "SHELF BELOW", means: "The point below the price where calming positioning builds fastest; a place a dip may pause." },
  negGammaEntry: { tag: "FASTER ABOVE",    means: "Above this price the positioning stops calming moves, so a rally through it can speed up." },
  vannaFlip:     { tag: "VOLATILITY FLIP", means: "Where the effect of rising or falling volatility on hedging switches direction. Matters most when the VIX is moving." },
  charmTarget:   { tag: "TOP LEVEL ABOVE", means: "The largest level just over the current price." },
  upperVomma:    { tag: "FAR LEVEL ABOVE", means: "The largest level well above the price: a marker for an outsized up day, not a normal target." },
  lowerVomma:    { tag: "FAR LEVEL BELOW", means: "The largest level well below the price: a marker for an outsized down day, not a normal target." },
  mopexMaxPain: { tag: "MAX PAIN", means: "The price at which the options in this window would be worth the least at expiry." },
  t1Up: { tag: "STRETCH 1 UP", means: "The current price plus 0.8 times the distance from floor to ceiling." },
  t2Up: { tag: "STRETCH 2 UP", means: "The current price plus 1.6 times the distance from floor to ceiling." },
  t1Down: { tag: "STRETCH 1 DOWN", means: "The current price minus 0.8 times the distance from floor to ceiling." },
  t2Down: { tag: "STRETCH 2 DOWN", means: "The current price minus 1.6 times the distance from floor to ceiling." },
};

export function modelLevelTag(kind: string): string {
  return MODEL_LEVEL_WORDS[kind]?.tag ?? kind.toUpperCase();
}
