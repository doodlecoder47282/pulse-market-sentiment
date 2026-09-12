/**
 * WidgetStack — customizable panel stack.
 * Every registered panel becomes a widget: reorder it, hide it, or add any
 * widget from anywhere else on the site into this tab's stack.
 * Layout persists server-side (SQLite) — localStorage is blocked in the
 * hosted iframe, so the backend is the source of truth.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import ErrorBoundary from "@/components/ErrorBoundary";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import {
  SlidersHorizontal,
  Check,
  ChevronUp,
  ChevronDown,
  EyeOff,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";

// ── Global widget registry — any widget can live on any stack ──
const WhaleFlowPanel = lazy(() => import("@/components/WhaleFlowPanel"));
const TrackedSignalsPanel = lazy(() => import("@/components/signals/TrackedSignalsPanel"));
const FlowPanel = lazy(() => import("@/components/FlowPanel"));
const Mag7Panel = lazy(() => import("@/components/Mag7Panel"));
const CanaryStrip = lazy(() => import("@/components/CanaryStrip"));
const ThermalHeatmap = lazy(() => import("@/components/ThermalHeatmap"));
const OfiHistogram = lazy(() => import("@/components/OfiHistogram"));
const RegimePanel = lazy(() => import("@/components/RegimePanel"));
const DepthSkewFlow = lazy(() => import("@/components/DepthSkewFlow"));
const LiveOdteTracker = lazy(() => import("@/components/LiveOdteTracker"));
const MLAccuracyCard = lazy(() => import("@/components/models/MLAccuracyCard"));

export const WIDGET_REGISTRY: Record<string, { label: string; home: string; node: React.ReactNode }> = {
  "whale-flow": { label: "Whale Flow", home: "Signals", node: <WhaleFlowPanel /> },
  "tracked-signals": { label: "Tracked Signals", home: "Signals", node: <TrackedSignalsPanel /> },
  "pc-flow": { label: "Put/Call Flow", home: "Signals", node: <FlowPanel /> },
  mag7: { label: "Mag 7 Basket", home: "Chart", node: <Mag7Panel /> },
  canary: { label: "Canary Strip", home: "Regime", node: <CanaryStrip /> },
  "thermal-heatmap": { label: "Thermal Gamma Map", home: "Regime", node: <ThermalHeatmap /> },
  "order-flow": { label: "Order Flow", home: "Regime", node: <OfiHistogram /> },
  "regime-panel": { label: "Regime Engine", home: "Regime", node: <RegimePanel /> },
  "depth-skew-flow": { label: "Depth \u00b7 Skew \u00b7 Flow", home: "Heatseeker", node: <DepthSkewFlow /> },
  "odte-tracker": { label: "Live 0DTE Tracker", home: "Heatseeker", node: <LiveOdteTracker /> },
  "ml-accuracy": { label: "ML Scorecard", home: "Models", node: <MLAccuracyCard /> },
};

type Layout = { order: string[]; hidden: string[] };

function effectiveLayout(saved: Layout | null | undefined, defaults: string[]): Layout {
  const known = (id: string) => id in WIDGET_REGISTRY;
  if (!saved) return { order: defaults.filter(known), hidden: [] };
  const order = saved.order.filter(known);
  // new defaults shipped after the user saved still show up
  for (const d of defaults) if (known(d) && !order.includes(d) && !saved.hidden.includes(d)) order.push(d);
  return { order, hidden: saved.hidden.filter(known) };
}

export default function WidgetStack({ tab, defaults }: { tab: string; defaults: string[] }) {
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const { data: saved } = useQuery<Layout | null>({
    queryKey: ["/api/layout", tab],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/layout/${tab}`);
      return r.json();
    },
    staleTime: 60_000,
  });

  const layout = useMemo(() => effectiveLayout(saved, defaults), [saved, defaults]);

  const save = useMutation({
    mutationFn: async (next: Layout) => {
      await apiRequest("PUT", `/api/layout/${tab}`, next);
      return next;
    },
    onMutate: async (next) => {
      queryClient.setQueryData(["/api/layout", tab], next);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["/api/layout", tab] }),
  });

  const reset = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/layout/${tab}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["/api/layout", tab] }),
  });

  const move = (id: string, dir: -1 | 1) => {
    const order = [...layout.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    save.mutate({ order, hidden: layout.hidden });
  };

  const hide = (id: string) => {
    save.mutate({ order: layout.order.filter((x) => x !== id), hidden: [...layout.hidden, id] });
  };

  const add = (id: string) => {
    save.mutate({ order: [...layout.order, id], hidden: layout.hidden.filter((x) => x !== id) });
    setAddOpen(false);
  };

  // widgets not currently in this stack — from anywhere on the site
  const addable = Object.keys(WIDGET_REGISTRY).filter((id) => !layout.order.includes(id));

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-2">
        {editing && (
          <button
            type="button"
            onClick={() => reset.mutate()}
            data-testid={`widgets-reset-${tab}`}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground transition hover:border-border hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        )}
        <button
          type="button"
          onClick={() => { setEditing((v) => !v); setAddOpen(false); }}
          data-testid={`widgets-toggle-${tab}`}
          className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-mono uppercase tracking-wider transition ${
            editing
              ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
              : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
          }`}
        >
          {editing ? <Check className="h-3 w-3" /> : <SlidersHorizontal className="h-3 w-3" />}
          {editing ? "Done" : "Customize"}
        </button>
      </div>

      {/* Widgets */}
      {layout.order.map((id, idx) => {
        const w = WIDGET_REGISTRY[id];
        if (!w) return null;
        return (
          <div
            key={id}
            className={editing ? "rounded-lg border border-dashed border-emerald-500/40 p-1.5 sm:p-2" : undefined}
          >
            {editing && (
              <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                <span className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/90">
                  {w.label}
                  <span className="ml-2 text-muted-foreground/60">from {w.home}</span>
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" aria-label="Move up" disabled={idx === 0} onClick={() => move(id, -1)} data-testid={`widget-up-${id}`} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition enabled:hover:text-foreground disabled:opacity-30">
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button type="button" aria-label="Move down" disabled={idx === layout.order.length - 1} onClick={() => move(id, 1)} data-testid={`widget-down-${id}`} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition enabled:hover:text-foreground disabled:opacity-30">
                    <ChevronDown className="h-4 w-4" />
                  </button>
                  <button type="button" aria-label="Hide widget" onClick={() => hide(id)} data-testid={`widget-hide-${id}`} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition hover:border-rose-500/50 hover:text-rose-400">
                    <EyeOff className="h-4 w-4" />
                  </button>
                </span>
              </div>
            )}
            <ErrorBoundary compact label={w.label}>
              <Suspense fallback={<PanelSkeleton variant="chart" />}>{w.node}</Suspense>
            </ErrorBoundary>
          </div>
        );
      })}

      {/* Add widget — pull any panel from anywhere on the site */}
      {editing && (
        <div className="rounded-lg border border-dashed border-border/60 p-3">
          {!addOpen ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              disabled={addable.length === 0}
              data-testid={`widgets-add-${tab}`}
              className="inline-flex min-h-[36px] w-full items-center justify-center gap-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider text-muted-foreground transition hover:text-foreground disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              {addable.length === 0 ? "All widgets placed" : "Add widget from anywhere"}
            </button>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Add a widget</span>
                <button type="button" aria-label="Close" onClick={() => setAddOpen(false)} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {addable.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => add(id)}
                    data-testid={`widget-add-${id}`}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-border/60 px-3 text-xs text-foreground/90 transition hover:border-emerald-500/50 hover:text-emerald-300"
                  >
                    <Plus className="h-3 w-3" />
                    {WIDGET_REGISTRY[id].label}
                    <span className="text-[9px] font-mono uppercase text-muted-foreground/70">{WIDGET_REGISTRY[id].home}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
