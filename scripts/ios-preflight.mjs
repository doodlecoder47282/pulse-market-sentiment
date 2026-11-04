// Deterministic structural checks. Not a Swift compile, secret audit, or device test.
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
// Resolve the parsers shipped with the pinned Capacitor CLI, not global tools.
const capRequire = createRequire(require.resolve("@capacitor/cli/package.json"));
const xcode = capRequire("xcode");
const plist = capRequire("plist");
const read = p => readFileSync(p, "utf8");
const json = p => JSON.parse(read(p));
const pass = text => console.log(`PASS ${text}`);

assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Use Node 22+.");
const pkg = json("package.json");
const lock = json("package-lock.json");
for (const name of ["@capacitor/core", "@capacitor/ios", "@capacitor/cli"]) {
  const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  assert.equal(declared, "8.5.2", `${name} version drift`);
  assert.equal(lock.packages[`node_modules/${name}`].version, declared);
}
pass("Node and locked Capacitor versions");

const project = xcode.project("ios/App/App.xcodeproj/project.pbxproj");
project.parseSync();
assert.equal(project.getFirstTarget().firstTarget.name, "App");
const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
const scheme = read("ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme");
assert.ok(scheme.includes(`BlueprintIdentifier="${project.getFirstTarget().uuid}"`));
for (const p of [
  "App/AppDelegate.swift", "App/SceneDelegate.swift", "App/Info.plist",
  "App/Base.lproj/Main.storyboard", "App/Base.lproj/LaunchScreen.storyboard",
  "CapApp-SPM/Package.swift", "CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift",
]) assert.ok(existsSync(`ios/App/${p}`), `Missing ${p}`);
assert.ok(existsSync("ios/debug.xcconfig"));
const swiftPackage = read("ios/App/CapApp-SPM/Package.swift");
assert.ok(swiftPackage.includes('exact: "8.5.2"'));
assert.ok(swiftPackage.includes(".iOS(.v15)"));
const info = plist.parse(read("ios/App/App/Info.plist"));
assert.equal(info.UILaunchStoryboardName, "LaunchScreen");
assert.equal(info.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName,
  "$(PRODUCT_MODULE_NAME).SceneDelegate");
assert.ok(!info.NSAppTransportSecurity?.NSAllowsArbitraryLoads, "Unsafe ATS override");
pass("Parsed Xcode project, shared scheme, Swift sources, plist and SPM wiring");

const config = json("ios/App/App/capacitor.config.json");
// Owner's choice (2026-11-03): the app loads the terminal LIVE from the owner's
// server (capacitor.config.json server.url), so merges reach the phone without an
// Xcode rebuild. The bundled dist/public copy is the fallback shell only.
assert.equal(config.webDir, "dist/public");
assert.ok(typeof config.server?.url === "string" && /^https:\/\/[a-z0-9.-]+\.up\.railway\.app\/?$/.test(config.server.url), "server.url must be the owner's https Railway address");
assert.ok(config.server?.cleartext !== true, "No cleartext to the live server");
assert.ok(!existsSync("capacitor.config.ts"), "One Capacitor config only: capacitor.config.ts would silently override capacitor.config.json");
const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(m=>m[1].replaceAll('"',""));
assert.ok(ids.length >= 2 && ids.every(id=>id===config.appId), "Debug/Release bundle IDs must match capacitor.config.json");
pass("App ID, bundled origin and no remote server.url");

const walk = dir => readdirSync(dir, {withFileTypes:true}).flatMap(e => {
  const p=path.join(dir,e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const files = walk("dist/public");
assert.ok(files.includes("dist/public/index.html"));
for (const file of files) {
  const dest = file.replace("dist/public", "ios/App/App/public");
  assert.ok(existsSync(dest), `Missing synced asset: ${dest}`);
  assert.deepEqual(readFileSync(dest), readFileSync(file), `Stale synced asset: ${dest}`);
  assert.ok(!/\.(?:db|sqlite|sqlite3|pem|p12|mobileprovision|map)$/.test(file), `Unexpected bundled file: ${file}`);
}
const html=read("dist/public/index.html");
for (const match of html.matchAll(/(?:src|href)="(\.?\/assets\/[^"]+)"/g)) {
  assert.ok(existsSync(path.join("dist/public",match[1].replace(/^\.?\//,""))), `Missing entry asset ${match[1]}`);
}
assert.ok(html.includes("viewport-fit=cover"));
pass(`${files.length} fallback-shell files match their synced Xcode copies`);

const iconDir="ios/App/App/Assets.xcassets/AppIcon.appiconset";
for (const image of json(`${iconDir}/Contents.json`).images) {
  const png=readFileSync(`${iconDir}/${image.filename}`);
  assert.equal(png.subarray(1,4).toString(),"PNG");
  assert.equal(png.readUInt32BE(16),1024);
  assert.equal(png.readUInt32BE(20),1024);
  assert.equal(png[25],2,"App icon must be opaque RGB");
}
pass("1024px opaque app icon");
console.log("STRUCTURAL PREFLIGHT PASSED. Swift compilation, signing and device runtime remain unverified here.");
