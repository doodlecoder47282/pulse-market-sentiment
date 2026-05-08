/**
 * mlServiceManager.ts
 *
 * Auto-spawns the FastAPI ML service (ml_service/app.py) on Node startup so
 * the projection bands always render. Without this, the Models tab forward
 * projection sits at status=UNAVAILABLE whenever the ML service isn't running
 * — which is every fresh deploy.
 *
 * Health-check polls every 15s. If the service crashes, restarts up to 3x.
 * Logs to stdout with [ml-service] prefix.
 *
 * Disable via PULSE_ML_AUTOSTART=0 env var.
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

let _proc: ChildProcess | null = null;
let _restarts = 0;
const MAX_RESTARTS = 3;
const ML_PORT = 5001;
const ML_DIR = path.resolve(process.cwd(), "ml_service");

async function _portOpen(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return !!r && r.ok;
  } catch {
    return false;
  }
}

function _spawn() {
  if (!fs.existsSync(ML_DIR)) {
    console.warn(`[ml-service] ${ML_DIR} not found, autostart skipped`);
    return;
  }
  const venvPython = path.join(ML_DIR, ".venv", "bin", "python");
  const py = fs.existsSync(venvPython) ? venvPython : "python3";

  console.log(`[ml-service] starting on port ${ML_PORT} (cwd=${ML_DIR}, py=${py})`);
  const child = spawn(py, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(ML_PORT)], {
    cwd: ML_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: { ...process.env },
  });

  child.stdout?.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.log(`[ml-service] ${s}`);
  });
  child.stderr?.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.log(`[ml-service] ${s}`);
  });

  child.on("exit", (code, signal) => {
    console.warn(`[ml-service] exited code=${code} signal=${signal}`);
    _proc = null;
    if (_restarts < MAX_RESTARTS) {
      _restarts += 1;
      const delay = 2000 * _restarts;
      console.log(`[ml-service] restarting in ${delay}ms (attempt ${_restarts}/${MAX_RESTARTS})`);
      setTimeout(_spawn, delay);
    } else {
      console.warn(`[ml-service] max restarts hit, giving up`);
    }
  });

  _proc = child;
}

export async function startMlService(): Promise<void> {
  if (process.env.PULSE_ML_AUTOSTART === "0") {
    console.log(`[ml-service] autostart disabled via PULSE_ML_AUTOSTART=0`);
    return;
  }
  // If already running externally, don't spawn a second one.
  if (await _portOpen(ML_PORT)) {
    console.log(`[ml-service] already running on port ${ML_PORT}, skipping spawn`);
    return;
  }
  _spawn();
}

export function stopMlService(): void {
  if (_proc) {
    try { _proc.kill("SIGTERM"); } catch {}
    _proc = null;
  }
}

// Clean shutdown on Node exit
process.on("SIGINT", () => { stopMlService(); process.exit(0); });
process.on("SIGTERM", () => { stopMlService(); process.exit(0); });
