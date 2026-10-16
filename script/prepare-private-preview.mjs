// Run after npm run build. Copies only public build assets, never server code,
// .env files, token stores or databases. Railway dist/public remains unchanged.
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
const port = process.argv[2] ?? "5089";
if (!/^\d{4,5}$/.test(port) || Number(port) > 65535) throw new Error("Invalid preview port");
const output = path.resolve("dist/private-preview");
rmSync(output, { recursive: true, force: true }); // Generated assets only.
mkdirSync(output, { recursive: true });
cpSync(path.resolve("dist/public"), output, { recursive: true });
const file = path.join(output, "index.html");
const html = readFileSync(file, "utf8");
// The opaque preview iframe has no browser persistence. Replace the compiled
// storage accesses in this COPY with an explicit page-lifetime Storage facade.
// The normal build retains its guarded device-settings behavior.
const bootstrap = `<script>
window.__BATCAVE_PREVIEW_API_BASE__ = "__PORT_${port}__";
window.__BATCAVE_PREVIEW_STORAGE__ = (function () {
  var values = new Map();
  return {
    getItem: function(k) { return values.has(String(k)) ? values.get(String(k)) : null; },
    setItem: function(k,v) { values.set(String(k),String(v)); },
    removeItem: function(k) { values.delete(String(k)); },
    clear: function() { values.clear(); },
    key: function(i) { return Array.from(values.keys())[i] || null; },
    get length() { return values.size; }
  };
})();
</script>`;
writeFileSync(file, html.replace("<head>", `<head>\n${bootstrap}`));
for (const name of readdirSync(path.join(output, "assets"))) {
  if (!name.endsWith(".js")) continue;
  const asset = path.join(output, "assets", name);
  const code = readFileSync(asset, "utf8");
  if (/\b(sessionStorage|indexedDB)\b/.test(code)) throw new Error("Unreviewed persistence API in preview build");
  writeFileSync(asset, code.replace(/\blocalStorage\b/g, "__BATCAVE_PREVIEW_STORAGE__"));
}
console.log("Prepared private preview assets without server secrets.");
