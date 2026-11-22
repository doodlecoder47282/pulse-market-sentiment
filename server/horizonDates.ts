// server/horizonDates.ts
//
// Date labels for the model horizons (daily, weekly, monthly, quarterly). Pure: the clock is an argument.
// "Today" is New York's date. From 7 or 8 PM New York time a UTC server clock is already on tomorrow, and
// these labels used to move a day (and, on monthly OPEX evening, a month) ahead of the chain pricing.

import { etDate } from "../shared/exchangeCalendar";

export type HorizonKey = "daily" | "weekly" | "monthly" | "quarterly";

export function buildHorizonDates(h: HorizonKey, nowMs: number = Date.now()): {
  spotAnchorDate: string;
  targetDate: string;
  targetDateLong: string;
  waypointLabels: string[];
} {
  // New York's date, held as local noon so the day arithmetic below is the same under any server clock.
  // The chain pricing for these horizons (horizonTargetIso) is on New York's date; the labels have to agree.
  const [ey, em, ed] = etDate(nowMs).split("-").map(Number);
  const now = new Date(ey, em - 1, ed, 12);
  const dayNames = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mm = (d: Date) => d.getMonth() + 1;
  const dd = (d: Date) => d.getDate();
  const fmt = (d: Date) => `${dayNames[d.getDay()]} ${mm(d)}/${dd(d)}`;
  const fmtLong = (d: Date) => `${dayNames[d.getDay()].toUpperCase()} ${monthNames[d.getMonth()].toUpperCase()} ${dd(d)}, ${d.getFullYear()}`;

  const spotAnchorDate = fmt(now);

  if (h === "daily") {
    const labels = ["OPEN", "10:30", "12:00", "14:00", "CLOSE"];
    return { spotAnchorDate, targetDate: `${spotAnchorDate} CLOSE`, targetDateLong: fmtLong(now), waypointLabels: labels };
  }

  if (h === "weekly") {
    // Find the Monday of the target week. If today is Sat/Sun, that's the upcoming
    // Monday. If we're already mid-week (Mon–Fri), use the current week's Monday so
    // historical+forward path stays anchored to the same trading week.
    const dow = now.getDay(); // 0=Sun..6=Sat
    const mon = new Date(now);
    if (dow === 0) mon.setDate(now.getDate() + 1);          // Sun → next Mon
    else if (dow === 6) mon.setDate(now.getDate() + 2);     // Sat → next Mon
    else mon.setDate(now.getDate() - (dow - 1));            // Mon..Fri → this Mon
    // Build full Mon–Fri label set (5 trading days)
    const labels: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      labels.push(fmt(d));
    }
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    return { spotAnchorDate, targetDate: fmt(fri), targetDateLong: fmtLong(fri), waypointLabels: labels };
  }

  if (h === "monthly") {
    // monthly — target 3rd Friday of this month (or next if passed)
    const third = thirdFridayOf(now);
    const target = now > third ? thirdFridayOf(new Date(now.getFullYear(), now.getMonth() + 1, 1)) : third;
    const weeks = Math.max(1, Math.ceil((target.getTime() - now.getTime()) / (7 * 86400000)));
    const labels: string[] = [];
    for (let i = 0; i <= weeks; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i * 7);
      if (d > target) break;
      labels.push(fmt(d));
    }
    if (labels.length < 2) labels.push(fmt(target));
    return { spotAnchorDate, targetDate: fmt(target), targetDateLong: fmtLong(target), waypointLabels: labels };
  }

  // quarterly — target 3rd Friday three months out
  const m3 = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  const target = thirdFridayOf(m3);
  // Waypoints: each monthly OPEX along the path (this month, +1mo, +2mo, +3mo)
  const labels: string[] = [spotAnchorDate];
  for (let i = 1; i <= 3; i++) {
    const midMonth = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const opex = thirdFridayOf(midMonth);
    labels.push(fmt(opex));
  }
  return { spotAnchorDate, targetDate: fmt(target), targetDateLong: fmtLong(target), waypointLabels: labels };
}

function thirdFridayOf(ref: Date): Date {
  const d = new Date(ref.getFullYear(), ref.getMonth(), 1);
  let fridays = 0;
  while (d.getMonth() === ref.getMonth()) {
    if (d.getDay() === 5) {
      fridays += 1;
      if (fridays === 3) return new Date(d);
    }
    d.setDate(d.getDate() + 1);
  }
  // Fallback — last day of month
  return new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
}
