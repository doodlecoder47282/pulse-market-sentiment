// ─────────────────────────────────────────────────────────────────────────────
// server/cosmos.ts
//
// Astronomy engine + financial-astrology reference for the "Cosmos" tab.
//
// CONTEXT ONLY, FOR ENTERTAINMENT, NOT A TRADING SIGNAL (review finding 5.3).
// Nothing in this file outputs a trade instruction, direction call, position
// size or alert. Each sky event carries an `evidence` label; only lunar,
// geomagnetic and SAD effects have published studies, and those effects are
// small or disputed. No other engine may consume Cosmos output as a signal
// (only routes.ts imports this file, for the Cosmos tab's own endpoints).
//
// DESIGN PRINCIPLE: everything here is deterministic. Given a UTC timestamp
// it produces the same planetary positions, aspects, lunar phase, signs,
// retrogrades, natal transits, and evidence-labeled sky events. No external
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

// ─── Mean lunar node ────────────────────────────────────────────────────────
// Longitude of the Moon's mean ascending node, Meeus "Astronomical Algorithms"
// 2nd ed. eq. 47.7: Omega = 125.0445479 - 1934.1362891 T + 0.0020754 T^2
// + T^3/467441 - T^4/60616000 (degrees, T in Julian centuries from J2000).
// It moves backward about 19.3° a year (18.6-year cycle).
export function meanLunarNodeLongitude(date: Date): number {
  const T = jcFromJd(julianDay(date));
  return norm360(
    125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + (T * T * T) / 467441 - (T * T * T * T) / 60616000,
  );
}

// ─── Void-of-course Moon ─────────────────────────────────────────────────────
// The Moon is "void of course" between its last major aspect to another planet
// in the current sign and its entry into the next sign (astrological
// tradition; no peer-reviewed market effect).
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
// a single daily number. Financial astrologers read its peaks and troughs as
// market turn dates (and concede frequent inversions). No peer-reviewed
// support; computed here as sky context only.
//
// Formula (Bradley's original weighting, simplified):
//   LT = sum of long-term aspect scores (Uranus, Neptune, Pluto vs Jupiter, Saturn)
//   MT = sum of middle-term aspect scores (Jupiter, Saturn vs Mars)
//   ST = sum of short-term from declinations
//   total = LT + MT + ST
//
// We implement a credible approximation: weighted aspect score across all
// outer-planet pairs, normalized to a -1..1 range. For research-grade use a
// trader would feed this into their own system; here it is context only.
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
  score: number; // net aspect score (soft minus hard aspects); astrological tradition, no market meaning
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

// ─── Sky events (deterministic, rule-based) ─────────────────────────────────
// Each event is a fact about the sky plus what the literature says about it.
// No event carries a trade instruction, direction call, size or alert
// (review finding 5.3). The interface keeps its historical name and fields so
// the API shape does not change; `severity` is always "info" and `evidence`
// says whether any peer-reviewed study supports a market effect.

/** What the literature supports for a sky event's claimed market effect. */
export type CosmosEvidence =
  | "peer-reviewed, small effect"
  | "peer-reviewed, disputed"
  | "working paper, small effect"
  | "no peer-reviewed support";

export interface FinancialSignal {
  id: string;
  /** Always "info": a sky event is context, never an alert level. */
  severity: "high" | "medium" | "info";
  headline: string;
  detail: string;
  /** Topic tags only (e.g. "lunar", "tradition"). Never an action. */
  impacts: string[];
  evidence: CosmosEvidence;
}

// Shared one-line citations (verified 2026-10-08):
//  - Yuan, Zheng & Zhu (2006), "Are investors moonstruck? Lunar phases and
//    stock returns", Journal of Empirical Finance 13(1). 48 countries; returns
//    around full moons lower than around new moons by about 3-5% a year.
//    https://researchonline.lse.ac.uk/id/eprint/39409
//  - Krivelyova & Robotti (2003), "Playing the field: Geomagnetic storms and
//    international stock markets", FRB Atlanta Working Paper 2003-5.
//    https://ideas.repec.org/p/fip/fedawp/2003-5.html
//  - Kamstra, Kramer & Levi (2003), "Winter Blues: A SAD Stock Market Cycle",
//    American Economic Review 93(1). Disputed by Kelly & Meschke (2010),
//    "Sentiment and stock returns: The SAD anomaly revisited", J. Banking &
//    Finance 34(6): https://ideas.repec.org/a/eee/jbfina/v34y2010i6p1308-1326.html
export const LUNAR_EVIDENCE_NOTE =
  "Yuan, Zheng & Zhu (2006, Journal of Empirical Finance, 48 countries): returns around full moons were lower than around new moons by about 3-5% a year in aggregate, roughly 1-2 basis points a day, against typical daily index moves near 100 basis points. Historical, small, not tested out of sample here.";
const NO_SUPPORT = "Financial-astrology tradition only; no peer-reviewed study supports a market effect.";

export const COSMOS_DISCLAIMER =
  "Cosmos is sky context for entertainment, not a trading signal. Nothing here is a trade instruction, direction call, position size or alert, and no other Batcave engine reads it.";

