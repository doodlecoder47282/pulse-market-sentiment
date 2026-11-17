// shared/cryptoFlow.ts
//
// Volume acceleration: the last 5 minutes' volume pace over the pace of the comparison window. Pure.
//
// The window is the last hour, or the coin's own life when it is younger than an hour. Until rule version
// 2026.11.17-1 the hour's volume was always divided by 60, so for a coin 3 minutes old, whose "1 h volume"
// IS its 5-minute volume, the ratio was exactly 12 whatever the tape looked like: the record read on
// 2026-11-17 showed a median acceleration of 12.00 for winners and for losers. Under
// CRYPTO_RULES.flow.accelMinAgeMinutes there is no baseline to compare with (the 5-minute window is most of
// the coin's life), so the figure is null: not read, never a number.

import { CRYPTO_RULES } from "./cryptoRules";

export const VOL_ACCEL_METHOD =
  "5-minute volume pace over the pace of the last hour (or of the coin's own life when younger than an hour); not read under the minimum age";

export function volumeAcceleration(
  vol5m: number | null | undefined,
  vol1h: number | null | undefined,
  ageMinutes: number | null | undefined,
  minAgeMinutes: number = CRYPTO_RULES.flow.accelMinAgeMinutes,
): number | null {
  if (vol5m == null || vol1h == null || !Number.isFinite(vol5m) || !Number.isFinite(vol1h)) return null; // missing is not zero flow
  const ageKnown = ageMinutes != null && Number.isFinite(ageMinutes) && ageMinutes >= 0;
  if (ageKnown && (ageMinutes as number) < minAgeMinutes) return null;
  const window = ageKnown ? Math.min(60, ageMinutes as number) : 60; // age unknown: the hour, as before
  const paceM5 = vol5m / 5;
  const paceWindow = vol1h / window;
  return paceWindow > 0 ? paceM5 / paceWindow : (paceM5 > 0 ? 5 : 0);
}
