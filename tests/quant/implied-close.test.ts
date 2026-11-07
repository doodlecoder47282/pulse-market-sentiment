// The chain's own settle distribution by Breeden-Litzenberger: recovers a known
// density from Black-Scholes mids, fails closed on ragged or sparse mids, and
// the side-by-side is a description, never a verdict.
import test from "node:test";
import assert from "node:assert/strict";
import { impliedClose, compareCloseDistributions, MIN_STRIKES } from "../../shared/impliedClose";
import { normCdf } from "../../shared/odteWiener";

// Black-Scholes with zero rate: call and put mids for a settle ~ lognormal(sigma_T).
function bs(S: number, K: number, sT: number) {
  const d1 = (Math.log(S / K) + 0.5 * sT * sT) / sT, d2 = d1 - sT;
  const c = S * normCdf(d1) - K * normCdf(d2);
  return { callMid: c, putMid: c - S + K };
}
const grid = (S: number, w: number, span: number) => { const out: number[] = []; for (let k = Math.round((S - span) / w) * w; k <= S + span; k += w) out.push(k); return out; };

test("recovers the Black-Scholes settle distribution from its own mids (mass, mean, sigma)", () => {
  const S = 6000, sT = 0.0075; // 45 pts 1-sigma, 0DTE-like
  const w = 5;
  const quotes = grid(S, w, 200).map((K) => ({ strike: K, ...bs(S, K, sT) }));
  const ic = impliedClose(S, quotes, w);
  assert.equal(ic.state, "ok", ic.reason ?? "");
  const total = ic.buckets.reduce((s, b) => s + b.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-3, `mass ${total}`);
  assert.ok(Math.abs(ic.mean! - S) < 0.05, `mean ${ic.mean}`);
  assert.ok(Math.abs(ic.sigma! - S * sT) < 1.5, `sigma ${ic.sigma} vs ${S * sT}`);
  assert.equal(ic.diagnostics.clipped, 0);
  assert.ok(ic.diagnostics.renormalised < 0.01);
  // Bucket mass matches the lognormal CDF where both are defined.
  const lnCdf = (x: number) => normCdf((Math.log(x / S) + 0.5 * sT * sT) / sT);
  for (const b of ic.buckets) {
    if (b.lo == null || b.hi == null) continue;
    assert.ok(Math.abs(b.p - (lnCdf(b.hi) - lnCdf(b.lo))) < 0.003, `bucket ${b.lo}-${b.hi}: ${b.p}`);
  }
});

test("fails closed: too few strikes, a grid gap, ragged mids; never a smoothed curve", () => {
  const S = 6000, w = 5, sT = 0.0075;
  const few = grid(S, w, 10).map((K) => ({ strike: K, ...bs(S, K, sT) }));
  const r1 = impliedClose(S, few, w);
  assert.equal(r1.state, "unavailable");
  assert.match(String(r1.reason), new RegExp(`${MIN_STRIKES} needed`));
  // A gap in the grid: only the longest contiguous run is read.
  const gapped = grid(S, w, 200).filter((K) => K !== 6020).map((K) => ({ strike: K, ...bs(S, K, sT) }));
  const r2 = impliedClose(S, gapped, w);
  assert.equal(r2.state, "ok");
  assert.ok(r2.diagnostics.strikes < gapped.length);
  // Ragged mids: alternate strikes mispriced by 2 pts -> many negative butterflies -> unavailable with the count.
  const ragged = grid(S, w, 200).map((K, i) => { const q = bs(S, K, sT); return { strike: K, callMid: q.callMid + (i % 2 ? 2 : 0), putMid: q.putMid + (i % 2 ? 2 : 0) }; });
  const r3 = impliedClose(S, ragged, w);
  assert.equal(r3.state, "unavailable");
  assert.match(String(r3.reason), /butterflies negative|renormalised/);
  // No two-sided quote on one side: that strike is skipped, not read as zero.
  const oneSided = grid(S, w, 200).map((K) => ({ strike: K, ...bs(S, K, sT), putMid: K < 5900 ? null : bs(S, K, sT).putMid }));
  assert.equal(impliedClose(S, oneSided, w).state, "ok");
});

