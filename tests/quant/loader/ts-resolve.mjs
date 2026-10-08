// Resolves extensionless relative imports and the tsconfig aliases
// (@shared/*, @/*) so quant tests run on plain Node 22 without npm installs:
//   node --experimental-transform-types --no-warnings \
//     --import ./tests/quant/loader/register.mjs --test 'tests/quant/*.test.ts'
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ALIASES = [
  ["@shared/", path.join(ROOT, "shared") + "/"],
  ["@/", path.join(ROOT, "client/src") + "/"],
];

function candidates(p) {
  return [p, p + ".ts", p + ".tsx", path.join(p, "index.ts"), p.replace(/\.js$/, ".ts")];
}

export async function resolve(spec, ctx, next) {
  let abs = null;
  for (const [prefix, target] of ALIASES) {
    if (spec.startsWith(prefix)) abs = target + spec.slice(prefix.length);
  }
  if (!abs && (spec.startsWith(".") || spec.startsWith("/")) && ctx.parentURL?.startsWith("file:")) {
    abs = fileURLToPath(new URL(spec, ctx.parentURL));
  }
  if (abs) {
    for (const c of candidates(abs)) {
      if (existsSync(c) && statSync(c).isFile()) return next(pathToFileURL(c).href, ctx);
    }
  }
  return next(spec, ctx);
}
