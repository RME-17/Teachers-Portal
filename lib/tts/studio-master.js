const { spawn } = require("child_process");
const { Readable, PassThrough } = require("stream");
const ffmpegPath = require("ffmpeg-static");

const OUTPUT_SAMPLE_RATE = 48000;
const OUTPUT_BITS_PER_SAMPLE = 16;
const OUTPUT_CHANNELS = 1;

function readWavBitsPerSample(buf) {
	if (buf.length < 36) return 16;
	return buf.readUInt16LE(34);
}

const FORMAT_MAP = { 16: "s16le", 24: "s24le", 32: "s32le" };

function pcmFormatName(bitsPerSample) {
	return FORMAT_MAP[bitsPerSample] || "s16le";
}

/**
 * Pipe raw PCM through FFmpeg broadcast-grade filter chain.
 * inputSampleRate and inputBitDepth determine how raw PCM bytes are parsed.
 * Returns a Readable stream of processed mono 48kHz PCM s16le.
 */
function streamThroughMaster({ inputStream, inputSampleRate, inputBitDepth, signal }) {
	if (process.env.RME_BYPASS_STUDIO_MASTER === '1') {
		return inputStream;
	}
	if (!ffmpegPath) {
		console.warn("[studio-master] ffmpeg-static not found, bypassing");
		return inputStream;
	}

	// Global speech rate (pitch-preserving). RME_VOICE_SPEED>1 = faster; 1.0 = unchanged.
	const speed = Math.min(1.6, Math.max(0.7, parseFloat(process.env.RME_VOICE_SPEED) || 1.12));
	const chain = [
		"highpass=f=70",
		"volume=0.5",
		"alimiter=limit=-6.0dB:attack=2:release=20",
		"aresample=48000:resampler=swr:precision=28",
		"aformat=sample_fmts=s16:channel_layouts=mono",
	];
	if (speed !== 1.0) chain.unshift('atempo=' + speed);

	const inFmt = pcmFormatName(inputBitDepth || 16);
	const child = spawn(ffmpegPath, [
		"-hide_banner",
		"-loglevel", "error",
		"-threads", "2",
		"-f", inFmt,
		"-ar", String(inputSampleRate),
		"-ac", "1",
		"-i", "pipe:0",
		"-af", chain.join(","),
		"-f", "s16le",
		"-ar", String(OUTPUT_SAMPLE_RATE),
		"-ac", String(OUTPUT_CHANNELS),
		"pipe:1",
	], { stdio: ["pipe", "pipe", "pipe"] });

	child.on("spawn", () => {
		console.log("[studio-master] filter graph initialized");
	});

	let aborted = false;
	if (signal) {
		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
		};
		signal.addEventListener("abort", onAbort, { once: true });
		child.on("exit", () => signal.removeEventListener("abort", onAbort));
	}

	inputStream.pipe(child.stdin);
	child.stdin.on("error", () => { /* ffmpeg may close stdin early — suppress writeEOF */ });

	child.stderr.on("data", (d) => {
		const text = d.toString().trim();
		if (text) console.log("[studio-master]", text);
	});

	const outStream = new PassThrough({ highWaterMark: 65536 });

	child.stdout.on("data", (chunk) => {
		if (!aborted) outStream.push(chunk);
	});

	child.stdout.on("end", () => {
		if (!aborted) outStream.push(null);
	});

	child.stdout.on("error", (err) => {
		console.warn("[studio-master] stdout error:", err.message);
		if (!aborted) outStream.destroy(err);
	});

	child.on("error", (err) => {
		console.warn("[studio-master] spawn error:", err.message);
		inputStream.unpipe(child.stdin);
		inputStream.pipe(outStream);
	});

	child.on("exit", (code) => {
		if (code !== 0 && !aborted) {
			console.warn("[studio-master] ffmpeg exited code=" + code);
		}
	});

	return outStream;
}

/**
 * Find the byte offset where PCM data starts in a WAV buffer,
 * scanning RIFF chunks so extra chunks (fact, LIST, etc.) don't corrupt parsing.
 */
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

/**
 * Process a complete WAV buffer through the studio chain.
 * Input: WAV buffer (any sample rate, mono)
 * Output: WAV buffer (48kHz stereo s16le)
 */
async function processWavBuffer(inputWav, inputSampleRate, signal) {
	if (!ffmpegPath) return inputWav;
	if (process.env.RME_BYPASS_STUDIO_MASTER === '1') return inputWav;

	const dataOffset = findDataOffset(inputWav);
	const pcmData = inputWav.subarray(dataOffset);
	const inputStream = new Readable();
	inputStream.push(pcmData);
	inputStream.push(null);

	const inputBitDepth = readWavBitsPerSample(inputWav);
	const outputStream = streamThroughMaster({ inputStream, inputSampleRate, inputBitDepth, signal });
	const chunks = [];
	try {
		for await (const chunk of outputStream) {
			chunks.push(chunk);
		}
	} catch {
		console.warn("[studio-master] processing failed, returning original");
		return inputWav;
	}

	if (chunks.length === 0) return inputWav;
	const processedPcm = Buffer.concat(chunks);
	if (processedPcm.length === 0) return inputWav;
	const header = buildWavHeader(processedPcm.length, OUTPUT_SAMPLE_RATE, OUTPUT_CHANNELS, OUTPUT_BITS_PER_SAMPLE);
	return Buffer.concat([header, processedPcm]);
}

function buildWavHeader(dataSize, sampleRate, channels, bitsPerSample) {
	const h = Buffer.alloc(44);
	const byteRate = sampleRate * channels * (bitsPerSample / 8);
	const blockAlign = channels * (bitsPerSample / 8);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + dataSize, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(channels, 22);
	h.writeUInt32LE(sampleRate, 24);
	h.writeUInt32LE(byteRate, 28);
	h.writeUInt16LE(blockAlign, 32);
	h.writeUInt16LE(bitsPerSample, 34);
	h.write("data", 36);
	h.writeUInt32LE(dataSize, 40);
	return h;
}

module.exports = { streamThroughMaster, processWavBuffer, findDataOffset };
