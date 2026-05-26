const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const APP_ROOT = path.join(__dirname, "..", "..");

function getPoolConfig() {
  const poolSize = +(process.env.RME_CHATTERBOX_POOL_SIZE || '2');
  const portsRaw = process.env.RME_CHATTERBOX_PORTS || '';
  let ports = portsRaw
    ? portsRaw.split(',').map(s => +s.trim()).filter(n => n > 0)
    : [];
  if (!ports.length) {
    const base = +(process.env.RME_CHATTERBOX_BASE_PORT || '8123');
    ports = Array.from({ length: poolSize }, (_, i) => base + i);
  }
  return { poolSize, ports };
}

async function getFreeVRAM() {
  try {
    const { execSync } = require('child_process');
    const out = String(execSync(
      'nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits',
      { timeout: 3000 }
    )).trim();
    return parseInt(out, 10);
  } catch {
    return null;
  }
}

function createChatterboxPool(opts = {}) {
  const { poolSize, ports: desiredPorts } = getPoolConfig();
  const modelArgs = opts.modelArgs || ['--model', 'original'];
  const scriptPath = path.join(APP_ROOT, 'tools', 'tts', 'chatterbox-server.py');
  const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';

  const backends = new Map();
  let _ready = false;
  let _readyPromise = null;
  let _shutdown = false;
  let healthTimer = null;

  function backendKey(port) { return String(port); }

  function logPort(port, msg) {
    console.log(`[chatterbox-pool] port ${port} ${msg}`);
  }

  function warnPort(port, msg) {
    console.warn(`[chatterbox-pool] WARN: port ${port} ${msg}`);
  }

  async function spawnPort(port) {
    const key = backendKey(port);
    const entry = {
      port,
      url: `http://127.0.0.1:${port}`,
      proc: null,
      inFlight: 0,
      totalRequests: 0,
      errorCount: 0,
      lastResponseMs: 0,
      healthy: false,
      startupDone: false,
      startupOk: false,
    };
    backends.set(key, entry);

    logPort(port, 'starting...');
    if (!fs.existsSync(scriptPath)) {
      warnPort(port, `server script not found at ${scriptPath}`);
      entry.startupDone = true;
      entry.startupOk = false;
      return false;
    }

    const proc = spawn(pythonCmd, [scriptPath, ...modelArgs, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' },
        process.env.HF_TOKEN ? { HF_TOKEN: process.env.HF_TOKEN } : {}),
      windowsHide: true,
    });
    entry.proc = proc;

    proc.stdout.on('data', (d) => {
      const text = d.toString().trim();
      if (text) console.log(`[chatterbox-server:${port}] ${text}`);
    });
    proc.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (text) console.log(`[chatterbox-server:${port}] ${text}`);
    });
    proc.on('exit', (code) => {
      logPort(port, `exited code=${code}`);
      entry.proc = null;
      entry.healthy = false;
    });

    // Health poll: try every 1s up to 600s
    const deadline = Date.now() + 600000;
    let ok = false;
    while (Date.now() < deadline) {
      if (_shutdown) break;
      try {
        const res = await fetch(`${entry.url}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          ok = true;
          break;
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 1000));
    }

    entry.startupDone = true;
    if (ok) {
      entry.healthy = true;
      entry.startupOk = true;
      logPort(port, 'ready');
    } else {
      warnPort(port, 'failed to start (timeout or error)');
      entry.startupOk = false;
    }
    return ok;
  }

  async function ready() {
    if (_ready) return;
    if (_readyPromise) return _readyPromise;

    _readyPromise = (async () => {
      const { poolSize: size, ports: desired } = getPoolConfig();
      let ports = [...desired];

      // VRAM pre-check: skip second process if VRAM too low
      if (ports.length > 1) {
        const freeVram = await getFreeVRAM();
        if (freeVram !== null && freeVram < 4000) {
          warnPort(ports[1], `only ${freeVram} MB free VRAM, skipping 2nd process to avoid OOM. Set RME_CHATTERBOX_POOL_SIZE=2 to force.`);
          ports = [ports[0]];
        }
      }

      console.log(`[chatterbox-pool] spawning ${ports.length} processes on ports ${ports.join(', ')}`);

      const results = await Promise.allSettled(
        ports.map(p => spawnPort(p).catch(e => {
          warnPort(p, `spawn error: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }))
      );

      const alive = [...backends.values()].filter(b => b.startupOk && b.healthy);
      if (alive.length === 0) {
        console.error('[chatterbox-pool] all backends failed to start');
        _ready = false;
        return;
      }

      _ready = true;
      const loadMs = Math.max(...alive.map(b => b.lastResponseMs || 0));
      console.log(`[chatterbox-pool] pool ready, ${alive.length}/${ports.length} backends alive, totalLoadMs=${loadMs} (parallel spawn)`);

      // Start background health check
      healthTimer = setInterval(() => {
        for (const entry of backends.values()) {
          if (_shutdown) break;
          if (!entry.startupDone) continue;
          if (!entry.proc || entry.proc.killed) {
            if (entry.healthy) {
              warnPort(entry.port, 'process gone, marking down');
              entry.healthy = false;
            }
            continue;
          }
          fetch(`${entry.url}/health`, { signal: AbortSignal.timeout(2000) })
            .then(r => {
              const wasDown = !entry.healthy;
              entry.healthy = r.ok;
              if (wasDown && entry.healthy) logPort(entry.port, 'recovered');
            })
            .catch(() => {
              if (entry.healthy) warnPort(entry.port, 'health check failed, marking down');
              entry.healthy = false;
            });
        }
      }, 5000);
    })();

    return _readyPromise;
  }

  function acquire() {
    const candidates = [...backends.values()].filter(b => b.healthy && b.startupOk);
    if (!candidates.length) {
      throw new Error('chatterbox-pool: no healthy backends');
    }
    candidates.sort((a, b) => {
      const diff = a.inFlight - b.inFlight;
      if (diff !== 0) return diff;
      return a.totalRequests - b.totalRequests;
    });
    candidates[0].inFlight++;
    candidates[0].totalRequests++;
    return candidates[0].port;
  }

  function release(port) {
    const key = backendKey(port);
    const entry = backends.get(key);
    if (entry && entry.inFlight > 0) entry.inFlight--;
  }

  function getTelemetry() {
    const result = {};
    for (const [key, entry] of backends) {
      result[key] = {
        port: entry.port,
        inFlight: entry.inFlight,
        totalRequests: entry.totalRequests,
        errorCount: entry.errorCount,
        lastResponseMs: entry.lastResponseMs,
        healthy: entry.healthy,
      };
    }
    return result;
  }

  function shutdown() {
    _shutdown = true;
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    for (const entry of backends.values()) {
      if (entry.proc && !entry.proc.killed) {
        logPort(entry.port, 'shutting down...');
        entry.proc.kill('SIGTERM');
      }
    }
  }

  function isReady() {
    return _ready;
  }

  function healthyBackendCount() {
    return [...backends.values()].filter(b => b.healthy && b.startupOk).length;
  }

  return {
    ready,
    acquire,
    release,
    shutdown,
    getTelemetry,
    isReady,
    healthyBackendCount,
  };
}

module.exports = { createChatterboxPool };
