#!/usr/bin/env node
// Clean reseed: ETF-only universe, DTE forced ≥7 calendar days, captured/expiry both inside daily_bars range.
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const db = new Database('./data.db');

// 1. Inspect daily_bars range
const range = db.prepare("SELECT MIN(date) as min_d, MAX(date) as max_d FROM daily_bars WHERE symbol='SPY'").get();
console.log('daily_bars SPY range:', range);

// 2. Wipe synth
const wiped = db.prepare("DELETE FROM prediction_outcomes WHERE prediction_id LIKE 'synth%'").run();
console.log('wiped synth rows:', wiped.changes);

// 3. Helpers
const ETF_UNIVERSE = ['SPY','QQQ','IWM','XLK','XLF','XLE','TLT','GLD','SMH','XLY'];
const HORIZONS = [10,15,20,30]; // trading-day-ish (we use calendar +5 buffer to be safe)
const TYPES = ['CALL','PUT'];

// Convert date string YYYY-MM-DD <-> ms
const dateToMs = (s) => new Date(s + 'T00:00:00Z').getTime();
const msToDate = (ms) => new Date(ms).toISOString().slice(0,10);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
};
const isWeekday = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
};
const nextWeekday = (dateStr) => {
  let d = dateStr;
  while (!isWeekday(d)) d = addDays(d, 1);
  return d;
};

// Sample valid trading days from daily_bars that have BOTH a captured date AND an expiry date 7+ cal days later, both in range
const minDateMs = dateToMs(range.min_d);
const maxDateMs = dateToMs(range.max_d);

// Build pool of capture dates: must be weekday AND ≥ min_d AND have ≥30 cal days of headroom before max_d
const allDates = db.prepare("SELECT DISTINCT date FROM daily_bars WHERE symbol='SPY' AND date <= ? ORDER BY date")
  .all(msToDate(maxDateMs - 30*86400000)).map(r => r.date);
console.log('valid capture dates:', allDates.length, 'first:', allDates[0], 'last:', allDates[allDates.length-1]);

const insert = db.prepare(`
  INSERT INTO prediction_outcomes
    (prediction_id, kind, symbol, captured_at, grading_due_at, inputs_json, prediction_json, outcome_json, pct_return, hit_30, hit_50, hit_100, graded, graded_at, grade_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, 1)
`);

let whaleCount = 0;
const tx = db.transaction(() => {
  // 60 whale alerts
  for (let i = 0; i < 60; i++) {
    const symbol = ETF_UNIVERSE[Math.floor(Math.random() * ETF_UNIVERSE.length)];
    const captureDate = allDates[Math.floor(Math.random() * allDates.length)];
    const dteCal = HORIZONS[Math.floor(Math.random() * HORIZONS.length)] + 5; // cushion
    let expiryDate = addDays(captureDate, dteCal);
    expiryDate = nextWeekday(expiryDate);
    if (dateToMs(expiryDate) > maxDateMs) continue; // skip if out of range
    if (expiryDate === captureDate) continue;

    const type = TYPES[Math.floor(Math.random() * TYPES.length)];
    const delta = type === 'CALL'
      ? 0.20 + Math.random() * 0.40
      : -(0.20 + Math.random() * 0.40);
    const premium = 1_000_000 + Math.random() * 9_000_000;
    const volOiRatio = 10 + Math.random() * 40;
    const isNewStrike = Math.random() < 0.3;

    const capturedAtMs = dateToMs(captureDate) + 14 * 3600 * 1000; // 2pm UTC ~ 10am ET
    const gradingDueAtMs = dateToMs(expiryDate) + 16 * 3600 * 1000; // 4pm UTC ~ noon ET (after expiry)

    const regime = ['TREND_UP','TREND_DN','CHOP','SQUEEZE'][Math.floor(Math.random()*4)];
    const strike = 100 + Math.random() * 200;
    const inputs = {
      gates: { premiumFloor: 1_000_000, volOiRatio: 10, deltaMin: 0.20, dteMin: 1 },
      regimeAtFire: regime,
      captureDate, expiryDate
    };
    // Match live whale alert shape (see outcomeLogger.logWhaleAlertPrediction)
    const prediction = {
      occ: `${symbol}_${expiryDate.replace(/-/g,'')}_${type[0]}_${Math.round(strike*100)}`,
      type,                       // 'CALL' | 'PUT'
      strike,
      expiration: expiryDate,
      dte: dteCal,
      premium,                    // dollars
      volOiRatio,
      isNewStrike,
      tag: 'whale',
      delta,
      sentiment: type === 'CALL' ? 'bullish' : 'bearish'
    };

    insert.run(
      `synth_whale_${i}`,
      'whale_alert',
      symbol,
      capturedAtMs,
      gradingDueAtMs,
      JSON.stringify(inputs),
      JSON.stringify(prediction)
    );
    whaleCount++;
  }

  // 20 regime calls (symbol = SPY proxy)
  for (let i = 0; i < 20; i++) {
    const captureDate = allDates[Math.floor(Math.random() * allDates.length)];
    let expiryDate = addDays(captureDate, 8);
    expiryDate = nextWeekday(expiryDate);
    if (dateToMs(expiryDate) > maxDateMs) continue;

    const regimes = ['TREND_UP','TREND_DN','CHOP','SQUEEZE'];
    const regime = regimes[Math.floor(Math.random() * regimes.length)];
    const conf = 0.30 + Math.random() * 0.65;

    const capturedAtMs = dateToMs(captureDate) + 14 * 3600 * 1000;
    const gradingDueAtMs = dateToMs(expiryDate) + 16 * 3600 * 1000;

    // Match live regime call shape (see outcomeLogger.logRegimeCallPrediction)
    const inputs = {
      currentRegime: regime,
      horizonMinutes: 60 * 24 * 5,
      drivers: { breadth: Math.random(), vix: 12 + Math.random()*15, trend: Math.random() },
      captureDate, expiryDate
    };
    const prediction = {
      topCandidate: regime,
      topProbability: conf,
      confidence: conf
    };

    insert.run(
      `synth_regime_${i}`,
      'regime_call',
      'SPY',
      capturedAtMs,
      gradingDueAtMs,
      JSON.stringify(inputs),
      JSON.stringify(prediction)
    );
  }
});
tx();

const after = db.prepare("SELECT COUNT(*) as n, kind FROM prediction_outcomes WHERE prediction_id LIKE 'synth%' GROUP BY kind").all();
console.log('reseeded:', after);
console.log('whaleCount inserted:', whaleCount);

// Sample one
const sample = db.prepare("SELECT prediction_id, symbol, captured_at, grading_due_at FROM prediction_outcomes WHERE prediction_id LIKE 'synth%' LIMIT 3").all();
sample.forEach(r => {
  console.log(r.prediction_id, r.symbol, msToDate(r.captured_at), '->', msToDate(r.grading_due_at), 'gap days:', Math.round((r.grading_due_at - r.captured_at)/86400000));
});

db.close();
