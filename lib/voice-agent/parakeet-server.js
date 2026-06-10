const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const APP_ROOT = path.join(__dirname, "..", "..");

let serverProc = null;
let startPromise = null;
let parakeetDevice = "cuda";
let parakeetModelName = "";

function getParakeetServerConfig() {
	const port = Number(process.env.RME_PARAKEET_PORT || "8127");
	const model = String(process.env.RME_PARAKEET_MODEL || "nvidia/parakeet-tdt-0.6b-v3").trim();
	const device = String(process.env.RME_PARAKEET_DEVICE || "cuda").trim();
	const pythonExe = String(process.env.RME_PARAKEET_PYTHON || process.env.RME_PYTHON_EXE || "python").trim();

	const scriptPath = path.join(process.env.RME_TOOLS_ROOT || path.join(APP_ROOT, "tools"), "stt", "parakeet-server.py");
	const venvDir = path.join(APP_ROOT, "tools", "stt", "venv");
	const venvPython = process.platform === "win32"
		? path.join(venvDir, "Scripts", "python.exe")
		: path.join(venvDir, "bin", "python");

	let python = pythonExe;
	if (fs.existsSync(venvPython)) {
		python = venvPython;
	}

	return {
		port,
		host: "127.0.0.1",
		baseUrl: `http://127.0.0.1:${port}`,
		model,
		device,
		python,
		scriptPath,
	};
}

function getParakeetDevice() {
	return parakeetDevice;
}

function getParakeetDeviceLabel() {
	return parakeetDevice === "cuda" ? "gpu" : "cpu";
}

function getParakeetModelBasename() {
	return parakeetModelName;
}

function isParakeetServerReady() {
	return Boolean(serverProc && !serverProc.killed);
}

async function waitForHealth(baseUrl, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/health`, { method: "GET" });
			if (res.ok) {
				const body = await res.text();
				if (body.includes('"status":"ok"') || body.includes(`"status": "ok"`)) {
					return true;
				}
			}
		} catch {
			/* server not up yet */
		}
		const urlObj = new URL(baseUrl);
		const ok = await new Promise((resolve) => {
			const sock = new net.Socket();
			sock.setTimeout(1000);
			sock.on("connect", () => { sock.destroy(); resolve(true); });
			sock.on("error", () => resolve(false));
			sock.on("timeout", () => { sock.destroy(); resolve(false); });
			sock.connect(Number(urlObj.port) || 8127, urlObj.hostname);
		});
		if (ok) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

async function ensureParakeetServer() {
	if (startPromise) return startPromise;
	startPromise = (async () => {
		const cfg = getParakeetServerConfig();
		parakeetModelName = cfg.model;

		if (!fs.existsSync(cfg.scriptPath)) {
			console.error(`[parakeet] Server script not found: ${cfg.scriptPath}`);
			return false;
		}

		if (!fs.existsSync(cfg.python)) {
			console.error(`[parakeet] Python not found: ${cfg.python}`);
			return false;
		}

		if (serverProc && !serverProc.killed) {
			return waitForHealth(cfg.baseUrl, 30000);
		}

		const args = [
			"-u",
			cfg.scriptPath,
			"--port", String(cfg.port),
			"--device", cfg.device,
			"--model", cfg.model,
		];

		console.log(`[parakeet] Starting server: ${cfg.python} ${args.join(" ")}`);

		const env = {
			...process.env,
			PYTHONUNBUFFERED: "1",
			RME_PARAKEET_PORT: String(cfg.port),
			RME_PARAKEET_DEVICE: cfg.device,
			RME_PARAKEET_MODEL: cfg.model,
		};

		serverProc = spawn(cfg.python, args, {
			cwd: APP_ROOT,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let bootLog = "";

		serverProc.stdout?.on("data", (c) => {
			const s = String(c);
			bootLog += s;
			if (s.trim()) console.log(`[parakeet] ${s.trim()}`);
		});
		serverProc.stderr?.on("data", (c) => {
			const s = String(c);
			bootLog += s;
			if (s.trim()) console.log(`[parakeet] ${s.trim()}`);
		});
		serverProc.on("exit", (code) => {
			if (code != null && code !== 0) {
				console.warn(`[parakeet] server exited ${code}`);
			}
			serverProc = null;
			startPromise = null;
		});

		const ok = await waitForHealth(cfg.baseUrl, 600000);
		if (ok) {
			try {
				const res = await fetch(`${cfg.baseUrl}/health`, { method: "GET" });
				if (res.ok) {
					const body = await res.json();
					if (body.device) {
						parakeetDevice = String(body.device).toLowerCase();
					}
				}
			} catch {
				/* ignore */
			}
			const devLabel = parakeetDevice === "cuda" ? "CUDA" : "CPU";
			console.log(
				`[parakeet] server up (${devLabel}) model=${cfg.model} — ${cfg.baseUrl}/health`,
			);
		} else {
			console.warn("[parakeet] server health check timed out after 600s");
			if (serverProc && !serverProc.killed) {
				try { serverProc.kill(); } catch {}
				serverProc = null;
				startPromise = null;
			}
			return false;
		}
		return ok;
	})();
	return startPromise;
}

function stopParakeetServer() {
	if (serverProc && !serverProc.killed) {
		console.log("[parakeet] Killing Parakeet server...");
		try {
			serverProc.kill();
			console.log("[parakeet] Parakeet server killed.");
		} catch (e) {
			console.warn("[parakeet] Error killing Parakeet server:", e);
		}
	}
	serverProc = null;
	startPromise = null;
}

async function transcribeViaParakeet(wavBuffer, filename = "capture.wav") {
	const cfg = getParakeetServerConfig();
	const t0 = Date.now();
	const boundary = `----RMEParakeet${Date.now()}`;
	const preamble = Buffer.from(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
			`Content-Type: audio/wav\r\n\r\n`,
		"utf8",
	);
	const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
	const body = Buffer.concat([preamble, wavBuffer, footer]);

	const res = await fetch(`${cfg.baseUrl}/transcribe`, {
		method: "POST",
		headers: {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
		},
		body,
	});
	const raw = await res.text();
	if (!res.ok) {
		throw new Error(`Parakeet server ${res.status}: ${raw.slice(0, 400)}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Parakeet server returned non-JSON");
	}
	if (!parsed.ok) {
		throw new Error(`Parakeet transcribe failed: ${parsed.error || "unknown"}`);
	}
	const text = String(parsed.text || "").trim();
	const ms = Date.now() - t0;
	const audioSec = (wavBuffer.length - 44) / 32000;
	if (text) {
		const rtFactor = (ms / 1000 / Math.max(audioSec, 0.01)).toFixed(2);
		console.log(
			`[parakeet] device=${parakeetDevice} model=${parakeetModelName} transcribed=${ms}ms audioSec=${audioSec.toFixed(2)} rtFactor=${rtFactor}x text="${text.slice(0, 80)}"`,
		);
	} else {
		console.log(
			`[parakeet] device=${parakeetDevice} model=${parakeetModelName} transcribed=${ms}ms audioSec=${audioSec.toFixed(2)} text="" (silence)`,
		);
	}
	return { ok: true, text, ms, via: "parakeet" };
}

module.exports = {
	ensureParakeetServer,
	stopParakeetServer,
	transcribeViaParakeet,
	getParakeetServerConfig,
	getParakeetDevice,
	getParakeetDeviceLabel,
	getParakeetModelBasename,
	isParakeetServerReady,
};
