import { useEffect, useRef, useState, useCallback } from "react";
import { BatmanLogoFull, BatmanLogoSmall } from "./BatmanLogo";
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
  x: number;        // % from left
  delay: number;    // seconds
  duration: number; // seconds
  size: number;     // px font-size
  rotation: number; // initial rotation deg
  rotationSpeed: number; // spin direction + speed
  emoji: string;
  drift: number;    // horizontal drift px
}

/** Pick emoji: 70% 💵, 20% 💰, 10% 💴 */
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
      duration: 2.5 + Math.random() * 3,      // 2.5s – 5.5s
      size: 22 + Math.random() * 26,            // 22px – 48px
      rotation: Math.random() * 60 - 30,        // -30° to +30°
      rotationSpeed: (Math.random() - 0.5) * 720,
      emoji: pickEmoji(),
      drift: (Math.random() - 0.5) * 120,       // -60px to +60px horizontal drift
    });
  }
  return bills;
}

/** Burst wave bills — faster fall, more chaotic */
function generateBurstBills(count: number, idOffset: number): Bill[] {
  const bills: Bill[] = [];
  for (let i = 0; i < count; i++) {
    bills.push({
      id: idOffset + i,
      x: Math.random() * 100,
      delay: Math.random() * 0.4,              // tight spawn window
      duration: 1.2 + Math.random() * 0.6,     // 1.2s – 1.8s (fast)
      size: 24 + Math.random() * 20,            // 24px – 44px
      rotation: Math.random() * 90 - 45,
      rotationSpeed: (Math.random() - 0.5) * 1080,
      emoji: pickEmoji(),
      drift: (Math.random() - 0.5) * 160,
    });
  }
  return bills;
}

