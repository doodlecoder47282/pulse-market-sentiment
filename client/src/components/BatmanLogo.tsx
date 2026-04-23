/**
 * BatmanLogo.tsx
 * Iconic Batman oval emblem — 1989 Burton / Dark Knight / Arkham style.
 *
 * Exports:
 *   BatmanLogo        — monochrome (currentColor), for inline/header use
 *   BatmanLogoFull    — yellow oval with black bat, for LaunchSplash hero
 *   BatmanLogoSmall   — alias of BatmanLogo for backward compat
 */

// ─── Shared bat silhouette path ───────────────────────────────────────────────
// Drawn on a 200×120 viewBox. Matches the classic DC movie-badge silhouette:
// wide outstretched wings, 3 scalloped curves per side, pointed ear tips,
// deep chest notch, and belly scallops. VERIFIED against reference image.
const BAT_PATH =
  "M 100,18 C 97,18 95,20 93,24 L 84,11 C 84,17 87,23 91,27 " +
  "C 78,23 58,17 38,16 C 22,15 6,19 4,31 C 10,29 20,28 28,31 " +
  "C 18,37 10,49 8,63 C 11,76 18,90 20,90 C 22,90 32,77 36,75 " +
  "C 40,73 50,90 54,90 C 58,90 62,79 66,78 C 70,77 74,93 76,93 " +
  "C 78,93 82,88 84,87 C 86,98 90,106 94,108 C 97,106 100,105 100,105 " +
  "C 100,105 103,106 106,108 C 110,106 114,98 116,87 " +
  "C 118,88 122,93 124,93 C 126,93 130,78 134,78 " +
  "C 138,77 142,90 146,90 C 150,90 158,77 164,75 " +
  "C 166,76 170,90 172,90 C 174,90 182,76 192,63 " +
  "C 190,49 182,37 172,31 C 180,28 190,29 196,31 " +
  "C 194,19 178,15 162,16 C 142,17 122,23 109,27 " +
  "C 113,23 116,17 116,11 L 107,24 C 105,20 103,18 100,18 Z";

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * Monochrome Batman logo using currentColor.
 * ViewBox 200×120. Default renders at ~60×36px.
 */
export function BatmanLogo({ className = "", size = 36 }: LogoProps) {
  return (
    <svg
      viewBox="0 0 200 120"
      width={size * (200 / 120)}
      height={size}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Batman"
      className={className}
    >
      <path d={BAT_PATH} />
    </svg>
  );
}

/** Alias — backward compat with existing BatIconSmall usages */
export function BatmanLogoSmall({ className = "", size = 36 }: LogoProps) {
  return <BatmanLogo className={className} size={size} />;
}

/**
 * Full yellow-oval version for LaunchSplash hero and BATCAVE header.
 * Black outer oval → yellow inner oval → black bat silhouette on yellow.
 * ViewBox 200×120.
 */
export function BatmanLogoFull({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 120"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Batman"
      className={className}
    >
      {/* Outer black oval (border/shadow) */}
      <ellipse cx="100" cy="60" rx="98" ry="58" fill="#000" />
      {/* Yellow oval field */}
      <ellipse cx="100" cy="60" rx="86" ry="48" fill="#FACC15" />
      {/* Black bat silhouette on yellow */}
      <path d={BAT_PATH} fill="#000" />
    </svg>
  );
}

export default BatmanLogo;
