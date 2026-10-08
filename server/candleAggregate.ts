// server/candleAggregate.ts
//
// Pure helper: roll minute candles up into N-minute candles anchored to the
// 09:30 ET regular-session open of each day (so 60-minute bars are
// 09:30-10:30, ..., 15:30-16:00, the RTH-anchored convention charting
// platforms use for US equities). Schwab's pricehistory only serves 1, 5, 10,
// 15 and 30-minute frequencies, so "2m" is built from 1m bars and "60m" from
// 30m bars instead of returning bars of a different size under that label.

import { etDate, etWallToEpochMs, REGULAR_OPEN_MIN } from "./exchangeCalendar";

export interface CandleLike {
  t: number;          // bar open time, epoch SECONDS
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

/**
 * Aggregate candles (assumed sorted by t, each shorter than `minutes`) into
 * `minutes`-wide candles. Bucket start = 09:30 ET + k x minutes on the bar's
 * ET date (bars before 09:30 fall into buckets counted back from 09:30).
 */
export function aggregateCandles<T extends CandleLike>(candles: readonly T[], minutes: number): CandleLike[] {
  if (!(minutes > 0) || candles.length === 0) return candles.map((c) => ({ ...c }));
  const width = minutes * 60;
  const anchorCache = new Map<string, number>();
  const out: CandleLike[] = [];
  let cur: CandleLike | null = null;
  for (const b of candles) {
    const date = etDate(b.t * 1000);
    let anchor = anchorCache.get(date);
    if (anchor == null) {
      anchor = Math.floor(etWallToEpochMs(date, REGULAR_OPEN_MIN) / 1000);
      anchorCache.set(date, anchor);
    }
    const start = anchor + Math.floor((b.t - anchor) / width) * width;
    if (cur && cur.t === start) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v = cur.v == null && b.v == null ? null : (cur.v ?? 0) + (b.v ?? 0);
    } else {
      if (cur) out.push(cur);
      cur = { t: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    }
  }
  if (cur) out.push(cur);
  return out;
}
