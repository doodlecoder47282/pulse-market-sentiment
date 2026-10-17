import { mkdirSync, realpathSync, readdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import path from "node:path";

/** Fail closed rather than silently adopting unknown historical market data. */
export function prepareRuntimeDirectory(directory, edition, sourceRoot) {
  if (!path.isAbsolute(directory)) throw new Error("Runtime directory must be absolute.");
  if (!["personal", "investor", "demo"].includes(edition)) throw new Error("Choose an explicit edition.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(directory);
  const source = realpathSync(sourceRoot);
  if (resolved === source || resolved.startsWith(source + path.sep)) {
    throw new Error("Runtime directory must be outside the source tree.");
  }
  const marker = path.join(resolved, ".batcave-runtime.json");
  const entries = readdirSync(resolved);
  if (!entries.includes(".batcave-runtime.json")) {
    if (entries.length) throw new Error("Unmarked runtime is not empty. Audit its provenance before migration.");
    writeFileSync(marker, JSON.stringify({ version: 1, edition }) + "\n", { flag: "wx", mode: 0o600 });
  }
  if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) throw new Error("Invalid runtime marker.");
  const saved = JSON.parse(readFileSync(marker, "utf8"));
  if (saved.version !== 1 || saved.edition !== edition) throw new Error("Runtime edition mismatch. Use a separate clean directory.");
  if (entries.some(name => name === ".env" || name.startsWith(".env."))) {
    throw new Error("Runtime env files are not allowed. Configure secrets in the hosting environment.");
  }
  return resolved;
}
