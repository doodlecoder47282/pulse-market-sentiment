// A root future (/ES) is read from Schwab's quotes answer whether it is keyed by the root or by the contract.
import test from "node:test";
import assert from "node:assert/strict";
import { futuresQuoteEntry, invalidSymbolsOf, isContractOf, isFutureRoot } from "../../server/schwabFutures";

test("root symbols and contract keys", () => {
  assert.ok(isFutureRoot("/ES") && isFutureRoot("/NQ") && isFutureRoot("/MES"));
  assert.ok(!isFutureRoot("SPY") && !isFutureRoot("$SPX") && !isFutureRoot("/ESZ26X"));
  assert.ok(isContractOf("/ES", "/ES") && isContractOf("/ES", "/ESZ26") && isContractOf("/NQ", "/NQH27"));
  assert.ok(!isContractOf("/ES", "/ESA26"), "A is not a month code");
  assert.ok(!isContractOf("/ES", "/ESZ2026") && !isContractOf("/ES", "/ESZ2"));
  assert.ok(!isContractOf("/M", "/MESZ26"), "a longer root is not a contract of a shorter one");
});

test("the entry is found under the root key or under one contract key", () => {
  const q = { assetMainType: "FUTURE", quote: { lastPrice: 7330.25 } };
  assert.deepEqual(futuresQuoteEntry({ "/ES": q }, "/ES"), { key: "/ES", entry: q });
  assert.deepEqual(futuresQuoteEntry({ "/ESZ26": q, SPY: {} }, "/ES"), { key: "/ESZ26", entry: q });
  assert.deepEqual(futuresQuoteEntry({ odd: { symbol: "/NQZ26", quote: {} } }, "/NQ")?.key, "odd");
});

test("no entry is chosen when there is none, when two contracts match, or for a non-future", () => {
  assert.equal(futuresQuoteEntry({ SPY: {}, errors: { invalidSymbols: ["/ES"] } }, "/ES"), null);
  assert.equal(futuresQuoteEntry({ "/ESZ26": {}, "/ESH27": {} }, "/ES"), null);
  assert.equal(futuresQuoteEntry({ "/NQZ26": {} }, "/ES"), null);
  assert.equal(futuresQuoteEntry({ SPY: {} }, "SPY"), null);
  assert.equal(futuresQuoteEntry(null, "/ES"), null);
});

test("Schwab's own list of unrecognised symbols is read, and absent means empty", () => {
  assert.deepEqual(invalidSymbolsOf({ errors: { invalidSymbols: ["/ES", 3] } }), ["/ES"]);
  assert.deepEqual(invalidSymbolsOf({ SPY: {} }), []);
  assert.deepEqual(invalidSymbolsOf(undefined), []);
});