export function financialSignals(positions: PlanetPosition[], asps: Aspect[], phase: LunarPhase, voc: VoidOfCourse, bradley: ReturnType<typeof bradleySiderograph>): FinancialSignal[] {
  const signals: FinancialSignal[] = [];
  const byId = Object.fromEntries(positions.map((p) => [p.id, p]));

  if (byId.mercury.retrograde) {
    signals.push({
      id: "mercury-retro",
      severity: "info",
      headline: `Mercury retrograde in ${byId.mercury.sign}`,
      detail:
        `Seen from Earth, Mercury appears to move backward for about three weeks, about three times a year. ` +
        `Tradition links it to miscommunication and reversals in tech. ${NO_SUPPORT}`,
      impacts: ["planetary", "tradition"],
      evidence: "no peer-reviewed support",
    });
  }

  if (byId.mars.retrograde) {
    signals.push({
      id: "mars-retro",
      severity: "info",
      headline: `Mars retrograde in ${byId.mars.sign}`,
      detail: `Tradition associates Mars retrograde with fading momentum. ${NO_SUPPORT}`,
      impacts: ["planetary", "tradition"],
      evidence: "no peer-reviewed support",
    });
  }

  if (byId.venus.retrograde) {
    signals.push({
      id: "venus-retro",
      severity: "info",
      headline: `Venus retrograde in ${byId.venus.sign}`,
      detail: `Tradition associates Venus retrograde with consumer spending and deal delays. ${NO_SUPPORT}`,
      impacts: ["planetary", "tradition"],
      evidence: "no peer-reviewed support",
    });
  }

  if (phase.name === "Full Moon" || phase.name === "New Moon") {
    signals.push({
      id: phase.name === "Full Moon" ? "full-moon" : "new-moon",
      severity: "info",
      headline: `${phase.name} (${phase.illumination.toFixed(2)} illumination)`,
      detail: LUNAR_EVIDENCE_NOTE,
      impacts: ["lunar"],
      evidence: "peer-reviewed, small effect",
    });
  }

  if (voc.active) {
    signals.push({
      id: "voc-moon",
      severity: "info",
      headline: `Moon void-of-course until ${voc.nextSignAt ? new Date(voc.nextSignAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }) : "sign change"}`,
      detail: `Traditional astrology calls the time before the Moon's next sign change "void of course". ${NO_SUPPORT}`,
      impacts: ["lunar", "tradition"],
      evidence: "no peer-reviewed support",
    });
  }

  for (const a of asps) {
    if (
      (a.a === "jupiter" && a.b === "saturn") ||
      (a.a === "saturn" && a.b === "jupiter")
    ) {
      signals.push({
        id: "jup-sat",
        severity: "info",
        headline: `Jupiter ${a.aspect} Saturn (orb ${a.orb.toFixed(1)}°, ${a.applying ? "applying" : "separating"})`,
        detail: `Gann-tradition long cycle (about 20 years between conjunctions), so there are too few events to test. ${NO_SUPPORT}`,
        impacts: ["planetary", "tradition"],
        evidence: "no peer-reviewed support",
      });
    }
  }

  for (const a of asps) {
    if ((a.a === "uranus" || a.b === "uranus") && a.quality === "hard" && a.score > 0.5) {
      signals.push({
        id: `uranus-${a.a}-${a.b}-${a.aspect}`,
        severity: "info",
        headline: `Uranus ${a.aspect} ${a.a === "uranus" ? a.b : a.a} (tight)`,
        detail: `Tradition associates hard Uranus aspects with surprises. ${NO_SUPPORT}`,
        impacts: ["planetary", "tradition"],
        evidence: "no peer-reviewed support",
      });
      break;
    }
  }

  for (const a of asps) {
    if ((a.a === "pluto" || a.b === "pluto") && a.score > 0.5) {
      signals.push({
        id: `pluto-${a.a}-${a.b}-${a.aspect}`,
        severity: "info",
        headline: `Pluto ${a.aspect} ${a.a === "pluto" ? a.b : a.a}`,
        detail: `Tradition associates Pluto with debt and power shifts. ${NO_SUPPORT}`,
        impacts: ["planetary", "tradition"],
        evidence: "no peer-reviewed support",
      });
      break;
    }
  }

  if (bradley.zone !== "neutral") {
    signals.push({
      id: "bradley",
      severity: "info",
      headline: `Bradley siderograph ${bradley.zone} zone (${bradley.value.toFixed(2)}, ${bradley.trend})`,
      detail:
        `Bradley's 1948 siderograph is a weighted sum of planetary aspects (approximated here). Practitioners read its ` +
        `extremes as turn dates and concede that turns often invert. ${NO_SUPPORT}`,
      impacts: ["cycle", "tradition"],
      evidence: "no peer-reviewed support",
    });
  }

  return signals;
}

// ─── Zodiac readings (astrological tradition, no market content) ────────────
// Kept for API compatibility; the client does not render them. The text
// describes traditional sign traits only: no entries, sizes or "lucky" trades.
export interface ZodiacReading {
  sign: Sign;
  glyph: string;
  element: string;
  modality: string;
  headline: string;
  detail: string;
  /** Historical field name. Now the Moon's traditional relation to the sign, no market claim. */
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

