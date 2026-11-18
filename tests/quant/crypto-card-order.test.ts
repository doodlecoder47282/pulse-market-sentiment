// The open coin card reads in one fixed order: verdict, why, risk, exit plan, record; the rest is collapsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../../client/src/components/CryptoPanel.tsx", import.meta.url), "utf8");
const desk = readFileSync(new URL("../../client/src/components/CoinDesk.tsx", import.meta.url), "utf8");
const order = (src: string, marks: string[]) => marks.map((m) => { const i = src.indexOf(m); assert.ok(i >= 0, `missing: ${m}`); return i; });
const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] < x);

test("the card's blocks are numbered and in order, and the plan and record follow before the collapsed detail", () => {
  const idx = order(panel, [
    '<CardBlock n={1} title="Verdict">',
    '<CardBlock n={2} title="Why">',
    '<CardBlock n={3} title="Risk">',
    '<CardBlock n={4} title="Exit plan · size and stops">',
    "{isOpen && <CoinDesk c={c} />}",
    'data-testid="crypto-card-more"',
    "{isOpen && <CoinLinks",
  ]);
  assert.ok(ascending(idx), `out of order: ${idx}`);
});

test("risk holds the kill flags, authorities, bundle, deployer history, price check and liquidity; nothing of it is under More detail", () => {
  const risk = panel.slice(panel.indexOf('<CardBlock n={3} title="Risk">'), panel.indexOf('<CardBlock n={4}'));
  for (const m of ["c.rugFlags.map", "mint {c.mintAuthorityActive", "<BundleRow bundle={c.bundle} />", "crypto-launch-context-", "price check · Jupiter", "crypto-liq-history-"]) {
    assert.ok(risk.includes(m), `risk block is missing ${m}`);
  }
  const more = panel.slice(panel.indexOf('data-testid="crypto-card-more-body"'), panel.indexOf("{isOpen && <CoinLinks"));
  for (const m of ["crypto-structure-", "crypto-candles-", "social · bsky", "data: DexScreener"]) assert.ok(more.includes(m), `More detail is missing ${m}`);
  for (const m of ["c.rugFlags.map", "price check · Jupiter"]) assert.ok(!more.includes(m), `${m} must not be collapsed`);
});

test("an empty reason list says so, and the detail toggle is a real button outside the card button with a phone-sized target", () => {
  assert.match(panel, /c\.verdictReasons\.length === 0 \? <p className="text-muted-foreground">no reasons recorded for this read<\/p>/);
  const toggle = panel.slice(panel.indexOf('data-testid="crypto-card-more"'), panel.indexOf('data-testid="crypto-card-more-body"'));
  assert.match(toggle, /<button type="button" onClick=\{\(\) => setMore\(\(v\) => !v\)\} aria-expanded=\{more\} className="[^"]*min-h-\[44px\]/);
  assert.ok(panel.indexOf("    </button>\n    {isOpen && <CoinDesk c={c} />}") < panel.indexOf('data-testid="crypto-card-more"'), "the toggle is not nested in the card button");
});

test("in the coin desk the exit plan and the record come before the grid of readings", () => {
  const idx = order(desk, ['data-testid="crypto-exit-plan"', "5 · Record", 'data-testid="crypto-plan-record"', 'data-testid="crypto-copy-prompt"', 'data-testid="crypto-coin-facts"']);
  assert.ok(ascending(idx), `out of order: ${idx}`);
});
