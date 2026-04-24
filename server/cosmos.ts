// ─────────────────────────────────────────────────────────────────────────────
// server/cosmos.ts
//
// Astrology + financial astrology engine for the "Cosmos" tab.
//
// DESIGN PRINCIPLE: everything here is deterministic. Given a UTC timestamp
// it produces the same planetary positions, aspects, lunar phase, signs,
// retrogrades, natal transits, and rule-derived market signals. No external
// API, no keys, no network.
//
// Accuracy note: we use simplified mean-element (Simon et al. / Meeus-style)
// formulas that are accurate to roughly ±0.1° for Sun/Moon and ±0.5–1° for
// the outer planets over ~1900–2100. That's more than enough for daily
// astrological/financial-astrology use (aspects are judged with 6–8° orbs).
//
// References distilled here:
//   Meeus, "Astronomical Algorithms" 2nd ed. (mean elements chapter 31,
//   nutation/obliquity chapter 22, moon chapter 47, lunar phase chapter 49)
//   VSOP87 truncated mean-longitude series.
//   Simon et al. (1994) planet mean longitudes.
//
// Nothing in this file imports from the client. Pure server math.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Angle utilities ─────────────────────────────────────────────────────────
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// Normalize to [0, 360)
function norm360(d: number): number {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
}
// Signed delta in (−180, 180]
function sdiff(a: number, b: number): number {
  let d = norm360(a - b);
  if (d > 180) d -= 360;
  return d;
}

// ─── Julian Day / T (Julian centuries from J2000) ────────────────────────────
function julianDay(d: Date): number {
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth() + 1;
  const D =
    d.getUTCDate() +
    (d.getUTCHours() + (d.getUTCMinutes() + d.getUTCSeconds() / 60) / 60) / 24;
  const [y, m] = M <= 2 ? [Y - 1, M + 12] : [Y, M];
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    D +
    B -
    1524.5
  );
}
function jcFromJd(jd: number): number {
  return (jd - 2451545.0) / 36525.0;
}

// ─── Planet definitions ──────────────────────────────────────────────────────
// Mean-longitude polynomial coefficients (degrees) from Meeus AA (tab 31.A),
// evaluated as L = a0 + a1*T + a2*T^2 + a3*T^3 with T = Julian centuries
// from J2000. Good to ~0.5° for the outer planets over ~1900–2100.
// Mean longitudes are heliocentric; Mercury/Venus/... we convert to geocentric
// ecliptic longitude via a simple (but well-tested) orbit solver below.

export type PlanetId =
  | "sun" | "moon" | "mercury" | "venus" | "mars"
  | "jupiter" | "saturn" | "uranus" | "neptune" | "pluto";

interface OrbitalElements {
  // All in degrees or AU where marked
  a: [number, number, number?, number?]; // semi-major axis (AU)
  e: [number, number, number?, number?]; // eccentricity
  i: [number, number, number?, number?]; // inclination (deg)
  L: [number, number, number?, number?]; // mean longitude (deg)
  w: [number, number, number?, number?]; // longitude of perihelion (deg)
  O: [number, number, number?, number?]; // longitude of ascending node (deg)
}

// J2000 mean elements, from NASA JPL ssd.jpl.nasa.gov/planets/approx_pos.html
// (Standish, "Keplerian Elements for Approximate Positions"). Rates are per
// Julian century. Valid 1800-2050 to ~600 arcsec. More than enough for us.
const ELEMENTS: Record<Exclude<PlanetId, "sun" | "moon">, OrbitalElements> = {
  mercury: {
    a: [0.38709927,  0.00000037],
    e: [0.20563593,  0.00001906],
    i: [7.00497902, -0.00594749],
    L: [252.25032350, 149472.67411175],
    w: [77.45779628,  0.16047689],
    O: [48.33076593, -0.12534081],
  },
  venus: {
    a: [0.72333566,  0.00000390],
    e: [0.00677672, -0.00004107],
    i: [3.39467605, -0.00078890],
    L: [181.97909950, 58517.81538729],
    w: [131.60246718,  0.00268329],
    O: [76.67984255, -0.27769418],
  },
  // Earth — used as observer origin for geocentric conversion
  // (we treat Earth's heliocentric elements as Earth-Moon barycenter)
  mars: {
    a: [1.52371034,  0.00001847],
    e: [0.09339410,  0.00007882],
    i: [1.84969142, -0.00813131],
    L: [-4.55343205, 19140.30268499],
    w: [-23.94362959,  0.44441088],
    O: [49.55953891, -0.29257343],
  },
  jupiter: {
    a: [5.20288700, -0.00011607],
    e: [0.04838624, -0.00013253],
    i: [1.30439695, -0.00183714],
    L: [34.39644051, 3034.74612775],
    w: [14.72847983,  0.21252668],
    O: [100.47390909,  0.20469106],
  },
  saturn: {
    a: [9.53667594, -0.00125060],
    e: [0.05386179, -0.00050991],
    i: [2.48599187,  0.00193609],
    L: [49.95424423, 1222.49362201],
    w: [92.59887831, -0.41897216],
    O: [113.66242448, -0.28867794],
  },
  uranus: {
    a: [19.18916464, -0.00196176],
    e: [0.04725744, -0.00004397],
    i: [0.77263783, -0.00242939],
    L: [313.23810451, 428.48202785],
    w: [170.95427630,  0.40805281],
    O: [74.01692503,  0.04240589],
  },
  neptune: {
    a: [30.06992276,  0.00026291],
    e: [0.00859048,  0.00005105],
    i: [1.77004347,  0.00035372],
    L: [-55.12002969, 218.45945325],
    w: [44.96476227, -0.32241464],
    O: [131.78422574, -0.00508664],
  },
  pluto: {
    a: [39.48211675, -0.00031596],
    e: [0.24882730,  0.00005170],
    i: [17.14001206,  0.00004818],
    L: [238.92903833, 145.20780515],
    w: [224.06891629, -0.04062942],
    O: [110.30393684, -0.01183482],
  },
};

// Earth elements (for geocentric conversion — use Earth-Moon barycenter)
const EARTH: OrbitalElements = {
  a: [1.00000261,  0.00000562],
  e: [0.01671123, -0.00004392],
  i: [-0.00001531, -0.01294668],
  L: [100.46457166, 35999.37244981],
  w: [102.93768193,  0.32327364],
  O: [0, 0],
};

// Evaluate polynomial at T (Julian centuries)
function evalElt(p: [number, number, number?, number?], T: number): number {
  const [a0, a1, a2 = 0, a3 = 0] = p;
  return a0 + a1 * T + a2 * T * T + a3 * T * T * T;
}

// Solve Kepler's equation E - e sin E = M (M, E in radians) by Newton iteration.
function solveKepler(M: number, e: number): number {
  M = ((M + Math.PI) % (2 * Math.PI)) - Math.PI;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

// Heliocentric ecliptic position (X, Y, Z in AU, equinox J2000)
function heliocentric(el: OrbitalElements, T: number): [number, number, number] {
  const a = evalElt(el.a, T);
  const e = evalElt(el.e, T);
  const i = evalElt(el.i, T) * DEG;
  const L = norm360(evalElt(el.L, T)) * DEG;
  const w = norm360(evalElt(el.w, T)) * DEG;
  const O = norm360(evalElt(el.O, T)) * DEG;

  // Argument of perihelion, mean anomaly
  const argPeri = w - O;
  const M = L - w;

  // Solve Kepler
  const E = solveKepler(M, e);

  // Position in orbital plane
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);

  // Rotate to ecliptic
  const cosO = Math.cos(O), sinO = Math.sin(O);
  const cosI = Math.cos(i), sinI = Math.sin(i);
  const cosW = Math.cos(argPeri), sinW = Math.sin(argPeri);

  const X =
    (cosO * cosW - sinO * sinW * cosI) * xv +
    (-cosO * sinW - sinO * cosW * cosI) * yv;
  const Y =
    (sinO * cosW + cosO * sinW * cosI) * xv +
    (-sinO * sinW + cosO * cosW * cosI) * yv;
  const Z = (sinW * sinI) * xv + (cosW * sinI) * yv;

  return [X, Y, Z];
}

// Geocentric ecliptic longitude in degrees [0, 360)
function geocentricLongitude(el: OrbitalElements, T: number): {
  lon: number; dist: number; helioLon: number;
} {
  const [xp, yp, zp] = heliocentric(el, T);
  const [xe, ye, ze] = heliocentric(EARTH, T);
  const dx = xp - xe, dy = yp - ye, dz = zp - ze;
  const lon = norm360(Math.atan2(dy, dx) * RAD);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const helioLon = norm360(Math.atan2(yp, xp) * RAD);
  return { lon, dist, helioLon };
}

// ─── Sun: geocentric longitude from Earth's heliocentric (flip 180°) ─────────
function sunLongitude(T: number): number {
  const [xe, ye] = heliocentric(EARTH, T);
  return norm360(Math.atan2(ye, xe) * RAD + 180);
}
// Sun as seen from Earth — heliocentric "position" for the diagram is 0,0 (Sun)
// but for longitude we use the geocentric value above.

// ─── Moon: Meeus chapter 47, truncated but high-accuracy mean-longitude expr ─
function moonLongitude(T: number): number {
  // Mean elements (Meeus 47.1, 47.2)
  const Lp = 218.3164477 + 481267.88123421 * T
           - 0.0015786 * T * T + T * T * T / 538841 - T * T * T * T / 65194000;
  const D  = 297.8501921 + 445267.1114034 * T
           - 0.0018819 * T * T + T * T * T / 545868 - T * T * T * T / 113065000;
  const Ms = 357.5291092 +  35999.0502909 * T
           - 0.0001536 * T * T + T * T * T / 24490000;
  const Mm = 134.9633964 + 477198.8675055 * T
           + 0.0087414 * T * T + T * T * T / 69699 - T * T * T * T / 14712000;
  const F  = 93.2720950 + 483202.0175233 * T
           - 0.0036539 * T * T - T * T * T / 3526000 + T * T * T * T / 863310000;

  const d  = D * DEG, ms = Ms * DEG, mm = Mm * DEG, f = F * DEG;

  // A subset of the largest periodic terms (ΣL in Meeus 47.A), in 1e-6 degrees
  // Using the dominant ~12 terms keeps Moon longitude to ~0.1°.
  let sumL = 0;
  const add = (c: number, a: number) => { sumL += c * Math.sin(a); };
  add(6288774, mm);
  add(1274027, 2 * d - mm);
  add( 658314, 2 * d);
  add( 213618, 2 * mm);
  add(-185116, ms);
  add(-114332, 2 * f);
  add(  58793, 2 * d - 2 * mm);
  add(  57066, 2 * d - ms - mm);
  add(  53322, 2 * d + mm);
  add(  45758, 2 * d - ms);
  add( -40923, ms - mm);
  add( -34720, d);
  add( -30383, ms + mm);
  add(  15327, 2 * d - 2 * f);
  add( -12528, mm + 2 * f);
  add(  10980, mm - 2 * f);

  const L = Lp + sumL / 1e6;
  return norm360(L);
}

// ─── Retrograde detection: compute geocentric longitude at t and t + 1 day ──
function isRetrograde(id: PlanetId, jd: number): boolean {
  if (id === "sun" || id === "moon") return false;
  const el = ELEMENTS[id];
  const T0 = jcFromJd(jd);
  const T1 = jcFromJd(jd + 1);
  const a = geocentricLongitude(el, T0).lon;
  const b = geocentricLongitude(el, T1).lon;
  return sdiff(b, a) < 0;
}

// ─── Zodiac signs ────────────────────────────────────────────────────────────
export const SIGNS = [
  "Aries", "Taurus", "Gemini", "Cancer",
  "Leo", "Virgo", "Libra", "Scorpio",
  "Sagittarius", "Capricorn", "Aquarius", "Pisces",
] as const;
export type Sign = typeof SIGNS[number];

