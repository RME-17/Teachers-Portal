// lib/voice-agent/speech-tags.js
// Parses RME speech tags into an ordered token list for the TTS mixer.
// Pure, no I/O. Strips every tag so nothing leaks into spoken text.
'use strict'

const RATE = Object.freeze({ slow: 0.85, fast: 1.18 })
const PAUSE_MIN_MS = 50
const PAUSE_MAX_MS = 2000
const SOUNDS = Object.freeze({
	sigh: 'sigh', chuckle: 'chuckle', laugh: 'laugh',
	breath: 'breath', cough: 'cough',
	'clear throat': 'clear_throat', clear_throat: 'clear_throat', clearthroat: 'clear_throat',
})

const TAG_RE = /\[(\/?)(slow|fast|emph|pause|sigh|chuckle|laugh|breath|clear[ _]?throat|cough)(?:=(\d+))?\]/gi

/**
 * @param {string} input
 * @returns {Array<{type:'text',value:string,prosody:{rate:number,emphasis:boolean}}
 *                 |{type:'pause',ms:number}
 *                 |{type:'sound',name:string}>}
 */
function parseSpeechTags(input) {
	const tokens = []
	let rate = 1
	let emph = 0
	let cursor = 0

	const pushText = (raw) => {
		// collapse any UNKNOWN [..] tags so they are never spoken
		const clean = String(raw || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ')
		if (clean.trim()) {
			tokens.push({ type: 'text', value: clean.trim(), prosody: { rate, emphasis: emph > 0 } })
		}
	}

	for (const m of (input || '').matchAll(TAG_RE)) {
		pushText(input.slice(cursor, m.index))
		cursor = m.index + m[0].length
		const closing = m[1] === '/'
		const name = m[2].toLowerCase().replace(/\s+/g, ' ')
		const num = m[3]

		if (name === 'slow' || name === 'fast') {
			rate = closing ? 1 : RATE[name]
		} else if (name === 'emph') {
			emph = Math.max(0, emph + (closing ? -1 : 1))
		} else if (name === 'pause' && !closing) {
			const ms = Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, Number(num) || 300))
			tokens.push({ type: 'pause', ms })
		} else if (SOUNDS[name] && !closing) {
			tokens.push({ type: 'sound', name: SOUNDS[name] })
		}
	}
	pushText(input.slice(cursor))
	return tokens
}

function hasSpeechTags(text) {
	if (!text) return false
	TAG_RE.lastIndex = 0
	return TAG_RE.test(text)
}

module.exports = { parseSpeechTags, hasSpeechTags, RATE, PAUSE_MIN_MS, PAUSE_MAX_MS, SOUNDS, TAG_RE }
