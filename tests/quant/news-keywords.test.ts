import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKET_UP, MARKET_DOWN, buildDeterministicAlphaBrief } from "../../server/alphaEngine";

const up = (t: string) => MARKET_UP.test(t), down = (t: string) => MARKET_DOWN.test(t);

test("a move word is a market move only next to a market, in the same clause", () => {
  for (const t of ["Stocks rally to record after Fed signals cuts", "Wall Street surges as yields fall", "Rally in tech shares lifts Nasdaq", "Oil jumps 4%", "Rally in U.S. stocks fizzles", "Chipmakers rally", "Shares of Nvidia jump 8%", "Stocks rally as dollar slides", "Bitcoin soars past 100,000"]) assert.equal(up(t), true, t);
  for (const t of ["Croatians rally in Zagreb demanding justice over psychiatric hospital death", "Campaign rally draws thousands", "Surge in flu cases worries hospitals", "Lakers rip Celtics",
    "10-year yield jumps after hot CPI", "Dollar index jumps to two-year high", "Consumer price index jumps 0.4%", "Bonds rally as growth fears mount", "Stocks fall as Trump rally draws crowd",
    "Stocks fall, while protesters rally in Paris", "Market share of EVs surges", "Labor market cools as jobless claims jump", "Gold Coast tourism surges", "Biles wins gold as US team soars", "Chips Act funding surges",
    "Surge in U.S. Treasury yields rattles markets"]) assert.equal(up(t), false, t);
  for (const t of ["Nasdaq has its worst week since 2020; Dow, S&P 500 in correction", "Stocks plunge as war escalates", "Bitcoin crashes below 60,000", "Crash in U.S. stocks wipes out gains", "Nikkei crash: worst day since 1987", "Stocks sink", "Nasdaq index slides", "Oil prices plunge", "Dow slumps 500 points"]) assert.equal(down(t), true, t);
  for (const t of ["Newspaper issues correction to Sunday story", "Two hurt in highway crash", "Rout in the semifinal", "Yields tumble after weak jobs report", "Dollar plunges after Fed cut",
    "Stocks rally as dollar slides", "Gold hits record as dollar slides", "Oil tanker sinks off Yemen", "Ship carrying copper sinks", "Ticketmaster site crashes as tech fails", "Crypto exchange crashes during peak traffic",
    "Housing market slump deepens", "Job market slides", "Silver Alert issued as search for missing man slides", "Stock car crash at Daytona"]) assert.equal(down(t), false, t);
});

test("the matcher is linear: a long hostile text returns at once", () => {
  const t0 = Date.now();
  MARKET_UP.test("stocks " + "a.".repeat(4000) + "x " + "rally ".repeat(4000));
  MARKET_DOWN.test("a. ".repeat(20000));
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
});

test("the brief: a protest is not tagged, a yields headline gets no direction from a move word", () => {
  const b = buildDeterministicAlphaBrief([
    { title: "Croatians rally in Zagreb demanding justice over psychiatric hospital death - Reuters", source: "Reuters" },
    { title: "Nasdaq has its worst week since 2020; Dow, S&P 500 in correction - Reuters", source: "Reuters" },
  ]);
  assert.doesNotMatch(b, /Croatians/);
  assert.match(b, /Nasdaq has its worst week[^|]*\| SENTIMENT \| \d+\/10 \| Bearish/);
  assert.doesNotMatch(buildDeterministicAlphaBrief([{ title: "10-year yield jumps after hot CPI", source: "Reuters" }]), /\| Bullish \|/);
  assert.doesNotMatch(buildDeterministicAlphaBrief([{ title: "Stocks rally as dollar slides", source: "Reuters" }]), /\| Bearish \|/);
});

test("the earnings topic needs an earnings phrase, not the bare words beat or miss, and not a macro print", () => {
  const src = readFileSync("server/news.ts", "utf8");
  const a = src.indexOf("  EARNINGS: ["), block = src.slice(a, src.indexOf("],", a));
  const res = block.split("\n").flatMap((l) => [...l.matchAll(/\/((?:[^\/\\\n]|\\.)+)\/i/g)].map((m) => new RegExp(m[1], "i")));
  const hit = (t: string) => res.some((r) => r.test(t));
  assert.ok(res.length >= 8, String(res.length));
  for (const t of ["Alcaraz digs deep to beat Shelton, will face world number one Zverev in final", "Team misses playoffs", "Trump tops polls", "CPI tops forecasts", "GDP misses estimates", "Payrolls beat consensus", "Third-quarter GDP rises 2.8%"]) assert.equal(hit(t), false, t);
  for (const t of ["Nvidia beats estimates as data-center revenue jumps", "Target profit falls, guidance cut", "Apple earnings due Thursday", "Apple beats on revenue", "Microsoft beats Wall Street expectations", "Amazon beats analyst estimates",
    "Walmart tops Q3 estimates", "Netflix misses subscriber estimates", "Nvidia reports fiscal third-quarter results", "Meta beats on top and bottom lines"]) assert.equal(hit(t), true, t);
});