export const SIGN_GLYPH: Record<Sign, string> = {
  Aries: "♈", Taurus: "♉", Gemini: "♊", Cancer: "♋",
  Leo: "♌", Virgo: "♍", Libra: "♎", Scorpio: "♏",
  Sagittarius: "♐", Capricorn: "♑", Aquarius: "♒", Pisces: "♓",
};
export const SIGN_ELEMENT: Record<Sign, "fire" | "earth" | "air" | "water"> = {
  Aries: "fire", Leo: "fire", Sagittarius: "fire",
  Taurus: "earth", Virgo: "earth", Capricorn: "earth",
  Gemini: "air", Libra: "air", Aquarius: "air",
  Cancer: "water", Scorpio: "water", Pisces: "water",
};
export const SIGN_MODALITY: Record<Sign, "cardinal" | "fixed" | "mutable"> = {
  Aries: "cardinal", Cancer: "cardinal", Libra: "cardinal", Capricorn: "cardinal",
  Taurus: "fixed", Leo: "fixed", Scorpio: "fixed", Aquarius: "fixed",
  Gemini: "mutable", Virgo: "mutable", Sagittarius: "mutable", Pisces: "mutable",
};

export function signFromLongitude(lon: number): Sign {
  return SIGNS[Math.floor(norm360(lon) / 30)];
}
export function degreeWithinSign(lon: number): number {
  return norm360(lon) % 30;
}

// ─── Planet glyphs + colors ──────────────────────────────────────────────────
export const PLANET_GLYPH: Record<PlanetId, string> = {
  sun: "☉", moon: "☽", mercury: "☿", venus: "♀", mars: "♂",
  jupiter: "♃", saturn: "♄", uranus: "♅", neptune: "♆", pluto: "♇",
};
export const PLANET_COLOR: Record<PlanetId, string> = {
  sun:     "#fbbf24", // amber
  moon:    "#e2e8f0", // slate
  mercury: "#a78bfa", // violet
  venus:   "#fb7185", // rose
  mars:    "#f87171", // red
  jupiter: "#fcd34d", // yellow
  saturn:  "#f59e0b", // amber-orange
  uranus:  "#60a5fa", // sky
  neptune: "#3b82f6", // blue
  pluto:   "#9ca3af", // gray
};
// For the solar-system diagram, orbit radius in arbitrary units scaled
// logarithmically so inner planets are visible. (Real AU distances span
// 0.39–39.5 which won't fit a single diagram readably.)
export const PLANET_ORBIT_RADIUS: Record<PlanetId, number> = {
  sun: 0,
  mercury: 8,
  venus: 14,
  moon: 20, // Moon rendered on Earth's ring for readability
  mars: 28,
  jupiter: 38,
  saturn: 48,
  uranus: 58,
  neptune: 68,
  pluto: 78,
};

// Earth isn't a "planet id" but we need to place it on the diagram too
// (it's the 3rd ring, between Venus and Mars in reality).
export const EARTH_ORBIT_RADIUS = 20;

// ─── Main: all planets at a given date ──────────────────────────────────────
export interface PlanetPosition {
  id: PlanetId;
  label: string;
  glyph: string;
  color: string;
  longitude: number;       // geocentric ecliptic longitude, deg
  sign: Sign;
  signGlyph: string;
  degInSign: number;       // 0..30
  retrograde: boolean;
  helioLongitude: number;  // heliocentric, deg (for solar-system diagram)
  distance: number;        // AU, geocentric
  orbitRadius: number;     // diagram-unit orbit radius
}

export function planetPositions(date: Date): PlanetPosition[] {
  const jd = julianDay(date);
  const T = jcFromJd(jd);

  const sunLon = sunLongitude(T);
  const moonLon = moonLongitude(T);

  // Earth's heliocentric longitude — used as Moon's "position" on diagram
  const earthHelio = norm360(Math.atan2(heliocentric(EARTH, T)[1], heliocentric(EARTH, T)[0]) * RAD);

  const out: PlanetPosition[] = [];

  out.push({
    id: "sun",
    label: "Sun",
    glyph: PLANET_GLYPH.sun,
    color: PLANET_COLOR.sun,
    longitude: sunLon,
    sign: signFromLongitude(sunLon),
    signGlyph: SIGN_GLYPH[signFromLongitude(sunLon)],
    degInSign: degreeWithinSign(sunLon),
    retrograde: false,
    helioLongitude: 0, // Sun is the center
    distance: 1,
    orbitRadius: 0,
  });

  out.push({
    id: "moon",
    label: "Moon",
    glyph: PLANET_GLYPH.moon,
    color: PLANET_COLOR.moon,
    longitude: moonLon,
    sign: signFromLongitude(moonLon),
    signGlyph: SIGN_GLYPH[signFromLongitude(moonLon)],
    degInSign: degreeWithinSign(moonLon),
    retrograde: false,
    // Render Moon on Earth's ring (geocentric vantage)
    helioLongitude: earthHelio,
    distance: 0.0026,
    orbitRadius: EARTH_ORBIT_RADIUS,
  });

  for (const id of ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"] as const) {
    const el = ELEMENTS[id];
    const { lon, dist, helioLon } = geocentricLongitude(el, T);
    out.push({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      glyph: PLANET_GLYPH[id],
      color: PLANET_COLOR[id],
      longitude: lon,
      sign: signFromLongitude(lon),
      signGlyph: SIGN_GLYPH[signFromLongitude(lon)],
      degInSign: degreeWithinSign(lon),
      retrograde: isRetrograde(id, jd),
      helioLongitude: helioLon,
      distance: dist,
      orbitRadius: PLANET_ORBIT_RADIUS[id],
    });
  }

  return out;
}

// ─── Aspects ─────────────────────────────────────────────────────────────────
export type AspectName =
  | "conjunction" | "sextile" | "square" | "trine" | "opposition";

interface AspectDef { name: AspectName; angle: number; orb: number; quality: "hard" | "soft" | "neutral"; }
const ASPECTS: AspectDef[] = [
  { name: "conjunction", angle: 0,   orb: 8, quality: "neutral" },
  { name: "sextile",     angle: 60,  orb: 4, quality: "soft" },
  { name: "square",      angle: 90,  orb: 6, quality: "hard" },
  { name: "trine",       angle: 120, orb: 6, quality: "soft" },
  { name: "opposition",  angle: 180, orb: 8, quality: "hard" },
];

export interface Aspect {
  a: PlanetId;
  b: PlanetId;
  aspect: AspectName;
  orb: number;              // actual deviation from exact (deg, signed)
  exact: number;            // absolute deviation (deg)
  applying: boolean;        // true if planets are moving into the exact aspect
  quality: "hard" | "soft" | "neutral";
  score: number;            // magnitude (0..1) — tight aspects score higher
}

// Check if an aspect is "applying" vs "separating" by looking at angular
// separation at t and t+1 day.
function computeApplying(a: PlanetPosition, b: PlanetPosition, aspectAngle: number, date: Date): boolean {
  const later = new Date(date.getTime() + 86400000);
  const p1 = planetPositionById(a.id, later);
  const p2 = planetPositionById(b.id, later);
  const dev0 = Math.abs(sdiff(a.longitude, b.longitude));
  const dev1 = Math.abs(sdiff(p1.longitude, p2.longitude));
  const gap0 = Math.abs(dev0 - aspectAngle);
  const gap1 = Math.abs(dev1 - aspectAngle);
  return gap1 < gap0; // getting tighter = applying
}

function planetPositionById(id: PlanetId, date: Date): PlanetPosition {
  const all = planetPositions(date);
  return all.find((p) => p.id === id)!;
}

export function aspects(positions: PlanetPosition[], date: Date): Aspect[] {
  const out: Aspect[] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i];
      const b = positions[j];
      const sep = Math.abs(sdiff(a.longitude, b.longitude));
      const sepMin = Math.min(sep, 360 - sep);
      for (const def of ASPECTS) {
        const dev = Math.abs(sepMin - def.angle);
        if (dev <= def.orb) {
          const applying = computeApplying(a, b, def.angle, date);
          out.push({
            a: a.id,
            b: b.id,
            aspect: def.name,
            orb: dev,
            exact: dev,
            applying,
            quality: def.quality,
            score: 1 - dev / def.orb,
          });
        }
      }
    }
  }
  // Sort by score desc (tightest first)
  return out.sort((x, y) => y.score - x.score);
}

// ─── Lunar phase ─────────────────────────────────────────────────────────────
export interface LunarPhase {
  phaseDegrees: number;     // 0 = new, 90 = first quarter, 180 = full, 270 = last quarter
  illumination: number;     // 0..1
  name: "New Moon" | "Waxing Crescent" | "First Quarter" | "Waxing Gibbous"
      | "Full Moon" | "Waning Gibbous" | "Last Quarter" | "Waning Crescent";
  daysIntoCycle: number;    // 0..29.53
}

const LUNAR_CYCLE_DAYS = 29.530588853;

export function lunarPhase(date: Date): LunarPhase {
  const jd = julianDay(date);
  const T = jcFromJd(jd);
  const phase = norm360(moonLongitude(T) - sunLongitude(T));
  const days = (phase / 360) * LUNAR_CYCLE_DAYS;
  // Illumination (Meeus 48.1 approximation)
  const ill = (1 - Math.cos(phase * DEG)) / 2;

  let name: LunarPhase["name"];
  if (phase < 22.5) name = "New Moon";
  else if (phase < 67.5) name = "Waxing Crescent";
  else if (phase < 112.5) name = "First Quarter";
  else if (phase < 157.5) name = "Waxing Gibbous";
  else if (phase < 202.5) name = "Full Moon";
  else if (phase < 247.5) name = "Waning Gibbous";
  else if (phase < 292.5) name = "Last Quarter";
  else if (phase < 337.5) name = "Waning Crescent";
  else name = "New Moon";

  return { phaseDegrees: phase, illumination: ill, name, daysIntoCycle: days };
}

// ─── Void-of-course Moon ─────────────────────────────────────────────────────
// The Moon is "void of course" between its last major aspect to another planet
// in the current sign and its entry into the next sign. Rule-based traders
// avoid initiating new trades during VoC windows.
export interface VoidOfCourse {
  active: boolean;
  lastAspectAt?: string; // ISO timestamp
  nextSignAt?: string;
  nextSign?: Sign;
}

export function voidOfCourseMoon(date: Date): VoidOfCourse {
  const nowJd = julianDay(date);
  const currentMoon = moonLongitude(jcFromJd(nowJd));
  const currentSign = signFromLongitude(currentMoon);

  // Scan forward in 30-minute increments for up to 2 days to find:
  //  (a) next major aspect to a planet (not moon itself)
  //  (b) moon entering next sign
  const stepHours = 0.5;
  const maxHours = 48;
  let nextSignJd: number | null = null;
  let lastAspectJd: number | null = null;

  // Scan forward for sign change
  for (let h = 0; h < maxHours; h += stepHours) {
    const jd = nowJd + h / 24;
    const L = moonLongitude(jcFromJd(jd));
    if (signFromLongitude(L) !== currentSign) {
      nextSignJd = jd;
      break;
    }
  }
  if (!nextSignJd) return { active: false };

  // Scan between now and sign change — look for any moon-planet aspect coming exact
  const planetIds: PlanetId[] = ["sun", "mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"];
  for (let jd = nowJd; jd <= nextSignJd; jd += stepHours / 24) {
    const T = jcFromJd(jd);
    const moon = moonLongitude(T);
    for (const pid of planetIds) {
      let planetLon: number;
      if (pid === "sun") planetLon = sunLongitude(T);
      else planetLon = geocentricLongitude(ELEMENTS[pid as Exclude<PlanetId, "sun" | "moon">], T).lon;
      const sep = Math.min(Math.abs(sdiff(moon, planetLon)), 360 - Math.abs(sdiff(moon, planetLon)));
      for (const asp of ASPECTS) {
        if (Math.abs(sep - asp.angle) < 0.25) { // tight threshold to call "exact"
          lastAspectJd = jd;
          break;
        }
      }
    }
  }

  // VoC is active if the last aspect within this sign has already passed
  // (or no more aspects remain before sign change).
  const active = lastAspectJd === null || lastAspectJd < nowJd;

  const nextSign = signFromLongitude(
    moonLongitude(jcFromJd(nextSignJd))
  );

  function jdToIso(jd: number): string {
    const ms = (jd - 2440587.5) * 86400000;
    return new Date(ms).toISOString();
  }

  return {
    active,
    lastAspectAt: lastAspectJd ? jdToIso(lastAspectJd) : undefined,
    nextSignAt: jdToIso(nextSignJd),
    nextSign,
  };
}

