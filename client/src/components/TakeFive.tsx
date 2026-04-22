// TakeFive.tsx
//
// The break room. A full trippy overlay the trader can open from a floating
// button or from the Take Five tab. Renders:
//   • animated gradient background (purple/teal/magenta, slow 45s loop)
//   • rotating Mark Douglas quotes + trader wisdom
//   • 4-7-8 breathing pacer circle
//   • the identity / core truths / checklist / hard rules / stop conditions
//     block from the user's PRE-MARKET READ HTML (verbatim)
//   • a "PATIENTS PAYS" signoff
//
// This component is purely presentational. No API calls. No storage.

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Pause, Play, Zap } from "lucide-react";

// ──────────────────────────────────────────────────────────────────────
// Quotes — Mark Douglas (Trading in the Zone, Disciplined Trader) + trader wisdom
// ──────────────────────────────────────────────────────────────────────

interface Quote {
  text: string;
  attr: string;
}

const QUOTES: Quote[] = [
  // Mark Douglas — Trading in the Zone
  { text: "Anything can happen.", attr: "Mark Douglas — Trading in the Zone" },
  {
    text: "You don't need to know what will happen next to make money.",
    attr: "Mark Douglas — Trading in the Zone",
  },
  {
    text: "There's a random distribution between wins and losses for any given set of variables that defines an edge.",
    attr: "Mark Douglas — Trading in the Zone",
  },
  {
    text: "An edge is nothing more than an indication of a higher probability of one thing happening over another.",
    attr: "Mark Douglas — Trading in the Zone",
  },
  { text: "Every moment in the market is unique.", attr: "Mark Douglas — Trading in the Zone" },
  {
    text: "The best traders have evolved to the point where they believe, without a shred of doubt, that anything can happen.",
    attr: "Mark Douglas",
  },
  {
    text: "Trading is a pattern-recognition numbers game. We use our analytics to identify patterns, define the risk, and determine when to take profits.",
    attr: "Mark Douglas",
  },
  {
    text: "The hard, cold reality of trading is that every trade has an uncertain outcome.",
    attr: "Mark Douglas — Disciplined Trader",
  },
  {
    text: "If you can learn to create a state of mind that is not affected by the market's behavior, the struggle will cease to exist.",
    attr: "Mark Douglas — Trading in the Zone",
  },
  // Jesse Livermore
  { text: "It was never my thinking that made the big money for me. It was my sitting.", attr: "Jesse Livermore" },
  {
    text: "There is nothing new in Wall Street. There can't be because speculation is as old as the hills.",
    attr: "Jesse Livermore",
  },
  // Paul Tudor Jones
  { text: "The most important rule is to play great defense, not great offense.", attr: "Paul Tudor Jones" },
  { text: "Don't focus on making money; focus on protecting what you have.", attr: "Paul Tudor Jones" },
  // Ed Seykota
  { text: "The elements of good trading are: cutting losses, cutting losses, and cutting losses.", attr: "Ed Seykota" },
  { text: "Everybody gets what they want out of the market.", attr: "Ed Seykota" },
  // Richard Dennis
  { text: "Trading has taught me not to take the conventional wisdom for granted.", attr: "Richard Dennis" },
  // Linda Raschke
  {
    text: "It's not about how much money you make. It's about how much money you keep, how hard it works for you, and how many generations you keep it for.",
    attr: "Linda Raschke",
  },
  // Market Wizards-adjacent
  { text: "Markets are never wrong — opinions are.", attr: "Jesse Livermore" },
  { text: "The trend is your friend until it ends.", attr: "Market adage" },
];

// ──────────────────────────────────────────────────────────────────────
// Rules — lifted verbatim from the user's PRE-MARKET READ HTML.
// Keep structure identical so the trader recognizes it.
// ──────────────────────────────────────────────────────────────────────

const IDENTITY =
  "I am a disciplined, patient trader. I rebuilt from $3k with my own rules. I trust my edge, respect my stops, and let the setup come to me.";

const CORE_TRUTHS: string[] = [
  "Anything can happen. I accept this before I enter.",
  "This trade is one of the next 100 trades — not the one that defines me.",
  "I do not need to know what the market will do. I only need to manage what I do.",
];

const BEFORE_I_TRADE: string[] = [
  "Trend + context: do the indices agree with my setup?",
  "Level: am I at a real level (value, S/R, prior day range, POC)?",
  "Risk defined: exact stop, exact size, exact R.",
  "Plan: where I scale, where I stop, where I stop trading for the day.",
  "Mindset: am I calm, present, and okay with being wrong?",
];

