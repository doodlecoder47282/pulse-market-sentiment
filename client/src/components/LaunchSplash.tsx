import { useEffect, useRef, useState, useCallback } from "react";
import { BatmanLogoFull } from "./BatmanLogo";
import { motion, AnimatePresence } from "framer-motion";

/* ─── Prop Types ─────────────────────────────────────────────────── */
interface LaunchSplashProps {
  onExit: () => void;
}

/* ─── Trader Quotes ──────────────────────────────────────────────── */
const QUOTES = [
  "the market pays you to be right, not to feel good",
  "discipline equals freedom",
  "risk defines the returns",
  "print or get printed on",
  "the trend is your friend until the bend at the end",
  "cut your losses short, let your winners run",
  "plan the trade, trade the plan",
  "the market can stay irrational longer than you can stay solvent",
  "buy fear, sell greed",
  "price is truth, everything else is narrative",
  "you don't need to predict, you need to react",
  "scared money don't make money",
  "be fearful when others are greedy",
  "the bulls make money, bears make money, pigs get slaughtered",
  "size wins, timing survives",
];

/* ─── Money bill config ──────────────────────────────────────────── */
interface Bill {
  id: number;
  x: number;
  delay: number;
  duration: number;
  size: number;
  rotation: number;
  rotationSpeed: number;
  emoji: string;
  drift: number;
}

function pickEmoji(): string {
  const r = Math.random();
  if (r < 0.70) return "💵";
  if (r < 0.90) return "💰";
  return "💴";
}

function generateBills(count: number): Bill[] {
  const bills: Bill[] = [];
  for (let i = 0; i < count; i++) {
    bills.push({
      id: i,
      x: Math.random() * 100,
      delay: Math.random() * 6,
      duration: 2.5 + Math.random() * 3,
      size: 22 + Math.random() * 26,
      rotation: Math.random() * 60 - 30,
      rotationSpeed: (Math.random() - 0.5) * 720,
      emoji: pickEmoji(),
      drift: (Math.random() - 0.5) * 120,
    });
  }
  return bills;
}

function generateBurstBills(count: number, idOffset: number): Bill[] {
  const bills: Bill[] = [];
  for (let i = 0; i < count; i++) {
    bills.push({
      id: idOffset + i,
      x: Math.random() * 100,
      delay: Math.random() * 0.4,
      duration: 1.2 + Math.random() * 0.6,
      size: 24 + Math.random() * 20,
      rotation: Math.random() * 90 - 45,
      rotationSpeed: (Math.random() - 0.5) * 1080,
      emoji: pickEmoji(),
      drift: (Math.random() - 0.5) * 160,
    });
  }
  return bills;
}

/* ─── Cinematic phase enum ───────────────────────────────────────── */
type Phase =
  | "atmospheric"   // 0.0 – 0.8s  pure black + rain
  | "tumbling"      // 0.8 – 2.0s  3D box spinning
  | "slamming"      // 2.0 – 2.6s  box slams toward camera, logo takes over
  | "revealing"     // 2.6 – 3.2s  BATCAVE title + subtitle fade in
  | "ready"         // 3.2s+       button + money rain
  | "exiting";      // user clicked — exit sequence

