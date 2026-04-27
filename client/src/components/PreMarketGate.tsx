import { useState, useEffect, useRef } from "react";

interface PreMarketGateProps {
  onAcknowledge: () => void;
}

export default function PreMarketGate({ onAcknowledge }: PreMarketGateProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-detect when user reaches bottom of read
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      // within 40px of bottom counts
      if (scrollTop + clientHeight >= scrollHeight - 40) {
        setScrolledToBottom(true);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    // also check immediately in case content fits without scroll
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const handleAck = () => {
    if (!scrolledToBottom) return;
    setAcknowledged(true);
    setExiting(true);
    setTimeout(() => onAcknowledge(), 700);
  };

  return (
    <div
      className={`fixed inset-0 z-[100] bg-black transition-opacity duration-700 ${
        exiting ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
      data-testid="overlay-premarket-gate"
      style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" }}
    >
      <div
        ref={scrollRef}
        className="h-full w-full overflow-y-auto px-6 sm:px-10 md:px-16 py-10 sm:py-14"
      >
        <div className="max-w-3xl mx-auto text-neutral-300">
          {/* Header */}
          <div className="text-[11px] sm:text-xs tracking-[0.25em] text-neutral-500 mb-6">
            // READ THIS . EVERY . SINGLE . DAY . BEFORE THE MARKET OPENS .
          </div>
          <h1
            className="text-5xl sm:text-7xl md:text-8xl font-black tracking-tight leading-[0.9] text-neutral-600 select-none"
            style={{ letterSpacing: "-0.02em" }}
          >
            PRE<span className="text-amber-400">-</span>
            <br />
            MARKET
          </h1>
          <div className="text-[11px] sm:text-xs tracking-[0.2em] text-neutral-500 mt-4 mb-12">
            GROUNDING PROTOCOL — DAILY READ
          </div>

          {/* Identity block */}
          <div className="border-l-2 border-amber-400 pl-5 py-2 mb-14 text-[15px] sm:text-base leading-relaxed space-y-2 text-neutral-400">
            <p>I am a <span className="text-neutral-100 font-semibold">disciplined, patient trader.</span></p>
            <p>I rebuilt from $3k with my own rules and my own mind.</p>
            <p>I do not need to trade every day.</p>
            <p>I do not need to recover losses today.</p>
            <p className="text-neutral-100 font-semibold">My only job is to execute my edge correctly.</p>
          </div>

          {/* What I know */}
          <SectionHeader>// WHAT I KNOW TO BE TRUE</SectionHeader>
          <Truth>
            Anything can happen. <strong className="text-neutral-100">I accept this before I enter.</strong>
          </Truth>
          <Truth>
            This trade is <strong className="text-neutral-100">one of the next 100 trades.</strong> Its outcome does not define me.
          </Truth>
          <Truth>
            I do not need to know what the market will do. <strong className="text-neutral-100">I need to execute my edge and let probability work.</strong>
          </Truth>
          <Truth>
            My best trades come from <strong className="text-neutral-100">patience and clarity</strong> — not urgency.
          </Truth>
          <Truth>
            <strong className="text-neutral-100">My only job is position sizing and exit control.</strong> Price decides profits.
          </Truth>

          {/* Pre-trade checklist */}
          <SectionHeader className="mt-12">// BEFORE I PLACE A SINGLE TRADE</SectionHeader>
          <Check>I have slept and I am not impaired. If not — I do not trade today.</Check>
          <Check>I know my <strong className="text-neutral-100">bias, key levels, and the setup</strong> I am waiting for.</Check>
          <Check>I know my <strong className="text-neutral-100">max loss for today in dollars</strong> and I accept it fully.</Check>
          <Check>My stop is set <strong className="text-neutral-100">mechanically before entry.</strong> 20% hard. No exceptions.</Check>
          <Check>I am asking: <strong className="text-neutral-100">Is this an A+ setup?</strong> B setups do not get sized. They get skipped.</Check>

          {/* Rules */}
          <SectionHeader className="mt-12">// THE RULES I WILL NOT BREAK TODAY</SectionHeader>
          <Rule kind="ok"><strong className="text-neutral-100">Max 3 trades.</strong> Quality over quantity. Always.</Rule>
          <Rule kind="ok"><strong className="text-neutral-100">Hit $300-500 goal — close the app.</strong> Done. No one more.</Rule>
          <Rule kind="ok"><strong className="text-neutral-100">Trim into the move.</strong> Take money off. Leave runners with stop above BE.</Rule>
          <Rule kind="ok"><strong className="text-neutral-100">After a loss — size down, not up.</strong> 1-2 contracts until confidence returns.</Rule>
          <Rule kind="bad"><strong className="text-neutral-100">No trading chop.</strong> If market is hard to read — I wait or I scalp fast and small.</Rule>
          <Rule kind="bad"><strong className="text-neutral-100">No trading after a big win.</strong> The journal proves this kills the day every time.</Rule>
          <Rule kind="bad"><strong className="text-neutral-100">No Friday revenge trades.</strong> Fridays are observe or 1 scalp max.</Rule>

          {/* Stop block */}
          <div
            className="mt-12 border-2 border-red-700/70 rounded p-6 sm:p-8"
            style={{ backgroundColor: "rgba(127, 29, 29, 0.06)" }}
          >
            <div className="text-[11px] sm:text-xs tracking-[0.25em] text-red-500 font-semibold mb-5">
              ⛔ I STOP IMMEDIATELY IF —
            </div>
            <ul className="space-y-3 text-[15px] sm:text-base leading-relaxed text-neutral-300">
              <li>I hit my <strong className="text-neutral-100">max daily loss.</strong> App closes. Day is over.</li>
              <li>I feel the urge to <strong className="text-neutral-100">size up after a loss.</strong> That feeling IS the stop signal.</li>
              <li>I've taken <strong className="text-neutral-100">3 losses in a row.</strong> 30 minute break minimum.</li>
              <li>I'm trying to <strong className="text-neutral-100">"save the week"</strong> on a Friday. Close it now.</li>
              <li>I ask "should I hold a little longer?" — <strong className="text-neutral-100">if I'm unsure, I'm out.</strong></li>
            </ul>
          </div>

          {/* Closer */}
          <div className="mt-12 border border-neutral-800 rounded p-6 sm:p-8 text-center text-neutral-400 leading-relaxed">
            <p>The rules exist because past me</p>
            <p className="mb-4">learned them the hard way.</p>
            <p className="text-neutral-200 font-semibold">Honoring them today is how I respect that work.</p>
            <div className="my-6 h-px bg-neutral-800" />
            <p>Money is the byproduct of</p>
            <p>strengthening mental discipline through trading.</p>
          </div>

          <div className="mt-10 text-center text-neutral-500 leading-relaxed">
            <p className="italic">I do not need to trade today.</p>
            <p className="text-neutral-200 italic">But if I do — I trade like a professional.</p>
          </div>

          <div className="mt-10 text-center">
            <p className="text-neutral-400 tracking-[0.2em] text-sm">Read . Breathe . Trade the plan .</p>
            <p className="text-amber-400 tracking-[0.4em] text-xs mt-3 font-semibold">— PATIENCE PAYS —</p>
          </div>

          {/* Acknowledge */}
          <div className="mt-12 mb-6 flex flex-col items-center gap-4">
            {!scrolledToBottom && (
              <p className="text-[11px] tracking-[0.2em] text-neutral-600">
                ↓ READ TO THE BOTTOM TO CONTINUE ↓
              </p>
            )}
            <button
              onClick={handleAck}
              disabled={!scrolledToBottom || acknowledged}
              data-testid="button-premarket-acknowledge"
              className={`group relative px-8 py-4 rounded border-2 transition-all duration-300 text-sm tracking-[0.25em] font-semibold ${
                scrolledToBottom && !acknowledged
                  ? "border-amber-400 text-amber-400 hover:bg-amber-400 hover:text-black cursor-pointer"
                  : "border-neutral-800 text-neutral-700 cursor-not-allowed"
              }`}
            >
              {acknowledged ? "TRADING THE PLAN..." : "I'VE READ IT. TRADE THE PLAN."}
            </button>
            <p className="text-[10px] tracking-[0.15em] text-neutral-700">
              this is a daily ritual. own it.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-6 ${className}`}>
      <div className="text-[11px] sm:text-xs tracking-[0.2em] text-amber-400/90 font-semibold mb-2">
        {children}
      </div>
      <div className="h-px bg-neutral-800" />
    </div>
  );
}

function Truth({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-3 border-b border-neutral-900 text-[15px] sm:text-base leading-relaxed text-neutral-400">
      <span className="text-amber-400 select-none">—</span>
      <p>{children}</p>
    </div>
  );
}

function Check({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-3 border-b border-neutral-900 text-[15px] sm:text-base leading-relaxed text-neutral-400">
      <span className="select-none text-neutral-600 border border-neutral-700 w-5 h-5 inline-block flex-shrink-0 mt-1" />
      <p>{children}</p>
    </div>
  );
}

function Rule({
  children,
  kind,
}: {
  children: React.ReactNode;
  kind: "ok" | "bad";
}) {
  const mark = kind === "ok" ? "✓" : "✗";
  const color = kind === "ok" ? "text-emerald-500" : "text-red-500";
  return (
    <div className="flex gap-4 py-3 border-b border-neutral-900 text-[15px] sm:text-base leading-relaxed text-neutral-400">
      <span className={`${color} select-none font-bold`}>{mark}</span>
      <p>{children}</p>
    </div>
  );
}
