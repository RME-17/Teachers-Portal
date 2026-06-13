/**
 * Best-effort CUDA 12 capability detection for startup logs and STT engine routing.
 *
 * IMPORTANT: PyTorch's cu124 wheels (installed by scripts/setup-voice-gpu.ps1) bundle
 * their own CUDA runtime. A usable GPU therefore only requires a recent NVIDIA *driver*
 * - NOT a system CUDA Toolkit and NOT `nvcc`. We detect the driver via `nvidia-smi`
 * first (works without the dev toolkit / on any CUDA 12.x), and treat the nvcc toolkit
 * as a secondary signal so older dev boxes still report available.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");

function tryRun(cmd, args) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return r && r.status === 0 ? String(r.stdout || "") : "";
  } catch {
    return "";
  }
}

/**
 * Detect an NVIDIA driver/runtime via nvidia-smi. nvidia-smi prints a header line
 * like "CUDA Version: 12.4" (the max version the driver supports) and is present
 * whenever a working NVIDIA driver is installed, even without the CUDA Toolkit.
 * @returns {boolean}
 */
function nvidiaDriverAvailable() {
  // nvidia-smi is on PATH on both Windows and Linux when the driver is installed.
  let out = tryRun("nvidia-smi", []);
  if (/NVIDIA-SMI/i.test(out) || /CUDA Version:\s*\d+\.\d+/i.test(out)) return true;

  // Windows fallback: the System32 copy may not be on PATH in some shells.
  if (process.platform === "win32") {
    const fixed = "C:\\Windows\\System32\\nvidia-smi.exe";
    try {
      if (fs.existsSync(fixed)) {
        out = tryRun(fixed, []);
        if (/NVIDIA-SMI/i.test(out) || /CUDA Version:\s*\d+\.\d+/i.test(out)) return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Detect a CUDA 12 Toolkit (nvcc). Optional dev signal only.
 * @returns {boolean}
 */
function cudaToolkitAvailable() {
  // nvcc on PATH (Windows + Linux).
  if (/release 12\./i.test(tryRun("nvcc", ["--version"]))) return true;

  if (process.platform === "win32") {
    // Probe the install root for ANY v12.x (not a fixed v12.1-12.6 list).
    const root = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA";
    try {
      if (fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root)) {
          if (/^v12\./i.test(dir) && fs.existsSync(root + "\\" + dir + "\\bin\\nvcc.exe")) {
            return true;
          }
        }
      }
    } catch {
      /* ignore */
    }
  } else {
    // Common Linux toolkit locations.
    for (const p of ["/usr/local/cuda/bin/nvcc", "/usr/bin/nvcc"]) {
      try {
        if (fs.existsSync(p) && /release 12\./i.test(tryRun(p, ["--version"]))) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/**
 * True when the machine can run CUDA 12 STT: a usable NVIDIA driver (preferred,
 * matches the bundled cu124 runtime) OR a CUDA 12 toolkit.
 * @returns {boolean}
 */
function cudaRuntimeLikelyAvailable() {
  return nvidiaDriverAvailable() || cudaToolkitAvailable();
}

module.exports = {
  cudaRuntimeLikelyAvailable,
  nvidiaDriverAvailable,
  cudaToolkitAvailable,
};
