// server/flowDedup.ts
//
// One definition of the whale dedup keys, used by the live engine and by the
// restart hydration from whale_alerts. They used to differ (the engine keyed
// on floor(log2(premium / floor)) with an untiered coarse key, hydration on
// ceil(premium / 1e6) with a tiered coarse key), so no hydrated key ever
// matched and every restart re-fired the last 18 hours of whales.
//
// Tier: doublings of the premium over the floor. A whale re-fires only when
// its premium has doubled since it last fired (tier +1); both keys carry the
// tier so the coarse key (same contract surface, different OCC spelling)
// cannot block a doubling.

export function premiumTier(premium: number, premiumFloor: number): number {
  const floor = Math.max(1, premiumFloor);
  return Math.floor(Math.log2(Math.max(1, premium / floor)));
}

export function dedupKeysFor(args: {
  occ: string; symbol: string; type: string; strike: number; expiration: string; premium: number; premiumFloor: number;
}): { fine: string; coarse: string; tier: number } {
  const tier = premiumTier(args.premium, args.premiumFloor);
  return {
    tier,
    fine: `${args.occ}|t${tier}`,
    coarse: `coarse|${args.symbol}|${args.type}|${args.strike}|${args.expiration}|t${tier}`,
  };
}
