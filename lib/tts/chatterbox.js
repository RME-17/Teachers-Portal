const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { normalizeForTts } = require("./normalize");
const { stripForTTS } = require("../voice/strip-for-tts");
const { chunkForTts, splitForSynth } = require("./chunk");
const { processWavBuffer, streamThroughMaster } = require("./studio-master");
const { createChatterboxPool } = require("./chatterbox-pool");


const BYTES_PER_SAMPLE = 2;
const FETCH_TIMEOUT_MS = 120000;
const POOL_SIZE = +(process.env.RME_CHATTERBOX_POOL_SIZE || '1');
const MAX_CONCURRENT = POOL_SIZE;

let activeRequests = 0;
const requestQueue = [];
let ttsPool = null;
let _ready = false;
let _ensuring = false;
let _currentVoice = null;
const _ttsModel = String(process.env.RME_CHATTERBOX_MODEL || "turbo").trim().toLowerCase() || "turbo";

function setVoice(name) {
	_currentVoice = String(name || "").trim() || null;
}

function getTtsVoice() {
	return _currentVoice || String(process.env.RME_CHATTERBOX_VOICE || "jennifer-english").trim() || "jennifer-english";
}

function releaseRequest() {
	activeRequests--;
	if (requestQueue.length > 0) {
		const next = requestQueue.shift();
		next();
	}
}

async function acquireSlot() {
	if (activeRequests < MAX_CONCURRENT) {
		activeRequests++;
		return;
	}
	return new Promise((resolve) => {
		requestQueue.push(() => {
			activeRequests++;
			resolve();
		});
	});
}

function getConfig() {
	const serverUrl = String(process.env.RME_CHATTERBOX_URL || "http://127.0.0.1:8123").replace(/\/+$/, "");
	const voice = getTtsVoice();
	const exaggeration = parseFloat(process.env.RME_CHATTERBOX_EXAGGERATION) || 0.8;
	const cfgWeight = parseFloat(process.env.RME_CHATTERBOX_CFG_WEIGHT) || 0.55;
	const minP = parseFloat(process.env.RME_CHATTERBOX_MIN_P) || 0.05;
	const temperature = parseFloat(process.env.RME_CHATTERBOX_TEMPERATURE) || 0.9;
	return { serverUrl, voice, exaggeration, cfgWeight, minP, temperature };
}

