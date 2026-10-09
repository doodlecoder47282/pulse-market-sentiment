import { stripTypeScriptTypes } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
let bad = 0, n = 0;
for (const dir of ["server", "shared"]) {
  for (const f of readdirSync(dir, { recursive: true })) {
    if (!String(f).endsWith(".ts")) continue;
    const p = `${dir}/${f}`; n++;
    try {
      const js = stripTypeScriptTypes(readFileSync(p, "utf8"), { mode: "transform" });
      new vm.SourceTextModule(js, { identifier: p });
    } catch (e) { bad++; console.log("PARSE FAIL", p, String(e.message).split("\n")[0]); }
  }
}
console.log(`parsed ${n} files, ${bad} failures`);
