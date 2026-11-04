// Background styles: navy is the default, every option has tokens, the choice
// is painted before the app loads and saved per device with storage guarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("navy is the default background and every listed style has its CSS (black keeps the original tokens)", () => {
  const ctx = src("client/src/components/ThemeContext.tsx");
  const ids = [...ctx.matchAll(/\{ id: "([a-z-]+)", label:/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["navy", "navy-glow", "graphite", "black"]);
  assert.match(ctx, /return "navy";/);
  const css = src("client/src/index.css");
  for (const id of ids.filter((x) => x !== "black")) assert.match(css, new RegExp(`\\.dark\\[data-bg="${id}"\\]`), id);
  assert.match(css, /\.dark\[data-bg="navy"\][^{]*\{[^}]*--background: 219 57% 9%;/, "navy surface = #0A1324");
  assert.match(css, /--primary: 217 100% 68%;/, "navy accent = #5B9BFF");
});

test("the saved style is painted before the app loads and storage is always guarded", () => {
  const html = src("client/index.html");
  assert.match(html, /localStorage\.getItem\("batcave:background"\)/);
  assert.match(html, /catch\(e\)\{document\.documentElement\.setAttribute\("data-bg","navy"\)/);
  assert.match(html, /<meta name="theme-color" content="#0A1324" \/>/);
  const ctx = src("client/src/components/ThemeContext.tsx");
  assert.match(ctx, /try \{ window\.localStorage\.setItem\(BG_KEY, b\); \} catch/);
  assert.match(ctx, /try \{\n\s+const v = window\.localStorage\.getItem\(BG_KEY\);/);
});

test("Settings offers the picker in both the live and the demo dialog, as an accessible radio group with full tap targets", () => {
  const s = src("client/src/components/SchwabSettings.tsx");
  assert.equal((s.match(/<BackgroundPicker \/>/g) ?? []).length, 2);
  const p = src("client/src/components/BackgroundPicker.tsx");
  assert.match(p, /role="radiogroup"/);
  assert.match(p, /role="radio"\n\s+aria-checked=\{on\}/);
  assert.match(p, /min-h-\[56px\]/);
});