test("comparison: a skewed implied settle reads as width, tilt and distance in words; the same distribution reads as the same", () => {
  const S = 6000, w = 5, sT = 0.0075;
  const quotes = grid(S, w, 200).map((K) => ({ strike: K, ...bs(S, K, sT) }));
  const ic = impliedClose(S, quotes, w);
  const same = compareCloseDistributions({ spot: S, sigma: S * sT }, ic, normCdf)!;
  assert.ok(same.tvDistance < 0.01, `tv ${same.tvDistance}`);
  assert.match(same.text, /about the same width/);
  assert.match(same.text, /A description of two models, not a signal\./);
  const narrowerWalk = compareCloseDistributions({ spot: S, sigma: 30 }, ic, normCdf)!;
  assert.match(narrowerWalk.text, /wider than the random walk's/);
  assert.ok(narrowerWalk.sigmaDiff > 10);
  assert.ok(narrowerWalk.tvDistance > same.tvDistance);
  // Unavailable implied -> no comparison, not a zero.
  assert.equal(compareCloseDistributions({ spot: S, sigma: 45 }, { ...ic, state: "unavailable", sigma: null }, normCdf), null);
  for (const bad of ["edge", "probability of", "buy", "sell", "long", "short", "expect"]) assert.doesNotMatch(same.text.toLowerCase(), new RegExp(`\\b${bad}\\b`));
});

test("wiring: the forward reads two-sided mids only, publishes the implied settle and the comparison; the card draws it or says why not", async () => {
  const { readFileSync } = await import("node:fs");
  const f = readFileSync(new URL("../../server/odteForward.ts", import.meta.url), "utf8");
  assert.match(f, /const quoted = bid != null && ask != null && bid > 0 && ask >= bid;/);
  assert.match(f, /if \(quoted\) \{\s*const style = String\(contractStyle\(c\)\);/, "two-sided mids grouped by settlement style (AM vs PM never paired)");
  assert.match(f, /\[\.\.\.twoSidedByStyle\.values\(\)\]\.sort\(\(a, b\) => b\.size - a\.size\)\[0\]/);
  assert.match(f, /impliedClose: implied,\s*closeComparison,/);
  const c = readFileSync(new URL("../../client/src/components/OdteForward.tsx", import.meta.url), "utf8");
  assert.match(c, /data-testid="odte-implied-close"/);
  assert.match(c, /not readable: \{data\.impliedClose\?\.reason \?\? "no chain mids"\}\. Nothing is drawn in its place\./);
  assert.match(c, /const maxP = Math\.max\(\.\.\.inner\.map\(\(b\) => b\.p\), \.\.\.impliedInner\.map\(\(b\) => b\.p\), 1e-9\);/, "one scale for both histograms");
});

// ── review cases (PR #69): forward, tick noise, skew ──────────────────────
const q = (x: number, t = 0.025) => Math.round(x / t) * t;
function bsF(F: number, K: number, sT: number) {
  const d1 = (Math.log(F / K) + 0.5 * sT * sT) / sT, d2 = d1 - sT;
  const c = F * normCdf(d1) - K * normCdf(d2);
  return { callMid: c, putMid: c - F + K };
}

test("parity uses the chain's own forward: a gap between the underlying print and the forward is reported, not a kink", () => {
  const S = 6000, w = 5, sT = 0.0075;
  // Mids priced off a forward 2 pts above the print (overnight carry, or a stale print).
  const quotes = grid(S, w, 200).map((K) => ({ strike: K, ...bsF(S + 2, K, sT) }));
  const ic = impliedClose(S, quotes, w);
  assert.equal(ic.state, "ok");
  assert.equal(ic.forward, 6002);
  assert.equal(ic.diagnostics.clipped, 0, "no kink at the spot");
  assert.ok(Math.abs(ic.sigma! - 45) < 1, `sigma ${ic.sigma}`);
  const cmp = compareCloseDistributions({ spot: S, sigma: 45 }, ic, normCdf)!;
  assert.equal(cmp.forwardMinusSpot, 2);
  assert.match(cmp.text, /parity forward sits \+2 pts from the underlying print/);
  assert.ok(cmp.tvDistance < 0.03);
  // With a 5-pt gap the same: sigma intact, the gap stated.
  const ic5 = impliedClose(S, grid(S, w, 200).map((K) => ({ strike: K, ...bsF(S + 5, K, sT) })), w);
  assert.ok(Math.abs(ic5.sigma! - 45) < 1 && ic5.diagnostics.clipped === 0);
  // A forward far from the print (the chain and the print disagree) is unavailable with the reason.
  assert.match(String(impliedClose(S, grid(S, w, 200).map((K) => ({ strike: K, ...bsF(S * 1.08, K, sT) })), w).reason), /not near the spot/);
});

test("mid-tick noise: nickel quantisation reads as about 1% distance; jittered mids are unavailable, not a wide sigma", () => {
  const S = 6000, w = 5, sT = 0.0075;
  const nickel = impliedClose(S, grid(S, w, 200).map((K) => { const b = bsF(S, K, sT); return { strike: K, callMid: q(b.callMid), putMid: q(b.putMid) }; }), w);
  assert.equal(nickel.state, "ok");
  const cmp = compareCloseDistributions({ spot: S, sigma: 45 }, nickel, normCdf)!;
  assert.ok(cmp.tvDistance < 0.03, `tv ${cmp.tvDistance} (was 0.20 on strike buckets)`);
  assert.ok(Math.abs(nickel.sigma! - 45) < 1.5, `sigma ${nickel.sigma}`);
  assert.match(cmp.text, /strike-bucket detail below about 1% per bucket is mid-tick noise/);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const jitter = impliedClose(S, grid(S, w, 200).map((K) => { const b = bsF(S, K, sT); const j = (rnd() - 0.5) * 0.2; return { strike: K, callMid: q(b.callMid + j), putMid: q(b.putMid + j) }; }), w);
  assert.equal(jitter.state, "unavailable");
  assert.match(String(jitter.reason), /renormalised \(limit 5%\)|butterflies negative/);
});

test("skew: a smile with higher IV below recovers a median above the forward (longer lower tail), said in words", () => {
  const S = 6000, w = 5, sT = 0.0075;
  const ic = impliedClose(S, grid(S, w, 200).map((K) => ({ strike: K, ...bsF(S, K, sT * (1 + 0.2 * Math.max(0, (S - K) / 45))) })), w);
  assert.equal(ic.state, "ok");
  assert.ok(ic.median! > ic.forward!, `median ${ic.median} forward ${ic.forward}`);
  assert.ok((ic.diagnostics.sigmaFromVariance ?? 0) > ic.sigma!, "the fat lower tail shows in the variance sigma, not the IQR sigma");
  const cmp = compareCloseDistributions({ spot: S, sigma: 45 }, ic, normCdf)!;
  assert.match(cmp.text, /median \+[\d.]+ pts above its forward \(longer lower tail\)/);
  assert.match(cmp.text, /from its interquartile range/);
});
