// "Can I trust this app?" check: nothing a subscriber sees may tell them to
// trade. Fails the build when instruction phrases ("buy the dip", "size up",
// "take profits", ...) appear in client code or in the server modules that
// write user-facing text. Descriptions of what DEALERS do ("dealers buy dips")
// are allowed. Personal-edition files and filter word lists are exempt below,
// each with its reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { editionFromEnv, featureAllowed } from "../../shared/edition";

const ROOT = new URL("../../", import.meta.url).pathname;

const INSTRUCTION = /\b(buy (the )?(dip|dips|calls|puts)|sell (the )?(rip|rips|calls|puts|premium|wings)|size (up|down|half)|half size|full size|go long|go short|take (the )?profits?|take the trade|enter (long|short|now)|act on (it|this|the)|fade (the|into|rallies|extremes)|ride (the )?(trend|pullbacks)|load up|scale (in|out)|stand aside|you should (buy|sell|enter)|cut size)\b/gi;

// Files exempt from the check, with the reason.
const EXEMPT: Record<string, string> = {
  "server/routes.ts": "personal-edition EOD trade setup prompt (403 in the investor edition); other routes.ts text is checked by its own tests",
  "server/odteAlertEngine.ts": "personal-edition Discord alert text (Discord is off in the investor edition)",
  "server/discordBatcaveCard.ts": "personal-edition Discord card",
  "server/edgeBriefText.ts": "banned-phrase filter list",
  "server/edgeLabBrief.ts": "LLM prompt rules that forbid these phrases",
  "server/cosmos.ts": "banned-phrase filter list",
  "server/sources.ts": "sentiment keyword list (words counted in social posts)",
  "client/src/components/PreMarketGate.tsx": "opt-in personal checklist written by the owner, off by default",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// Strip comments so code notes about old behaviour do not count.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("no trade-instruction language in subscriber-facing text", () => {
  const files = [...walk(join(ROOT, "client/src")), ...walk(join(ROOT, "server"))];
  const hits: string[] = [];
  for (const abs of files) {
    const rel = abs.slice(ROOT.length);
    if (EXEMPT[rel]) continue;
    const src = stripComments(readFileSync(abs, "utf8"));
    for (const m of src.matchAll(INSTRUCTION)) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 40), m.index).toLowerCase();
      if (/dealer|market makers?|customers?/.test(before)) continue; // describes others' behaviour
      const line = src.slice(0, m.index).split("\n").length;
      hits.push(`${rel}:${line}: "${m[0]}"`);
    }
  }
  assert.deepEqual(hits, [], `instruction language found:\n${hits.join("\n")}`);
});

test("edition: personal by default, investor only when set; investor drops trade features", () => {
  assert.equal(editionFromEnv({}), "personal");
  assert.equal(editionFromEnv({ BATCAVE_EDITION: "investor" }), "investor");
  assert.equal(editionFromEnv({ BATCAVE_EDITION: " Investor " }), "investor");
  assert.equal(featureAllowed("eod-trade-setup", "personal"), true);
  assert.equal(featureAllowed("eod-trade-setup", "investor"), false);
  assert.equal(featureAllowed("discord-trade-cards", "investor"), false);
});