/* ─── Fog blobs ──────────────────────────────────────────────────── */
function FogBlob({
  x, y, size, color, duration, delay
}: { x: string; y: string; size: string; color: string; duration: number; delay: number }) {
  return (
    <motion.div
      className="absolute rounded-full blur-3xl pointer-events-none"
      style={{
        left: x,
        top: y,
        width: size,
        height: size,
        background: color,
      }}
      animate={{
        x: [0, 40, -30, 20, 0],
        y: [0, -30, 20, -15, 0],
        scale: [1, 1.15, 0.9, 1.1, 1],
        opacity: [0.3, 0.5, 0.35, 0.45, 0.3],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    />
  );
}

/* ─── Main Component ─────────────────────────────────────────────── */
export default function LaunchSplash({ onExit }: LaunchSplashProps) {
  /* ── State ── */
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [quoteVisible, setQuoteVisible] = useState(true);
  const [exiting, setExiting] = useState(false);
  const [flashActive, setFlashActive] = useState(false);
  const [billsExploding, setBillsExploding] = useState(false);
  const [reducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [isMobile] = useState(() => window.innerWidth < 640);

  const billCount = isMobile ? 60 : 120;
  const [bills] = useState(() => generateBills(billCount));
  // Burst wave bills — separate layer, starts with id offset to avoid collisions
  const [burstBills, setBurstBills] = useState<Bill[]>([]);
  const burstIdRef = useRef(billCount + 1000);

  const keyPressTimeRef = useRef<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hasExitedRef = useRef(false);

  /* ── Quote cycling ── */
  useEffect(() => {
    if (reducedMotion) return;
    const interval = setInterval(() => {
      setQuoteVisible(false);
      setTimeout(() => {
        setQuoteIndex((i) => (i + 1) % QUOTES.length);
        setQuoteVisible(true);
      }, 400);
    }, 2500);
    return () => clearInterval(interval);
  }, [reducedMotion]);

  /* ── Burst wave spawner — every 2 seconds ── */
  useEffect(() => {
    if (reducedMotion || exiting) return;
    const spawnBurst = () => {
      const count = 15 + Math.floor(Math.random() * 6); // 15–20 bills
      const newBills = generateBurstBills(count, burstIdRef.current);
      burstIdRef.current += count + 100;
      setBurstBills(newBills);
      // Clear burst after animation completes
      setTimeout(() => setBurstBills([]), 2200);
    };
    // First burst at 0.5s, then every 2s
    const initial = setTimeout(spawnBurst, 500);
    const interval = setInterval(spawnBurst, 2000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [reducedMotion, exiting]);

  /* ── Keyboard handler ── */
  const triggerExit = useCallback(() => {
    if (hasExitedRef.current) return;
    hasExitedRef.current = true;
    handleExit();
  }, []); // eslint-disable-line

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        // Immediate exit on Escape
        if (e.key === "Escape") {
          triggerExit();
          return;
        }
        // Any key after 1s
        if (keyPressTimeRef.current === null) {
          keyPressTimeRef.current = Date.now();
        } else if (Date.now() - keyPressTimeRef.current > 1000) {
          triggerExit();
        } else {
          triggerExit();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [triggerExit]);

  /* ── Exit sequence ── */
  function handleExit() {
    if (exiting) return;
    setExiting(true);

    if (reducedMotion) {
      // Skip animation entirely
      setTimeout(onExit, 300);
      return;
    }

    // 1. Button pulse already handled by CSS
    // 2. Bills explode
    setBillsExploding(true);
    // 3. Flash
    setTimeout(() => setFlashActive(true), 120);
    setTimeout(() => setFlashActive(false), 420);
    // 4. Fade to black + dissolve
    // (handled by AnimatePresence exit animation)
    setTimeout(() => {
      onExit();
    }, 1500);
  }

  const handleButtonClick = () => {
    if (hasExitedRef.current) return;
    hasExitedRef.current = true;
    handleExit();
  };

  return (
    <AnimatePresence>
      {!exiting ? (
        <motion.div
          key="splash"
          className="fixed inset-0 flex flex-col items-center justify-between overflow-hidden"
          style={{
            zIndex: 9999,
            background: "#000",
          }}
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: "easeInOut" }}
        >
          {/* ── Dark fog background ── */}
          {!reducedMotion && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              {/* Fog blobs */}
              <FogBlob x="10%" y="5%" size="40vw" color="rgba(16, 185, 129, 0.08)" duration={18} delay={0} />
              <FogBlob x="60%" y="10%" size="35vw" color="rgba(245, 158, 11, 0.07)" duration={22} delay={2} />
              <FogBlob x="5%" y="50%" size="30vw" color="rgba(16, 185, 129, 0.06)" duration={25} delay={4} />
              <FogBlob x="65%" y="55%" size="38vw" color="rgba(245, 158, 11, 0.06)" duration={20} delay={1} />
              <FogBlob x="30%" y="30%" size="25vw" color="rgba(16, 185, 129, 0.05)" duration={30} delay={3} />
              {/* Center glow */}
              <div
                className="absolute rounded-full blur-3xl pointer-events-none"
                style={{
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  width: "60vw",
                  height: "60vh",
                  background: "radial-gradient(circle, rgba(16,185,129,0.04) 0%, transparent 70%)",
                }}
              />
            </div>
          )}

          {/* ── Falling money bills — main layer ── */}
          {!reducedMotion && (
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
          {!reducedMotion && burstBills.length > 0 && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
              {burstBills.map((bill) => (
                <BurstBill key={bill.id} bill={bill} />
              ))}
            </div>
          )}

          {/* ── Flash overlay ── */}
          <AnimatePresence>
            {flashActive && (
              <motion.div
                key="flash"
                className="absolute inset-0 pointer-events-none"
                style={{ background: "#10b981", zIndex: 10000 }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.6 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            )}
          </AnimatePresence>

          {/* ── TOP: Logo ── */}
          <motion.div
            className="flex flex-col items-center pt-8 sm:pt-16"
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            style={{ zIndex: 10 }}
          >
            {/* Movie bat logo — big, amber with glow */}
            <BatmanLogoFull className="w-48 sm:w-72 drop-shadow-[0_0_32px_rgba(250,204,21,0.8)]" />
            <motion.h1
              className="mt-4 text-5xl sm:text-7xl font-black tracking-widest text-amber-400"
              style={{
                fontFamily: "'Bebas Neue', 'Impact', sans-serif",
                textShadow: "0 0 40px rgba(245,158,11,0.5), 0 0 80px rgba(245,158,11,0.25)",
                letterSpacing: "0.2em",
              }}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, delay: 0.2, ease: "backOut" }}
            >
              BATCAVE
            </motion.h1>
            <motion.p
              className="mt-1 text-[10px] sm:text-sm tracking-[0.3em] sm:tracking-[0.4em] text-amber-400/50 font-mono uppercase px-4 text-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.5 }}
            >
              Market Intelligence Terminal
            </motion.p>
          </motion.div>

          {/* ── MIDDLE: Rotating quote ── */}
          <motion.div
            className="flex flex-col items-center px-8 sm:px-16 max-w-2xl w-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.5 }}
            style={{ zIndex: 10 }}
          >
            <div className="w-16 h-px bg-amber-500/30 mb-6" />
            <div className="min-h-[4rem] flex items-center justify-center text-center">
              <AnimatePresence mode="wait">
                <motion.p
                  key={quoteIndex}
                  className="text-base sm:text-lg font-mono text-white/70 italic tracking-wide leading-relaxed"
                  style={{
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    textShadow: "0 0 20px rgba(16,185,129,0.15)",
                  }}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.35, ease: "easeInOut" }}
                >
                  "{QUOTES[quoteIndex]}"
                </motion.p>
              </AnimatePresence>
            </div>
            <div className="w-16 h-px bg-amber-500/30 mt-6" />
          </motion.div>

          {/* ── BOTTOM: CTA button ── */}
          <motion.div
            className="flex flex-col items-center pb-8 sm:pb-16"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.6, ease: "easeOut" }}
            style={{ zIndex: 10 }}
          >
            <motion.p
              className="text-xs text-white/25 font-mono tracking-widest mb-6 uppercase"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1, duration: 0.5 }}
            >
              Press Enter or click to continue
            </motion.p>
            <motion.button
              ref={buttonRef}
              data-testid="button-launch-batcave"
              aria-label="Launch BATCAVE"
              onClick={handleButtonClick}
              className="relative overflow-hidden font-black uppercase tracking-widest text-black cursor-pointer select-none"
              style={{
                background: "#10b981",
                fontSize: "clamp(0.85rem, 2.5vw, 1.25rem)",
                padding: "clamp(1rem, 3vw, 1.5rem) clamp(1.5rem, 6vw, 3rem)",
                borderRadius: "0.5rem",
                border: "none",
                fontFamily: "'Bebas Neue', 'Impact', sans-serif",
                letterSpacing: "0.12em",
                boxShadow: "0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)",
              }}
              whileHover={{
                scale: 1.04,
                boxShadow: "0 0 50px rgba(16,185,129,0.7), 0 0 100px rgba(16,185,129,0.3)",
              }}
              whileTap={{ scale: 1.15 }}
              animate={
                !exiting
                  ? {
                      scale: [1, 1.03, 1],
                      boxShadow: [
                        "0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)",
                        "0 0 45px rgba(16,185,129,0.6), 0 0 80px rgba(16,185,129,0.25)",
                        "0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)",
                      ],
                    }
                  : {}
              }
              transition={{
                scale: { duration: 2, repeat: Infinity, ease: "easeInOut" },
                boxShadow: { duration: 2, repeat: Infinity, ease: "easeInOut" },
              }}
            >
              {/* Button shimmer */}
              <motion.div
                className="absolute inset-0 pointer-events-none"
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
        </motion.div>
      ) : (
        /* ── Exit fade-to-black ── */
        <motion.div
          key="splash-exit"
          className="fixed inset-0"
          style={{ zIndex: 9999, background: "#000" }}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.5, delay: 0.8 }}
        />
      )}
    </AnimatePresence>
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

/* ─── Burst Bill Sub-component (fast burst wave) ─────────────────── */
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
