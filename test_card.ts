import { formatOdteAlert } from "./server/odteAlertEngine";

// Synthetic OdteAlert — CALL, WALL_REJECT, A grade, T2 present
const alert: any = {
  side: "call",
  setup: "WALL_REJECT",
  spot: 5420.5,
  asOf: new Date("2026-05-06T14:23:00-04:00").getTime(),
  grade: { score: 87, letter: "A", reasoning: [] },
  contract: {
    strike: 5425,
    delta: 0.43,
    last: 4.20,
    gamma: 0.012,
    theta: -0.18,
    vega: 0.09,
    iv: 0.18,
    midPrice: 4.25,
    key: "SPX_5425_C",
    expiry: "2026-05-06",
    bid: 4.10,
    ask: 4.40,
    volume: 1200,
    openInterest: 8500,
  },
  reversionFrom: { name: "CALL WALL", price: 5445.0, kind: "wall" },
  t1: { name: "VOMMA POCKET", price: 5400.0, estPctGain: 35, kind: "wall" },
  t2: { name: "STRONG MAG", price: 5375.0, estPctGain: 80, kind: "mag" },
  stopPct: 20,
  stopLevel: 5438,
  t2TriggerLevel: 5400.0,
  t2TrailingStopLevel: 5397.0,
  greekSignals: "OFI SLOPE DOWN  \u00b7  \u03b3-slope DOWN",
  regime: "\u03b3+ DAMPENED \u00b7 CHOP",
  wire15: {
    projReturnPctT1: 0.72,
    projReturnPctT2: 1.41,
  },
};

const result = formatOdteAlert(alert);
console.log("=== TEST CARD OUTPUT ===");
console.log(result.content);
console.log("=== END ===");

// Also test PUT / FAILED_BREAK / no T2
const alertPut: any = {
  side: "put",
  setup: "FAILED_BREAK",
  spot: 5380.0,
  asOf: new Date("2026-05-06T11:05:00-04:00").getTime(),
  grade: { score: 82, letter: "A-", reasoning: [] },
  contract: {
    strike: 5375,
    delta: -0.41,
    last: 3.80,
    gamma: 0.011,
    theta: -0.15,
    vega: 0.08,
    iv: 0.19,
    midPrice: 3.85,
    key: "SPX_5375_P",
    expiry: "2026-05-06",
    bid: 3.70,
    ask: 3.90,
    volume: 900,
    openInterest: 6200,
  },
  reversionFrom: { name: "STRONG MAG", price: 5360.0, kind: "mag" },
  t1: { name: "MAIN PIVOT", price: 5400.0, estPctGain: 40, kind: "pivot" },
  t2: null,
  stopPct: 20,
  stopLevel: 5364,
  t2TriggerLevel: 5400.0,
  t2TrailingStopLevel: 5403.0,
  greekSignals: "OFI SLOPE UP  \u00b7  \u03b3-slope FLAT",
  regime: "\u03b3\u2212 VOLATILE",
  wire15: {
    projReturnPctT1: 0.68,
    projReturnPctT2: null,
  },
};

const resultPut = formatOdteAlert(alertPut);
console.log("\n=== TEST CARD OUTPUT (PUT / FAILED_BREAK / no T2) ===");
console.log(resultPut.content);
console.log("=== END ===");
