import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareRuntimeDirectory } from "./runtime-directory.mjs";

// Production launcher: keep every relative DB, cache, backup and session file
// in its edition-owned directory. Never copy data or credentials from source.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edition = process.env.BATCAVE_EDITION;
const directory = process.env.BATCAVE_RUNTIME_DIR;
if (!directory) throw new Error("Set BATCAVE_RUNTIME_DIR to a new persistent directory outside the source tree.");
const cwd = prepareRuntimeDirectory(directory, edition, root);
const env = { ...process.env, NODE_ENV: "production" };
if (edition === "demo") {
  env.PULSE_ML_RETRAIN_ENABLED = "0";
  env.PULSE_ML_DATALOG = "0";
  env.PULSE_ML_AUTOSTART = "0";
  delete env.PULSE_ML_URL;
  for (const key of Object.keys(env)) if (key.startsWith("SCHWAB_")) delete env[key];
}
const child = spawn(process.execPath, [path.join(root, "dist/index.cjs")], { cwd, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("Isolated runtime could not start."); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
