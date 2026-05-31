// lib/voice-agent/tts-mixer.js
// RME speech-tag audio engine: parses [slow]/[fast]/[emph]/[pause]/[chuckle] etc.
// into real audio transformations using ffmpeg atempo + silence insertion.
// Pure PCM pipeline — no SSML, no markup leakage.
'use strict'

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { parseSpeechTags } = require('./speech-tags')

const TAGS_ENABLED = String(process.env.RME_TTS_TAGS || 'on').trim().toLowerCase() !== 'off'
const RATE_SLOW = parseFloat(process.env.RME_TTS_RATE_SLOW) || 0.85
const RATE_FAST = parseFloat(process.env.RME_TTS_RATE_FAST) || 1.18
const NONVERBAL_GAIN = parseFloat(process.env.RME_NONVERBAL_GAIN) || 0.9
const CLIP_DIR = String(process.env.RME_NONVERBAL_DIR || path.join(__dirname, '..', '..', 'tools', 'voice', 'nonverbals')).trim()
const SAMPLE_RATE = 24000
const BYTES_PER_SAMPLE = 2
const FADE_SAMPLES = Math.floor(SAMPLE_RATE * 0.006) // 6ms

// In-memory clip cache
const _clipCache = {}

// ---- WAV helpers ----

function readWavPcm(buf) {
	if (!buf || buf.length < 44) return null
	const dataOffset = findWavDataOffset(buf)
	const dataSize = buf.readUInt32LE(dataOffset - 4)
	return buf.subarray ? buf.subarray(dataOffset, dataOffset + dataSize) : buf.slice(dataOffset, dataOffset + dataSize)
}

function findWavDataOffset(buf) {
	let off = 12
	while (off + 8 <= buf.length) {
		const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3])
		const sz = buf.readUInt32LE(off + 4)
		if (id === 'data') return off + 8
		off += 8 + sz + (sz % 2)
	}
	return 44
}

function wrapWav(pcmBuffer, sampleRate) {
	const dataSize = pcmBuffer.length
	const header = Buffer.alloc(44)
	header.write('RIFF', 0)
	header.writeUInt32LE(36 + dataSize, 4)
	header.write('WAVE', 8)
	header.write('fmt ', 12)
	header.writeUInt32LE(16, 16) // chunk size
	header.writeUInt16LE(1, 20) // PCM
	header.writeUInt16LE(1, 22) // mono
	header.writeUInt32LE(sampleRate, 24)
	header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28) // byte rate
	header.writeUInt16LE(BYTES_PER_SAMPLE, 32) // block align
	header.writeUInt16LE(16, 34) // bits per sample
	header.write('data', 36)
	header.writeUInt32LE(dataSize, 40)
	return Buffer.concat([header, pcmBuffer])
}

function readWavSampleRate(buf) {
	if (!buf || buf.length < 44) return SAMPLE_RATE
	return buf.readUInt32LE(24) || SAMPLE_RATE
}

// ---- Silence ----

function silencePcm(ms, sampleRate) {
	const nsamples = Math.floor(sampleRate * ms / 1000)
	return Buffer.alloc(nsamples * BYTES_PER_SAMPLE)
}

// ---- ffmpeg atempo (pitch-preserving) ----

function applyRate(wavBuf, rate, sampleRate, ffmpegPath) {
	if (rate === 1) return Promise.resolve(wavBuf)
	return new Promise((resolve, reject) => {
		const ffmpeg = ffmpegPath || 'ffmpeg'
		const child = spawn(ffmpeg, [
			'-f', 'wav', '-i', 'pipe:0',
			'-filter:a', `atempo=${rate.toFixed(6)}`,
			'-f', 'wav', 'pipe:1'
		], {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		})
		const chunks = []
		let stderr = ''
		child.stdout.on('data', c => chunks.push(c))
		child.stderr.on('data', d => { stderr += String(d) })
		child.on('error', reject)
		child.on('close', code => {
			if (code !== 0) {
				console.warn(`[tts-mixer] ffmpeg atempo rate=${rate} exited ${code}:`, stderr.slice(0, 300))
				// Graceful fallback: return original buffer on failure
				return resolve(wavBuf)
			}
			resolve(Buffer.concat(chunks))
		})
		child.stdin.write(wavBuf)
		child.stdin.end()
	})
}

// ---- Non-verbal clip loader ----

function ensureClipDir() {
	try { fs.mkdirSync(CLIP_DIR, { recursive: true }) } catch {}
	for (const name of ['sigh', 'chuckle', 'laugh', 'breath', 'clear_throat', 'cough']) {
		try { fs.mkdirSync(path.join(CLIP_DIR, name), { recursive: true }) } catch {}
	}
}

function loadNonverbal(name) {
	if (_clipCache[name]) return _clipCache[name]

	const dir = path.join(CLIP_DIR, name)
	if (!fs.existsSync(dir)) return null

	const variants = []
	try {
		const files = fs.readdirSync(dir)
			.filter(f => f.endsWith('.wav'))
			.sort()
		for (const f of files) {
			variants.push(fs.readFileSync(path.join(dir, f)))
		}
	} catch {
		return null
	}

	if (!variants.length) return null

	// Return all variants for random selection
	_clipCache[name] = variants
	return variants
}

