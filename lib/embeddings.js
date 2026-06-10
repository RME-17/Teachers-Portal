const path = require("path");
const fs = require("fs");
const os = require("os");

// @xenova/transformers caches model files to disk. Its default cache dir lives
// inside the package (inside app.asar when packaged - a file, not a folder), so
// writes fail with ENOTDIR. Resolve a writable cache dir instead.
function resolveCacheDir() {
	if (process.env.RME_TRANSFORMERS_CACHE) return process.env.RME_TRANSFORMERS_CACHE;
	try {
		const { app } = require("electron");
		if (app && typeof app.getPath === "function") {
			return path.join(app.getPath("userData"), "transformers-cache");
		}
	} catch (e) {
		/* not in electron main - fall through */
	}
	return path.join(os.tmpdir(), "rme-transformers-cache");
}

let _pipeline = null;
let _warmMs = 0;

async function getPipeline() {
	if (_pipeline) return _pipeline;
	const { pipeline, env } = await import("@xenova/transformers");
	try {
		const cacheDir = resolveCacheDir();
		fs.mkdirSync(cacheDir, { recursive: true });
		env.cacheDir = cacheDir;
		env.allowRemoteModels = true;
	} catch (e) {
		console.warn("[embeddings] cache dir setup failed:", (e && e.message) || e);
	}
	const t0 = Date.now();
	_pipeline = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
		quantized: true,
	});
	_warmMs = Date.now() - t0;
	console.log(`[embeddings] model warm-loaded in ${_warmMs}ms`);
	return _pipeline;
}

async function embed(text) {
	try {
		if (!text || typeof text !== "string") {
			return { ok: false, error: { code: "BAD_INPUT", message: "embed requires non-empty string" } };
		}
		const truncated = text.slice(0, 8000);
		const pipe = await getPipeline();
		const output = await pipe(truncated, { pooling: "mean", normalize: true });
		return { ok: true, data: Array.from(output.data) };
	} catch (err) {
		return { ok: false, error: { code: "EMBED_FAILED", message: err instanceof Error ? err.message : String(err) } };
	}
}

function warmMs() { return _warmMs; }

module.exports = { embed, getPipeline, warmMs };
