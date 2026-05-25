const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const {
  resolveVoiceEnvPaths,
  fileExists: voiceFileExists,
} = require("../voice-env-resolve");

const APP_ROOT = path.join(__dirname, "..", "..");

let serverProc = null;
let startPromise = null;
let whisperDevice = "cpu";
let whisperModelBasename = "";

/** Probe PATH for CUDA 12 runtime DLLs. */
function cudaRuntimeDllsOnPath() {
  const candidates = ["cublas64_12.dll", "cudart64_12.dll"];
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    for (const dll of candidates) {
      try {
        const p = path.join(dir, dll);
        if (fs.existsSync(p)) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/** Check if a directory contains CUDA DLLs (for bundled CUDA builds). */
function cudaDllsInDir(dir) {
  if (!dir) return false;
  const candidates = ["cublas64_12.dll", "cudart64_12.dll"];
  for (const dll of candidates) {
    try {
      if (fs.existsSync(path.join(dir, dll))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Detect if binary path suggests CUDA build. */
function isCudaBinaryPath(binPath) {
  return /cuda/i.test(String(binPath || ""));
}

function getWhisperServerConfig() {
  const urlRaw =
    String(process.env.RME_WHISPER_SERVER_URL || "").trim() ||
    "http://127.0.0.1:8780";
  let host = "127.0.0.1";
  let port = 8780;
  try {
    const u = new URL(urlRaw);
    host = u.hostname || host;
    port = Number(u.port) || 8780;
  } catch {
    /* keep defaults */
  }
  const resolved = resolveVoiceEnvPaths(APP_ROOT, {
    whisperServerBin: process.env.RME_WHISPER_SERVER_BIN,
  });
  const bin = resolved.whisperServerBin || "";

  const fastModel = String(process.env.RME_WHISPER_MODEL_FAST || "").trim();
  const accurateModel = String(process.env.RME_WHISPER_MODEL_ACCURATE || "").trim();
  const oldModel = String(process.env.RME_WHISPER_MODEL || "").trim();

  let model = fastModel;
  if (!model || !voiceFileExists(model)) {
    if (oldModel && voiceFileExists(oldModel)) {
      model = oldModel;
    } else if (accurateModel && voiceFileExists(accurateModel)) {
      model = accurateModel;
    }
  }
  return { urlRaw, baseUrl: `http://${host}:${port}`, host, port, bin, model };
}

function getWhisperDevice() {
  return whisperDevice;
}

function getWhisperDeviceLabel() {
  return whisperDevice === "cuda" ? "gpu" : "cpu";
}

function getWhisperModelBasename() {
  return whisperModelBasename;
}

function isWhisperServerReady() {
  return Boolean(serverProc && !serverProc.killed);
}

function isWhisperGpuDisabled() {
  const v = String(process.env.RME_WHISPER_SERVER_GPU || "auto")
    .trim()
    .toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { method: "GET" });
      if (res.ok) {
        const body = await res.text();
        if (body.includes('"status":"ok"') || body.includes("ok")) {
          return true;
        }
      }
    } catch {
      /* health endpoint may not exist; fall through to port check */
    }
    /* fallback: check if port is listening */
    const urlObj = new URL(baseUrl);
    const ok = await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
      sock.connect(Number(urlObj.port) || 8780, urlObj.hostname);
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function generateSilentWav16k(durationSec) {
  const sampleRate = 16000;
  const numSamples = Math.round(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  const pcm = Buffer.alloc(dataSize, 0);
  return Buffer.concat([header, pcm]);
}

async function fireWarmupInference(baseUrl) {
  const boundary = `----RMEWarm${Date.now()}`;
  const wavBuf = generateSilentWav16k(1);
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="silence.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    "utf8",
  );
  const mid = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response"\r\n\r\njson\r\n--${boundary}--\r\n`,
    "utf8",
  );
  const body = Buffer.concat([preamble, wavBuf, mid]);
  try {
    const res = await fetch(`${baseUrl}/inference`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (res.ok) {
      console.log("[whisper] warm-up inference OK");
    }
  } catch {
    /* non-fatal */
  }
}

async function ensureWhisperServer() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const cfg = getWhisperServerConfig();
    whisperModelBasename = cfg.model ? path.basename(cfg.model) : "";

    if (!cfg.bin) {
      console.log(
        "[whisper] server binary not configured (RME_WHISPER_SERVER_BIN); using whisper-cli fallback",
      );
      return false;
    }
    if (!voiceFileExists(cfg.bin)) {
      console.error(
        `[whisper-server] Binary not found at RME_WHISPER_SERVER_BIN=${cfg.bin}. Check that the cuBLAS CUDA build exists at that path.`,
      );
      return false;
    }

    if (!cfg.model) {
      console.log(
        "[whisper] no model found (checked RME_WHISPER_MODEL_FAST, RME_WHISPER_MODEL_ACCURATE, RME_WHISPER_MODEL); server not started",
      );
      return false;
    }
    if (!voiceFileExists(cfg.model)) {
      console.error(
        `[whisper-server] Model not found: ${cfg.model}. Download ggml-base.en.bin or ggml-small.en.bin into tools/voice/models/.`,
      );
      return false;
    }

    if (serverProc && !serverProc.killed) {
      return waitForHealth(cfg.baseUrl, 30000);
    }

    if (!cudaRuntimeDllsOnPath() && !cudaDllsInDir(path.dirname(cfg.bin))) {
      console.log(
        "[whisper-server] CUDA runtime not detected. Using CPU with AVX2 optimizations.",
      );
    }

    const flashAttn = String(process.env.RME_WHISPER_FLASH_ATTN || "").trim() !== "0";
    const beamSize = String(process.env.RME_WHISPER_BEAM_SIZE || "").trim() || "1";
    const bestOf = String(process.env.RME_WHISPER_BEST_OF || "").trim() || "1";

    const args = [
      "-m", cfg.model,
      "--host", cfg.host,
      "--port", String(cfg.port),
      "--beam-size", beamSize,
      "--best-of", bestOf,
    ];

    if (flashAttn) {
      args.push("--flash-attn");
    }

    args.push("--convert");

    if (isWhisperGpuDisabled()) {
      args.push("--no-gpu");
      whisperDevice = "cpu";
    } else {
      args.push("--device", "0");
    }

    args.push("--threads", "4");
    args.push("--processors", "1");

    const ffmpegBinDir = path.join(APP_ROOT, "tools", "voice", "ffmpeg", "bin");
    const whisperEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
    if (ffmpegBinDir && fs.existsSync(ffmpegBinDir)) {
      whisperEnv.PATH = `${ffmpegBinDir}${path.delimiter}${whisperEnv.PATH || ""}`;
    }

    serverProc = spawn(cfg.bin, args, {
      cwd: path.dirname(cfg.bin),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: whisperEnv,
    });

    let bootLog = "";

    serverProc.stdout?.on("data", (c) => {
      const s = String(c);
      bootLog += s;
      if (s.trim()) console.log(`[whisper-server] ${s.trim()}`);
    });
    serverProc.stderr?.on("data", (c) => {
      const s = String(c);
      bootLog += s;
      if (s.trim()) console.log(`[whisper-server] ${s.trim()}`);
    });
    serverProc.on("exit", (code) => {
      if (code != null && code !== 0) {
        console.warn(`[whisper] server exited ${code}`);
      }
      serverProc = null;
      startPromise = null;
    });

    const ok = await waitForHealth(cfg.baseUrl, 30000);
    if (ok) {
      if (/no gpu found|use gpu\s*=\s*0/i.test(bootLog)) {
        whisperDevice = "cpu";
        console.warn(
          "[whisper-server] GPU init failed — check that whisper-server.exe was built with cuBLAS and that NVIDIA driver supports CUDA 12.x. Falling back to CPU mode.",
        );
      } else if (/ggml_cuda_init|use gpu\s*=\s*1|cublas|cuda/i.test(bootLog)) {
        whisperDevice = "cuda";
      }
      const devLabel = whisperDevice === "cuda" ? "CUDA" : "CPU";
      console.log(
        `[whisper] server up (${devLabel}) model=${whisperModelBasename} — ${cfg.baseUrl}/health`,
      );
      void fireWarmupInference(cfg.baseUrl);
    } else {
      console.warn("[whisper] server health check timed out after 10s");
    }
    return ok;
  })();
  return startPromise;
}

function stopWhisperServer() {
  if (serverProc && !serverProc.killed) {
    console.log("[whisper] Killing whisper server...");
    try {
      serverProc.kill();
      console.log("[whisper] Whisper server killed.");
    } catch (e) {
      console.warn("[whisper] Error killing whisper server:", e);
    }
  }
  serverProc = null;
  startPromise = null;
}

async function transcribeViaServer(wavBuffer, filename = "capture.wav") {
  const cfg = getWhisperServerConfig();
  const t0 = Date.now();
  const boundary = `----RMEWhisper${Date.now()}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
    "utf8",
  );
  const fields =
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response"\r\n\r\n` +
    `json` +
    `\r\n--${boundary}--\r\n`;
  const mid = Buffer.from(fields, "utf8");
  const body = Buffer.concat([preamble, wavBuffer, mid]);

  const res = await fetch(`${cfg.baseUrl}/inference`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Whisper server ${res.status}: ${raw.slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Whisper server returned non-JSON");
  }
  const text = String(parsed?.text || "").trim();
  if (!text) {
    throw new Error("Whisper server returned empty text");
  }
  const ms = Date.now() - t0;
  const audioSec = (wavBuffer.length - 44) / 32000;
  const rtFactor = (ms / 1000 / Math.max(audioSec, 0.01)).toFixed(2);
  console.log(
    `[whisper] device=${whisperDevice} model=${whisperModelBasename} transcribed=${ms}ms audioSec=${audioSec.toFixed(2)} rtFactor=${rtFactor}x`,
  );
  return { ok: true, text, ms, via: "server" };
}

module.exports = {
  ensureWhisperServer,
  stopWhisperServer,
  transcribeViaServer,
  getWhisperServerConfig,
  getWhisperDevice,
  getWhisperDeviceLabel,
  getWhisperModelBasename,
  isWhisperServerReady,
  isWhisperGpuDisabled,
};