    const elementTrait: Record<typeof element, string> = {
      fire: "Fire sign (tradition: initiative)",
      earth: "Earth sign (tradition: patience)",
      air: "Air sign (tradition: analysis)",
      water: "Water sign (tradition: intuition)",
    };

    let headline = elementTrait[element];
    if (isMoonSign) headline = `Moon in this sign today. ${headline}`;
    if (isSunSign) headline = `Sun in this sign. ${headline}`;

    const ruler: Record<Sign, PlanetId> = {
      Aries: "mars", Taurus: "venus", Gemini: "mercury", Cancer: "moon",
      Leo: "sun", Virgo: "mercury", Libra: "venus", Scorpio: "pluto",
      Sagittarius: "jupiter", Capricorn: "saturn", Aquarius: "uranus", Pisces: "neptune",
    };
    const rulerPlanet = ruler[sign];
    const rulerAsps = asps.filter((a) => a.a === rulerPlanet || a.b === rulerPlanet).slice(0, 2);
    const aspectNote = rulerAsps.length > 0
      ? rulerAsps.map((a) => `${a.a}-${a.b} ${a.aspect}`).join(", ")
      : "none";

    const detail = `Ruling planet: ${PLANET_GLYPH[rulerPlanet]} ${rulerPlanet}. Aspects to the ruler: ${aspectNote}. ` +
      `Modality: ${modality}. Astrological tradition only, no market content.`;

    const signIdx = SIGNS.indexOf(sign);
    const moonIdx = SIGNS.indexOf(moonSign);
    const diff = (moonIdx - signIdx + 12) % 12;
    const luckyWindow =
      diff === 0 ? "Moon conjunct this sign"
      : diff === 4 || diff === 8 ? "Moon trine this sign (tradition: harmonious)"
      : diff === 2 || diff === 10 ? "Moon sextile this sign (tradition: mildly harmonious)"
      : diff === 6 ? "Moon opposite this sign (tradition: tension)"
      : diff === 3 || diff === 9 ? "Moon square this sign (tradition: friction)"
      : "No major Moon aspect to this sign";

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
  /** Sky events with evidence labels (historical field name; not market signals). */
  financialSignals: FinancialSignal[];
  zodiacReadings: ZodiacReading[];
  natalTransits: NatalTransit[];
  dailyBriefMarkdown: string;
  /** Always present: what this tab is and is not. */
  disclaimer: string;
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
    disclaimer: COSMOS_DISCLAIMER,
  };
}