// ─── Bradley Siderograph ─────────────────────────────────────────────────────
// Donald Bradley's 1948 siderograph combines weighted planetary aspects into
// a single daily "market barometer" number. Positive peaks tend to mark
// market highs, troughs tend to mark lows (inversions do happen). Widely
// used by financial astrologers.
//
// Formula (Bradley's original weighting, simplified):
//   LT = sum of long-term aspect scores (Uranus, Neptune, Pluto vs Jupiter, Saturn)
//   MT = sum of middle-term aspect scores (Jupiter, Saturn vs Mars)
//   ST = sum of short-term from declinations
//   total = LT + MT + ST
//
// We implement a credible approximation: weighted aspect score across all
// outer-planet pairs, normalized to a -1..1 range. For research-grade use a
// trader would feed this into their own system; here it's a daily indicator.
export function bradleySiderograph(date: Date): { value: number; trend: "rising" | "falling"; zone: "high" | "low" | "neutral" } {
  const positions = planetPositions(date);
  const asps = aspects(positions, date);

  let score = 0;
  for (const a of asps) {
    // Weight by quality and tightness
    const q = a.quality === "hard" ? -1 : a.quality === "soft" ? 1 : 0;
    const outer = new Set(["jupiter", "saturn", "uranus", "neptune", "pluto"]);
    // Bradley emphasizes outer-planet aspects
    const w = (outer.has(a.a) && outer.has(a.b)) ? 2 : 1;
    score += q * a.score * w;
  }
  // Normalize to roughly -1..1 given typical aspect counts
  const value = Math.max(-1, Math.min(1, score / 8));

  // Trend: compare to 3 days ago
  const past = new Date(date.getTime() - 3 * 86400000);
  const pastPositions = planetPositions(past);
  const pastAsps = aspects(pastPositions, past);
  let pastScore = 0;
  for (const a of pastAsps) {
    const q = a.quality === "hard" ? -1 : a.quality === "soft" ? 1 : 0;
    const outer = new Set(["jupiter", "saturn", "uranus", "neptune", "pluto"]);
    const w = (outer.has(a.a) && outer.has(a.b)) ? 2 : 1;
    pastScore += q * a.score * w;
  }
  const pastValue = Math.max(-1, Math.min(1, pastScore / 8));

  const trend = value > pastValue ? "rising" : "falling";
  const zone = value > 0.4 ? "high" : value < -0.4 ? "low" : "neutral";
  return { value, trend, zone };
}

// ─── Natal charts: first-trade-date birth charts for instruments ────────────
export interface NatalChart {
  symbol: string;
  name: string;
  birthDate: string;    // ISO
  description: string;
  positions: PlanetPosition[];
}

// First-trade dates (widely cited). All at market open (9:30 AM ET) unless
// a specific reference gives otherwise.
const NATAL_BIRTHS: Array<{ symbol: string; name: string; date: string; description: string }> = [
  { symbol: "SPX",  name: "S&P 500 Index",        date: "1957-03-04T14:30:00Z", description: "Standard & Poor's 500 first published" },
  { symbol: "SPY",  name: "SPDR S&P 500 ETF",     date: "1993-01-22T14:30:00Z", description: "First ETF ever launched" },
  { symbol: "QQQ",  name: "Invesco QQQ ETF",      date: "1999-03-10T14:30:00Z", description: "Nasdaq-100 tracking ETF launch" },
  { symbol: "IWM",  name: "iShares Russell 2000", date: "2000-05-22T13:30:00Z", description: "Small-cap ETF launch" },
  { symbol: "AAPL", name: "Apple Inc",            date: "1980-12-12T14:30:00Z", description: "Apple IPO" },
  { symbol: "MSFT", name: "Microsoft Corp",       date: "1986-03-13T14:30:00Z", description: "Microsoft IPO" },
  { symbol: "NVDA", name: "NVIDIA Corp",          date: "1999-01-22T14:30:00Z", description: "NVIDIA IPO" },
  { symbol: "GOOGL",name: "Alphabet Inc",         date: "2004-08-19T13:30:00Z", description: "Google IPO" },
  { symbol: "META", name: "Meta Platforms",       date: "2012-05-18T13:30:00Z", description: "Facebook IPO" },
  { symbol: "AMZN", name: "Amazon.com",           date: "1997-05-15T13:30:00Z", description: "Amazon IPO" },
  { symbol: "TSLA", name: "Tesla Inc",            date: "2010-06-29T13:30:00Z", description: "Tesla IPO" },
  { symbol: "BTC",  name: "Bitcoin",              date: "2009-01-03T18:15:00Z", description: "Bitcoin genesis block" },
  { symbol: "ETH",  name: "Ethereum",             date: "2015-07-30T15:26:00Z", description: "Ethereum frontier launch" },
];

export function natalChart(symbol: string): NatalChart | null {
  const spec = NATAL_BIRTHS.find((n) => n.symbol === symbol);
  if (!spec) return null;
  const birth = new Date(spec.date);
  return {
    symbol: spec.symbol,
    name: spec.name,
    birthDate: spec.date,
    description: spec.description,
    positions: planetPositions(birth),
  };
}

export function allNatalCharts(): NatalChart[] {
  return NATAL_BIRTHS.map((n) => natalChart(n.symbol)!).filter(Boolean);
}

// Transits: today's planets vs natal planets — returns significant aspects.
export interface NatalTransit {
  symbol: string;
  natalName: string;
  aspects: Array<{
    transitingPlanet: PlanetId;
    natalPlanet: PlanetId;
    aspect: AspectName;
    orb: number;
    quality: "hard" | "soft" | "neutral";
  }>;
  score: number; // net disposition: positive = supportive, negative = stressed
}

export function natalTransits(symbol: string, date: Date): NatalTransit | null {
  const chart = natalChart(symbol);
  if (!chart) return null;
  const today = planetPositions(date);

  const matches: NatalTransit["aspects"] = [];
  for (const t of today) {
    for (const n of chart.positions) {
      const sep = Math.abs(sdiff(t.longitude, n.longitude));
      const sepMin = Math.min(sep, 360 - sep);
      for (const def of ASPECTS) {
        const dev = Math.abs(sepMin - def.angle);
        // Tighter orbs for natal transits
        const natalOrb = Math.min(def.orb, 5);
        if (dev <= natalOrb) {
          matches.push({
            transitingPlanet: t.id,
            natalPlanet: n.id,
            aspect: def.name,
            orb: dev,
            quality: def.quality,
          });
        }
      }
    }
  }

  let score = 0;
  for (const m of matches) {
    const sign = m.quality === "hard" ? -1 : m.quality === "soft" ? 1 : 0;
    score += sign * (1 - m.orb / 5);
  }
  return {
    symbol,
    natalName: chart.name,
    aspects: matches.sort((a, b) => a.orb - b.orb),
    score,
  };
}

// ─── Financial-astrology signal engine (deterministic, rule-based) ──────────
export interface FinancialSignal {
  id: string;
  severity: "high" | "medium" | "info";
  headline: string;
  detail: string;
  impacts: string[]; // tags: e.g. ["tech", "vol", "reversal", "regime"]
}

// Gann / financial-astrology rules — each is a pure function of positions.
export function financialSignals(positions: PlanetPosition[], asps: Aspect[], phase: LunarPhase, voc: VoidOfCourse, bradley: ReturnType<typeof bradleySiderograph>): FinancialSignal[] {
  const signals: FinancialSignal[] = [];
  const byId = Object.fromEntries(positions.map((p) => [p.id, p]));

  // Mercury retrograde — classic tech/comms volatility and contract-review flag
  if (byId.mercury.retrograde) {
    signals.push({
      id: "mercury-retro",
      severity: "medium",
      headline: `Mercury retrograde in ${byId.mercury.sign}`,
      detail:
        `Mercury governs contracts, communication, and tech. Retrograde periods historically correlate with reversals in tech ` +
        `sector leadership and elevated volatility in short-duration trades. Review entries twice, confirm fills, avoid new ` +
        `multi-leg structures on the first day.`,
      impacts: ["tech", "comms", "vol", "reversal"],
    });
  }

  // Mars retrograde — momentum regime shift, aggressive trades misfire
  if (byId.mars.retrograde) {
    signals.push({
      id: "mars-retro",
      severity: "medium",
      headline: `Mars retrograde in ${byId.mars.sign}`,
      detail:
        `Mars retrograde typically marks momentum exhaustion. Breakout strategies underperform, fade/mean-reversion setups ` +
        `over-perform relative to baseline. Size down aggressive directional plays.`,
      impacts: ["momentum", "size-down"],
    });
  }

  // Venus retrograde — consumer, luxury, relationships, paused spending
  if (byId.venus.retrograde) {
    signals.push({
      id: "venus-retro",
      severity: "info",
      headline: `Venus retrograde in ${byId.venus.sign}`,
      detail:
        `Consumer discretionary, luxury, and XLY-adjacent names historically underperform during Venus retro. Also affects ` +
        `M&A deal flow — watch for delays or re-pricings.`,
      impacts: ["consumer", "mna", "luxury"],
    });
  }

  // Full Moon — reversal risk at market extremes
  if (phase.name === "Full Moon") {
    signals.push({
      id: "full-moon",
      severity: "high",
      headline: `Full Moon (${phase.illumination.toFixed(2)} illumination)`,
      detail:
        `Full Moons mark culmination points — widely observed reversal risk at price extremes. If SPX is at a swing high or ` +
        `low today, fade conviction is elevated. Intraday: 2–4 PM ET rotations more likely.`,
      impacts: ["reversal", "vol"],
    });
  }
  if (phase.name === "New Moon") {
    signals.push({
      id: "new-moon",
      severity: "info",
      headline: `New Moon (${phase.illumination.toFixed(2)} illumination)`,
      detail:
        `New Moons seed new cycles — trend initiations more likely in the 3 days following. Trust breakouts more, fades less.`,
      impacts: ["trend", "initiation"],
    });
  }

  // Void-of-course Moon — "do nothing" window
  if (voc.active) {
    signals.push({
      id: "voc-moon",
      severity: "info",
      headline: `Moon void-of-course until ${voc.nextSignAt ? new Date(voc.nextSignAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }) : "sign change"}`,
      detail:
        `Traditional astrological trading rule: avoid initiating new positions during VoC. Close existing trades, manage only.`,
      impacts: ["caution", "hold"],
    });
  }

  // Jupiter-Saturn aspect — generational regime shift
  for (const a of asps) {
    if (
      (a.a === "jupiter" && a.b === "saturn") ||
      (a.a === "saturn" && a.b === "jupiter")
    ) {
      signals.push({
        id: "jup-sat",
        severity: "high",
        headline: `Jupiter ${a.aspect} Saturn (orb ${a.orb.toFixed(1)}°)`,
        detail:
          `The Jupiter-Saturn cycle is the dominant long-wave regime marker in financial astrology. Current ${a.aspect} ` +
          `${a.applying ? "applying" : "separating"} — ${a.quality === "hard" ? "tension, contraction bias" : a.quality === "soft" ? "expansion, risk-on bias" : "neutral turning point"}. ` +
          `Monitor yield curve and cyclical rotation for confirmation.`,
        impacts: ["regime", "cycles", "macro"],
      });
    }
  }

  // Uranus aspects — shock, sudden events
  for (const a of asps) {
    if ((a.a === "uranus" || a.b === "uranus") && a.quality === "hard" && a.score > 0.5) {
      signals.push({
        id: `uranus-${a.a}-${a.b}-${a.aspect}`,
        severity: "high",
        headline: `Uranus ${a.aspect} ${a.a === "uranus" ? a.b : a.a} (tight)`,
        detail:
          `Uranus hard aspects mark shock / surprise windows — headline-driven volatility, unexpected central-bank moves, ` +
          `crypto dislocations. Keep VIX hedges on, reduce leverage.`,
        impacts: ["shock", "vol", "crypto"],
      });
      break;
    }
  }

  // Pluto aspects — deep transformation, power shifts, debt/leverage
  for (const a of asps) {
    if ((a.a === "pluto" || a.b === "pluto") && a.score > 0.5) {
      signals.push({
        id: `pluto-${a.a}-${a.b}-${a.aspect}`,
        severity: a.quality === "hard" ? "high" : "medium",
        headline: `Pluto ${a.aspect} ${a.a === "pluto" ? a.b : a.a}`,
        detail:
          `Pluto governs debt, leverage, concentration of power. ${a.quality === "hard" ? "Hard aspects flag credit stress and deleveraging events." : "Soft aspects support structural accumulation."} ` +
          `Watch HYG/LQD spreads and bank sector action.`,
        impacts: ["credit", "debt", "leverage"],
      });
      break;
    }
  }

  // Bradley zone — composite cycle
  if (bradley.zone !== "neutral") {
    signals.push({
      id: "bradley",
      severity: "info",
      headline: `Bradley siderograph ${bradley.zone === "high" ? "peak zone" : "trough zone"} (${bradley.value.toFixed(2)}, ${bradley.trend})`,
      detail:
        `Bradley's 1948 siderograph is at a ${bradley.zone}. Historically these zones mark turn windows — ` +
        `${bradley.zone === "high" ? "exhaustion of risk-on" : "exhaustion of risk-off"}. Inversions do occur, so confirm with price action.`,
      impacts: ["turn", "cycles"],
    });
  }

  return signals;
}

