// server/tokenKeyFile.ts
//
// Local token-encryption key file for a loopback (127.0.0.1) install without
// BATCAVE_TOKEN_KEY: 32 random bytes, base64, written once with mode 0600 in
// a 0700 directory OUTSIDE the repo and outside data/ (default
// ~/.batcave/token.key, override BATCAVE_TOKEN_KEY_FILE). Keeping it off the
// database's directory means a copied data.db or backups/ folder does not
// carry its own key. The key is never logged; only the path is.
//
// Refusals (the policy then locks token storage, tokenCrypto.ts):
//   - a path inside the working directory (the repo) or its data/;
//   - an existing file readable by group/other (POSIX mode & 077), the same
//     rule ssh applies to private keys;
//   - a file that is not exactly 32 bytes of base64.
// No DB imports: unit-tested with temp directories.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseTokenKey, wantsLocalKeyFile, tokenKeyPolicy, type LocalKey, type TokenKeyPolicy } from "./tokenCrypto";
import type { EnvLike } from "./accessGate";

export const TOKEN_KEY_FILE_ENV = "BATCAVE_TOKEN_KEY_FILE";

export function localKeyPath(env: EnvLike, home: string = os.homedir()): string {
  const o = (env[TOKEN_KEY_FILE_ENV] ?? "").trim();
  return o ? path.resolve(o) : path.join(home, ".batcave", "token.key");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Reads the key file, or creates it when `create` and it does not exist. */
export function loadLocalKey(p: string, opts: { create: boolean; cwd?: string } = { create: true }): LocalKey | null {
  const cwd = opts.cwd ?? process.cwd();
  if (isInside(p, cwd) || isInside(p, path.join(cwd, "data"))) {
    return { ok: false, path: p, error: "key file path is inside the app directory; use a path outside the repo (default ~/.batcave/token.key)" };
  }
  try {
    if (!existsSync(p)) {
      if (!opts.create) return null;
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const raw = randomBytes(32).toString("base64");
      try {
        writeFileSync(p, raw + "\n", { flag: "wx", mode: 0o600 });
        try { chmodSync(p, 0o600); } catch { /* umask can only narrow; best effort */ }
        return { ok: true, key: Buffer.from(raw, "base64"), path: p, created: true };
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e; // another process won the race: read theirs
      }
    }
    if (process.platform !== "win32") {
      const mode = statSync(p).mode & 0o777;
      if (mode & 0o077) return { ok: false, path: p, error: `key file mode ${mode.toString(8)} is readable by others (chmod 600 ${p})` };
    }
    const parsed = parseTokenKey(readFileSync(p, "utf8"));
    if (!parsed.ok) return { ok: false, path: p, error: "key file is not 32 bytes of base64" };
    return { ok: true, key: parsed.key, path: p, created: false };
  } catch (e: any) {
    return { ok: false, path: p, error: e?.code ?? "unreadable" };
  }
}

let _resolved: { sig: string; local: LocalKey | null } | null = null;

/**
 * Token key policy with the local key file resolved (created once per
 * process when the policy needs it; read as a decrypt-only key otherwise).
 */
export function resolveTokenKeyPolicy(env: EnvLike = process.env): { policy: TokenKeyPolicy; local: LocalKey | null } {
  const p = localKeyPath(env);
  const want = wantsLocalKeyFile(env);
  const sig = `${p}|${want}`;
  if (!_resolved || _resolved.sig !== sig || (want && !_resolved.local?.ok)) {
    _resolved = { sig, local: loadLocalKey(p, { create: want }) };
  }
  return { policy: tokenKeyPolicy(env, _resolved.local), local: _resolved.local };
}

/** Test helper. */
export function _resetResolvedTokenKey(): void {
  _resolved = null;
}
