import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DefaultTooltipContent } from "recharts";
import { vixToAtmPct } from "../shared/vol";

// Execute exact source functions/blocks, not replicas. The VM has no imports,
// require, process, fetch, timers, providers, database or bootstrap. Only explicit
// fixture dependencies are injected. This also keeps routes.ts from starting jobs.
function source(file: string) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}
function nodes(file: ts.SourceFile, match: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
function evaluate(code: string, fixtures: Record<string, unknown> = {}) {
  return runInNewContext(ts.transpileModule(code, {
    fileName: "fixture.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText, fixtures, { timeout: 1000 });
}
function functions(file: string, names: string[], fixtures: Record<string, unknown> = {}) {
  const root = source(file);
  const texts = names.map(name => {
    const matches = nodes(root, n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.equal(matches.length, 1, `exact source function ${name}`);
    return matches[0].getText(root).replace(/^export\s+/, "");
  });
  return evaluate(`${texts.join("\n")}\n;({${names.join(",")}});`, fixtures);
}

test("Schwab chain spot fails closed for absent, null, nonfinite and nonpositive values", () => {
  const { buildPerTickerGamma } = functions("server/tickerAlpha.ts", ["approxGamma", "buildPerTickerGamma"]);
  const chain = (last: unknown) => ({
    underlying: { last },
    callExpDateMap: { "2026-10-02:1": { "100": [{ openInterest: 10, gamma: 0.02, volatility: 20 }] } },
  });
  for (const last of [undefined, null, "", 0, -1, NaN, Infinity, -Infinity, "invalid"]) {
    assert.equal(buildPerTickerGamma(chain(last), "TEST"), null, `invalid spot ${last}`);
  }
  assert.equal(buildPerTickerGamma(null, "TEST"), null);
  assert.equal(buildPerTickerGamma({ ...chain(100), error: "unavailable" }, "TEST"), null);
  assert.equal(buildPerTickerGamma({ underlying: { last: 100 } }, "TEST"), null);
});

test("valid spot and gamma/IV paths preserve GEX units and observed fallback price", () => {
  const { buildPerTickerGamma, approxGamma } = functions("server/tickerAlpha.ts", ["approxGamma", "buildPerTickerGamma"]);
  const chain = {
    underlying: { last: 100 },
    callExpDateMap: { "2026-10-02:1": { "100": [{ openInterest: 10, gamma: 0.02, volatility: 20 }] } },
  };
  const direct = buildPerTickerGamma(chain, "TEST");
  assert.equal(direct.spot, 100);
  assert.equal(direct.totalGex, 0.02 * 10 * 100 * 100 ** 2 * 0.01);
  const derived = buildPerTickerGamma({
    ...chain, underlying: { last: null }, underlyingPrice: "100",
    callExpDateMap: { "2026-10-02:1": { "100": [{ openInterest: 10, volatility: 20 }] } },
  }, "TEST");
  assert.equal(derived.spot, 100);
  assert.equal(derived.totalGex, approxGamma(100, 100, 1 / 365, 0.2) * 10 * 100 * 100 ** 2 * 0.01);
});

function trajectoryFixture() {
  const root = source("server/routes.ts");
  // Use the smallest try/catch containing attachment, including the guard.
  const matches = nodes(root, n => ts.isTryStatement(n) && n.getText(root).includes("q.weeklyTrajectory = traj;"));
  const block = matches.sort((a, b) => a.getWidth(root) - b.getWidth(root))[0];
  assert.ok(block);
  const fixtureModules = new Map([
    ["./jpmCollar", "jpmFixture"],
    ["./quarterlyTrajectory", "trajectoryModule"],
  ]);
  let imports = 0;
  const transformed = ts.transform(block, [context => {
    const visit: ts.Visitor = n => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = n.arguments[0];
        assert.ok(ts.isStringLiteral(arg));
        const replacement = fixtureModules.get(arg.text);
        assert.ok(replacement, `unexpected dependency ${arg.text}`);
        imports++;
        return ts.factory.createIdentifier(replacement);
      }
      return ts.visitEachChild(n, visit, context);
    };
    return n => ts.visitNode(n, visit) as ts.Node;
  }]);
  const code = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0], root);
  transformed.dispose();
  assert.equal(imports, 2);
  const calls: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  let jpmCalls = 0;
  const run = evaluate(`(async function(enriched, symbol, snap) {
    const getOrBuild = async () => snap;
    const vixData = {vix: 20, vix9d: 19, vix3m: 22};
    ${code}
    return enriched;
  });`, {
    console: { warn: (message: string) => warnings.push(message) },
    jpmFixture: { buildJPMCollarSnapshot: async () => {
      jpmCalls++;
      return { current: { shortPut: 6000, longPut: 5900, shortCall: 6200 } };
    } },
    trajectoryModule: { buildQuarterlyTrajectory: (input: Record<string, unknown>) => {
      calls.push(input);
      return { fixtureOnly: true, gammaFlip: input.gammaFlip };
    } },
  });
  return { run, calls, warnings, jpmCalls: () => jpmCalls };
}
const gammaSnapshot = (zeroGamma: unknown) => ({
  gamma: { zeroGamma, callWall: 610, putWall: 590, maxPain: 600, totalGex: 2e9 },
  composite: { score: 60 }, vol: { skew: { value: 110 } },
});

test("quarterly route omits only the optional trajectory for an unknown/invalid flip", async () => {
  const fixture = trajectoryFixture();
  for (const flip of [undefined, null, NaN, Infinity, -Infinity, 0, -1]) {
    const daily = { audit: { realizedSigma20d: 0.18 } };
    const quarterly = { spot: 6000 };
    const enriched = { horizons: { daily, quarterly }, warnings: ["existing"] };
    const result = await fixture.run(enriched, "^GSPC", gammaSnapshot(flip));
    assert.equal(result, enriched);
    assert.equal(result.horizons.daily, daily);
    assert.equal(Object.hasOwn(quarterly, "weeklyTrajectory"), false);
    assert.deepEqual(enriched.warnings, ["existing"]);
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.jpmCalls(), 0);
  assert.equal(fixture.warnings.length, 7);
});

test("quarterly route retains symbol-dependent gamma/collar scaling for valid inputs", async () => {
  const fixture = trajectoryFixture();
  for (const [symbol, scale, collarScale] of [["SPY", 1, 0.1], ["^GSPC", 10, 1]] as const) {
    const result = await fixture.run({
      horizons: { quarterly: { spot: 600 * scale }, daily: { audit: { realizedSigma20d: 0.18 } } },
    }, symbol, gammaSnapshot(599));
    const input = fixture.calls.at(-1)!;
    assert.equal(input.gammaFlip, 599 * scale);
    assert.equal(input.callWall, 610 * scale);
    assert.equal(input.putWall, 590 * scale);
    assert.equal(input.maxPain, 600 * scale);
    assert.equal(input.totalGex, 2e9);
    assert.equal(input.realizedVol20d, 0.18);
    assert.equal((input.jpmStrikes as { shortPut: number }).shortPut, 6000 * collarScale);
    assert.equal(result.horizons.quarterly.weeklyTrajectory.gammaFlip, 599 * scale);
  }
  assert.equal(fixture.warnings.length, 0);
});

function contractFixture() {
  const root = source("server/odteAlertEngine.ts");
  const fn = nodes(root, n => ts.isFunctionDeclaration(n) && n.name?.text === "buildAlert")[0] as ts.FunctionDeclaration;
  const statements = [...fn.body!.statements];
  const from = statements.findIndex(n => ts.isTypeAliasDeclaration(n) && n.name.text === "PickedContract");
  const to = statements.findIndex(n => n.getText(root).startsWith("let legacyContract:"));
  assert.ok(from >= 0 && to > from);
  const rejections: string[] = [];
  const pick = evaluate(`(function(args, side, t1Lv) {
    const setup = "PIVOT_RECLAIM", reversionLevel = {};
    ${statements.slice(from, to).map(n => n.getText(root)).join("\n")}
    return pickedContract;
  });`, {
    console: { log() {} },
    gateReject: (_a: unknown, _b: unknown, _c: unknown, _d: unknown, reason: string) => {
      rejections.push(reason); return null;
    },
  });
  const args = (strikes: Record<string, unknown>, spot = 6000) => ({
    spot,
    wire15: { todayExpKey: "2026-10-02:0", schwabChain: {
      callExpDateMap: { "2026-10-02:0": strikes }, putExpDateMap: { "2026-10-02:0": strikes },
    } },
  });
  return { pick, args, rejections };
}
const contract = (symbol: string, delta = 0.4) => [{
  symbol, delta, gamma: 0.02, theta: -1, vega: 2, bid: 9.9, ask: 10.1,
  volatility: 20, openInterest: 123, totalVolume: 456,
}];

test("typed 0DTE candidates retain contract identity, prices, Greeks and target preference", () => {
  const { pick, args, rejections } = contractFixture();
  const selected = pick(args({
    "5999": contract("OUTSIDE"), "6005": contract("CHOSEN"), "6010": contract("FURTHER"),
  }), "call", { price: 6020 });
  assert.equal(selected.key, "CHOSEN");
  assert.equal(selected.expiry, "2026-10-02");
  assert.equal(selected.strike, 6005);
  assert.equal(selected.midPrice, 10);
  assert.equal(selected.bid, 9.9);
  assert.equal(selected.ask, 10.1);
  assert.equal(selected.iv, 0.2);
  assert.equal(selected.gamma, 0.02);
  assert.equal(selected.theta, -1);
  assert.equal(selected.vega, 2);
  assert.equal(selected.openInterest, 123);
  assert.equal(selected.volume, 456);
  assert.equal(rejections.length, 0);
  const put = pick(args({ "5995": contract("PUT", -0.4), "6001": contract("OTHER", -0.4) }), "put", { price: 5980 });
  assert.equal(put.key, "PUT");
  assert.equal(put.delta, -0.4);
});

test("0DTE empty/out-of-band candidates fail closed; unavailable chain preserves legacy branch", () => {
  const { pick, args, rejections } = contractFixture();
  for (const strikes of [{}, { "6005": contract("LOW", 0.34) }, { "6005": contract("HIGH", 0.51) }]) {
    assert.equal(pick(args(strikes), "call", { price: 6020 }), null);
  }
  assert.deepEqual(rejections, Array(3).fill("CONTRACT_NO_STRIKE_IN_DELTA_BAND"));
  assert.equal(pick({ spot: 6000 }, "call", { price: 6020 }), null);
  assert.equal(rejections.length, 3);
  assert.equal(pick(args({ "5999": contract("NEAREST"), "5990": contract("FAR") }), "call", { price: 6020 }).key, "NEAREST");
  assert.equal(pick(args({ "6005": contract("MIN", 0.35) }), "call", { price: 6020 }).key, "MIN");
  assert.equal(pick(args({ "6005": contract("MAX", 0.50) }), "call", { price: 6020 }).key, "MAX");
});

test("model audit extreme signed charm cannot drift baseline spot without a validated mapping", () => {
  const { buildAudit } = functions("server/models.ts", ["buildAudit"], { vixToAtmPct });
  for (const charm of [0, 1e9, -1e9, 10e9, -10e9, 1e15, -1e15]) {
    const profile = {
      current: { charm, gex: 1e9, dex: 1e9, vex: 0 }, curve: [],
      zeroGammaSpot: null, zeroCharmSpot: null, zeroCharmSpots: [], charmSlope: 0,
      ranges: { charm: { min: -1e9, max: 1e9 } }, contractCount: 10, netCTrue: 5,
    };
    const result = buildAudit(profile, [], 1000, { change: null, windowMin: null }, {
      paths: [], scenarioProbIn: { bull: 30, base: 40, bear: 30 },
      iv1d: null, iv1dPrev: null, charmPrev: null, lastRecal: null,
    });
    assert.equal(result.charmPerDay, charm / 1e9);
    assert.equal(result.scenarioTargets.base, 1000);
    assert.equal(result.scenarioTargets.bull, 1005.5);
    assert.equal(result.scenarioTargets.bear, 994.5);
    assert.equal(result.scenarioTargets.oneDayEM, 5.5);
    assert.equal(result.mainPivot, null);
    assert.equal(result.charmZero, null);
  }
});

test("master alpha pivots preserve the selected candle timestamp and OHLC", async () => {
  const prior = { t: 1790861400, o: 100, h: 103, l: 99, c: 102, v: 500 };
  const latest = { ...prior, t: prior.t + 86400, c: 101 };
  let received: unknown;
  const { masterAlphaRoute } = functions("server/masterAlpha.ts", ["masterAlphaRoute"], {
    fetchOHLC: async () => ({ price: 20, candles: [prior, latest] }),
    buildModelsSnapshot: async () => ({ horizons: { daily: { fixture: true } } }),
    buildPivotBundle: (symbol: string, ohlc: unknown) => { received = { symbol, ...ohlc as object }; return received; },
    runMasterAlpha: async (input: unknown) => input,
  });
  let result: unknown;
  await masterAlphaRoute({ query: { symbol: "$SPX.X" } }, { json: (value: unknown) => { result = value; } });
  assert.deepEqual(JSON.parse(JSON.stringify(received)), { symbol: "^GSPC", t: prior.t, o: 100, h: 103, l: 99, c: 102 });
  assert.ok(result);
});

test("daily playbook magnets remain sorted literal kinds; scenario arithmetic is unchanged", async () => {
  const snap = { capturedAt: 1790861400, spy: { price: 600 },
    gamma: { spot: 600, callWall: 610, putWall: 590, zeroGamma: 599, maxPain: 601, totalGex: 2e9 },
    vol: { vix: { value: 20 } }, composite: { score: 50 },
  };
  const { buildDailyPlaybook } = functions("server/dailyPlaybook.ts",
    ["buildDailyPlaybook", "impliedDailySigma", "clamp01", "nowSec", "sessionET"],
    { getSnap: async () => snap, vixToAtmPct });
  const result = await buildDailyPlaybook("SPY");
  assert.deepEqual(Array.from(result.magnets, (m: { kind: string }) => m.kind), ["putWall", "gammaFlip", "spot", "maxPain", "callWall"]);
  assert.equal(result.paths.bull.probability, 0.28);
  assert.equal(result.paths.base.probability, 0.5);
  assert.equal(result.paths.bear.probability, 0.22);
});

test("range chart accessor uses actual low/high bounds at spot and EOD, not zero baseline", () => {
  const file = "client/src/components/DailyPlaybookChart.tsx";
  const { buildPathSeries } = functions(file, ["buildPathSeries"]);
  const paths = { bull: { target: { low: 105, high: 110 } },
    base: { target: { low: 98, high: 102 } }, bear: { target: { low: 90, high: 95 } } };
  const rows = buildPathSeries({ spot: 100, paths });
  const root = source(file);
  const area = nodes(root, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(root) === "Area")[0] as ts.JsxSelfClosingElement;
  const attr = area.attributes.properties.find(n => ts.isJsxAttribute(n) && n.name.getText(root) === "dataKey") as ts.JsxAttribute;
  const expression = (attr.initializer as ts.JsxExpression).expression!;
  for (const k of ["bull", "base", "bear"] as const) {
    const accessor = evaluate(`(${expression.getText(root)});`, { k });
    assert.deepEqual(Array.from(accessor(rows[0])), [100, 100]);
    assert.deepEqual(Array.from(accessor(rows.at(-1))), [paths[k].target.low, paths[k].target.high]);
    for (const row of rows) assert.ok(accessor(row)[0] <= accessor(row)[1]);
  }
  assert.equal(area.attributes.properties.some(n => ts.isJsxAttribute(n) && n.name.getText(root) === "baseLine"), false);
});

test("seasonality analysis consumes yearly fields without inventing a yearly lookback property", () => {
  const { generateAnalysisText } = functions("server/seasonality.ts", ["generateAnalysisText"]);
  const text = generateAnalysisText("TEST", null, {
    fullYearAvg: 8.5, fullYearWinRate: 0.7, presidentialCycleYear: 2, presidentialCycleAvg: null,
  }, 20);
  assert.match(text, /past 20 years/);
  assert.match(text, /\+8.5%/);
  assert.match(text, /win rate 70%/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test("magnet labels preserve exact names/values in wrapping HTML outside the clipped SVG", () => {
  const file = "client/src/components/DailyPlaybookChart.tsx";
  const { MagnetLegend } = functions(file, ["MagnetLegend", "fmt$"], {
    React: { createElement },
    MAGNET_COLORS: { spot: "#60a5fa", maxPain: "#a78bfa", gammaFlip: "#fbbf24", callWall: "#10b981", putWall: "#ef4444" },
  });
  const magnets = [
    { kind: "spot", label: "Spot", level: 764.74, strength: "secondary" },
    { kind: "maxPain", label: "Max Pain", level: 765, strength: "secondary" },
    { kind: "gammaFlip", label: "Gamma Flip", level: 768.82, strength: "primary" },
    { kind: "callWall", label: "Call Wall", level: 785, strength: "primary" },
    { kind: "putWall", label: "Put Wall", level: 745, strength: "primary" },
  ];
  const markup = renderToStaticMarkup(createElement(MagnetLegend, { magnets }));
  assert.equal((markup.match(/<li /g) ?? []).length, magnets.length);
  for (const m of magnets) {
    assert.ok(markup.includes(m.label));
    assert.ok(markup.includes(m.level.toFixed(2)));
  }
  assert.match(markup, /aria-label="Chart level magnets"/);
  assert.match(markup, /flex-wrap/);
  assert.equal((markup.match(/class="font-mono text-foreground"/g) ?? []).length, magnets.length);
  assert.doesNotMatch(markup, /style="color:/, "readable price text uses theme foreground, not pastel line colors");
  assert.doesNotMatch(markup, /<svg|truncate|overflow-hidden|text-ellipsis/);
  const root = source(file);
  const rightLabels = nodes(root, n => ts.isJsxAttribute(n) && n.name.getText(root) === "position"
    && ts.isStringLiteral(n.initializer!) && n.initializer.text === "right");
  assert.equal(rightLabels.length, 0, "no magnet label can extend beyond the right SVG edge");
  assert.match(root.getText(), /<MagnetLegend magnets=\{magnets\} \/>/);
});

test("playbook tooltip explicitly themes background, heading and every range/scalar item", () => {
  const root = source("client/src/components/DailyPlaybookChart.tsx");
  const tooltip = nodes(root, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(root) === "Tooltip")[0] as ts.JsxSelfClosingElement;
  const props = Object.fromEntries(["contentStyle", "labelStyle", "itemStyle", "formatter", "labelFormatter"].map(name => {
    const attr = tooltip.attributes.properties.find(n => ts.isJsxAttribute(n) && n.name.getText(root) === name) as ts.JsxAttribute;
    const expression = (attr.initializer as ts.JsxExpression).expression!;
    return [name, evaluate(`(${expression.getText(root)});`)];
  }));
  assert.equal(props.contentStyle.backgroundColor, "hsl(var(--popover))");
  for (const style of [props.contentStyle, props.labelStyle, props.itemStyle]) {
    assert.equal(style.color, "hsl(var(--popover-foreground))");
  }
  assert.deepEqual(Array.from(props.formatter([745, 785], "bullBand")), ["$745.00 – $785.00", "Bull range"]);
  assert.deepEqual(Array.from(props.formatter(765, "baseMid")), ["$765.00", "Base mid"]);
  const markup = renderToStaticMarkup(createElement(DefaultTooltipContent, {
    ...props, label: 0.5,
    payload: [{ name: "bullBand", value: [745, 785], color: "none" }, { name: "baseMid", value: 765, color: "#a3a3a3" }],
  }));
  assert.match(markup, /50% through session/);
  assert.match(markup, /Bull range/);
  assert.match(markup, /\$745\.00 – \$785\.00/);
  assert.match(markup, /\$765\.00/);
  assert.equal((markup.match(/color:hsl\(var\(--popover-foreground\)\)/g) ?? []).length, 4);
  assert.doesNotMatch(markup, /color:none|background(?:-color)?:#0a0a0a/);
});

test("keyboard labels and actual numeric handler target rendered panels; key 7 is Cosmos", () => {
  const root = source("client/src/hooks/use-keyboard-shortcuts.ts");
  const labels = nodes(root, n => ts.isVariableDeclaration(n) && n.name.getText(root) === "TAB_LABELS")[0] as ts.VariableDeclaration;
  const keys = nodes(root, n => ts.isVariableDeclaration(n) && n.name.getText(root) === "TAB_KEYS")[0] as ts.VariableDeclaration;
  const values = evaluate(`(${labels.initializer!.getText(root)});`);
  const context = source("client/src/components/TickerContext.tsx");
  const tabType = nodes(context, n => ts.isTypeAliasDeclaration(n) && n.name.text === "TabKey")[0] as ts.TypeAliasDeclaration;
  const expected = (tabType.type as ts.UnionTypeNode).types.map(n => ((n as ts.LiteralTypeNode).literal as ts.StringLiteral).text);
  assert.deepEqual(Object.keys(values).sort(), expected.sort());
  assert.equal(values.heatseeker, "Heatseeker");
  assert.equal(values.crypto, "Crypto");
  assert.equal(values.cosmos, "Cosmos");
  const numericKeys = Array.from(evaluate(`(${keys.initializer!.getText(root)});`));
  assert.deepEqual(numericKeys,
    ["signals", "chart", "models", "tradedesk", "regime", "news", "cosmos", "takefive"]);
  const dashboard = source("client/src/pages/dashboard.tsx");
  const panels = nodes(dashboard, n => ts.isJsxOpeningElement(n) && n.tagName.getText(dashboard) === "TabsContent")
    .map(n => (n as ts.JsxOpeningElement).attributes.properties
      .find(a => ts.isJsxAttribute(a) && a.name.getText(dashboard) === "value") as ts.JsxAttribute)
    .map(a => (a.initializer as ts.StringLiteral).text);
  for (const tab of Object.keys(values)) assert.ok(panels.includes(tab), `rendered panel for ${tab}`);

  let handler: (event: unknown) => void = () => assert.fail("keyboard handler not installed");
  let selected: string | undefined;
  let prevented = 0;
  const { useKeyboardShortcuts } = functions("client/src/hooks/use-keyboard-shortcuts.ts", ["useKeyboardShortcuts"], {
    TAB_KEYS: numericKeys,
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => unknown) => effect(),
    window: { addEventListener: (_name: string, listener: typeof handler) => { handler = listener; } },
  });
  useKeyboardShortcuts({ activeTab: "signals", setActiveTab: (tab: string) => { selected = tab; },
    setTake5Open() {}, take5Open: false, setHelpOpen() {}, helpOpen: false });
  for (let key = 1; key <= 8; key++) {
    handler({ key: String(key), target: { tagName: "BUTTON" }, preventDefault: () => { prevented++; } });
    assert.equal(selected, numericKeys[key - 1]);
    assert.ok(panels.includes(selected!), `key ${key} has rendered content`);
  }
  assert.equal(prevented, 8);
  const help = readFileSync("client/src/components/ShortcutsModal.tsx", "utf8");
  assert.match(help, /TAB_KEYS as TAB_ORDER/);
  assert.doesNotMatch(help, /"voices"/);
});
