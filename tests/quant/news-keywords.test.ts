import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKET_UP, MARKET_DOWN, buildDeterministicAlphaBrief } from "../../server/alphaEngine";

test("a move word is a market move only next to a market", () => {
  for (const t of ["Stocks rally to record after Fed signals cuts", "Wall Street surges as yields fall", "Rally in tech shares lifts Nasdaq", "Oil jumps 4%"]) assert.match(t, MARKET_UP, t);
  for (const t of ["Croatians rally in Zagreb demanding justice over psychiatric hospital death", "Campaign rally draws thousands", "Surge in flu cases worries hospitals", "Lakers rip Celtics"]) assert.doesNotMatch(t, MARKET_UP, t);
  for (const t of ["Nasdaq has its worst week since 2020; Dow, S&P 500 in correction", "Stocks plunge as war escalates", "Bitcoin crashes below 60,000"]) assert.match(t, MARKET_DOWN, t);
  for (const t of ["Newspaper issues correction to Sunday story", "Two hurt in highway crash", "Rout in the semifinal"]) assert.doesNotMatch(t, MARKET_DOWN, t);
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
});
