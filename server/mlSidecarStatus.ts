// server/mlSidecarStatus.ts
//
// Is the Python ML sidecar installed on this host? (review item 9.5 / R2-F 7)
// The Node server spawns ml_service/app.py (mlServiceManager.ts) and the
// weekly retrain (mlRetrainCron.ts) posts to it. On a host without Python or
// without the packages in ml_service/requirements.txt (the default Railway
// Nixpacks Node build), both used to fail with only a log line. This check
// lets /api/ml/health, the Projected Path panel and the retrain cron say
// "ML sidecar not installed" with the missing piece, instead of failing
// silently. Result cached for 10 minutes (one short python process per check).

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

export interface SidecarInstallStatus {
  installed: boolean;
  python: string | null;
  missingModules: string[];
  reason: string | null;
  checkedAt: number;
}

const REQUIRED = ["fastapi", "uvicorn", "pydantic", "numpy", "pandas", "sklearn", "scipy", "joblib", "lightgbm"];
const TTL_MS = 10 * 60_000;
let _cache: SidecarInstallStatus | null = null;

export function sidecarInstallStatus(force = false): SidecarInstallStatus {
  if (!force && _cache && Date.now() - _cache.checkedAt < TTL_MS) return _cache;
  const dir = path.resolve(process.cwd(), "ml_service");
  const done = (s: Omit<SidecarInstallStatus, "checkedAt">) => (_cache = { ...s, checkedAt: Date.now() });
  if (process.env.PULSE_ML_AUTOSTART === "0" && process.env.PULSE_ML_URL) {
    // External sidecar configured: installation is not this host's concern.
    return done({ installed: true, python: null, missingModules: [], reason: null });
  }
  if (!fs.existsSync(path.join(dir, "app.py"))) {
    return done({ installed: false, python: null, missingModules: [], reason: "ml_service/app.py not found" });
  }
  const venv = path.join(dir, ".venv", "bin", "python");
  const py = fs.existsSync(venv) ? venv : "python3";
  const code = `import importlib.util, json; print(json.dumps([m for m in ${JSON.stringify(REQUIRED)} if importlib.util.find_spec(m) is None]))`;
  const r = spawnSync(py, ["-I", "-c", code], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) {
    return done({ installed: false, python: null, missingModules: [], reason: `python not runnable (${py})` });
  }
  let missing: string[] = [];
  try { missing = JSON.parse(String(r.stdout).trim().split("\n").pop() || "[]"); } catch { missing = ["(unparseable check)"]; }
  return done({
    installed: missing.length === 0,
    python: py,
    missingModules: missing,
    reason: missing.length ? `missing Python packages: ${missing.join(", ")} (pip install -r ml_service/requirements.txt)` : null,
  });
}
