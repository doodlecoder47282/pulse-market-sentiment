import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMainDbPath } from "../../server/dbPath";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rw-vol-"));

test("no volume: data.db stays in the working directory (local runs unchanged)", () => {
  const cwd = tmp();
  assert.equal(resolveMainDbPath({}, cwd), path.join(cwd, "data.db"));
});

test("Railway volume: data.db lives on the volume, so a redeploy keeps the Schwab login", () => {
  const cwd = tmp();
  const vol = path.join(cwd, "data");
  assert.equal(resolveMainDbPath({ RAILWAY_VOLUME_MOUNT_PATH: vol }, cwd), path.join(vol, "data.db"));
});

test("older build's data.db is copied onto the volume once, never over an existing one", () => {
  const cwd = tmp();
  const vol = path.join(cwd, "data");
  fs.writeFileSync(path.join(cwd, "data.db"), "old");
  const p = resolveMainDbPath({ RAILWAY_VOLUME_MOUNT_PATH: vol }, cwd);
  assert.equal(fs.readFileSync(p, "utf8"), "old");
  fs.writeFileSync(p, "volume-copy");
  resolveMainDbPath({ RAILWAY_VOLUME_MOUNT_PATH: vol }, cwd);
  assert.equal(fs.readFileSync(p, "utf8"), "volume-copy");
});

test("BATCAVE_DB_PATH wins over the volume", () => {
  const cwd = tmp();
  assert.equal(resolveMainDbPath({ BATCAVE_DB_PATH: "x/y.db", RAILWAY_VOLUME_MOUNT_PATH: "/vol" }, cwd), path.join(cwd, "x/y.db"));
});

test("every main-database open goes through mainDbPath()", () => {
  const root = new URL("../../server/", import.meta.url);
  for (const f of fs.readdirSync(root).filter((n) => n.endsWith(".ts"))) {
    const s = fs.readFileSync(new URL(f, root), "utf8");
    assert.doesNotMatch(s, /new Database\(["'](\.\/)?data\.db["']/, `${f} opens data.db by name`);
    assert.doesNotMatch(s, /= ["']\.\/data\.db["']/, `${f} hard-codes ./data.db`);
  }
});
