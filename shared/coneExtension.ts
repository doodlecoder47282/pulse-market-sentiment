// shared/coneExtension.ts
//
// Pure: extend an intraday forecast band past its last horizon to the
// session close (ML Lab chart, client/src/components/MLProjectionPanel.tsx).
// Round 3 (Sector 9): the band used to be extended by drawing the 30 -> 60
// minute SLOPE of each line straight on to 16:00 (capped at +-1.5%), which
// grows the band linearly in time and keeps extrapolating the median's drift.
// A diffusion band grows with the square root of time (variance additive in
// time: the same square-root-of-time rule as the baseline cone,
// server/mlServedBand.ts, flat intraday profile), and the median is not
// extrapolated, so beyond the last fitted horizon h:
//   base(t)      = base(h)
//   upper(t)     = base(h) + (upper(h) - base(h)) sqrt(t / h)
//   lower(t)     = base(h) - (base(h) - lower(h)) sqrt(t / h)
// with t the minutes since the band's anchor. It stops at the session close
// passed in (13:00 ET on half days, from the exchange calendar), and draws
// nothing when the close is unknown or already passed.

export interface ExtensionRow { minute: number; bullExt: number; baseExt: number; bearExt: number }

export function sqrtTimeExtension(args: {
  /** Minute (after 09:30 ET) the band is anchored at (t = 0). */
  anchorMinute: number;
  /** Minute of the last fitted horizon and the band there (prices). */
  lastMinute: number;
  base: number;
  bull: number;
  bear: number;
  /** Session close, minutes after 09:30 ET (390 regular, 210 on a 13:00 half day); null = unknown / no session. */
  closeMinute: number | null | undefined;
  stepMin?: number;
}): ExtensionRow[] {
  const { anchorMinute, lastMinute, base, bull, bear } = args;
  const close = args.closeMinute;
  const step = args.stepMin ?? 5;
  const h = lastMinute - anchorMinute;
  if (close == null || !Number.isFinite(close) || !(h > 0) || lastMinute >= close) return [];
  if (![base, bull, bear].every((x) => Number.isFinite(x))) return [];
  const up = bull - base, dn = base - bear;
  const out: ExtensionRow[] = [{ minute: lastMinute, bullExt: bull, baseExt: base, bearExt: bear }];
  const firstStep = Math.ceil((lastMinute + 1e-9) / step) * step;
  for (let m = firstStep === lastMinute ? lastMinute + step : firstStep; m <= close; m += step) {
    const k = Math.sqrt((m - anchorMinute) / h);
    out.push({ minute: m, bullExt: base + up * k, baseExt: base, bearExt: base - dn * k });
  }
  if (out[out.length - 1].minute < close) {
    const k = Math.sqrt((close - anchorMinute) / h);
    out.push({ minute: close, bullExt: base + up * k, baseExt: base, bearExt: base - dn * k });
  }
  return out;
}
