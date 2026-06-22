import { spawn } from 'child_process';
import { createConnection } from 'net';
import { appendFileSync } from 'fs';
import path from 'path';

const PYTHON_SERVICE_HOST = '127.0.0.1';
const PYTHON_SERVICE_PORT = 3031;
const SERVICE_DIR = path.join(process.cwd(), 'mini-services', 'data-service');
const LOG_FILE = '/var/log/data-service.log';

let startupPromise: Promise<boolean> | null = null;

/**
 * Check if the Python data-service is reachable on port 3031.
 */
export function isDataServiceRunning(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: PYTHON_SERVICE_HOST,
      port: PYTHON_SERVICE_PORT,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Spawn the Python data-service as a detached daemon process that survives
 * the parent Node.js process. Uses `detached: true` + `unref()` so the child
 * gets its own session and isn't killed when the parent exits.
 */
function spawnDataService(): void {
  const child = spawn(
    'python3',
    ['-u', '-c', 'import uvicorn; uvicorn.run("main:app", host="0.0.0.0", port=3031, reload=False, log_level="info")'],
    {
      cwd: SERVICE_DIR,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    }
  );
  child.unref();
  // Write a marker so we can trace (best-effort, non-blocking)
  try {
    appendFileSync(LOG_FILE, `\n[spawn] data-service PID ${child.pid} at ${new Date().toISOString()}\n`);
  } catch {
    // ignore
  }
}

/**
 * Ensure the Python data-service is running. If not, spawn it (detached) and
 * wait up to 20 seconds for it to become reachable. Each call checks liveness
 * first; if down, attempts a fresh spawn (no stale promise caching).
 */
export async function ensureDataServiceRunning(): Promise<boolean> {
  // Fast path: already reachable
  if (await isDataServiceRunning()) return true;

  // Slow path: spawn and wait (reset promise each time so retries work)
  if (startupPromise) {
    const ok = await startupPromise;
    if (ok) return true;
    startupPromise = null;
  }

  startupPromise = (async () => {
    spawnDataService();
    // Poll until reachable or timeout
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      if (await isDataServiceRunning()) return true;
    }
    return false;
  })();

  const ok = await startupPromise;
  if (!ok) startupPromise = null;
  return ok;
}