async function serverHealthCheck(url) {
	try {
		const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function ensureServer() {
  if (_ensuring) {
    console.log("[chatterbox] ensureServer already in progress, waiting...");
    while (_ensuring) await new Promise(r => setTimeout(r, 500));
    return;
  }
  _ensuring = true;
  try {
    const cfg = getConfig();
    if (ttsPool && ttsPool.isReady()) {
      _ready = true;
      return;
    }
    if (ttsPool) {
      ttsPool.shutdown();
      ttsPool = null;
    }
    if (POOL_SIZE === 1) {
      // Single-process mode: behave exactly as before
      if (await serverHealthCheck(cfg.serverUrl)) {
        _ready = true;
        console.log(`[chatterbox] Connected to server at ${cfg.serverUrl}`);
        return;
      }
      /* Kill leftover Python process on the configured port */
      try {
        const { execSync } = require("child_process");
        const out = String(execSync(
          `netstat -ano | findstr ":${new URL(cfg.serverUrl).port || 8123} "`,
          { timeout: 3000, windowsHide: true }
        ) || "");
        const seen = new Set();
        for (const line of out.split("\n")) {
          const m = line.match(/(\d+)\s*$/);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            try { execSync(`taskkill /PID ${m[1]} /F`, { timeout: 2000, windowsHide: true }); } catch {}
          }
        }
      } catch {}
      const scriptPath = path.join(__dirname, "..", "..", "tools", "tts", "chatterbox-server.py");
      if (!fs.existsSync(scriptPath)) {
        console.warn("[chatterbox] Server script not found at", scriptPath);
        console.warn("[chatterbox] Start the server manually: python tools/tts/chatterbox-server.py");
        return;
      }
      const pythonCmd = process.env.RME_PYTHON_EXE || (process.platform === "win32" ? "py" : "python3");
      console.log(`[chatterbox] Starting server: ${pythonCmd} ${scriptPath} --model ${_ttsModel}`);
      const sp = spawn(pythonCmd, [scriptPath, "--model", _ttsModel], {
        stdio: ["ignore", "pipe", "pipe"],
        env: Object.assign({}, process.env, { PYTHONUNBUFFERED: "1", TQDM_DISABLE: "1" }, process.env.HF_TOKEN ? { HF_TOKEN: process.env.HF_TOKEN } : {}),
        windowsHide: true,
      });
      sp.stdout.on("data", (d) => {
        const text = d.toString().trim();
        if (text) console.log("[chatterbox-server]", text);
      });
      sp.stderr.on("data", (d) => {
        const text = d.toString().trim();
        if (text) console.log("[chatterbox-server]", text);
      });
      sp.on("exit", (code) => {
        console.log(`[chatterbox] Server exited code=${code}`);
        _ready = false;
      });
      for (let i = 0; i < 600; i++) {
        if (await serverHealthCheck(cfg.serverUrl)) {
          _ready = true;
          console.log(`[chatterbox] Server ready after ${i + 1}s`);
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      console.warn("[chatterbox] Server not ready after 600s (10 min)");
      console.warn("[chatterbox] Ensure Python 3.10+ and dependencies are installed:");
      console.warn("[chatterbox]   pip install -r tools/tts/requirements.txt");
      return;
    }
    // Pool mode
    ttsPool = createChatterboxPool({ modelArgs: ['--model', _ttsModel] });
    await ttsPool.ready();
    _ready = ttsPool.isReady();
    if (_ready) {
      console.log(`[chatterbox] pool ready with ${ttsPool.healthyBackendCount()} backends`);
    }
  } finally {
    _ensuring = false;
  }
}

async function synthesizeChunk(text, opts) {
	const cfg = getConfig();
	const baseUrl = opts?.baseUrl || cfg.serverUrl;
	const payloadText = stripForTTS(text);
	const res = await fetch(`${baseUrl}/v1/audio/speech`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			input: payloadText,
			voice: opts?.voice || cfg.voice,
			model: "tts-1",
			exaggeration: opts?.exaggeration ?? cfg.exaggeration,
			cfg_weight: opts?.cfgWeight ?? cfg.cfgWeight,
			min_p: opts?.minP ?? cfg.minP,
			temperature: opts?.temperature ?? cfg.temperature,
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		let detail = "";
		try { detail = await res.text(); } catch {}
		throw new Error(`Chatterbox API ${res.status}${detail ? `: ${detail.slice(0, 2000)}` : ""}`);
	}
		const buf = Buffer.from(await res.arrayBuffer());
		if (process.env.RME_TTS_DEBUG === '1') {
			console.log("[RME-TTS] non-stream response:", { bytes: buf.length, status: res.status });
		}
	if (buf.length < 44) {
		throw new Error("Chatterbox returned empty or truncated WAV");
	}
	return buf;
}

async function synthesize(opts) {
	const normalized = normalizeForTts(String(opts?.text || "").trim(), { preserveProsody: true });
	if (!normalized) throw new Error("Nothing to speak after normalization");
	const maxWords = Math.max(1, Math.floor(Number(
		opts?.maxWords ?? process.env.RME_TTS_CHUNK_MAX_WORDS ?? 28,
	) || 28));
	const maxChars = Math.max(40, Math.floor(Number(
		opts?.maxChars ?? process.env.RME_TTS_CHUNK_MAX_CHARS ?? 200,
	) || 200));
	const textChunks = splitForSynth(normalized, maxWords, maxChars);
	if (!textChunks.length) throw new Error("Nothing to speak after chunking");
	const t0 = Date.now();
	await acquireSlot();
	let port = null;
	try {
		if (ttsPool && ttsPool.isReady()) {
			port = await ttsPool.acquire();
		}
		const baseUrl = port ? `http://127.0.0.1:${port}` : getConfig().serverUrl;
		const wavBuffers = [];
		for (const chunk of textChunks) {
			const wavBuffer = await synthesizeChunk(chunk, { ...opts, baseUrl });
			wavBuffers.push(wavBuffer);
		}
		let wavBuffer = mergeWavBuffers(wavBuffers);
		const totalMs = Date.now() - t0;
		const inputSampleRate = readWavSampleRate(wavBuffer);
		wavBuffer = await processWavBuffer(wavBuffer, inputSampleRate);
		const logPort = port || '?';
		console.log(`[chatterbox] synth port=${logPort} totalMs=${totalMs} chars=${normalized.length} chunks=${textChunks.length} maxWords=${maxWords} maxChars=${maxChars} bytes=${wavBuffer.length}`);
		const durationMs = Math.round(wavDurationMs(wavBuffer));
		return {
			merged: wavBuffer,
			chunks: textChunks.length,
			bytes: wavBuffer.length,
			durationMs,
			speechMs: durationMs,
			trimmedMs: 0,
			overlapMs: 0,
			port,
		};
	} finally {
		if (port !== null && ttsPool) ttsPool.release(port);
		releaseRequest();
	}
}

async function synthesizeStreaming(opts) {
	const normalized = normalizeForTts(String(opts?.text || "").trim(), { preserveProsody: true });
	if (!normalized) throw new Error("Nothing to speak after normalization");
	const payloadText = stripForTTS(normalized);
	const t0 = Date.now();
	await acquireSlot();
	let port = null;
	try {
		if (ttsPool && ttsPool.isReady()) {
			port = await ttsPool.acquire();
		}
		const baseUrl = port ? `http://127.0.0.1:${port}` : getConfig().serverUrl;
		const voice = opts?.voice || getTtsVoice();
		const cfg = getConfig();
		const res = await fetch(`${baseUrl}/v1/audio/speech/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: payloadText,
				voice,
				model: "tts-1",
				exaggeration: opts?.exaggeration ?? cfg.exaggeration,
				cfg_weight: opts?.cfgWeight ?? cfg.cfgWeight,
				temperature: opts?.temperature ?? cfg.temperature,
			}),
			signal: opts?.signal || AbortSignal.timeout(120000),
		});
		if (!res.ok) {
			let detail = "";
			try { detail = await res.text(); } catch {}
			throw new Error(`chatterbox stream HTTP ${res.status} port=${port}: ${(detail || "<unreadable>").slice(0, 500)}`);
		}
		if (!res.body) {
			throw new Error(`chatterbox stream port=${port}: no response body`);
		}
		const reader = res.body.getReader();
		const SR = 24000;
		const MIN_CHUNK_MS = 2500;
		const MIN_CHUNK_BYTES = Math.round(SR * 2 * (MIN_CHUNK_MS / 1000));
		let chunkIndex = 0;
		let totalBytes = 0;
		const accum = [];
		let accumBytes = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const pcm = Buffer.from(value);
			if (!pcm.length) continue;
			totalBytes += pcm.length;
			accum.push(pcm);
			accumBytes += pcm.length;
			if (accumBytes >= MIN_CHUNK_BYTES) {
				const chunkPcm = Buffer.concat(accum);
				accum.length = 0;
				accumBytes = 0;
				const chunkMs = Math.round((chunkPcm.length / (SR * 2)) * 1000);
				const pcmBuf = chunkPcm;
				const idx = chunkIndex++;
				const wav = Buffer.concat([buildWavHeader(chunkPcm.length, SR, 1, 16), chunkPcm]);
								if (process.env.RME_TTS_DEBUG === '1') {
									console.log("[RME-TTS] stream chunk:", { index: idx, pcmBytes: pcmBuf.length, wavBytes: wav.length, durationMs: chunkMs });
								}
				if (typeof opts.onChunk === "function") {
					opts.onChunk({ index: idx, audio: wav, mimeType: "audio/wav", durationMs: chunkMs });
				}
			}
		}
		if (accum.length > 0) {
			const chunkPcm = Buffer.concat(accum);
			const chunkMs = Math.round((chunkPcm.length / (SR * 2)) * 1000);
			const pcmBuf = chunkPcm;
			const idx = chunkIndex++;
			const wav = Buffer.concat([buildWavHeader(chunkPcm.length, SR, 1, 16), chunkPcm]);
						if (process.env.RME_TTS_DEBUG === '1') {
							console.log("[RME-TTS] stream chunk:", { index: idx, pcmBytes: pcmBuf.length, wavBytes: wav.length, durationMs: chunkMs });
						}
			if (typeof opts.onChunk === "function") {
				opts.onChunk({ index: idx, audio: wav, mimeType: "audio/wav", durationMs: chunkMs });
			}
		}
		const totalMs = Date.now() - t0;
		const totalDurationMs = Math.round((totalBytes / (SR * 2)) * 1000);
		const logPort = port || '?';
		console.log(`[chatterbox] streaming-synth port=${logPort} totalMs=${totalMs} chars=${payloadText.length} audioMs=${totalDurationMs}`);
		return {
			ok: true,
			data: { streamed: true, durationMs: totalDurationMs, speechMs: totalDurationMs },
		};
	} finally {
		if (port !== null && ttsPool) ttsPool.release(port);
		releaseRequest();
	}
}

async function synthesizeUtterance(opts) {
	const normalized = normalizeForTts(String(opts?.text || "").trim(), { preserveProsody: true });
	if (!normalized) throw new Error("Nothing to speak after normalization");
	const chunks = chunkForTts(normalized, 35);
	if (!chunks.length) throw new Error("Nothing to speak after chunking");
	const t0 = Date.now();
	const wavBuffers = [];
	for (const chunk of chunks) {
		const wavBuffer = await synthesizeChunk(chunk, opts);
		wavBuffers.push(wavBuffer);
	}
	let merged = mergeWavBuffers(wavBuffers);
	const inputSampleRate = readWavSampleRate(merged);
	merged = await processWavBuffer(merged, inputSampleRate);
	const durationMs = Math.round(wavDurationMs(merged));
	const synthMs = Date.now() - t0;
	console.log(`[chatterbox] utterance synthMs=${synthMs} chars=${normalized.length} chunks=${chunks.length} audioMs=${durationMs}`);
	return {
		merged,
		chunks: chunks.length,
		bytes: merged.length,
		durationMs,
		speechMs: durationMs,
		trimmedMs: 0,
		overlapMs: 0,
	};
}

function findDataOffset(buf) {
	if (buf.length < 12) return 44;
	let offset = 12;
	while (offset + 8 <= buf.length) {
		const chunkId = buf.toString("ascii", offset, offset + 4);
		const chunkSize = buf.readUInt32LE(offset + 4);
		if (chunkId === "data") return offset + 8;
		offset += 8 + chunkSize + (chunkSize % 2);
	}
	return 44;
}

function readWavChannels(buf) {
	if (buf.length < 24) return 1;
	return buf.readUInt16LE(22);
}

function readWavSampleRate(buf) {
	if (buf.length < 26) return 24000;
	return buf.readUInt32LE(24);
}

function readWavBitsPerSample(buf) {
	if (buf.length < 36) return 16;
	return buf.readUInt16LE(34);
}

function mergeWavBuffers(buffers) {
	if (buffers.length === 1) return buffers[0];
	if (!buffers.length) throw new Error("No WAV buffers to merge");
	const channels = readWavChannels(buffers[0]);
	const sampleRate = readWavSampleRate(buffers[0]);
	const bitsPerSample = readWavBitsPerSample(buffers[0]);
	const frameSize = (channels * bitsPerSample) / 8;
	let totalFrames = 0;
	const dataChunks = [];
	for (const buf of buffers) {
		const doff = findDataOffset(buf);
		const frameCount = Math.floor((buf.length - doff) / frameSize);
		totalFrames += frameCount;
		dataChunks.push(buf.subarray(doff, doff + frameCount * frameSize));
	}
	const totalBytes = totalFrames * frameSize;
	const header = buildWavHeader(totalBytes, sampleRate, channels, bitsPerSample);
	const merged = Buffer.alloc(44 + totalBytes);
	header.copy(merged, 0);
	let offset = 44;
	for (const chunk of dataChunks) {
		chunk.copy(merged, offset);
		offset += chunk.length;
	}
	return merged;
}

function buildWavHeader(dataSize, sampleRate, channels, bitsPerSample) {
	channels = channels || 1;
	const bps = bitsPerSample || 16;
	const frameSize = (channels * bps) / 8;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataSize, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * frameSize, 28);
	header.writeUInt16LE(frameSize, 32);
	header.writeUInt16LE(bps, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);
	return header;
}

function wavDurationMs(buf) {
	if (buf.length < 44) return 0;
	const dataOffset = findDataOffset(buf);
	const dataSize = buf.readUInt32LE(dataOffset - 4);
	const channels = buf.readUInt16LE(22);
	const sampleRate = buf.readUInt32LE(24);
	const bitsPerSample = buf.readUInt16LE(34);
	const bytesPerSample = (channels * bitsPerSample) / 8;
	if (bytesPerSample === 0) return 0;
	return (dataSize / bytesPerSample / sampleRate) * 1000;
}

function ttsReady() {
	return _ready;
}

async function warmTts() {
	await ensureServer();
	try {
		console.log("[chatterbox] Warming up kernels with dummy synthesis...");
		await synthesize({ text: "Ready.", voice: getTtsVoice() });
		console.log("[chatterbox] Warm-up complete.");
	} catch (e) {
		const detail = e instanceof Error ? (e.message || "no message") : (typeof e === "object" ? JSON.stringify(e) : String(e));
		console.warn("[chatterbox] Warm-up synthesis failed:", detail);
		if (e instanceof Error && e.stack) console.warn("[chatterbox] Warm-up stack:", e.stack.split("\n").slice(0, 4).join("\n"));
	}
}

function getTtsStatus() {
	return {
		provider: "chatterbox",
		ready: _ready,
	};
}

function shutdown() {
  if (ttsPool) {
    console.log("[chatterbox] Shutting down TTS pool...");
    ttsPool.shutdown();
    ttsPool = null;
  }
  _ready = false;
}

module.exports = {
	synthesize,
	synthesizeStreaming,
	synthesizeUtterance,
	warmTts,
	ttsReady,
	getTtsStatus,
	getTtsVoice,
	setVoice,
	shutdown,
};