// ─── Daily brief composer (deterministic) ───────────────────────────────────
// Sky facts plus evidence labels. No regime call, no trading disposition.
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

  const lines: string[] = [
    `## SKY SUMMARY — ${dateStr}`,
    `*${COSMOS_DISCLAIMER}*`,
    ``,
    `Moon in ${byId.moon.sign} (${phase.name}, ${(phase.illumination * 100).toFixed(0)}% illum). ` +
    `Sun in ${byId.sun.sign}. Bradley ${brad.value.toFixed(2)} ${brad.trend}. ` +
    `${voc.active ? `Moon void-of-course until ${voc.nextSignAt ? new Date(voc.nextSignAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "sign change"} ET.` : ""}`,
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
    lines.push(`## SKY EVENTS (context, not signals)`);
    for (const s of sigs) {
      lines.push(`- **${s.headline}** [${s.evidence}] — ${s.detail}`);
    }
    lines.push(``);
  }

  if (topNatal.length > 0) {
    lines.push(`## NATAL TRANSITS — today's sky vs first-trade charts (astrological tradition, untested)`);
    for (const t of topNatal) {
      const topHits = t.aspects.slice(0, 2).map((a) => `${a.transitingPlanet} ${a.aspect} natal ${a.natalPlanet}`).join(", ");
      lines.push(`- **${t.symbol}** (${t.natalName}): aspect score ${t.score.toFixed(2)}. ${topHits || "no tight aspects"}.`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Positions from VSOP87/Meeus mean-element formulas (Sun/Moon about ±0.1°, outer planets about ±0.5°); aspects use 6-8° orbs. Only lunar, geomagnetic and SAD effects have peer-reviewed studies, and those effects are small or disputed. Not a trading signal.*`);

  return lines.join("\n");
}

// ─── Forward-looking weekly + monthly sky calendar ──────────────────────────
// Scan ahead day-by-day through the geocentric engine; collect moon-phase
// changes, planetary stations, sign ingresses and Bradley zone changes.
// Deterministic, no network, no LLM required. Events carry no direction:
// `bias` is always "neutral" and `netBias` is always "neutral" (fields kept
// for API compatibility; Cosmos makes no direction calls).

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
  /** Astronomical prominence of the event, not market impact. */
  severity: "high" | "medium" | "low";
  /** Deprecated: always "neutral". Cosmos makes no direction calls. */
  bias: "bullish" | "bearish" | "neutral" | "volatile";
  evidence: CosmosEvidence;
}

function scanForwardEvents(startDate: Date, days: number): OutlookEvent[] {
  const events: OutlookEvent[] = [];
  const phaseNames: Record<string, OutlookEvent["type"]> = {
    "New Moon": "new_moon",
    "Full Moon": "full_moon",
    "First Quarter": "first_quarter",
    "Last Quarter": "last_quarter",
  };
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
      const isSyzygy = phase.name === "Full Moon" || phase.name === "New Moon";
      events.push({
        date: iso,
        dayOffset: d,
        type: phaseNames[phase.name],
        headline: `${phase.name} in ${byId.moon.sign}`,
        detail: isSyzygy ? LUNAR_EVIDENCE_NOTE : "Quarter phase. No studied market effect.",
        severity: isSyzygy ? "high" : "low",
        bias: "neutral",
        evidence: isSyzygy ? "peer-reviewed, small effect" : "no peer-reviewed support",
      });
    }

    // Bradley zone changes
    if (brad.zone !== prevBradZone && brad.zone !== "neutral") {
      events.push({
        date: iso,
        dayOffset: d,
        type: brad.zone === "high" ? "bradley_high" : "bradley_low",
        headline: `Bradley siderograph enters ${brad.zone.toUpperCase()} zone (${brad.value.toFixed(2)})`,
        detail: `Practitioners read siderograph extremes as turn dates and concede frequent inversions. ${NO_SUPPORT}`,
        severity: "medium",
        bias: "neutral",
        evidence: "no peer-reviewed support",
      });
    }

    // Planet retrograde stations
    for (const p of positions) {
      if (p.retrograde !== prevRx[p.id]) {
        const isMerc = p.id === "mercury";
        const nowRx = p.retrograde;
        const baseType: OutlookEvent["type"] =
          isMerc
            ? (nowRx ? "mercury_rx_start" : "mercury_rx_end")
            : (nowRx ? "planet_rx_start" : "planet_rx_end");
        events.push({
          date: iso,
          dayOffset: d,
          type: baseType,
          headline: `${p.glyph} ${p.label} stations ${nowRx ? "RETROGRADE" : "DIRECT"}`,
          detail: `${p.label} stations ${nowRx ? "retrograde" : "direct"} in ${p.sign}. Practitioners watch station dates for reversals. ${NO_SUPPORT}`,
          severity: isMerc ? "high" : "medium",
          bias: "neutral",
          evidence: "no peer-reviewed support",
        });
      }
      prevRx[p.id] = p.retrograde;
    }

    // Major sign ingresses (only for slower bodies)
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
          detail: `${p.label} ingress to ${p.sign}. Astrological tradition reads ingresses as theme shifts. ${NO_SUPPORT}`,
          severity: id === "sun" ? "low" : id === "jupiter" || id === "saturn" ? "high" : "medium",
          bias: "neutral",
          evidence: "no peer-reviewed support",
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
  /** Deprecated: always "neutral". Cosmos makes no direction calls. */
  netBias: "bullish" | "bearish" | "mixed" | "neutral";
  keyDates: string[];           // ISO dates of astronomically prominent events
  markdown: string;
  disclaimer: string;
}

function buildOutlookMarkdown(
  horizon: "weekly" | "monthly",
  startDate: Date,
  endDate: Date,
  events: OutlookEvent[],
  snapshot: CosmosSnapshot,
): string {
  const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const fmtRange = `${fmtDate(startDate)} → ${fmtDate(endDate)}`;
  const label = horizon === "weekly" ? "7-DAY SKY CALENDAR" : "30-DAY SKY CALENDAR";
  const byId = Object.fromEntries(snapshot.positions.map((p) => [p.id, p]));

  const openingContext = horizon === "weekly"
    ? `Week opens with Moon in ${byId.moon.sign}, ${snapshot.lunarPhase.name} (${(snapshot.lunarPhase.illumination * 100).toFixed(0)}% illum). Sun in ${byId.sun.sign}. Bradley ${snapshot.bradley.value.toFixed(2)} ${snapshot.bradley.trend}. Mercury ${byId.mercury.retrograde ? "retrograde" : "direct"}.`
    : `Month opens with Sun in ${byId.sun.sign}, Moon in ${byId.moon.sign} (${snapshot.lunarPhase.name}). Jupiter in ${byId.jupiter.sign}, Saturn in ${byId.saturn.sign}. Bradley ${snapshot.bradley.value.toFixed(2)} ${snapshot.bradley.trend}.`;

  const lines: string[] = [
    `## ${label} — ${fmtRange}`,
    ``,
    `*${COSMOS_DISCLAIMER}*`,
    ``,
    openingContext,
    ``,
  ];

  const highEvents = events.filter((e) => e.severity === "high");
  const medEvents = events.filter((e) => e.severity === "medium");

  if (highEvents.length > 0) {
    lines.push(`### MAJOR SKY EVENTS`);
    for (const e of highEvents) {
      const dstr = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      lines.push(`- **${dstr}** **${e.headline}** [${e.evidence}] — ${e.detail}`);
    }
    lines.push(``);
  }

  if (medEvents.length > 0) {
    lines.push(`### OTHER SKY EVENTS`);
    for (const e of medEvents) {
      const dstr = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      lines.push(`- ${dstr} ${e.headline} [${e.evidence}] — ${e.detail}`);
    }
    lines.push(``);
  }

  if (events.length === 0) {
    lines.push(`### EVENT CALENDAR`);
    lines.push(`No major sky events in this window.`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Forward projection from VSOP87/Meeus formulas. No direction call, no trade instruction: only lunar, geomagnetic and SAD effects have peer-reviewed studies, and those effects are small or disputed.*`);

  return lines.join("\n");
}

function buildOutlook(horizon: "weekly" | "monthly", date: Date): Outlook {
  const days = horizon === "weekly" ? 7 : 30;
  const events = scanForwardEvents(date, days);
  const endDate = new Date(date.getTime() + days * 86_400_000);
  const snapshot = buildCosmosSnapshot(date);
  const keyDates = events.filter((e) => e.severity === "high").map((e) => e.date);
  return {
    horizon,
    startDate: date.toISOString(),
    endDate: endDate.toISOString(),
    events,
    netBias: "neutral",
    keyDates,
    markdown: buildOutlookMarkdown(horizon, date, endDate, events, snapshot),
    disclaimer: COSMOS_DISCLAIMER,
  };
}

export function buildWeeklyOutlook(date: Date = new Date()): Outlook {
  return buildOutlook("weekly", date);
}

export function buildMonthlyOutlook(date: Date = new Date()): Outlook {
  return buildOutlook("monthly", date);
}

// System prompt for the optional LLM narrative (routes.ts, only when keys are
// set). It must describe the sky calendar, never turn it into trades.
export const OUTLOOK_SYSTEM_PROMPT = `You write a short, plain-English sky calendar for the Cosmos tab of a market terminal. You receive a deterministic list of sky events for the next 7 days (weekly) or 30 days (monthly), each tagged with its evidence level.

Rules:
1. Start with this exact sentence: "For entertainment and context, not a trading signal."
2. Keep every date and event exactly as given. Never invent or omit events.
3. Do NOT give trade instructions, position sizes, sector tilts, hedges, entries, exits, price targets, or any bullish/bearish/neutral direction call. Do not say what the market will do.
4. State the evidence plainly: only lunar (Yuan, Zheng & Zhu 2006: about 3-5% a year in aggregate, a basis point or two a day), geomagnetic (Krivelyova & Robotti 2003, a working paper) and SAD (Kamstra, Kramer & Levi 2003, disputed by Kelly & Meschke 2010) effects have studies behind them, and those effects are small. Retrogrades, Bradley, Gann, ingresses and natal charts have no peer-reviewed support.
5. Plain markdown, no emojis, at most 250 words.`;

// ─── NOAA Kp-index (geomagnetic storm) fetcher ──────────────────────────────
// Pulls from NOAA SWPC free endpoints (no key). Cached 60min.
// Kp 0-4 = quiet, 5 = G1 storm, 6 = G2, 7 = G3, 8 = G4, 9 = G5.
// Krivelyova & Robotti (FRB Atlanta WP 2003-5) associate unusually high
// geomagnetic activity with lower returns the following week (one working
// paper, small effect). Shown as context only; never an alert.

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

// ─── Taxonomy (reference data) ──────────────────────────────────────────────
// Reference list of sky events that financial astrology talks about. Each
// entry says what is claimed and what the evidence is. No entry contains a
// trade instruction (review finding 5.3). `weight` is a historical field:
// it no longer means signal strength; `evidence` is what the UI shows.

export interface TaxonomyEntry {
  id: string;
  name: string;
  category: "planetary" | "lunar" | "solar_geomag" | "cycle_gann";
  tags: string[];
  description: string;
  weight: "HIGH" | "HIGH_ACADEMIC" | "MEDIUM" | "MACRO" | "FILTER" | "PROPRIETARY" | "ESOTERIC";
  evidence: CosmosEvidence;
}

export const TAXONOMY: TaxonomyEntry[] = [
  // Planetary
  { id: "mercury_rx", name: "Mercury Retrograde", category: "planetary", tags: ["~3x/yr", "~3 weeks"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Mercury appears to move backward from Earth for about three weeks, about three times a year. Practitioners claim turning points cluster within a few days of its stations. No peer-reviewed study supports a market effect." },
  { id: "jupiter_saturn", name: "Jupiter–Saturn Cycle", category: "planetary", tags: ["~20-yr"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "W.D. Gann's 'master cycle': conjunctions about every 20 years. Practitioner lore; with one event per 20 years there is no testable sample." },
  { id: "venus_elongation", name: "Venus Elongation", category: "planetary", tags: ["Greatest elongation"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Venus at its greatest angular distance from the Sun (about 46°). Appears in Gann-style price-time work as a turning date for commodities. Practitioner lore; untested." },
  { id: "mars_station", name: "Mars Stations", category: "planetary", tags: ["~2-yr cycle"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Mars appears to stop and reverse about every two years. Tradition links its stations to energy-market volatility. Practitioner lore; untested." },
  { id: "pluto_ingress", name: "Pluto Ingress", category: "planetary", tags: ["Generational"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Pluto moved into Aquarius in 2023-2024 (previously about 1778-1798). Used for generational narratives only; no testable market link." },

  // Lunar
  { id: "new_moon", name: "New Moon", category: "lunar", tags: ["monthly", "small effect"], weight: "HIGH_ACADEMIC", evidence: "peer-reviewed, small effect",
    description: "Yuan, Zheng & Zhu (2006, Journal of Empirical Finance, 48 countries): returns around new moons exceeded those around full moons by about 3-5% a year in aggregate, roughly 1-2 basis points a day. Dichev & Janes (2003) report a similar US pattern. Small next to daily volatility, and not stable in every later sample." },
  { id: "full_moon", name: "Full Moon", category: "lunar", tags: ["monthly", "small effect"], weight: "HIGH_ACADEMIC", evidence: "peer-reviewed, small effect",
    description: "Same studies as New Moon: returns around full moons were lower on average, by about 3-5% a year in aggregate (a basis point or two a day). An average across many years and countries, not a forecast for any one day." },
  { id: "lunar_eclipse", name: "Lunar Eclipses", category: "lunar", tags: ["2–3/yr"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Practitioners claim eclipses precede volatility or reversals. No peer-reviewed support. Eclipse dates are not computed here." },
  { id: "moon_sign", name: "Moon Sign Transit", category: "lunar", tags: ["~2.5 days each"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "The Moon changes zodiac sign about every 2.5 days. Tradition calls some signs 'decisive' and others 'indecisive'. No peer-reviewed support." },

  // Solar & Geomagnetic
  { id: "solar_eclipse", name: "Solar Eclipse", category: "solar_geomag", tags: ["~2/yr"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Practitioners claim solar eclipses precede trend changes. No peer-reviewed support. Eclipse dates are not computed here." },
  { id: "geomagnetic_storm", name: "Geomagnetic Storms", category: "solar_geomag", tags: ["NOAA Kp ≥ 5", "small effect"], weight: "HIGH_ACADEMIC", evidence: "working paper, small effect",
    description: "Krivelyova & Robotti (Federal Reserve Bank of Atlanta Working Paper 2003-5): unusually high geomagnetic activity in the prior week was associated with lower returns on the world index and most international indices in their sample; they attribute it to mood misattribution. One working-paper result, not tested out of sample here. Kp comes live from NOAA." },
  { id: "solar_max", name: "Solar Max / Sunspot Cycles", category: "solar_geomag", tags: ["~11-yr cycle"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Nineteenth-century writers (for example W.S. Jevons) linked sunspot cycles to commercial crises. Modern evidence does not support a tradable market link." },
  { id: "sad_seasonal", name: "Seasonal Affective Disorder", category: "solar_geomag", tags: ["SAD", "Sep–Dec", "disputed"], weight: "HIGH_ACADEMIC", evidence: "peer-reviewed, disputed",
    description: "Kamstra, Kramer & Levi (2003, American Economic Review): returns were lower in autumn as nights lengthen and higher after the winter solstice. Kelly & Meschke (2010, Journal of Banking & Finance) find the effect is mechanically driven by the overlapping dummy-variable specification and turn-of-year returns. Disputed." },

  // Time Cycle & Gann
  { id: "node_cycle", name: "18.6-Year Node Cycle", category: "cycle_gann", tags: ["Lunar Node"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "The Moon's orbital nodes circle the zodiac every 18.6 years (astronomical fact). McWhirter and Gann tied node positions to economic cycles. Practitioner lore; with so few cycles there is no testable sample." },
  { id: "gann_sq9", name: "Gann Square of Nine", category: "cycle_gann", tags: ["Price levels"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Gann's spiral number grid, used by practitioners to map price and time levels. No peer-reviewed support." },
  { id: "dtt_goldbach", name: "Fibonacci + Prime Number Nodes", category: "cycle_gann", tags: ["DTT / Goldbach"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Practitioner frameworks that time candles by prime counts and overlay number-theory price levels. No peer-reviewed support." },
  { id: "helio_kabbalah", name: "Heliocentric Kabbalah Math", category: "cycle_gann", tags: ["Esoteric"], weight: "ESOTERIC", evidence: "no peer-reviewed support",
    description: "Sun-centered planetary positions combined with numerological interval timing (used in Bucholtz's almanacs). Esoteric; no peer-reviewed support." },
];

// Books: practitioner literature. None is peer-reviewed.
export interface BookEntry {
  title: string;
  authors: string;
  publisher: string;
  tier: 1 | 2 | 3;
  tags: string[];
  summary: string;
  score?: number; // removed: no quality score is implied
}

export const BOOKS: BookEntry[] = [
  { title: "A Trader's Guide to Financial Astrology", authors: "Larry Pesavento & Shane Smoleny", publisher: "Wiley Trading Series · 2014", tier: 1,
    tags: ["Wiley", "Practitioner", "Lunar cycles"],
    summary: "Practitioner text by a long-time trader with historical tables and lunar-cycle studies. Not peer-reviewed; the historical correlations are in-sample." },
  { title: "Timing Solutions for Swing Traders", authors: "Robert Lee", publisher: "Wiley Trading Series · 2012", tier: 1,
    tags: ["Wiley", "Practitioner", "Timing cycles"],
    summary: "Combines technical analysis with planetary timing cycles for swing trading. Practitioner framework; not peer-reviewed." },
  { title: "Financial Astrology Almanac (Annual Series)", authors: "M.G. Bucholtz", publisher: "InvestingSuccess.ca · Annual", tier: 2,
    tags: ["Date calendar", "Annual"],
    summary: "Annual almanac of New Moon cycles, Venus and Mercury events, conjunctions, declinations and Kabbalah intervals for NYSE/NASDAQ dates. Practitioner material." },
  { title: "Trading In Sync With Commodities", authors: "Susan Abbott Gidel", publisher: "susangidel.com · 2020s", tier: 2,
    tags: ["Commodities"],
    summary: "Compares S&P 500, gold, soybeans, crude, Euro FX and T-notes with astrological transits and first-trade charts. Practitioner material." },
  { title: "The Law of Vibration", authors: "William D. Gann (compiled)", publisher: "Various publications", tier: 2,
    tags: ["Original source", "Square of 9"],
    summary: "Gann's own writing on price-time relationships, planetary angles and the Square of Nine. Deliberately cryptic; historical interest." },
  { title: "Profitable Financial Market Trading — Ephemeris Alarm Series", authors: "Khit Wong", publisher: "Multiple volumes · Crypto + Equities", tier: 2,
    tags: ["Crypto", "Intraday"],
    summary: "Applies financial astrology to minute-level timing, including BTC and ETH. Practitioner material." },
  { title: "McWhirter Theory of Stock Market Forecasting", authors: "Louise McWhirter", publisher: "1977 reprint · Original ~1930s", tier: 3,
    tags: ["Lunar Node", "18.6yr cycle"],
    summary: "Uses the Moon's node position through the zodiac to describe economic cycles. Historical practitioner text." },
  { title: "Financial Astrology (Original)", authors: "David Williams", publisher: "1984 · Out of print", tier: 3,
    tags: ["Jupiter-Saturn", "Sunspots", "DJIA"],
    summary: "Early historical comparison of Jupiter-Saturn cycles, sunspots and planetary aspects with the DJIA. In-sample historical tables." },
];

export interface AcademicPaper {
  title: string;
  source: string;
  finding: string;
  badge: "FED ATL" | "U MICH" | "SAGE/TGARCH" | "APPLIED ECON" | "AER" | "JBF";
  category: "fed" | "university";
}

export const ACADEMIC_PAPERS: AcademicPaper[] = [
  { category: "fed", badge: "FED ATL",
    title: "Playing the Field: Geomagnetic Storms and International Stock Markets",
    source: "Krivelyova & Robotti · Federal Reserve Bank of Atlanta · Working Paper 2003-5",
    finding: "Unusually high geomagnetic activity in the prior week was associated with lower returns on the world index and most international indices in the sample. The authors link it to mood misattribution. A working paper; not tested out of sample here." },
  { category: "fed", badge: "AER",
    title: "Winter Blues: A SAD Stock Market Cycle",
    source: "Kamstra, Kramer & Levi · American Economic Review 93(1), 2003 (FRB Atlanta WP 2002-13)",
    finding: "Returns were lower in autumn as daylight shortens and higher after the winter solstice, across several countries. Disputed: see Kelly & Meschke (2010)." },
  { category: "university", badge: "JBF",
    title: "Sentiment and Stock Returns: The SAD Anomaly Revisited",
    source: "Kelly & Meschke · Journal of Banking & Finance 34(6), 2010",
    finding: "The SAD effect does not match the seasonal pattern of depression or its cross-country prevalence, and is mechanically driven by the overlapping dummy-variable specification and turn-of-year returns." },
  { category: "university", badge: "U MICH",
    title: "Are Investors Moonstruck? Lunar Phases and Stock Returns",
    source: "Yuan, Zheng & Zhu · Journal of Empirical Finance 13(1), 2006 · 48 countries",
    finding: "Returns were lower around full moons than around new moons, by about 3-5% a year for global portfolios. Not explained by volatility, volume, announcements or other calendar effects. An aggregate average, not a daily forecast." },
  { category: "university", badge: "U MICH",
    title: "Lunar Cycle Effects in Stock Returns",
    source: "Dichev & Janes · Journal of Private Equity, 2003 (working paper 2001)",
    finding: "Returns in the 15 days around new moons were about double those in the 15 days around full moons, in about 100 years of US index data and in most of 24 other countries." },
  { category: "university", badge: "SAGE/TGARCH",
    title: "Moon Phases, Mood and Stock Market Returns (59 Markets)",
    source: "Floros & Tan · 2013 · TGARCH model",
    finding: "Significant full-moon effects in 6 of 59 markets and new-moon effects in 8, i.e. absent in most markets; the estimates interact with Monday and January effects." },
  { category: "university", badge: "APPLIED ECON",
    title: "Lunar Seasonality in Precious Metal Returns",
    source: "Brian Lucey · Applied Economics Letters · 2010",
    finding: "Reports lunar-cycle patterns in gold and silver returns similar to those found in equities. Historical, in-sample." },
];

export interface EdgeRule {
  id: string;
  title: string;
  color: "gold" | "blue" | "green";
  body: string; // markdown
}

// Historical name kept for the API ("rules"). These are reading rules for a
// context tab, not trading rules.
export const EDGE_RULES: EdgeRule[] = [
  { id: "rule_1", color: "gold", title: "RULE 1 — CONTEXT, NOT A SIGNAL",
    body: "Nothing on this tab is a trade instruction, a direction call, a position size or an alert, and no other Batcave engine reads Cosmos output. It is shown for entertainment and context." },
  { id: "rule_2", color: "blue", title: "RULE 2 — WHAT HAS STUDIES BEHIND IT",
    body: "**Lunar:** returns around full moons were lower than around new moons by about 3-5% a year in aggregate (Yuan, Zheng & Zhu 2006), about 1-2 basis points a day against typical daily index moves near 100 basis points.\n\n**Geomagnetic:** one Federal Reserve working paper (Krivelyova & Robotti 2003) finds lower returns after stormy weeks.\n\n**SAD:** published (Kamstra, Kramer & Levi 2003) and then disputed (Kelly & Meschke 2010).\n\nAll are historical averages. None has been tested out of sample in this app, and none is shown to be tradable after costs." },
  { id: "rule_3", color: "green", title: "RULE 3 — WHAT HAS NONE",
    body: "Mercury, Mars and Venus retrogrades, the Bradley siderograph, Gann cycles and the Square of Nine, lunar nodes, eclipses, void-of-course Moons, zodiac signs and natal charts of tickers have no peer-reviewed support for a market effect." },
  { id: "rule_4", color: "gold", title: "RULE 4 — WHY COINCIDENCES PROVE NOTHING",
    body: "There are dozens of sky events every month, so some will always line up with market turns by chance. Matching events to moves after the fact is data snooping (multiple testing). Evidence needs a rule fixed in advance and tested on later data against random dates." },
  { id: "rule_5", color: "blue", title: "RULE 5 — WHAT IT WOULD TAKE TO BECOME A SIGNAL",
    body: "Log the event dates going forward, fix one rule in advance, and grade it against a random-date null after trading costs over a large sample. Until that exists, Cosmos stays context." },
];

export const HONEST_EDGE_ASSESSMENT = "Only three sky-related effects have studies behind them: the lunar cycle (about 3-5% a year in aggregate, a basis point or two a day), geomagnetic storms (one Federal Reserve working paper) and the SAD cycle (published, then shown to be largely a specification artifact). They are historical averages across many years and countries, small next to daily volatility, and not tested out of sample here. Retrogrades, Bradley, Gann and natal charts have no peer-reviewed support. Cosmos is context for entertainment, not a trading signal.";

// ─── Taxonomy live-lighting ─────────────────────────────────────────────────
// Given a snapshot + kp, return which taxonomy entries are "ACTIVE NOW" and
// how close they are (0-1). "Active" means the sky event is happening, never
// that a market effect is expected. Every static entry gets a live state.

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
    currentValue: `Moon in ${moon.sign}${isDecisive ? " (tradition: 'decisive' sign)" : isRange ? " (tradition: 'indecisive' sign)" : ""}`,
    badge: isDecisive || isRange ? "TRADITION" : undefined,
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
  // Reference only: no live sunspot feed. (NASA/NOAA announced in Oct 2024
  // that Solar Cycle 25 had reached its solar maximum period.)
  out["solar_max"] = {
    id: "solar_max",
    active: false,
    strength: 0,
    currentValue: "reference only (no live sunspot feed)",
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
    currentValue: sadDepth ? "Sep 22 – Dec 21: lengthening nights (SAD window, effect disputed)" : sadRecovery ? "Dec 22 – Apr: shortening nights" : "summer",
    badge: sadDepth ? "SAD WINDOW" : undefined,
  };

  // Cycle & Gann — mostly reference/macro, not live-triggered
  // Computed (was a hard-coded "North Node in Aries (entered 2023)", stale
  // since mid-2023). Mean node, Meeus "Astronomical Algorithms" eq. 47.7.
  const node = meanLunarNodeLongitude(now);
  out["node_cycle"] = {
    id: "node_cycle",
    active: false,
    strength: 0,
    currentValue: `Mean North Node in ${signFromLongitude(node)} ${degreeWithinSign(node).toFixed(1)}° (astronomical fact; market link untested)`,
  };
  out["gann_sq9"] = {
    id: "gann_sq9",
    active: false,
    strength: 0,
    currentValue: "reference only",
  };
  out["dtt_goldbach"] = {
    id: "dtt_goldbach",
    active: false,
    strength: 0,
    currentValue: "reference only",
  };
  out["helio_kabbalah"] = {
    id: "helio_kabbalah",
    active: false,
    strength: 0,
    currentValue: "reference only",
  };

  return out;
}
