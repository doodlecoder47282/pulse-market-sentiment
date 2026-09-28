// Static inventory only: never starts services or reads runtime databases/secrets.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n")
  .filter(p => /\.(ts|tsx|js|mjs|cjs|py|sh|bat|swift)$/.test(p) && !p.startsWith("data/"));
const totals = new Map();
const rows = paths.map(p => {
  const text = fs.readFileSync(p, "utf8");
  const group = p.includes("/") ? p.split("/")[0] : "root";
  totals.set(group, (totals.get(group) ?? 0) + 1);
  const hosts = [...new Set([...text.matchAll(/https:\/\/[a-zA-Z0-9.-]+/g)].map(m => new URL(m[0]).hostname))];
  const tags = [
    /\bfetch\(/.test(text) && "network",
    /sqlite|\.prepare\(/.test(text) && "database",
    /setInterval|cron\.|schedule\(/.test(text) && "scheduler",
    /Math\.random/.test(text) && "randomness",
    /messages\.create|chat\.completions/.test(text) && "LLM",
    /kelly|probability|gamma\(/i.test(text) && "calculation",
  ].filter(Boolean);
  return `| \`${p}\` | ${text.split("\n").length} | ${tags.join(", ") || "—"} | ${hosts.join(", ") || "—"} |`;
});
fs.mkdirSync("docs", {recursive: true});
fs.writeFileSync("docs/REVIEW_INVENTORY.md", [
  "# Batcave source inventory", "",
  `Generated from tracked source paths. ${paths.length} source/script files received static inventory scanning.`,
  "Tags and hosts are lexical leads, not proof that a path executes or that a calculation is correct.",
  "Comments may contribute host names. Runtime databases, credentials, and generated build bundles are not read.", "",
  ...[...totals].map(([group,n]) => `- **${group}:** ${n} files.`), "",
  "| File | Lines | Review leads | Referenced HTTPS hosts |", "|---|---:|---|---|", ...rows, "",
].join("\n"));
console.log(JSON.stringify({files:paths.length,groups:Object.fromEntries(totals)}));
