import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKET_UP, MARKET_DOWN, buildDeterministicAlphaBrief } from "../../server/alphaEngine";

test("a move word is a market move only next to a market", () => {
  for (const t of ["Stocks rally to record after Fed signals cuts", "Wall Street surges as yields fall", "Rally in tech shares lifts Nasdaq", "Oil jumps 4%", "Rally in U.S. stocks fizzles", "Chipmakers rally", "Tech rally fades"]) assert.match(t, MARKET_UP, t);
  for (const t of ["Croatians rally in Zagreb demanding justice over psychiatric hospital death", "Campaign rally draws thousands", "Surge in flu cases worries hospitals", "Lakers rip Celtics", "10-year yield jumps after hot CPI", "Dollar index jumps to two-year high", "Bonds rally as growth fears mount"]) assert.doesNotMatch(t, MARKET_UP, t);
  for (const t of ["Nasdaq has its worst week since 2020; Dow, S&P 500 in correction", "Stocks plunge as war escalates", "Bitcoin crashes below 60,000", "Crash in U.S. stocks wipes out gains", "Nikkei crash: worst day since 1987", "Tech rout deepens", "Stocks sink", "Tech stocks sell off"]) assert.match(t, MARKET_DOWN, t);
  for (const t of ["Newspaper issues correction to Sunday story", "Two hurt in highway crash", "Rout in the semifinal", "Yields tumble after weak jobs report", "Dollar plunges after Fed cut"]) assert.doesNotMatch(t, MARKET_DOWN, t);
});

test("the brief no longer tags a protest as bullish", () => {
  const b = buildDeterministicAlphaBrief([
    { title: "Croatians rally in Zagreb demanding justice over psychiatric hospital death - Reuters", source: "Reuters" },
    { title: "Nasdaq has its worst week since 2020; Dow, S&P 500 in correction - Reuters", source: "Reuters" },
  ]);
  assert.doesNotMatch(b, /Croatians/);
  assert.match(b, /Nasdaq has its worst week[^|]*\| SENTIMENT \| \d+\/10 \| Bearish/);
});

test("the earnings topic needs an earnings phrase, not the bare words beat or miss", () => {
  const src = readFileSync("server/news.ts", "utf8");
  const line = src.split("\n").find((l) => l.trimStart().startsWith("EARNINGS: ["))!;
  const res = [...line.matchAll(/\/((?:[^\/\\]|\\.)+)\/i/g)].map((m) => new RegExp(m[1], "i"));
  const hit = (t: string) => res.some((r) => r.test(t));
  assert.ok(res.length >= 5);
  assert.equal(hit("Alcaraz digs deep to beat Shelton, will face world number one Zverev in final"), false);
  assert.equal(hit("Team misses playoffs"), false);
  assert.equal(hit("Nvidia beats estimates as data-center revenue jumps"), true);
  assert.equal(hit("Target profit falls, guidance cut"), true);
  assert.equal(hit("Apple earnings due Thursday"), true);
  for (const t of ["Apple beats on revenue", "Microsoft beats Wall Street expectations", "Amazon beats analyst estimates", "Walmart tops Q3 estimates", "Netflix misses subscriber estimates", "Nvidia reports fiscal third-quarter results"]) assert.equal(hit(t), true, t);
});

test("a rates or dollar headline gets no direction tag from a move word", () => {
  const b = buildDeterministicAlphaBrief([{ title: "10-year yield jumps after hot CPI", source: "Reuters" }]);
  assert.doesNotMatch(b, /\| Bullish \|/);
});