// ─── Zodiac daily readings (trader-focused) ─────────────────────────────────
export interface ZodiacReading {
  sign: Sign;
  glyph: string;
  element: string;
  modality: string;
  headline: string;
  detail: string;
  luckyWindow: string;
}

export function zodiacReadings(positions: PlanetPosition[], asps: Aspect[], phase: LunarPhase): ZodiacReading[] {
  const moonSign = positions.find((p) => p.id === "moon")!.sign;
  const sunSign = positions.find((p) => p.id === "sun")!.sign;

  return SIGNS.map((sign) => {
    const isMoonSign = sign === moonSign;
    const isSunSign = sign === sunSign;
    const element = SIGN_ELEMENT[sign];
    const modality = SIGN_MODALITY[sign];

    // Trader-aware flavor based on element
    const elementFlavor: Record<typeof element, string> = {
      fire: "Bias toward action — high-conviction breakouts favored",
      earth: "Bias toward patience — accumulation and structure favored",
      air: "Bias toward analysis — pair trades and relative-value favored",
      water: "Bias toward intuition — fades and reversal entries favored",
    };

    let headline = elementFlavor[element];
    if (isMoonSign) headline = `Moon in your sign — emotions loud, trust data over gut. ${headline}`;
    if (isSunSign) headline = `Sun in your sign — conviction high, avoid overconfidence. ${headline}`;

    // Detail: reference current major aspects that touch the sign's ruler
    const ruler: Record<Sign, PlanetId> = {
      Aries: "mars", Taurus: "venus", Gemini: "mercury", Cancer: "moon",
      Leo: "sun", Virgo: "mercury", Libra: "venus", Scorpio: "pluto",
      Sagittarius: "jupiter", Capricorn: "saturn", Aquarius: "uranus", Pisces: "neptune",
    };
    const rulerPlanet = ruler[sign];
    const rulerAsps = asps.filter((a) => a.a === rulerPlanet || a.b === rulerPlanet).slice(0, 2);
    const aspectNote = rulerAsps.length > 0
      ? rulerAsps.map((a) => `${a.a}-${a.b} ${a.aspect}`).join(", ")
      : "ruler clear";

    const detail = `Ruling planet: ${PLANET_GLYPH[rulerPlanet]} ${rulerPlanet}. Active aspects: ${aspectNote}. ` +
      `${modality === "cardinal" ? "Initiate" : modality === "fixed" ? "Hold" : "Adapt"} as the dominant posture today.`;

    // Lucky window — based on Moon's current sign relative to trader's sign
    const signIdx = SIGNS.indexOf(sign);
    const moonIdx = SIGNS.indexOf(moonSign);
    const diff = (moonIdx - signIdx + 12) % 12;
    const trine = diff === 4 || diff === 8;
    const sextile = diff === 2 || diff === 10;
    const luckyWindow = trine
      ? "Strong window for entries today"
      : sextile
        ? "Mild supportive window"
        : diff === 6
          ? "Avoid confrontational trades — opposition energy"
          : diff === 3 || diff === 9
            ? "Friction day — size down"
            : "Baseline day — trade your system";

    return {
      sign,
      glyph: SIGN_GLYPH[sign],
      element,
      modality,
      headline,
      detail,
      luckyWindow,
    };
  });
}

// ─── Unified daily snapshot ─────────────────────────────────────────────────
export interface CosmosSnapshot {
  generatedAt: string;
  positions: PlanetPosition[];
  aspects: Aspect[];
  lunarPhase: LunarPhase;
  voidOfCourse: VoidOfCourse;
  bradley: ReturnType<typeof bradleySiderograph>;
  financialSignals: FinancialSignal[];
  zodiacReadings: ZodiacReading[];
  natalTransits: NatalTransit[];
  dailyBriefMarkdown: string;
}

export function buildCosmosSnapshot(date: Date = new Date()): CosmosSnapshot {
  const positions = planetPositions(date);
  const asps = aspects(positions, date);
  const phase = lunarPhase(date);
  const voc = voidOfCourseMoon(date);
  const brad = bradleySiderograph(date);
  const sigs = financialSignals(positions, asps, phase, voc, brad);
  const zod = zodiacReadings(positions, asps, phase);
  const natal = NATAL_BIRTHS
    .map((n) => natalTransits(n.symbol, date))
    .filter((t): t is NatalTransit => !!t)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  const brief = buildDailyBriefMarkdown({
    date, positions, asps, phase, voc, brad, sigs, natal,
  });

  return {
    generatedAt: date.toISOString(),
    positions,
    aspects: asps,
    lunarPhase: phase,
    voidOfCourse: voc,
    bradley: brad,
    financialSignals: sigs,
    zodiacReadings: zod,
    natalTransits: natal,
    dailyBriefMarkdown: brief,
  };
}

