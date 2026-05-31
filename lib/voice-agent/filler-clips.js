const fs = require("fs");
const path = require("path");
const { synthesize, getTtsStatus, getTtsVoice } = require("../tts/index");

const FILLER_TEXTS = [
	"Hmm, one sec…",
	"Right—",
	"On it.",
	"Let me check…",
	"Okay…",
	"Just a moment.",
	"Got it.",
	"Thinking…",
	"Bear with me.",
	"Working on that.",
	"One moment.",
	"Sure thing.",
];

let _cacheDir = null;
let _lastUsedIndex = -1;

function setCacheDir(dir) {
	_cacheDir = String(dir || "").trim() || null;
}

function getFillerPath(index) {
	if (!_cacheDir) return null;
	return path.join(_cacheDir, `filler-${String(index).padStart(2, "0")}.wav`);
}

async function ensureFillers() {
	if (!_cacheDir) return { ok: false, error: "No cache dir set" };
	fs.mkdirSync(_cacheDir, { recursive: true });

	const status = getTtsStatus();
	if (!status.ready) return { ok: false, error: "TTS not ready" };

	const voice = getTtsVoice();
	let generated = 0;
	let existed = 0;

	for (let i = 0; i < FILLER_TEXTS.length; i++) {
		const fp = getFillerPath(i);
		if (!fp) continue;
		if (fs.existsSync(fp)) {
			existed++;
			continue;
		}
		try {
			const result = await synthesize({
				text: FILLER_TEXTS[i],
				voice,
				maxWords: 8,
				maxChars: 60,
			});
			if (result && result.merged) {
				fs.writeFileSync(fp, result.merged);
				generated++;
			}
		} catch (e) {
			console.warn("[filler-clips] failed to generate filler", i, e instanceof Error ? e.message : String(e));
		}
	}

	return { ok: true, generated, existed, total: FILLER_TEXTS.length };
}

function getRandomFillerIndex(excludeLast) {
	if (FILLER_TEXTS.length <= 1) return 0;
	let idx;
	let guard = 0;
	do {
		idx = Math.floor(Math.random() * FILLER_TEXTS.length);
		guard++;
	} while (excludeLast !== false && idx === _lastUsedIndex && guard < 20);
	return idx;
}

function loadFillerBuffer(index) {
	const fp = getFillerPath(index);
	if (!fp || !fs.existsSync(fp)) return null;
	try {
		return fs.readFileSync(fp);
	} catch {
		return null;
	}
}

function pickAndLoadFiller() {
	const idx = getRandomFillerIndex(true);
	const buf = loadFillerBuffer(idx);
	if (buf) {
		_lastUsedIndex = idx;
		return { index: idx, text: FILLER_TEXTS[idx], buffer: buf };
	}
	// Fallback: try any available filler
	for (let i = 0; i < FILLER_TEXTS.length; i++) {
		if (i === _lastUsedIndex) continue;
		const b = loadFillerBuffer(i);
		if (b) {
			_lastUsedIndex = i;
			return { index: i, text: FILLER_TEXTS[i], buffer: b };
		}
	}
	return null;
}

function getFillerCount() {
	if (!_cacheDir) return 0;
	let count = 0;
	for (let i = 0; i < FILLER_TEXTS.length; i++) {
		if (fs.existsSync(getFillerPath(i))) count++;
	}
	return count;
}

module.exports = {
	setCacheDir,
	ensureFillers,
	pickAndLoadFiller,
	getFillerCount,
	FILLER_TEXTS,
};