/* ─── Main Component ─────────────────────────────────────────────── */
export default function LaunchSplash({ onExit }: LaunchSplashProps) {
  const [phase, setPhase] = useState<Phase>("atmospheric");
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [quoteVisible, setQuoteVisible] = useState(true);
  const [flashActive, setFlashActive] = useState(false);
  const [shockwaveActive, setShockwaveActive] = useState(false);
  const [billsExploding, setBillsExploding] = useState(false);

  const [reducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [isMobile] = useState(() => window.innerWidth < 640);

  const billCount = isMobile ? 60 : 120;
  const [bills] = useState(() => generateBills(billCount));
  const [burstBills, setBurstBills] = useState<Bill[]>([]);
  const burstIdRef = useRef(billCount + 1000);
  const hasExitedRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  /* ── Cinematic timeline (runs once on mount) ── */
  useEffect(() => {
    if (reducedMotion) {
      // Skip straight to ready state
      setPhase("ready");
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setPhase("tumbling"),  800));
    timers.push(setTimeout(() => setPhase("slamming"),  2000));
    timers.push(setTimeout(() => {
      setShockwaveActive(true);
      setFlashActive(true);
      setTimeout(() => setFlashActive(false), 80);
      setTimeout(() => setShockwaveActive(false), 800);
    }, 2100));
    timers.push(setTimeout(() => setPhase("revealing"), 2600));
    timers.push(setTimeout(() => setPhase("ready"),     3200));

    return () => timers.forEach(clearTimeout);
  }, [reducedMotion]);

  /* ── Quote cycling (only during ready) ── */
  useEffect(() => {
    if (phase !== "ready" || reducedMotion) return;
    const interval = setInterval(() => {
      setQuoteVisible(false);
      setTimeout(() => {
        setQuoteIndex((i) => (i + 1) % QUOTES.length);
        setQuoteVisible(true);
      }, 400);
    }, 2500);
    return () => clearInterval(interval);
  }, [phase, reducedMotion]);

  /* ── Money burst wave (only during ready) ── */
  useEffect(() => {
    if (phase !== "ready" || reducedMotion) return;
    const spawnBurst = () => {
      const count = 15 + Math.floor(Math.random() * 6);
      const newBills = generateBurstBills(count, burstIdRef.current);
      burstIdRef.current += count + 100;
      setBurstBills(newBills);
      setTimeout(() => setBurstBills([]), 2200);
    };
    const initial = setTimeout(spawnBurst, 300);
    const interval = setInterval(spawnBurst, 2000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [phase, reducedMotion]);

  /* ── Exit sequence ── */
  const triggerExit = useCallback(() => {
    if (hasExitedRef.current) return;
    hasExitedRef.current = true;

    if (reducedMotion) {
      setTimeout(onExit, 300);
      return;
    }

    setPhase("exiting");
    setBillsExploding(true);
    setTimeout(() => setFlashActive(true), 120);
    setTimeout(() => setFlashActive(false), 420);
    // Unmount splash faster so it never blocks dashboard interactions.
    // Exit animation is purely visual — dashboard is ready underneath.
    setTimeout(onExit, 600);
  }, [reducedMotion, onExit]);

  /* ── Skip cinematic on any click/key during non-ready phases ── */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        if (phase === "ready" || phase === "exiting") {
          if (e.key === "Enter" || e.key === "Escape") triggerExit();
        } else {
          // Skip cinematic → jump to ready
          setPhase("ready");
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [phase, triggerExit]);

  const handleSkipOrExit = useCallback(() => {
    if (phase === "ready") {
      triggerExit();
    } else if (phase !== "exiting") {
      setPhase("ready");
    }
  }, [phase, triggerExit]);

  const isReady = phase === "ready";
  const isExiting = phase === "exiting";
  const showCube = phase === "tumbling" || phase === "slamming";
  const showLogoFull = phase === "slamming" || phase === "revealing" || phase === "ready" || phase === "exiting";
  const showTitle = phase === "revealing" || phase === "ready" || phase === "exiting";
  const showButton = phase === "ready" || phase === "exiting";

  return (
    <AnimatePresence>
      {phase !== "exiting" ? (
        <motion.div
          key="splash"
          className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden"
          style={{ zIndex: 9999, background: "#000", cursor: showCube ? "default" : "pointer" }}
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: "easeInOut" }}
          onClick={handleSkipOrExit}
        >
          {/* ── Atmospheric background layers ── */}
          <div className="absolute inset-0 pointer-events-none">
            {/* Gotham radial vignette — subtle blue/gray glow */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(30,50,80,0.18) 0%, rgba(10,20,40,0.08) 40%, transparent 70%)",
              }}
            />
            {/* Horizontal fog gradient */}
            <motion.div
              style={{
                position: "absolute",
                inset: 0,
                background: "linear-gradient(90deg, rgba(16,185,129,0.03) 0%, rgba(245,158,11,0.04) 50%, rgba(16,185,129,0.03) 100%)",
                backgroundSize: "200% 100%",
              }}
              animate={{ backgroundPosition: ["0% 0%", "100% 0%", "0% 0%"] }}
              transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
            />
            {/* Rain streaks — 40 thin vertical lines */}
            {!reducedMotion && <RainStreaks />}
          </div>

          {/* ── Screen flash overlay (slam moment) ── */}
          <AnimatePresence>
            {flashActive && (
              <motion.div
                key="flash"
                className="absolute inset-0 pointer-events-none"
                style={{ background: "#fff", zIndex: 10001 }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.15 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.08 }}
              />
            )}
          </AnimatePresence>

          {/* ── Shockwave ring (slam moment) ── */}
          <AnimatePresence>
            {shockwaveActive && (
              <motion.div
                key="shockwave"
                className="absolute rounded-full pointer-events-none"
                style={{
                  left: "50%",
                  top: "50%",
                  width: 4,
                  height: 4,
                  marginLeft: -2,
                  marginTop: -2,
                  border: "2px solid rgba(250,204,21,0.6)",
                  zIndex: 10000,
                }}
                initial={{ scale: 0, opacity: 0.8 }}
                animate={{ scale: 200, opacity: 0 }}
                exit={{}}
                transition={{ duration: 0.7, ease: "easeOut" }}
              />
            )}
          </AnimatePresence>

          {/* ── 3D Cube scene ── */}
          <AnimatePresence>
            {showCube && !reducedMotion && (
              <motion.div
                key="cube-scene"
                className="absolute"
                style={{
                  perspective: "1200px",
                  perspectiveOrigin: "50% 50%",
                  width: 280,
                  height: 280,
                  left: "50%",
                  top: "50%",
                  marginLeft: -140,
                  marginTop: -140,
                  zIndex: 20,
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: phase === "slamming" ? 0 : 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  opacity: phase === "slamming"
                    ? { duration: 0.4, delay: 0.15 }
                    : { duration: 0.1 }
                }}
              >
                <CSSCube phase={phase} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Ready-state stack: logo + title + quote + button, naturally centered ── */}
          {(showLogoFull || showTitle || isReady || showButton) && (
            <div
              className="relative flex h-full w-full flex-col items-center justify-center gap-[clamp(0.75rem,2vh,1.5rem)] px-[5vw] py-[clamp(1rem,4vh,2.5rem)] text-center"
              style={{ zIndex: 30 }}
            >
              {/* Logo */}
              <AnimatePresence>
                {showLogoFull && (
                  <motion.div
                    key="batman-logo-full"
                    className="flex items-center justify-center"
                    style={{ width: "clamp(8rem, 22vw, 18rem)" }}
                    initial={{ opacity: 0, scale: 0.4 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.5, ease: [0.19, 1, 0.22, 1] }}
                  >
                    <BatmanLogoFull className="w-full h-auto drop-shadow-[0_0_40px_rgba(250,204,21,0.9)]" />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Title */}
              <AnimatePresence>
                {showTitle && (
                  <motion.div
                    key="batcave-title"
                    className="flex max-w-full flex-col items-center"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                  >
                    <motion.h1
                      className="font-black text-amber-400"
                      style={{
                        fontFamily: "'Bebas Neue', 'Impact', sans-serif",
                        fontSize: "clamp(2rem, 8vw, 5rem)",
                        textShadow: "0 0 40px rgba(245,158,11,0.5), 0 0 80px rgba(245,158,11,0.25)",
                        letterSpacing: "0.2em",
                        lineHeight: 1,
                        margin: 0,
                      }}
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.5, delay: 0.1, ease: "backOut" }}
                    >
                      BATCAVE
                    </motion.h1>
                    <motion.p
                      className="text-amber-400/50 font-mono uppercase"
                      style={{
                        marginTop: "0.5rem",
                        fontSize: "clamp(0.6rem, 1.4vw, 0.875rem)",
                        letterSpacing: "clamp(0.15em, 0.5vw, 0.4em)",
                      }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3, duration: 0.5 }}
                    >
                      Market Intelligence Terminal
                    </motion.p>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Quote */}
              <AnimatePresence>
                {isReady && (
                  <motion.div
                    key="quote-area"
                    className="flex w-full max-w-2xl flex-col items-center"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                  >
                    <div className="mb-3 h-px w-12 bg-amber-500/30 sm:mb-4 sm:w-16" />
                    <div className="flex min-h-[3rem] items-center justify-center text-center sm:min-h-[3.5rem]">
                      <AnimatePresence mode="wait">
                        <motion.p
                          key={quoteIndex}
                          className="font-mono italic text-white/70"
                          style={{
                            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                            fontSize: "clamp(0.75rem, 1.8vw, 1rem)",
                            lineHeight: 1.5,
                            textShadow: "0 0 20px rgba(16,185,129,0.15)",
                          }}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: quoteVisible ? 1 : 0, y: quoteVisible ? 0 : -8 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ duration: 0.35, ease: "easeInOut" }}
                        >
                          &ldquo;{QUOTES[quoteIndex]}&rdquo;
                        </motion.p>
                      </AnimatePresence>
                    </div>
                    <div className="mt-3 h-px w-12 bg-amber-500/30 sm:mt-4 sm:w-16" />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* CTA button */}
              <AnimatePresence>
                {showButton && (
                  <motion.div
                    key="cta-area"
                    className="flex w-full max-w-md flex-col items-center"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                  >
                    <motion.p
                      className="font-mono uppercase text-white/25"
                      style={{
                        fontSize: "clamp(0.6rem, 1.2vw, 0.75rem)",
                        letterSpacing: "0.2em",
                        marginBottom: "clamp(0.75rem, 1.5vh, 1.25rem)",
                      }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.5, duration: 0.5 }}
                    >
                      Press Enter or click to continue
                    </motion.p>
                    <motion.button
                      ref={buttonRef}
                      data-testid="button-launch-batcave"
                      aria-label="Launch BATCAVE"
                      onClick={(e) => { e.stopPropagation(); triggerExit(); }}
                      className="relative block w-full overflow-hidden text-center font-black uppercase text-black cursor-pointer select-none sm:w-auto"
                      style={{
                        background: "#10b981",
                        fontSize: "clamp(0.72rem, 2vw, 1.15rem)",
                        padding: "clamp(0.85rem, 2vh, 1.35rem) clamp(1rem, 4vw, 2.5rem)",
                        borderRadius: "0.5rem",
                        border: "none",
                        fontFamily: "'Bebas Neue', 'Impact', sans-serif",
                        letterSpacing: "0.1em",
                        lineHeight: 1.2,
                        boxShadow: "0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)",
                        whiteSpace: "normal",
                      }}
                      whileHover={{
                        scale: 1.04,
                        boxShadow: "0 0 50px rgba(16,185,129,0.7), 0 0 100px rgba(16,185,129,0.3)",
                      }}
                      whileTap={{ scale: 1.15 }}
                      animate={{
                        scale: [1, 1.03, 1],
                        boxShadow: [
                          "0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)",
                          "0 0 45px rgba(16,185,129,0.6), 0 0 80px rgba(16,185,129,0.25)",
                          "0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)",
                        ],
                      }}
                      transition={{
                        scale: { duration: 2, repeat: Infinity, ease: "easeInOut" },
                        boxShadow: { duration: 2, repeat: Infinity, ease: "easeInOut" },
                      }}
                    >
                      {/* Button shimmer */}
                      <motion.div
                        className="pointer-events-none absolute inset-0"
                        style={{
                          background: "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.25) 50%, transparent 60%)",
                          backgroundSize: "200% 100%",
                        }}
                        animate={{ backgroundPosition: ["200% 0", "-200% 0"] }}
                        transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                      />
                      ARE YOU READY TO FUCKING PRINT
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* ── Falling money bills — only in ready state ── */}
          {isReady && !reducedMotion && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
              {bills.map((bill) => (
                <FallingBill
                  key={bill.id}
                  bill={bill}
                  exploding={billsExploding}
                />
              ))}
            </div>
          )}

          {/* ── Burst wave layer ── */}
          {isReady && !reducedMotion && burstBills.length > 0 && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
              {burstBills.map((bill) => (
                <BurstBill key={bill.id} bill={bill} />
              ))}
            </div>
          )}

          {/* ── Skip hint during cinematic ── */}
          {!isReady && !isExiting && (
            <motion.div
              className="absolute bottom-6 text-white/20 text-[10px] font-mono tracking-widest uppercase select-none pointer-events-none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1, duration: 0.5 }}
              style={{ zIndex: 50 }}
            >
              Click or press any key to skip
            </motion.div>
          )}
        </motion.div>
      ) : (
        /* ── Exit fade-to-black (pointer-events-none so it never blocks the dashboard) ── */
        <motion.div
          key="splash-exit"
          className="fixed inset-0 pointer-events-none"
          style={{ zIndex: 9999, background: "#000" }}
          initial={{ opacity: 0.9 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        />
      )}
    </AnimatePresence>
  );
}