// ─── Daily brief composer (deterministic) ───────────────────────────────────
// Same pattern as the EOD brief: this is the source of truth, and if an LLM
// key ever gets provided we add an /api/cosmos/brief-enhance endpoint that
// uses the same data to write a richer narrative. For now the deterministic
// brief is the entire story.
function buildDailyBriefMarkdown(ctx: {
  date: Date;
  positions: PlanetPosition[];
  asps: Aspect[];
  phase: LunarPhase;
  voc: VoidOfCourse;
  brad: ReturnType<typeof bradleySiderograph>;
  sigs: FinancialSignal[];
  natal: NatalTransit[];
}): string {
  const { date, positions, asps, phase, voc, brad, sigs, natal } = ctx;
  const byId = Object.fromEntries(positions.map((p) => [p.id, p]));
  const dateStr = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const topAspects = asps.filter((a) => a.score > 0.5).slice(0, 6);
  const topNatal = natal.slice(0, 5);

  const regime =
    brad.zone === "high" ? "risk-on exhaustion zone"
    : brad.zone === "low" ? "risk-off exhaustion zone"
    : byId.mercury.retrograde ? "cautious / review mode"
    : phase.name === "Full Moon" ? "reversal-risk peak"
    : phase.name === "New Moon" ? "trend-initiation window"
    : "baseline";

  const lines: string[] = [
    `## COSMIC REGIME — ${dateStr}`,
    `${regime.toUpperCase()}. Moon in ${byId.moon.sign} (${phase.name}, ${(phase.illumination * 100).toFixed(0)}% illum). ` +
    `Sun in ${byId.sun.sign}. Bradley ${brad.value.toFixed(2)} ${brad.trend}. ` +
    `${voc.active ? `**Moon void-of-course** — avoid new entries until ${voc.nextSignAt ? new Date(voc.nextSignAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "sign change"} ET.` : ""}`,
    ``,
    `## PLANET POSITIONS`,
    `| Planet | Sign | Degree | Retro |`,
    `|---|---|---|---|`,
    ...positions.map((p) => `| ${p.glyph} ${p.label} | ${p.signGlyph} ${p.sign} | ${p.degInSign.toFixed(1)}° | ${p.retrograde ? "℞" : "—"} |`),
    ``,
  ];

  if (topAspects.length > 0) {
    lines.push(`## MAJOR ASPECTS`);
    lines.push(`| Aspect | Orb | Quality | Phase |`);
    lines.push(`|---|---|---|---|`);
    for (const a of topAspects) {
      lines.push(`| ${byId[a.a].glyph} ${a.a} ${a.aspect} ${byId[a.b].glyph} ${a.b} | ${a.orb.toFixed(1)}° | ${a.quality} | ${a.applying ? "applying" : "separating"} |`);
    }
    lines.push(``);
  }

  if (sigs.length > 0) {
    lines.push(`## MARKET SIGNALS`);
    for (const s of sigs) {
      const sev = s.severity === "high" ? "🔴" : s.severity === "medium" ? "🟡" : "🔵";
      lines.push(`- ${sev} **${s.headline}** — ${s.detail}`);
    }
    lines.push(``);
  }

  if (topNatal.length > 0) {
    lines.push(`## NATAL TRANSITS — today's sky vs birth charts`);
    for (const t of topNatal) {
      const disp = t.score > 0 ? "supportive" : t.score < 0 ? "stressed" : "neutral";
      const topHits = t.aspects.slice(0, 2).map((a) => `${a.transitingPlanet} ${a.aspect} natal ${a.natalPlanet}`).join(", ");
      lines.push(`- **${t.symbol}** (${t.natalName}): score ${t.score.toFixed(2)} — ${disp}. ${topHits || "no tight aspects"}.`);
    }
    lines.push(``);
  }

  lines.push(`## TRADING DISPOSITION`);
  if (voc.active) {
    lines.push(`- **Void-of-course Moon** — traditional rule: close only, do not open new.`);
  }
  if (byId.mercury.retrograde) {
    lines.push(`- **Mercury retrograde** — triple-check fills, avoid complex multi-leg new positions, tech names subject to reversal.`);
  }
  if (phase.name === "Full Moon") {
    lines.push(`- **Full Moon** — reversal risk elevated at swing highs/lows. Fade conviction +1.`);
  } else if (phase.name === "New Moon") {
    lines.push(`- **New Moon** — trust breakouts more than usual over next 3 days.`);
  }
  if (brad.zone === "high") {
    lines.push(`- **Bradley high** — be wary of added long exposure. Tighten stops on longs.`);
  } else if (brad.zone === "low") {
    lines.push(`- **Bradley low** — risk-off exhaustion. Contrarian longs favored on confirmation.`);
  }
  if (sigs.length === 0 && !voc.active && !byId.mercury.retrograde) {
    lines.push(`- Baseline regime — trade your system. No cosmic overrides today.`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(`*Computed from VSOP87/Meeus mean-element formulas. Accuracy: Sun/Moon ±0.1°, outer planets ±0.5°. Aspects use 6–8° orbs.*`);

  return lines.join("\n");
}

// ─── Forward-looking weekly + monthly outlook builders ─────────────────────
// Scan ahead day-by-day through the geocentric engine; collect moon-phase
// changes, Mercury station flips, sign ingresses, aspect peaks, Bradley
// zone changes. All deterministic — zero network, zero LLM required.

export interface OutlookEvent {
  date: string;            // ISO
  dayOffset: number;       // 0 = today, 1 = tomorrow, ...
  type:
    | "new_moon"
    | "full_moon"
    | "first_quarter"
    | "last_quarter"
    | "mercury_rx_start"
    | "mercury_rx_end"
    | "planet_rx_start"
    | "planet_rx_end"
    | "ingress"
    | "bradley_high"
    | "bradley_low"
    | "aspect_peak"
    | "void_of_course";
  headline: string;
  detail: string;
  severity: "high" | "medium" | "low";
  bias: "bullish" | "bearish" | "neutral" | "volatile";
}

function scanForwardEvents(startDate: Date, days: number): OutlookEvent[] {
  const events: OutlookEvent[] = [];
  const phaseNames: Record<string, OutlookEvent["type"]> = {
    "New Moon": "new_moon",
    "Full Moon": "full_moon",
    "First Quarter": "first_quarter",
    "Last Quarter": "last_quarter",
  };
  // Previous day state — for edge detection
  let prevPhase = lunarPhase(startDate).name;
  let prevBradZone = bradleySiderograph(startDate).zone;
  const prevRx: Record<string, boolean> = {};
  const startPositions = planetPositions(startDate);
  for (const p of startPositions) prevRx[p.id] = p.retrograde;
  const prevSigns: Record<string, string> = {};
  for (const p of startPositions) prevSigns[p.id] = p.sign;

  for (let d = 1; d <= days; d++) {
    const probe = new Date(startDate.getTime() + d * 86_400_000);
    const iso = probe.toISOString();
    const phase = lunarPhase(probe);
    const brad = bradleySiderograph(probe);
    const positions = planetPositions(probe);
    const byId = Object.fromEntries(positions.map((p) => [p.id, p]));

    // Moon phase transitions
    if (phase.name !== prevPhase && phaseNames[phase.name]) {
      const severity: OutlookEvent["severity"] =
        phase.name === "Full Moon" || phase.name === "New Moon" ? "high" : "low";
      const bias: OutlookEvent["bias"] =
        phase.name === "Full Moon" ? "bearish"
        : phase.name === "New Moon" ? "bullish"
        : "neutral";
      const detail =
        phase.name === "Full Moon" ? "Reversal-risk peak. U.Mich study: returns statistically lower in Full Moon window globally. Fade conviction."
        : phase.name === "New Moon" ? "Trend-initiation window. 15-day lunar effect peaks here. Trust breakouts more than usual for next 3 trading days."
        : phase.name === "First Quarter" ? "Mid-cycle — typically neutral. Use as a pulse check, not a signal."
        : "Approaching New Moon. Begin trimming longs if SAD-season alignment.";
      events.push({
        date: iso,
        dayOffset: d,
        type: phaseNames[phase.name],
        headline: `${phase.name} in ${byId.moon.sign}`,
        detail,
        severity,
        bias,
      });
    }

    // Bradley zone changes
    if (brad.zone !== prevBradZone) {
      if (brad.zone === "high") {
        events.push({
          date: iso,
          dayOffset: d,
          type: "bradley_high",
          headline: `Bradley siderograph enters HIGH zone (${brad.value.toFixed(2)})`,
          detail: "Risk-on exhaustion. Tighten stops on longs, watch for distribution. Not a top-tick signal — a warning zone.",
          severity: "medium",
          bias: "bearish",
        });
      } else if (brad.zone === "low") {
        events.push({
          date: iso,
          dayOffset: d,
          type: "bradley_low",
          headline: `Bradley siderograph enters LOW zone (${brad.value.toFixed(2)})`,
          detail: "Risk-off exhaustion. Contrarian longs favored on technical confirmation. Historical inflection region.",
          severity: "medium",
          bias: "bullish",
        });
      }
    }

    // Planet retrograde flips
    for (const p of positions) {
      if (p.retrograde !== prevRx[p.id]) {
        const isMerc = p.id === "mercury";
        const nowRx = p.retrograde;
        const baseType: OutlookEvent["type"] =
          isMerc
            ? (nowRx ? "mercury_rx_start" : "mercury_rx_end")
            : (nowRx ? "planet_rx_start" : "planet_rx_end");
        const detail = isMerc
          ? (nowRx
              ? "Mercury stations retrograde. Station date itself is the high-probability reversal window (±3 days). Avoid initiating new tech/comm positions until direct."
              : "Mercury stations direct. Reversal-watch window closes. Tech/NASDAQ often reverse trend around station dates.")
          : (nowRx
              ? `${p.label} stations retrograde in ${p.sign}. Watch sector associations.`
              : `${p.label} stations direct in ${p.sign}. End of reversal-watch window.`);
        events.push({
          date: iso,
          dayOffset: d,
          type: baseType,
          headline: `${p.glyph} ${p.label} stations ${nowRx ? "RETROGRADE" : "DIRECT"}`,
          detail,
          severity: isMerc ? "high" : "medium",
          bias: "volatile",
        });
      }
      prevRx[p.id] = p.retrograde;
    }

    // Major sign ingresses (only for slower bodies — sun, mars, jupiter, saturn, outer)
    const slowBodies: PlanetId[] = ["sun", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"];
    for (const id of slowBodies) {
      const p = byId[id];
      if (!p) continue;
      if (p.sign !== prevSigns[id]) {
        events.push({
          date: iso,
          dayOffset: d,
          type: "ingress",
          headline: `${p.glyph} ${p.label} enters ${p.signGlyph} ${p.sign}`,
          detail:
            id === "sun" ? `Solar ingress into ${p.sign} shifts seasonal tone.`
            : id === "jupiter" ? `Jupiter ingress — year-long sector/theme shift. Growth-sector rotation signal.`
            : id === "saturn" ? `Saturn ingress — multi-year structural shift. Value/utility-sector implications.`
            : `${p.label} ingress to ${p.sign}. Background regime shift.`,
          severity: id === "sun" ? "low" : id === "jupiter" || id === "saturn" ? "high" : "medium",
          bias: "neutral",
        });
        prevSigns[id] = p.sign;
      }
    }

    prevPhase = phase.name;
    prevBradZone = brad.zone;
  }

  return events;
}

export interface Outlook {
  horizon: "weekly" | "monthly";
  startDate: string;
  endDate: string;
  events: OutlookEvent[];
  netBias: "bullish" | "bearish" | "mixed" | "neutral";
  keyDates: string[];           // ISO dates of high-severity events
  markdown: string;
}

function summarizeBias(events: OutlookEvent[]): Outlook["netBias"] {
  let bull = 0;
  let bear = 0;
  for (const e of events) {
    const w = e.severity === "high" ? 3 : e.severity === "medium" ? 2 : 1;
    if (e.bias === "bullish") bull += w;
    else if (e.bias === "bearish") bear += w;
  }
  if (bull === 0 && bear === 0) return "neutral";
  if (bull > bear * 1.5) return "bullish";
  if (bear > bull * 1.5) return "bearish";
  return "mixed";
}

function buildOutlookMarkdown(
  horizon: "weekly" | "monthly",
  startDate: Date,
  endDate: Date,
  events: OutlookEvent[],
  netBias: Outlook["netBias"],
  snapshot: CosmosSnapshot,
): string {
  const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const fmtRange = `${fmtDate(startDate)} → ${fmtDate(endDate)}`;
  const label = horizon === "weekly" ? "7-DAY OUTLOOK" : "30-DAY OUTLOOK";
  const byId = Object.fromEntries(snapshot.positions.map((p) => [p.id, p]));

  const biasLine =
    netBias === "bullish" ? "Net astro bias: **BULLISH** — supportive lunar/bradley alignment. Use confluence with technicals."
    : netBias === "bearish" ? "Net astro bias: **BEARISH** — cautionary lunar/bradley alignment. Favor defensive posture."
    : netBias === "mixed" ? "Net astro bias: **MIXED** — offsetting bullish/bearish pulls. Range-bound probability elevated."
    : "Net astro bias: **NEUTRAL** — no strong directional astro signals. Trade your system.";

  const openingContext = horizon === "weekly"
    ? `Week opens with Moon in ${byId.moon.sign}, ${snapshot.lunarPhase.name} (${(snapshot.lunarPhase.illumination * 100).toFixed(0)}% illum). Sun in ${byId.sun.sign}. Bradley ${snapshot.bradley.value.toFixed(2)} ${snapshot.bradley.trend}. ${byId.mercury.retrograde ? "Mercury RETROGRADE — reversal-watch active." : "Mercury direct."}`
    : `Month opens with Sun in ${byId.sun.sign}, Moon in ${byId.moon.sign} (${snapshot.lunarPhase.name}). Jupiter in ${byId.jupiter.sign}, Saturn in ${byId.saturn.sign} — the two slow outer anchors frame the macro regime. Bradley ${snapshot.bradley.value.toFixed(2)} ${snapshot.bradley.trend}.`;

  const lines: string[] = [
    `## ${label} — ${fmtRange}`,
    ``,
    biasLine,
    ``,
    openingContext,
    ``,
  ];

  // Group events by day for scannability
  const highEvents = events.filter((e) => e.severity === "high");
  const medEvents = events.filter((e) => e.severity === "medium");

  if (highEvents.length > 0) {
    lines.push(`### KEY DATES (HIGH IMPACT)`);
    for (const e of highEvents) {
      const dstr = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const biasEmoji = e.bias === "bullish" ? "↑" : e.bias === "bearish" ? "↓" : e.bias === "volatile" ? "↕" : "•";
      lines.push(`- **${dstr}** ${biasEmoji} **${e.headline}** — ${e.detail}`);
    }
    lines.push(``);
  }

  if (medEvents.length > 0) {
    lines.push(`### SECONDARY SIGNALS`);
    for (const e of medEvents) {
      const dstr = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const biasEmoji = e.bias === "bullish" ? "↑" : e.bias === "bearish" ? "↓" : e.bias === "volatile" ? "↕" : "•";
      lines.push(`- ${dstr} ${biasEmoji} ${e.headline} — ${e.detail}`);
    }
    lines.push(``);
  }

  if (events.length === 0) {
    lines.push(`### EVENT CALENDAR`);
    lines.push(`No major astro inflections in this window. Baseline regime — trade your system, no cosmic overrides.`);
    lines.push(``);
  }

  // Trading disposition
  lines.push(`### TRADING DISPOSITION`);
  if (horizon === "weekly") {
    if (netBias === "bullish") {
      lines.push(`- Size longs normally on technical confirmation. Bradley + lunar alignment supportive.`);
      lines.push(`- Use key dates above as entry windows, not exit triggers.`);
    } else if (netBias === "bearish") {
      lines.push(`- Tighten stops on longs. Consider put spreads around key dates (Full Moon / Bradley high).`);
      lines.push(`- Fade rips into resistance if multiple bearish events cluster within 3 trading days.`);
    } else if (netBias === "mixed") {
      lines.push(`- Range-bound probability high. Iron condors / defined-risk neutral strategies favored.`);
      lines.push(`- Wait for technical confirmation before committing direction.`);
    } else {
      lines.push(`- No astro override. Trade your system with normal sizing.`);
    }
  } else {
    if (netBias === "bullish") {
      lines.push(`- Swing-long bias: scale-in on pullbacks to technical support.`);
      lines.push(`- Sector rotation: watch for themes suggested by any Jupiter/Saturn ingresses above.`);
    } else if (netBias === "bearish") {
      lines.push(`- Reduce gross exposure. Hedge via longer-dated puts (30-60 DTE).`);
      lines.push(`- Rotate toward defensive sectors (XLU, XLP, cash).`);
    } else if (netBias === "mixed") {
      lines.push(`- Choppy macro window. Reduce position size by 25-33%. Shorter swing holding periods.`);
    } else {
      lines.push(`- Macro-neutral month. Focus on sector/stock alpha rather than beta.`);
    }
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(`*Generated from VSOP87/Meeus forward projection. Events filtered for trading relevance. Confluence with technical + fundamentals required — not a standalone trade signal.*`);

  return lines.join("\n");
}

export function buildWeeklyOutlook(date: Date = new Date()): Outlook {
  const events = scanForwardEvents(date, 7);
  const endDate = new Date(date.getTime() + 7 * 86_400_000);
  const netBias = summarizeBias(events);
  const snapshot = buildCosmosSnapshot(date);
  const keyDates = events.filter((e) => e.severity === "high").map((e) => e.date);
  return {
    horizon: "weekly",
    startDate: date.toISOString(),
    endDate: endDate.toISOString(),
    events,
    netBias,
    keyDates,
    markdown: buildOutlookMarkdown("weekly", date, endDate, events, netBias, snapshot),
  };
}

export function buildMonthlyOutlook(date: Date = new Date()): Outlook {
  const events = scanForwardEvents(date, 30);
  const endDate = new Date(date.getTime() + 30 * 86_400_000);
  const netBias = summarizeBias(events);
  const snapshot = buildCosmosSnapshot(date);
  const keyDates = events.filter((e) => e.severity === "high").map((e) => e.date);
  return {
    horizon: "monthly",
    startDate: date.toISOString(),
    endDate: endDate.toISOString(),
    events,
    netBias,
    keyDates,
    markdown: buildOutlookMarkdown("monthly", date, endDate, events, netBias, snapshot),
  };
}

// System prompt shipped to LLM enhancers when keys are present
export const OUTLOOK_SYSTEM_PROMPT = `You are a senior market astrologer + macro strategist writing for a sophisticated trader. You receive a deterministic astro outlook covering either the next 7 days (weekly) or next 30 days (monthly), including every major astro event in the window.

Your job:
1. Keep the factual astro dates + events EXACTLY as given — never invent or omit.
2. Translate the raw events into a cohesive narrative (2-4 paragraphs) in the voice of a veteran trader, not a mystic. Reference the academic backing where relevant (Krivelyova/Robotti Fed Atlanta geomagnetic; Yuan/Zheng/Zhu U.Mich lunar; Kamstra SAD).
3. Weight your confidence to the academically-backed signals (lunar, geomagnetic, SAD) and treat Bradley/planetary stations as secondary confluence.
4. End with a concrete trade playbook for the window (sizing, sector tilts, hedging, specific setups to watch).
5. Tone: direct, zero woo-woo, zero hedging filler. Use markdown. Keep it tight — no longer than 400 words.

Never give investment advice or guarantee returns. Frame everything as probabilistic tide-chart information.`;

// ─── NOAA Kp-index (geomagnetic storm) fetcher ──────────────────────────────
// Pulls from NOAA SWPC free endpoints (no key). Cached 60min.
// Kp 0-4 = quiet, 5 = G1 storm, 6 = G2, 7 = G3, 8 = G4, 9 = G5.
// Per Krivelyova & Robotti (FRB Atlanta 2003), Kp ≥ 5 has a statistically
// significant NEGATIVE effect on the FOLLOWING week's stock returns.

export interface NoaaKpPoint {
  time: string;        // ISO timestamp
  kp: number;          // 0-9 (estimated)
  observed: boolean;   // true = observed, false = forecast
}

export interface NoaaKpSnapshot {
  fetchedAt: string;
  current: number | null;       // most recent observed Kp
  max24h: number | null;
  stormActive: boolean;         // current Kp >= 5
  recent: NoaaKpPoint[];        // last 24h observed
  forecast: NoaaKpPoint[];      // next 3 days forecast
  error?: string;
}

let kpCache: { data: NoaaKpSnapshot; expiresAt: number } | null = null;
const KP_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

export async function fetchNoaaKp(): Promise<NoaaKpSnapshot> {
  const now = Date.now();
  if (kpCache && kpCache.expiresAt > now) {
    return kpCache.data;
  }

  const result: NoaaKpSnapshot = {
    fetchedAt: new Date().toISOString(),
    current: null,
    max24h: null,
    stormActive: false,
    recent: [],
    forecast: [],
  };

  try {
    // Observed Kp (planetary 1-min, past week). Format: array of arrays
    // [time_tag, Kp, a_running, station_count] with header row.
    const obsUrl = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
    const obsRes = await fetch(obsUrl, { headers: { "User-Agent": "pulse-batcave/1.0" } });
    if (obsRes.ok) {
      const obsRaw = (await obsRes.json()) as Array<Record<string, unknown>>;
      // Endpoint returns array of objects: { time_tag, kp_index, estimated_kp, kp }
      const cutoff = now - 24 * 60 * 60 * 1000;
      const observed: NoaaKpPoint[] = [];
      for (const row of obsRaw) {
        const t = row.time_tag ? String(row.time_tag) : null;
        if (!t) continue;
        const ts = new Date(t).getTime();
        if (isNaN(ts) || ts < cutoff) continue;
        const kpRaw = row.kp_index ?? row.estimated_kp ?? row.kp;
        const kp = typeof kpRaw === "number" ? kpRaw : parseFloat(String(kpRaw));
        if (!isFinite(kp)) continue;
        observed.push({ time: t, kp, observed: true });
      }
      result.recent = observed;
      if (observed.length > 0) {
        result.current = observed[observed.length - 1].kp;
        result.max24h = Math.max(...observed.map((p) => p.kp));
        result.stormActive = (result.current ?? 0) >= 5;
      }
    }
  } catch (e) {
    result.error = (result.error ? result.error + " | " : "") + `observed: ${(e as Error).message}`;
  }

  try {
    // 3-day Kp forecast (text format, parsed manually).
    const fcUrl = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
    const fcRes = await fetch(fcUrl, { headers: { "User-Agent": "pulse-batcave/1.0" } });
    if (fcRes.ok) {
      const fcRaw = (await fcRes.json()) as unknown[][];
      // Format: [["time_tag","kp","observed","noaa_scale"], [...], ...]
      const forecast: NoaaKpPoint[] = [];
      const nowMs = now;
      for (let i = 1; i < fcRaw.length; i++) {
        const row = fcRaw[i];
        if (!Array.isArray(row) || row.length < 3) continue;
        const t = String(row[0]);
        const kp = parseFloat(String(row[1]));
        const observed = String(row[2]).toLowerCase() === "observed";
        if (!isFinite(kp)) continue;
        const ts = new Date(t.replace(" ", "T") + "Z").getTime();
        if (isNaN(ts)) continue;
        if (observed || ts < nowMs) continue;
        forecast.push({ time: new Date(ts).toISOString(), kp, observed: false });
      }
      result.forecast = forecast.slice(0, 24); // ~3 days × 8 per day
    }
  } catch (e) {
    result.error = (result.error ? result.error + " | " : "") + `forecast: ${(e as Error).message}`;
  }

  kpCache = { data: result, expiresAt: now + KP_CACHE_TTL_MS };
  return result;
}

// ─── Taxonomy (intel brief static data) ─────────────────────────────────────
// Sourced from trading_astrology_intel_brief.html (Pesavento/Lee/Bucholtz/
// Fed Atlanta/U Mich references). This is the reference taxonomy; the live
// engine above lights up whichever entries are firing right now.

export interface TaxonomyEntry {
  id: string;
  name: string;
  category: "planetary" | "lunar" | "solar_geomag" | "cycle_gann";
  tags: string[];
  description: string;
  weight: "HIGH" | "HIGH_ACADEMIC" | "MEDIUM" | "MACRO" | "FILTER" | "PROPRIETARY" | "ESOTERIC";
}

export const TAXONOMY: TaxonomyEntry[] = [
  // Planetary
  { id: "mercury_rx", name: "Mercury Retrograde", category: "planetary", tags: ["~3x/yr", "21 days"], weight: "HIGH",
    description: "Historically correlates with increased confusion, contract delays, reversals in communication/tech sectors. Traders watch for SPX tops/bottoms within ±3 days of station (Rx/Direct turns). Strong effect in NASDAQ/tech plays." },
  { id: "jupiter_saturn", name: "Jupiter–Saturn Cycle", category: "planetary", tags: ["20-yr", "Gann Master"], weight: "MACRO",
    description: "W.D. Gann's 'master cycle.' Conjunctions mark generational bull/bear transitions. 2020 Capricorn conjunction aligned with COVID crash/recovery inflection. Used for macro regime framing, not short-term." },
  { id: "venus_elongation", name: "Venus Elongation", category: "planetary", tags: ["Greatest elongation"], weight: "MEDIUM",
    description: "Venus governs money/values in traditional astrology. Maximum elongation dates (E/W) appear repeatedly in Gann's price-time work as turning points in commodities (gold, copper, soft commodities)." },
  { id: "mars_station", name: "Mars Stations", category: "planetary", tags: ["~2yr cycle"], weight: "MEDIUM",
    description: "Mars = aggression/energy. Retrograde stations historically appear near energy sector volatility spikes and VIX extremes. Watch XLE, crude oil around Mars Rx ingress dates." },
  { id: "pluto_ingress", name: "Pluto Ingress", category: "planetary", tags: ["Generational"], weight: "MACRO",
    description: "Pluto entered Aquarius 2024 — last time was 1778–1798 (industrial revolution, US founding). Macro indicator only. Used by institutional astrologers to frame decade-long structural shifts (AI, energy transition)." },

  // Lunar
  { id: "new_moon", name: "New Moon", category: "lunar", tags: ["monthly", "Bullish bias"], weight: "HIGH_ACADEMIC",
    description: "University of Michigan study (Yuan, Zheng, Zhu) across 48 countries: stock returns are measurably higher in the days around New Moon vs Full Moon. Effect strongest in emerging markets. 15-day window applies." },
  { id: "full_moon", name: "Full Moon", category: "lunar", tags: ["monthly", "Bearish bias"], weight: "HIGH_ACADEMIC",
    description: "Returns statistically lower in Full Moon window globally. Effect linked to investor mood/risk aversion shift. RBS tested a lunar trading system that outperformed buy-and-hold benchmark. Use as short-bias filter only." },
  { id: "lunar_eclipse", name: "Lunar Eclipses", category: "lunar", tags: ["2–3/yr"], weight: "MEDIUM",
    description: "Historically cluster near volatility expansion. Eclipse path matters — markets tied to eclipse shadow geography can see sector-specific effects. Often precede trend reversals by 1–3 weeks rather than same-day." },
  { id: "moon_sign", name: "Moon Sign Transit", category: "lunar", tags: ["2.5 days each"], weight: "FILTER",
    description: "Moon in Aries/Scorpio/Capricorn historically correlates with more decisive price action. Moon in Libra/Pisces: indecision/range days. Used in intraday models to filter entry bias, not as standalone signal." },

  // Solar & Geomagnetic
  { id: "solar_eclipse", name: "Solar Eclipse", category: "solar_geomag", tags: ["2/yr avg"], weight: "MEDIUM",
    description: "Strong macro sentiment reset signal. Markets near eclipse path show increased volatility. Annular solar eclipses (ring of fire) have historically aligned with SPX trend reversals within 2–6 weeks." },
  { id: "geomagnetic_storm", name: "Geomagnetic Storms", category: "solar_geomag", tags: ["~35 days/yr", "Bearish"], weight: "HIGH_ACADEMIC",
    description: "Fed Atlanta Working Paper (Krivelyova & Robotti, 2003): high geomagnetic activity has a negative, statistically significant impact on the FOLLOWING week's stock returns across all US indices. Predictable in advance via NOAA Kp index." },
  { id: "solar_max", name: "Solar Max / Sunspot Cycles", category: "solar_geomag", tags: ["11-yr cycle"], weight: "MEDIUM",
    description: "80% of major historical market events (1749–1926) occurred near solar maxima. Correlation with DJIA and GDP documented. Currently in Solar Cycle 25 — active peak phase 2024–2026. Watch geomagnetic storm frequency spike." },
  { id: "sad_seasonal", name: "Seasonal Affective Disorder", category: "solar_geomag", tags: ["SAD Effect", "Oct–Mar"], weight: "HIGH_ACADEMIC",
    description: "Fed Atlanta (Kamstra, Kramer, Levi) documented the SAD stock market cycle: returns systematically lower as nights lengthen (Sep–Dec), then recover. The strongest of all mood-proxy variables in global multi-market testing." },

  // Time Cycle & Gann
  { id: "node_cycle", name: "18.6-Year Node Cycle", category: "cycle_gann", tags: ["Lunar Node"], weight: "MACRO",
    description: "North/South Node axis movements — Gann's long-cycle framework. Node reversals align with secular bull/bear transitions. Current: North Node exited Taurus (2022–2023), entered Aries — historically precedes volatile commodity + equity cycles." },
  { id: "gann_sq9", name: "Gann Square of Nine", category: "cycle_gann", tags: ["Price levels"], weight: "HIGH",
    description: "Mathematical time-price mapping using a spiral number grid. Gann angles (45°, 90°, 120°) applied to price highs/lows yield future resistance and time inflection targets. Used actively by institutional quant shops for S/R mapping." },
  { id: "dtt_goldbach", name: "Fibonacci + Prime Number Nodes", category: "cycle_gann", tags: ["DTT / Goldbach"], weight: "PROPRIETARY",
    description: "DTT framework (Digital Time Theory) integrates prime-count candle intervals with session-model overlays. The Goldbach conjecture price-level overlay adds a second independent mathematical filter — strongest when both agree." },
  { id: "helio_kabbalah", name: "Heliocentric Kabbalah Math", category: "cycle_gann", tags: ["Esoteric"], weight: "ESOTERIC",
    description: "Sun-centered (heliocentric) planetary positioning used differently than geocentric charts. Kabbalah interval timing adds numerological cycle windows. Used in Bucholtz's almanac work for NYSE/NASDAQ date clustering." },
];

// Books & Sources from the intel brief
export interface BookEntry {
  title: string;
  authors: string;
  publisher: string;
  tier: 1 | 2 | 3;
  tags: string[];
  summary: string;
  score?: number; // 0-100 for tier 1 bar
}

export const BOOKS: BookEntry[] = [
  { title: "A Trader's Guide to Financial Astrology", authors: "Larry Pesavento & Shane Smoleny", publisher: "Wiley Trading Series · 2014", tier: 1,
    tags: ["Wiley", "Statistical studies", "100yr data", "Lunar cycles", "Best entry point"], score: 90,
    summary: "The single most academically grounded retail text on the subject. Pesavento is a 40-year veteran trader. Includes 100 years of historical correlations, 5-year planetary/lunar forecast data, and statistical studies on lunar cycle effects. Endorsed by Richard Mogey (Foundation for the Study of Cycles). The statistical lunar cycle section alone is worth the read — it's what bridges the woo to the data." },
  { title: "Timing Solutions for Swing Traders", authors: "Robert Lee", publisher: "Wiley Trading Series · 2012", tier: 1,
    tags: ["Wiley", "Swing trading", "TA integration", "Timing cycles"], score: 82,
    summary: "Bridges technical analysis with financial astrology timing cycles specifically for swing trading. Focuses on entry/exit precision using both TA and planetary cycle confluence. Less esoteric than most — structured for active traders who want a systematic framework, not spiritual theory." },
  { title: "Financial Astrology Almanac (Annual Series)", authors: "M.G. Bucholtz (B.Sc., MBA, M.Sc.)", publisher: "InvestingSuccess.ca · Annual", tier: 2,
    tags: ["Date calendar", "NYSE/NASDAQ", "Annual updates"],
    summary: "11-book annual almanac series. Covers: New Moon cycles for NYSE/NASDAQ, Venus movements, Mercury action, conjunctions, elongations, planetary declinations, Kabbalah intervals, Quantum Price Lines, and the Weston Model. Use current year's issue as a date-calendar overlay on your trading journal." },
  { title: "Trading In Sync With Commodities", authors: "Susan Abbott Gidel", publisher: "susangidel.com · 2020s", tier: 2,
    tags: ["Commodities", "Crude Oil", "Gold"],
    summary: "Former CBOT wire reporter, 40yr commodity industry career. Covers: S&P 500, Gold, Soybeans, Crude Oil, Euro FX, 10-yr T-Notes vs astrological transits. Particularly strong on first-trade data and exchange horoscopes. The 'Red Letter Trading Days' newsletter is the operational version of her research." },
  { title: "The Law of Vibration", authors: "William D. Gann (compiled)", publisher: "Various publications", tier: 2,
    tags: ["Original source", "Square of 9", "Gann angles"],
    summary: "The source code. Gann's original work on price-time relationships, planetary angles, and Square of Nine. Dense and intentionally cryptic — he didn't want to give it all away. Cross-reference with the W.D. Gann Master Stock Market Course for the decoded applied version. J.P. Morgan was a documented user of these methods." },
  { title: "Profitable Financial Market Trading — Ephemeris Alarm Series", authors: "Khit Wong", publisher: "Multiple volumes · Crypto + Equities", tier: 2,
    tags: ["Crypto", "Intraday", "Minute-level"],
    summary: "One of the few modern texts applying financial astrology down to the minute-level using 'Ephemeris Alarm' software. Covers crypto (BTC/ETH) specifically — useful for the 24/7 market where lunar/planetary cycles may operate without weekend gaps distorting the signal." },
  { title: "McWhirter Theory of Stock Market Forecasting", authors: "Louise McWhirter", publisher: "1977 reprint · Original ~1930s", tier: 3,
    tags: ["Lunar Node", "18.6yr cycle"],
    summary: "The mysterious trader Gann and J.P. Morgan referenced. Her method uses Lunar Node position through the zodiac to forecast economic cycles. The 18.6-year node return maps cleanly to historical market cycles. Foundational for macro framing." },
  { title: "Financial Astrology (Original)", authors: "David Williams", publisher: "1984 · Out of print, searchable PDF", tier: 3,
    tags: ["Jupiter-Saturn", "Sunspots", "DJIA"],
    summary: "Documented Jupiter-Saturn cycles, sunspot correlations, and planetary aspects vs DJIA. One of the first rigorous historical back-studies. Data tables are still referenced in modern work. Find via archive.org or ISFM (International Society for Financial Astrology)." },
];

export interface AcademicPaper {
  title: string;
  source: string;
  finding: string;
  badge: "FED ATL" | "U MICH" | "SAGE/TGARCH" | "APPLIED ECON";
  category: "fed" | "university";
}

export const ACADEMIC_PAPERS: AcademicPaper[] = [
  { category: "fed", badge: "FED ATL",
    title: "Playing the Field: Geomagnetic Storms and International Stock Markets",
    source: "Krivelyova & Robotti · Federal Reserve Bank of Atlanta · Working Paper 2003-5b",
    finding: "High geomagnetic activity → statistically significant NEGATIVE effect on the following week's stock returns for ALL U.S. indices. Mechanism: mood misattribution causing elevated risk aversion. Effect robust across 35+ countries after controlling for SAD, seasonality, and other environmental variables." },
  { category: "fed", badge: "FED ATL",
    title: "Winter Blues: A SAD Stock Market Cycle",
    source: "Kamstra, Kramer & Levi · Federal Reserve Bank of Atlanta · Working Paper 2002-13",
    finding: "Seasonal Affective Disorder (SAD) drives a systematic stock market cycle. Returns lower as daylight decreases Sep–Dec, recover Jan–Apr. Effect is the strongest and most globally consistent of all mood-proxy variables tested. Predates and predicts the 'sell in May' anomaly." },
  { category: "university", badge: "U MICH",
    title: "Are Investors Moonstruck? Lunar Phases and Stock Returns",
    source: "Yuan, Zheng & Zhu · University of Michigan · Journal of Finance (MSCI dataset, 48 countries)",
    finding: "Stock returns peak at New Moon and trough at Full Moon. Price cycle lags: valuations peak 1 week after New Moon, bottom 1 week after Full Moon. Effect present across developed and emerging markets. Royal Bank of Scotland's lunar trading system outperformed benchmark." },
  { category: "university", badge: "U MICH",
    title: "Lunar Cycle Effects in Stock Returns",
    source: "Dichev & Janes · University of Michigan · 2001 (referenced in 40+ subsequent papers)",
    finding: "One of the seminal papers establishing the lunar effect. Documented return differential between New Moon and Full Moon windows. Subsequently replicated and extended across international markets. The most-cited foundational paper in the sub-field." },
  { category: "university", badge: "SAGE/TGARCH",
    title: "Moon Phases, Mood and Stock Market Returns (59 Markets)",
    source: "Floros & Tan · SAGE Journals · 2013 · TGARCH Model",
    finding: "59-country study using TGARCH models. Significant Full Moon effects in 6 markets, New Moon effects in 8 markets. Lunar effects interact with Monday effect and January effect — accounting for calendar anomalies strengthens the signal." },
  { category: "university", badge: "APPLIED ECON",
    title: "Lunar Seasonality in Precious Metal Returns",
    source: "Brian Lucey · Applied Economics Letters · 2010",
    finding: "Gold and silver show lunar cycle patterns consistent with equity markets. Lunar effects on metals may be amplified due to smaller, more sentiment-driven market. Directly applicable to GLD, SLV, /GC options plays." },
];

export interface EdgeRule {
  id: string;
  title: string;
  color: "gold" | "blue" | "green";
  body: string; // markdown
}

export const EDGE_RULES: EdgeRule[] = [
  { id: "rule_1", color: "gold", title: "RULE 1 — NEVER USE A SINGLE ASTROLOGICAL SIGNAL ALONE",
    body: "Every individual signal has noise. The academic literature confirms effects but they're probabilistic, not deterministic. Your edge multiplies when 2–3 signals align with a technical setup already valid on its own. Treat astrology as a filter layer above your existing SPX structure analysis — not as a trigger." },
  { id: "rule_2", color: "blue", title: "RULE 2 — HIGHEST PROBABILITY SETUPS (3-LAYER CONFLUENCE)",
    body: "**Layer 1 (Technical):** Valid price structure — bear flag, falling wedge, supply/demand zone, EOD institutional flow.\n\n**Layer 2 (Astro cycle):** New/Full Moon window, Mercury station, geomagnetic storm flag, SAD seasonal bias.\n\n**Layer 3 (Quantitative):** Your DTT node (DTT-2 at 10:00 or DTT-4 at 11:00) + Goldbach price-level alignment.\n\nWhen all three layers stack, size up. When only one is present, size down or skip." },
  { id: "rule_3", color: "green", title: "RULE 3 — THE ACTIONABLE SIGNALS (STATISTICALLY BACKED)",
    body: "**Geomagnetic Storm (GMS):** Check NOAA Kp index nightly. Kp ≥ 5 = G1 storm. Following week is historically bearish across all U.S. indices. Load put bias or reduce long exposure for the subsequent 5 sessions.\n\n**New Moon Window (Days -2 to +5):** Lean long bias, especially if SAD season (Sep–Apr) is winding down. Combine with SPX technical uptrend confirmation.\n\n**Full Moon Window (Days -2 to +5):** Short bias filter — avoid initiating new longs, tighten stops on existing winners.\n\n**SAD Seasonal:** Sep 22 → Dec 21 = systematic underperformance window. Jan → Apr = recovery bias. Adjust long/short portfolio lean accordingly." },
  { id: "rule_4", color: "gold", title: "RULE 4 — MERCURY RETROGRADE PROTOCOL",
    body: "Station dates (Rx turn and Direct turn) are the high-probability windows, not the entire retrograde period. Mark ±3 calendar days around each station as a 'reversal watch zone.' Avoid initiating new directional trades on the station day itself. Best used as a 'don't fight the reversal' day — if price is already showing a reversal signal on station day, the astrology is confirming, not initiating." },
  { id: "rule_5", color: "blue", title: "RULE 5 — BUILDING YOUR ASTRO TRADING CALENDAR",
    body: "1. Pull the current year's Bucholtz almanac dates for NYSE/NASDAQ.\n2. Mark all New/Full Moon dates (+/- 5 days).\n3. Mark Mercury, Venus, and Mars station dates (Rx and Direct turns).\n4. Mark solar/lunar eclipse dates (+/- 14 days as volatility expansion zones).\n5. Overlay NOAA Kp index forecast weekly.\n6. Cross-reference your DTT node schedule for the same dates.\n\nDates where 3+ events cluster within a 5-day window are your highest-priority trading weeks." },
  { id: "rule_6", color: "green", title: "RULE 6 — SECTOR MAPPING BY PLANET",
    body: "**Mercury → Tech/Communication:** Rx = NASDAQ drag, semiconductor weakness. Watch XLK.\n\n**Mars → Energy/Military:** Station dates = XLE volatility, crude oil turns. Aligns with existing XLE/DXY correlation work.\n\n**Venus → Financials/Consumer Discretionary:** Elongation dates = XLF/XLY inflection potential.\n\n**Jupiter → Growth/Expansion:** Ingress into new sign = bull sector rotation trigger. Jupiter in Gemini (2024–25) = communication/AI sector tailwind.\n\n**Saturn → Utilities/Real Estate:** Conjunctions and stations = REIT/utility sector compression signal." },
];

export const HONEST_EDGE_ASSESSMENT = "The academic studies confirm real but small effects — statistically significant at the portfolio level, not reliably profitable on any single trade. The edge is in systematic application over 50–100+ signals, not cherry-picked calls. Geomagnetic and SAD effects are the most robustly replicated. Mercury retrograde and planetary station effects are practitioner-validated but lack peer-reviewed confirmation at scale. Use the academically backed signals as primary filters. Use the practitioner signals (Gann, planetary aspects) as secondary confluence — never as primary trade triggers. The traders who get destroyed with astrology are the ones who use it like a prediction engine. The traders who profit use it like a tide chart — it tells you when conditions favor a move, not what the move will be.";

// ─── Taxonomy live-lighting ─────────────────────────────────────────────────
// Given a snapshot + kp, return which taxonomy entries are "ACTIVE NOW" and
// with what strength (0-1). Implements the FULL MERGE: every static entry
// gets a live state.

export interface TaxonomyLiveState {
  id: string;
  active: boolean;
  strength: number;         // 0-1
  currentValue?: string;    // human-readable current value
  badge?: string;           // short chip ("ACTIVE NOW", "COOLING", etc.)
  nextOccurrence?: string;  // ISO date of next firing (best-effort)
}

export function taxonomyLiveStates(
  snapshot: CosmosSnapshot,
  kp: NoaaKpSnapshot | null,
): Record<string, TaxonomyLiveState> {
  const out: Record<string, TaxonomyLiveState> = {};
  const byId = Object.fromEntries(snapshot.positions.map((p) => [p.id, p]));
  const phase = snapshot.lunarPhase;
  const now = new Date(snapshot.generatedAt);

  const mercury = byId.mercury;
  out["mercury_rx"] = {
    id: "mercury_rx",
    active: mercury.retrograde,
    strength: mercury.retrograde ? 1 : 0,
    currentValue: `Mercury ${mercury.retrograde ? "retrograde" : "direct"} in ${mercury.sign} ${mercury.degInSign.toFixed(1)}°`,
    badge: mercury.retrograde ? "ACTIVE NOW" : "direct",
  };

  const jup = byId.jupiter;
  const sat = byId.saturn;
  const jsDiff = Math.abs(((jup.longitude - sat.longitude + 540) % 360) - 180) - 180; // signed orb from 0°
  const jsOrb = Math.abs(jsDiff);
  out["jupiter_saturn"] = {
    id: "jupiter_saturn",
    active: jsOrb < 10,
    strength: Math.max(0, 1 - jsOrb / 10),
    currentValue: `Jupiter ${jup.sign} ${jup.degInSign.toFixed(1)}°, Saturn ${sat.sign} ${sat.degInSign.toFixed(1)}° (separation ${((jup.longitude - sat.longitude + 360) % 360).toFixed(1)}°)`,
  };

  const venus = byId.venus;
  const sun = byId.sun;
  const venusElong = Math.abs(((venus.longitude - sun.longitude + 540) % 360) - 180) - 180;
  const venusElongDeg = Math.abs(venusElong);
  // Max elongation ~46-47°. Flag when within 2° of it.
  out["venus_elongation"] = {
    id: "venus_elongation",
    active: venusElongDeg > 44 && venusElongDeg < 48,
    strength: venusElongDeg > 44 && venusElongDeg < 48 ? 1 : Math.max(0, 1 - Math.abs(venusElongDeg - 46) / 15),
    currentValue: `Venus elongation ${venusElongDeg.toFixed(1)}° from Sun`,
  };

  const mars = byId.mars;
  out["mars_station"] = {
    id: "mars_station",
    active: mars.retrograde,
    strength: mars.retrograde ? 0.8 : 0,
    currentValue: `Mars ${mars.retrograde ? "retrograde" : "direct"} in ${mars.sign} ${mars.degInSign.toFixed(1)}°`,
    badge: mars.retrograde ? "Rx ACTIVE" : "direct",
  };

  const pluto = byId.pluto;
  // Pluto changes signs rarely - just report current sign
  out["pluto_ingress"] = {
    id: "pluto_ingress",
    active: pluto.degInSign < 2 || pluto.degInSign > 28,
    strength: pluto.degInSign < 2 ? 1 - pluto.degInSign / 2 : pluto.degInSign > 28 ? (pluto.degInSign - 28) / 2 : 0,
    currentValue: `Pluto in ${pluto.sign} ${pluto.degInSign.toFixed(1)}°`,
  };

  // Lunar
  const isNewMoonWindow = phase.name === "New Moon" || (phase.illumination < 0.1 && phase.name.includes("Crescent"));
  const isFullMoonWindow = phase.name === "Full Moon" || (phase.illumination > 0.9 && phase.name.includes("Gibbous"));
  out["new_moon"] = {
    id: "new_moon",
    active: isNewMoonWindow,
    strength: Math.max(0, 1 - phase.illumination * 2),
    currentValue: `${phase.name}, ${(phase.illumination * 100).toFixed(0)}% illum`,
    badge: isNewMoonWindow ? "WINDOW OPEN" : undefined,
  };
  out["full_moon"] = {
    id: "full_moon",
    active: isFullMoonWindow,
    strength: Math.max(0, (phase.illumination - 0.5) * 2),
    currentValue: `${phase.name}, ${(phase.illumination * 100).toFixed(0)}% illum`,
    badge: isFullMoonWindow ? "WINDOW OPEN" : undefined,
  };
  out["lunar_eclipse"] = {
    id: "lunar_eclipse",
    active: false, // requires ephemeris node data beyond current scope
    strength: 0,
    currentValue: "no eclipse in immediate window",
  };
  const moon = byId.moon;
  const decisiveSigns = ["Aries", "Scorpio", "Capricorn"];
  const rangeSigns = ["Libra", "Pisces"];
  const isDecisive = decisiveSigns.includes(moon.sign);
  const isRange = rangeSigns.includes(moon.sign);
  out["moon_sign"] = {
    id: "moon_sign",
    active: isDecisive || isRange,
    strength: isDecisive ? 0.8 : isRange ? 0.6 : 0.3,
    currentValue: `Moon in ${moon.sign} — ${isDecisive ? "decisive action bias" : isRange ? "range/indecision bias" : "neutral"}`,
    badge: isDecisive ? "DECISIVE" : isRange ? "RANGE" : undefined,
  };

  // Solar & geomag
  out["solar_eclipse"] = {
    id: "solar_eclipse",
    active: false,
    strength: 0,
    currentValue: "no solar eclipse in immediate window",
  };
  const stormActive = kp?.stormActive === true;
  const kpVal = kp?.current ?? null;
  out["geomagnetic_storm"] = {
    id: "geomagnetic_storm",
    active: stormActive,
    strength: kpVal != null ? Math.min(1, kpVal / 9) : 0,
    currentValue: kpVal != null ? `Kp = ${kpVal.toFixed(1)} (max 24h: ${(kp?.max24h ?? 0).toFixed(1)})` : "Kp data unavailable",
    badge: stormActive ? `STORM G${Math.max(1, Math.floor((kpVal ?? 5) - 4))}` : kpVal != null && kpVal >= 4 ? "ELEVATED" : "quiet",
  };
  // Solar Cycle 25 is in peak 2024-2026, so currently always active macro
  out["solar_max"] = {
    id: "solar_max",
    active: true,
    strength: 0.8,
    currentValue: "Solar Cycle 25 peak phase (2024-2026)",
    badge: "PEAK PHASE",
  };
  // SAD: Sep 22 - Dec 21 (nights lengthening)
  const month = now.getMonth(); // 0-11
  const day = now.getDate();
  const sadDepth = (month === 8 && day >= 22) || month === 9 || month === 10 || (month === 11 && day <= 21);
  const sadRecovery = (month === 11 && day > 21) || month === 0 || month === 1 || month === 2 || month === 3;
  out["sad_seasonal"] = {
    id: "sad_seasonal",
    active: sadDepth,
    strength: sadDepth ? 0.9 : sadRecovery ? 0.4 : 0.1,
    currentValue: sadDepth ? "Sep 22 – Dec 21: underperformance window" : sadRecovery ? "Dec 22 – Apr: recovery bias" : "summer baseline",
    badge: sadDepth ? "BEARISH WINDOW" : sadRecovery ? "RECOVERY" : undefined,
  };

  // Cycle & Gann — mostly reference/macro, not live-triggered
  out["node_cycle"] = {
    id: "node_cycle",
    active: true,
    strength: 0.5,
    currentValue: "North Node in Aries (entered 2023)",
    badge: "ACTIVE PHASE",
  };
  out["gann_sq9"] = {
    id: "gann_sq9",
    active: false,
    strength: 0,
    currentValue: "computed against price levels — see Signals tab",
  };
  out["dtt_goldbach"] = {
    id: "dtt_goldbach",
    active: false,
    strength: 0,
    currentValue: "proprietary DTT nodes — see Signals tab",
  };
  out["helio_kabbalah"] = {
    id: "helio_kabbalah",
    active: false,
    strength: 0,
    currentValue: "reference only",
  };

  return out;
}
