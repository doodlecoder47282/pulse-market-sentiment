// use-keyboard-shortcuts.ts — keyboard navigation for the Pulse dashboard.
// Keys 1-8: switch tabs in locked order
// /: focus ticker input in Chart tab
// ESC: close Take Five overlay / blur focused input
// ?: toggle help modal

import { useEffect, useCallback, type RefObject } from "react";
import type { TabKey } from "@/components/TickerContext";

// Tab order matches the locked UI order
const TAB_KEYS: TabKey[] = [
  "signals",
  "chart",
  "models",
  "tradedesk",
  "regime",
  "news",
  "voices",
  "takefive",
];

interface UseKeyboardShortcutsOptions {
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
  setTake5Open: (open: boolean) => void;
  take5Open: boolean;
  setHelpOpen: (open: boolean) => void;
  helpOpen: boolean;
  /** Ref to the Chart tab ticker input so "/" can focus it */
  tickerInputRef?: RefObject<HTMLInputElement | null>;
}

export function useKeyboardShortcuts({
  activeTab,
  setActiveTab,
  setTake5Open,
  take5Open,
  setHelpOpen,
  helpOpen,
  tickerInputRef,
}: UseKeyboardShortcutsOptions) {
  const handler = useCallback(
    (e: KeyboardEvent) => {
      // Ignore when typing in an input/textarea/select/contenteditable
      const target = e.target as HTMLElement;
      const tag = target.tagName.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target.isContentEditable
      ) {
        // ESC still blurs the focused element
        if (e.key === "Escape") {
          target.blur();
        }
        return;
      }

      // 1-8 → switch tabs
      if (e.key >= "1" && e.key <= "8") {
        const idx = parseInt(e.key, 10) - 1;
        const tab = TAB_KEYS[idx];
        if (tab) {
          e.preventDefault();
          setActiveTab(tab);
        }
        return;
      }

      // / → focus ticker input on chart tab
      if (e.key === "/") {
        e.preventDefault();
        // Switch to chart tab first if not already there
        if (activeTab !== "chart") {
          setActiveTab("chart");
        }
        // Focus the ticker input after a brief tick for the tab to mount
        setTimeout(() => {
          if (tickerInputRef?.current) {
            tickerInputRef.current.focus();
            tickerInputRef.current.select();
          } else {
            // Fallback: find any input in the chart tab content
            const input = document.querySelector<HTMLInputElement>(
              '[data-testid="chart-ticker-input"], [data-tab-input="chart"]'
            );
            if (input) {
              input.focus();
              input.select();
            }
          }
        }, 80);
        return;
      }

      // ESC → close overlays / blur
      if (e.key === "Escape") {
        if (take5Open) {
          setTake5Open(false);
          return;
        }
        if (helpOpen) {
          setHelpOpen(false);
          return;
        }
        // Blur any focused element
        (document.activeElement as HTMLElement)?.blur?.();
        return;
      }

      // ? → toggle help modal
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(!helpOpen);
        return;
      }
    },
    [activeTab, setActiveTab, setTake5Open, take5Open, setHelpOpen, helpOpen, tickerInputRef]
  );

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);
}

export const TAB_LABELS: Record<TabKey, string> = {
  signals: "Signals",
  chart: "Chart",
  models: "Models",
  tradedesk: "Trade Desk",
  regime: "Regime",
  news: "News",
  voices: "Voices",
  takefive: "Take Five",
  edgelab: "Edge Lab",
};

export const SHORTCUT_DOCS = [
  { key: "1 – 8", description: "Switch to tab by position (Signals → Take Five)" },
  { key: "/", description: "Focus ticker search in Chart tab" },
  { key: "ESC", description: "Close overlay / blur focused input" },
  { key: "?", description: "Toggle this help screen" },
];
