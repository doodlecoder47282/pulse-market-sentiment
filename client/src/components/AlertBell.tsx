// AlertBell.tsx
// The bell in the header: every board level a ticker crossed and every rule that armed, as the desk logged
// them (shared/alerts.ts, GET /api/alerts). Nothing to set up. New rule arms and index crossings are
// announced as they arrive (a toast; a device notification too if the user allowed one), and the bell counts
// what has happened since the list was last opened. It reports events; it never says what to do with them.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { alertPanelPlace, announcement, laterSeen, newLoud, seenOf, unreadCount, validSeen, type AlertItem, type AlertSeen } from "@shared/alerts";

interface AlertsPayload {
  asOfMs: number; items: AlertItem[];
  watching: boolean; sessionOpen: boolean; evaluatedAt: number | null; lastTickError: string | null; note: string;
}

// What has been looked at, as the highest storage row id of each kind. Kept in this browser only.
const SEEN_KEY = "batcave.alerts.seen";
const readSeen = (): AlertSeen => {
  try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}"); return { arm: Number(v?.arm) || 0, hit: Number(v?.hit) || 0 }; } catch { return { arm: 0, hit: 0 }; }
};
const writeSeen = (s: AlertSeen) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch { /* the count then resets on reload */ } };
const when = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour12: false, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const canNotify = () => typeof window !== "undefined" && "Notification" in window;
const permission = (): string => { try { return canNotify() ? Notification.permission : "unsupported"; } catch { return "unsupported"; } };

export default function AlertBell() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<AlertSeen>(readSeen);
  const [perm, setPerm] = useState<string>(permission);
  const [place, setPlace] = useState<{ top: number; right: number; width: number } | null>(null);
  // The mark of the previous read (it only moves forward) and when each level was last announced.
  const prev = useRef<AlertSeen | null>(null);
  const said = useRef<Record<string, number>>({});
  const btn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const q = useQuery<AlertsPayload>({
    queryKey: ["/api/alerts"],
    queryFn: async () => (await apiRequest("GET", "/api/alerts")).json(),
    // Keeps reading with the tab in the background: that is when an announcement is worth most.
    refetchInterval: 60_000, refetchIntervalInBackground: true, staleTime: 30_000, refetchOnWindowFocus: true, retry: false,
  });
  const items = q.data?.items ?? [];

  // Announce what is new since the previous read. The first read after opening the app is history, not news.
  useEffect(() => {
    if (!q.data) return;
    const fresh = newLoud(q.data.items, prev.current, said.current);
    const now = seenOf(q.data.items);
    prev.current = prev.current ? laterSeen(prev.current, now) : now;
    for (const f of fresh) said.current[f.subject] = f.at;
    // A mark left over from a log that has since been reset would hide everything: drop it.
    setSeen((s) => { const v = validSeen(s, q.data!.items); if (v.arm !== s.arm || v.hit !== s.hit) writeSeen(v); return v.arm !== s.arm || v.hit !== s.hit ? v : s; });
    const say = announcement(fresh);
    if (!say) return;
    toast({ title: say.title, description: say.text });
    if (permission() === "granted" && document.visibilityState !== "visible") {
      try { new Notification(say.title, { body: say.text, tag: "batcave-alert" }); } catch { /* some browsers only allow these from a service worker */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  // Close on a click outside or Escape; keep the panel under the bell when the window changes.
  useEffect(() => {
    if (!open) return;
    const put = () => { const r = btn.current?.getBoundingClientRect(); if (r) setPlace(alertPanelPlace(r, window.innerWidth)); };
    put();
    const away = (e: MouseEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !panel.current?.contains(t)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", put);
    window.addEventListener("scroll", put, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); window.removeEventListener("resize", put); window.removeEventListener("scroll", put, true); };
  }, [open]);

  const unread = unreadCount(items, seen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && items.length) { const mark = laterSeen(seen, seenOf(items)); writeSeen(mark); setSeen(mark); }
  };
  const allow = async () => {
    if (!canNotify()) return;
    // Older Safari takes a callback and returns nothing: read the permission afterwards either way.
    try { await Notification.requestPermission(); } catch { /* read below */ }
    setPerm(permission());
  };

  const watching = !!q.data?.watching;
  const state = q.isError ? "the alert feed could not be read (the request failed)"
    : !q.data ? "reading"
    : q.data.lastTickError ? `the desk's last check failed: ${q.data.lastTickError}`
    : !watching ? "the desk is not watching (the level watch is not running)"
    : q.data.sessionOpen ? `watching now, last check ${q.data.evaluatedAt ? when(q.data.evaluatedAt) : "not yet"} ET`
    : "outside the regular session: nothing is watched until the next open";
  const empty = q.isError ? "Not read, so this is not a list of no alerts."
    : !q.data ? "Reading."
    : !watching ? "Nothing is logged, and the level watch is not running, so nothing is being logged."
    : "Nothing logged yet: no board level crossed and no rule armed since the desk started watching.";

  return (
    <>
      <button
        ref={btn} type="button" onClick={toggle} title="Alerts" aria-label={unread ? `Alerts, ${unread} new` : "Alerts"} aria-expanded={open} aria-controls="alerts-panel"
        className="relative flex shrink-0 items-center justify-center rounded-md border border-border/60 h-11 w-11 sm:w-auto sm:px-2 lg:h-auto lg:p-1.5 text-muted-foreground transition hover:border-border hover:text-foreground"
        data-testid="button-alerts"
      >
        <Bell className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-amber-500 px-1 text-center font-mono text-[11px] font-bold leading-[18px] text-black" data-testid="alerts-unread">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {/* Drawn at the top of the page, outside the header: the header is its own layer, and tables further down would be painted over a panel inside it. */}
      {open && place && createPortal(
        <div
          ref={panel} id="alerts-panel" role="region" aria-label="Alerts" data-testid="alerts-panel"
          style={{ top: place.top, right: place.right, width: place.width }}
          className="fixed z-[60] rounded-md border border-border bg-background p-3 shadow-xl"
        >
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-foreground">Alerts</span>
            <span className="text-right text-[11px] text-muted-foreground" data-testid="alerts-state">{state}</span>
          </div>
          {items.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground" data-testid="alerts-empty">{empty}</p>
          ) : (
            <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {items.map((i) => (
                <li key={i.id} className={`rounded border px-2 py-1.5 text-xs leading-relaxed ${i.kind === "rule_armed" ? "border-violet-500/40" : "border-border/40"}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-foreground">{i.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{when(i.at)}</span>
                  </div>
                  <div className="text-muted-foreground">{i.text}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 border-t border-border/40 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            {q.data?.note}
            {perm === "default" && (
              <button type="button" onClick={allow} className="mt-1 block min-h-[32px] rounded border border-border/60 px-2 py-1 text-foreground hover:border-border" data-testid="alerts-allow">
                Also notify on this device when the tab is in the background
              </button>
            )}
            {perm === "granted" && <div className="mt-1">Device notifications are on for this browser while the app is open in a tab.</div>}
            {perm === "denied" && <div className="mt-1">Device notifications are blocked for this site in the browser's settings; alerts still show here.</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
