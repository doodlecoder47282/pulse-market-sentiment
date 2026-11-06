// shared/alphaBrief.ts
//
// The News tab's AI brief: a DESCRIPTIVE schema and its markdown rendering.
// Pure. The model is asked to describe what the provided news, tape and
// positioning say; it states no probabilities, no confidence scores, no price
// targets beyond the levels it was given, and no trades. Missing inputs go in
// dataGaps. The card renders markdown from these fields, never the model's
// raw JSON text.

export interface DescriptiveBrief {
  summary?: string;
  drivers?: string[];
  tapeCheck?: string[];
  positioning?: string[];
  levelsToWatch?: Array<{ level?: string; why?: string }>;
  whatWouldChange?: string[];
  counterpoints?: string[];
  dataGaps?: string[];
}

const str = (v: unknown, max = 600): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const strs = (v: unknown, n = 6): string[] => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter((x): x is string => !!x).slice(0, n) : []);

/** Keep only the descriptive fields, trimmed; null when nothing usable is left. */
export function sanitizeBrief(raw: unknown): DescriptiveBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const levels = Array.isArray(r.levelsToWatch)
    ? (r.levelsToWatch as unknown[]).map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { level: str(o.level, 80) ?? undefined, why: str(o.why, 300) ?? undefined };
      }).filter((x) => x.level).slice(0, 6)
    : [];
  const out: DescriptiveBrief = {
    summary: str(r.summary) ?? undefined,
    drivers: strs(r.drivers),
    tapeCheck: strs(r.tapeCheck),
    positioning: strs(r.positioning),
    levelsToWatch: levels,
    whatWouldChange: strs(r.whatWouldChange),
    counterpoints: strs(r.counterpoints),
    dataGaps: strs(r.dataGaps),
  };
  const any = !!out.summary || [out.drivers, out.tapeCheck, out.positioning, out.levelsToWatch, out.whatWouldChange, out.counterpoints].some((a) => (a?.length ?? 0) > 0);
  return any ? out : null;
}

/** Markdown for the card: headings and bullets, no raw JSON. */
export function renderBriefMarkdown(b: DescriptiveBrief): string {
  const parts: string[] = [];
  if (b.summary) parts.push(b.summary);
  const list = (title: string, xs?: string[]) => { if (xs && xs.length) parts.push(`**${title}**\n\n${xs.map((x) => `- ${x}`).join("\n")}`); };
  list("Drivers", b.drivers);
  list("Tape check", b.tapeCheck);
  list("Positioning", b.positioning);
  if (b.levelsToWatch && b.levelsToWatch.length) list("Levels to watch", b.levelsToWatch.map((l) => (l.why ? `${l.level}: ${l.why}` : String(l.level))));
  list("What would change this read", b.whatWouldChange);
  list("Counterpoints", b.counterpoints);
  list("Data gaps", b.dataGaps);
  parts.push("_Descriptive summary of the provided news, tape and positioning. No probabilities, targets or trade ideas; not investment advice._");
  return parts.join("\n\n");
}