function pickNonverbalClip(name) {
	const variants = loadNonverbal(name)
	if (!variants || !variants.length) return null
	const idx = Math.floor(Math.random() * variants.length)
	return variants[idx]
}

// ---- Edge fade for click-free concatenation ----

function applyFade(pcmBuf, fadeLen, fadeOut) {
	if (!pcmBuf || pcmBuf.length < 4) return pcmBuf
	const nsamples = Math.min(Math.floor(pcmBuf.length / 2), fadeLen)
	if (nsamples === 0) return pcmBuf
	const out = Buffer.alloc(pcmBuf.length)
	pcmBuf.copy(out)

	for (let i = 0; i < nsamples; i++) {
		const gain = fadeOut ? 1 - (i / nsamples) : (i / nsamples)
		const offset = fadeOut ? (pcmBuf.length / 2 - nsamples + i) * 2 : i * 2
		if (offset >= 0 && offset + 1 < out.length) {
			const sample = out.readInt16LE(offset)
			out.writeInt16LE(Math.round(sample * gain), offset)
		}
	}
	return out
}

function concatWithEdgeFade(parts, sampleRate, fadeMs) {
	if (!parts.length) return Buffer.alloc(0)
	if (parts.length === 1) return parts[0]

	const fadeSamples = Math.floor(sampleRate * (fadeMs || 0.006))
	const segments = []

	for (let i = 0; i < parts.length; i++) {
		let buf = parts[i]
		if (i > 0) buf = applyFade(buf, fadeSamples, false)  // fade in
		if (i < parts.length - 1) buf = applyFade(buf, fadeSamples, true)  // fade out
		segments.push(buf)
	}

	return Buffer.concat(segments)
}

// ---- Prosody to Chatterbox params ----

function prosodyToChatterbox(prosody) {
	const params = {}
	if (prosody.emphasis) {
		params.exaggeration = 0.7
		params.cfg_weight = 0.45
	}
	return params
}

// ---- Main synth entry point ----

/**
 * @param {string} taggedText — text with RME speech tags
 * @param {{ synthChunk: (text: string, prosody?: object) => Promise<{merged:Buffer, durationMs:number}>,
 *            sampleRate?: number,
 *            ffmpegPath?: string,
 *            isFirstChunk?: boolean }} opts
 * @returns {Promise<{merged:Buffer, durationMs:number}>}
 */
async function synthTagged(taggedText, opts = {}) {
	const { synthChunk, sampleRate = SAMPLE_RATE, ffmpegPath, isFirstChunk = false } = opts

	// Full bypass: no tags or tags disabled
	if (!TAGS_ENABLED || !taggedText) {
		return synthChunk(String(taggedText || '').trim())
	}

	const tokens = parseSpeechTags(taggedText)

	// Check if any tag token exists — if all text, skip mixer
	const hasTags = tokens.some(t => t.type !== 'text')
	if (!hasTags) {
		return synthChunk(taggedText.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim())
	}

	// First chunk: skip rate changes and clip splicing for TTFA budget
	const applyTransform = !isFirstChunk
	const pcmParts = []

	ensureClipDir()

	for (const t of tokens) {
		if (t.type === 'text') {
			let text = t.value
			if (!text) continue
			const prosody = prosodyToChatterbox(t.prosody)
			let result
			try {
				result = await synthChunk(text, prosody)
			} catch (e) {
				console.warn('[tts-mixer] synthChunk failed for text:', text.slice(0, 50), e instanceof Error ? e.message : String(e))
				continue
			}
			if (!result || !result.merged) continue
			let pcm = readWavPcm(result.merged)
			if (!pcm) continue

			if (applyTransform && t.prosody.rate !== 1) {
				try {
					const rateBuf = await applyRate(result.merged, t.prosody.rate, sampleRate, ffmpegPath)
					pcm = readWavPcm(rateBuf) || pcm
				} catch {
					// keep original pcm on rate failure
				}
			}
			pcmParts.push(pcm)
		} else if (t.type === 'pause') {
			if (applyTransform) {
				pcmParts.push(silencePcm(t.ms, sampleRate))
			}
			// skip pauses on first chunk
		} else if (t.type === 'sound') {
			if (!applyTransform) continue // skip clips on first chunk
			const clip = pickNonverbalClip(t.name)
			if (clip) {
				const pcm = readWavPcm(clip)
				if (pcm) pcmParts.push(pcm)
			}
			// missing clip => skip silently
		}
	}

	if (!pcmParts.length) {
		return { merged: wrapWav(silencePcm(100, sampleRate), sampleRate), durationMs: 100 }
	}

	const mergedPcm = concatWithEdgeFade(pcmParts, sampleRate, 6)
	const merged = wrapWav(mergedPcm, sampleRate)
	const durationMs = Math.round((mergedPcm.length / (sampleRate * BYTES_PER_SAMPLE)) * 1000)

	return { merged, durationMs }
}

function tagsEnabled() {
	return TAGS_ENABLED
}

module.exports = { synthTagged, tagsEnabled, applyRate, silencePcm, concatWithEdgeFade, ensureClipDir, wrapWav, readWavPcm }