const HARD_RULES: string[] = [
  "Max 3 trades per day — no revenge, no over-trading.",
  "Hit my $300–$500 goal → close the app. I made my number. Protect it.",
  "Trim into the move. Pay me first — I earned it.",
  "After a loss → size down. Re-prove the setup.",
  "No trading chop. No trading news I don't understand.",
  "No trading after a big win — euphoria is a tax.",
  "No Friday revenge trades. Walk away from the keyboard.",
];

const STOP_CONDITIONS: string[] = [
  "Hit max daily loss → done. No 'one more try'.",
  "Feel the urge to size up to 'get it back' → STOP. That is the signal to stop.",
  "3 losses in a row → 30-minute break away from screens.",
  "Friday and I'm in the red → 'save the week' is a trap. Don't trade out of it.",
];

// ──────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────

interface TakeFiveProps {
  /** render as floating-button launcher (true) or embedded tab (false) */
  mode?: "overlay" | "embedded";
  /** controlled open state for overlay mode */
  open?: boolean;
  onClose?: () => void;
}

export default function TakeFive({ mode = "embedded", open = true, onClose }: TakeFiveProps) {
  const [motion, setMotion] = useState<boolean>(true);
  const [quoteIdx, setQuoteIdx] = useState(0);
  const timerRef = useRef<number | null>(null);

  // Rotate quotes every 10s when motion is on
  useEffect(() => {
    if (!motion) return;
    timerRef.current = window.setInterval(() => {
      setQuoteIdx((i) => (i + 1) % QUOTES.length);
    }, 10_000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [motion]);

  // Escape key closes overlay
  useEffect(() => {
    if (mode !== "overlay" || !open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [mode, open, onClose]);

  if (mode === "overlay" && !open) return null;

  const quote = QUOTES[quoteIdx];

  const body = (
    <div
      className={`take5-shell ${motion ? "" : "[&_*]:!animate-none"}`}
      data-testid="take5-root"
      style={mode === "overlay" ? { minHeight: "100vh" } : { borderRadius: "0.75rem", padding: "2rem" }}
    >
      <div className="relative mx-auto max-w-6xl px-6 py-10">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div
              className="take5-title text-6xl font-bold leading-none md:text-7xl"
              data-testid="take5-title"
            >
              TAKE FIVE
            </div>
            <div className="mt-2 text-xs uppercase tracking-[0.3em] text-[#ffd000]/70">
              Step off the screen. Breathe. Come back sharp.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setMotion((m) => !m)}
              className="take5-panel rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-white/5"
              data-testid="btn-toggle-motion"
              aria-label={motion ? "Pause animations" : "Resume animations"}
            >
              {motion ? (
                <span className="inline-flex items-center gap-1.5">
                  <Pause className="h-3 w-3" /> Pause motion
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <Play className="h-3 w-3" /> Resume motion
                </span>
              )}
            </button>
            {mode === "overlay" && onClose && (
              <button
                onClick={onClose}
                className="take5-panel rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-white/5"
                data-testid="btn-close-take5"
                aria-label="Close Take Five"
              >
                <span className="inline-flex items-center gap-1.5">
                  <X className="h-3.5 w-3.5" /> Close
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Top row — quote rotator + breath pacer */}
        <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-[1.3fr_1fr]">
          {/* Quote card */}
          <div className="take5-panel flex min-h-[220px] flex-col justify-center rounded-lg p-6">
            <div className="mb-3 text-[10px] uppercase tracking-[0.3em] text-[#ffd000]/70">
              Wisdom from the tape
            </div>
            <blockquote
              key={quoteIdx /* re-trigger fade when quote changes */}
              className="take5-quote"
              data-testid="take5-quote"
            >
              <span className="mr-1 text-[#ffd000]">&ldquo;</span>
              {quote.text}
              <span className="ml-1 text-[#ffd000]">&rdquo;</span>
              <div className="mt-3 font-sans text-[11px] uppercase tracking-wider text-[#00ff88]/80">
                — {quote.attr}
              </div>
            </blockquote>
            <div className="mt-5 flex items-center gap-2 text-[10px] text-[#f7f5ff]/50">
              <button
                onClick={() => setQuoteIdx((i) => (i - 1 + QUOTES.length) % QUOTES.length)}
                className="rounded border border-white/10 px-2 py-0.5 hover:bg-white/5"
                data-testid="btn-prev-quote"
              >
                prev
              </button>
              <button
                onClick={() => setQuoteIdx((i) => (i + 1) % QUOTES.length)}
                className="rounded border border-white/10 px-2 py-0.5 hover:bg-white/5"
                data-testid="btn-next-quote"
              >
                next
              </button>
              <span className="ml-auto font-mono">
                {quoteIdx + 1} / {QUOTES.length}
              </span>
            </div>
          </div>

          {/* Breath pacer */}
          <div className="take5-panel flex flex-col items-center justify-center rounded-lg p-6">
            <div className="mb-3 text-[10px] uppercase tracking-[0.3em] text-[#00ff88]/80">
              4 · 7 · 8 breathing pacer
            </div>
            <div className="relative flex h-[200px] w-[200px] items-center justify-center">
              <div className={`breath-circle ${motion ? "" : "!animation-none"}`} />
              <div className="breath-label absolute select-none text-[#f7f5ff]">
                BREATHE
              </div>
            </div>
            <div className="mt-3 max-w-[280px] text-center text-[10px] leading-snug text-[#f7f5ff]/70">
              Inhale 4s, hold 7s, exhale 8s. Follow the glow. Three rounds and you're back.
            </div>
          </div>
        </div>

        {/* Identity + core truths */}
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="take5-panel green rounded-lg p-5">
            <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-[#00ff88]">
              <Zap className="h-3.5 w-3.5" /> Identity
            </div>
            <p className="font-mono text-[14px] leading-relaxed text-[#f7f5ff]">
              {IDENTITY}
            </p>
          </div>

          <div className="take5-panel rounded-lg p-5">
            <div className="mb-2 text-[10px] uppercase tracking-[0.25em] text-[#ffd000]">
              Core truths
            </div>
            <ul className="space-y-2 font-mono text-[13px] leading-relaxed">
              {CORE_TRUTHS.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="select-none text-[#00ff88]">▸</span>
                  <span className="text-[#f7f5ff]/95">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Before I trade */}
        <div className="mb-4 take5-panel rounded-lg p-5">
          <div className="mb-3 text-[10px] uppercase tracking-[0.25em] text-[#ffd000]">
            Before I Trade
          </div>
          <ul className="grid grid-cols-1 gap-2 font-mono text-[13px] md:grid-cols-2">
            {BEFORE_I_TRADE.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="select-none font-bold text-[#ffd000]">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-[#f7f5ff]/95">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Hard Rules + Stop Conditions */}
        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="take5-panel rounded-lg p-5">
            <div className="mb-3 text-[10px] uppercase tracking-[0.25em] text-[#ffd000]">
              Hard Rules
            </div>
            <ul className="space-y-2 font-mono text-[12.5px] leading-relaxed">
              {HARD_RULES.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="select-none text-[#00ff88]">●</span>
                  <span className="text-[#f7f5ff]/95">{t}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="take5-panel red rounded-lg p-5">
            <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-[#ff2d2d]">
              Stop Conditions
            </div>
            <ul className="space-y-2 font-mono text-[12.5px] leading-relaxed">
              {STOP_CONDITIONS.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="select-none text-[#ff2d2d]">■</span>
                  <span className="text-[#f7f5ff]/95">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Truth block */}
        <div className="take5-panel rounded-lg p-5 text-center">
          <p className="font-mono text-[13px] italic text-[#f7f5ff]/90">
            The rules exist because past me learned them the hard way. Honoring them today is how I respect that work.
          </p>
        </div>

        {/* Signoff */}
        <div className="mt-8 text-center">
          <div
            className="take5-title text-3xl font-bold md:text-4xl"
            data-testid="take5-signoff"
          >
            — PATIENTS PAYS —
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.3em] text-[#ffd000]/60">
            (yes, we know — but that's how it's written and that's how we keep it)
          </div>
        </div>
      </div>
    </div>
  );

  if (mode === "overlay") {
    return (
      <div
        className="fixed inset-0 z-[60] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Take Five"
        data-testid="take5-overlay"
      >
        {body}
      </div>
    );
  }
  return body;
}

// ──────────────────────────────────────────────────────────────────────
// Floating launcher button — global, top-right
// ──────────────────────────────────────────────────────────────────────

export function TakeFiveFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="take5-fab"
      data-testid="btn-take-five-fab"
      aria-label="Open Take Five"
      title="Step off. Breathe. Come back sharp."
    >
      <Zap className="h-3.5 w-3.5" />
      <span>TAKE 5</span>
    </button>
  );
}

// Silence unused-export warnings for identity (kept verbatim for future use)
export const _IDENTITY_TEXT = IDENTITY;
export const _QUOTES = QUOTES;
// Hook for components that want stable identity of current quote index
export function useTakeFiveQuoteRotator(enabled = true) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setIdx((i) => (i + 1) % QUOTES.length), 10_000);
    return () => window.clearInterval(t);
  }, [enabled]);
  return useMemo(() => ({ idx, quote: QUOTES[idx], setIdx }), [idx]);
}