/* ─── Rain Streaks ───────────────────────────────────────────────── */
function RainStreaks() {
  const streaks = Array.from({ length: 40 }, (_, i) => ({
    id: i,
    left: `${(i / 40) * 100 + Math.random() * 2.5}%`,
    height: `${40 + Math.random() * 60}px`,
    delay: `${Math.random() * 3}s`,
    duration: `${0.4 + Math.random() * 0.6}s`,
    opacity: 0.04 + Math.random() * 0.08,
  }));

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <style>{`
        @keyframes rain-fall {
          0% { transform: translateY(-100px); opacity: var(--rain-opacity); }
          80% { opacity: var(--rain-opacity); }
          100% { transform: translateY(110vh); opacity: 0; }
        }
      `}</style>
      {streaks.map((s) => (
        <div
          key={s.id}
          style={{
            position: "absolute",
            left: s.left,
            top: 0,
            width: "1px",
            height: s.height,
            background: "linear-gradient(to bottom, transparent, rgba(150,180,220,0.7), transparent)",
            animation: `rain-fall ${s.duration} linear ${s.delay} infinite`,
            "--rain-opacity": s.opacity,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

/* ─── 3D CSS Cube ────────────────────────────────────────────────── */
function CSSCube({ phase }: { phase: Phase }) {
  return (
    <>
      <style>{`
        .batcave-cube-wrapper {
          transform-style: preserve-3d;
          width: 280px;
          height: 280px;
          position: relative;
          transform-origin: center center;
        }

        .batcave-cube-wrapper.phase-tumbling {
          animation: cubeTumble 1.2s cubic-bezier(0.19, 1, 0.22, 1) forwards;
        }

        .batcave-cube-wrapper.phase-slamming {
          animation: cubeSlam 0.5s cubic-bezier(0.19, 1, 0.22, 1) forwards;
        }

        @keyframes cubeTumble {
          0% {
            transform: scale(0.6) rotateX(0deg) rotateY(0deg) rotateZ(0deg);
            opacity: 0;
          }
          15% { opacity: 1; }
          100% {
            transform: scale(1.0) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 1;
          }
        }

        @keyframes cubeSlam {
          0% {
            transform: scale(1.0) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 1;
          }
          60% {
            transform: scale(1.8) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 0.9;
          }
          100% {
            transform: scale(2.5) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 0;
          }
        }

        .cube-face {
          position: absolute;
          width: 280px;
          height: 280px;
          backface-visibility: hidden;
          border: 1px solid rgba(250, 204, 21, 0.15);
          background: #050505;
          overflow: hidden;
        }

        .cube-face::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(135deg, rgba(250,204,21,0.06) 0%, transparent 50%, rgba(250,204,21,0.03) 100%);
          pointer-events: none;
        }

        /* Chrome rim on edges */
        .cube-face::after {
          content: '';
          position: absolute;
          inset: 0;
          box-shadow: inset 0 0 20px rgba(255,255,255,0.04), inset 1px 1px 0 rgba(255,255,255,0.08), inset -1px -1px 0 rgba(0,0,0,0.5);
          pointer-events: none;
        }

        .cube-face.front  { transform: translateZ(140px); background: #060606; }
        .cube-face.back   { transform: rotateY(180deg) translateZ(140px); }
        .cube-face.right  { transform: rotateY(90deg) translateZ(140px); }
        .cube-face.left   { transform: rotateY(-90deg) translateZ(140px); }
        .cube-face.top    { transform: rotateX(90deg) translateZ(140px); }
        .cube-face.bottom { transform: rotateX(-90deg) translateZ(140px); }

        /* Tech-line texture on side faces */
        .cube-face.right::before,
        .cube-face.left::before,
        .cube-face.top::before,
        .cube-face.bottom::before {
          background:
            repeating-linear-gradient(
              0deg,
              transparent,
              transparent 18px,
              rgba(250,204,21,0.04) 18px,
              rgba(250,204,21,0.04) 19px
            ),
            repeating-linear-gradient(
              90deg,
              transparent,
              transparent 18px,
              rgba(250,204,21,0.03) 18px,
              rgba(250,204,21,0.03) 19px
            );
        }
      `}</style>

      <div className={`batcave-cube-wrapper phase-${phase}`}>
        {/* Front face: Batman logo */}
        <div className="cube-face front flex items-center justify-center">
          <BatmanLogoFull className="w-48 drop-shadow-[0_0_24px_rgba(250,204,21,0.7)]" />
        </div>
        {/* Back face: also Batman */}
        <div className="cube-face back flex items-center justify-center">
          <BatmanLogoFull className="w-48 drop-shadow-[0_0_16px_rgba(250,204,21,0.4)]" />
        </div>
        {/* Side faces: matte tech grid */}
        <div className="cube-face right" />
        <div className="cube-face left" />
        <div className="cube-face top" />
        <div className="cube-face bottom" />
      </div>
    </>
  );
}

/* ─── Falling Bill Sub-component (main rain layer) ───────────────── */
interface FallingBillProps {
  bill: Bill;
  exploding: boolean;
}

function FallingBill({ bill, exploding }: FallingBillProps) {
  const angle = Math.random() * 360;
  const distance = 150 + Math.random() * 300;
  const explodeX = Math.cos((angle * Math.PI) / 180) * distance;
  const explodeY = Math.sin((angle * Math.PI) / 180) * distance;

  if (exploding) {
    return (
      <motion.div
        className="absolute select-none pointer-events-none"
        style={{
          left: `${bill.x}%`,
          top: "50%",
          fontSize: `${bill.size}px`,
          lineHeight: 1,
        }}
        animate={{
          x: explodeX,
          y: explodeY,
          opacity: 0,
          scale: 0,
          rotate: bill.rotation + 720,
        }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      >
        {bill.emoji}
      </motion.div>
    );
  }

  return (
    <div
      className="absolute select-none pointer-events-none"
      style={{
        left: `${bill.x}%`,
        top: "-80px",
        fontSize: `${bill.size}px`,
        lineHeight: 1,
        animation: `bill-fall-${bill.id % 5} ${bill.duration}s linear ${bill.delay}s infinite`,
        "--bill-drift": `${bill.drift}px`,
      } as React.CSSProperties}
    >
      <div
        style={{
          animation: `bill-spin ${Math.abs(bill.rotationSpeed) / 180 + 1.5}s linear infinite ${bill.rotationSpeed < 0 ? "reverse" : ""}`,
          transform: `rotate(${bill.rotation}deg)`,
        }}
      >
        {bill.emoji}
      </div>
    </div>
  );
}

/* ─── Burst Bill Sub-component ───────────────────────────────────── */
function BurstBill({ bill }: { bill: Bill }) {
  return (
    <motion.div
      className="absolute select-none pointer-events-none"
      style={{
        left: `${bill.x}%`,
        top: "-60px",
        fontSize: `${bill.size}px`,
        lineHeight: 1,
      }}
      initial={{ y: 0, x: 0, opacity: 1, rotate: bill.rotation }}
      animate={{
        y: "120vh",
        x: bill.drift,
        opacity: [1, 1, 0.7, 0],
        rotate: bill.rotation + bill.rotationSpeed / 2,
      }}
      transition={{
        duration: bill.duration,
        delay: bill.delay,
        ease: "easeIn",
      }}
    >
      {bill.emoji}
    </motion.div>
  );
}
