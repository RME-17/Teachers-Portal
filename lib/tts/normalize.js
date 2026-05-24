/**
 * Normalize assistant text for Kokoro TTS (pure function).
 */
const { toWords, toWordsOrdinal } = require("number-to-words");

const KNOWN_ACRONYMS = new Set([
  "NASA",
  "ASAP",
  "FBI",
  "CIA",
  "NATO",
  "UN",
  "EU",
  "UK",
  "US",
  "USA",
  "PDF",
  "HTML",
  "API",
  "IPC",
  "TTS",
  "STT",
  "LLM",
  "AI",
  "HR",
  "VAT",
  "GPS",
  "SMS",
  "USB",
  "WiFi",
  "CEO",
  "CFO",
  "CTO",
]);

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** @param {number} n */
function intToWords(n) {
  const num = Math.trunc(Math.abs(n));
  let words = toWords(num).replace(/,/g, " ");
  words = words.replace(/\bhundred (\w[\w ]*)$/, "hundred and $1");
  return n < 0 ? `minus ${words}` : words;
}

/** @param {string} numStr */
function parseGroupedInteger(numStr) {
  const cleaned = String(numStr).replace(/,/g, "");
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

/** @param {string} y */
function yearToSpoken(y) {
  const n = parseInt(y, 10);
  if (!Number.isFinite(n)) return y;
  if (n >= 2000 && n <= 2099) {
    const century = Math.floor(n / 100);
    const rest = n % 100;
    if (rest === 0) return intToWords(n);
    return `${intToWords(century)} ${intToWords(rest)}`;
  }
  if (n >= 1900 && n <= 1999) {
    const rest = n % 100;
    if (rest === 0) return intToWords(n);
    return `${intToWords(1900)} ${intToWords(rest)}`;
  }
  return intToWords(n);
}

/** @param {string} d */
function dayToOrdinal(d) {
  const n = parseInt(d, 10);
  if (!Number.isFinite(n) || n < 1 || n > 31) return d;
  return toWordsOrdinal(n);
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeForTts(text, opts) {
	const preserveProsody = opts && opts.preserveProsody === true;
	let t = String(text ?? "");

	// By default (preserveProsody=false) strip prosody tags so non-TTS consumers see plain text.
	// When preserveProsody=true, keep [pause=...], [slow], [fast], [emph] intact for Chatterbox.
	if (!preserveProsody) {
		t = t.replace(/\[pause\s*=\s*\d+\]/gi, ", ");
		t = t.replace(/\[\/?slow\]/gi, "");
		t = t.replace(/\[\/?fast\]/gi, "");
		t = t.replace(/\[\/?emph\]/gi, "");
	}

	t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  t = t.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  t = t.replace(/[*#_~]/g, " ");
  t = t.replace(/^#{1,6}\s+/gm, "");

  t = t.replace(/\u2014/g, ", ");
  t = t.replace(/\u2026/g, "...");
  t = t.replace(/\.{4,}/g, "...");

  t = t.replace(
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    (_m, y, mo, d) => {
      const monthIdx = parseInt(mo, 10) - 1;
      const month =
        monthIdx >= 0 && monthIdx < 12 ? MONTH_NAMES[monthIdx] : mo;
      return `the ${dayToOrdinal(d)} of ${month}, ${yearToSpoken(y)}`;
    },
  );

  t = t.replace(
    /\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{1,2}))?\b/g,
    (_m, whole, cents) => {
      const n = parseGroupedInteger(whole);
      if (n == null) return _m;
      const base = intToWords(n);
      if (!cents || /^0+$/.test(cents)) {
        return n === 1 ? `${base} dollar` : `${base} dollars`;
      }
      const c = parseInt(cents.padEnd(2, "0").slice(0, 2), 10);
      const cWords = intToWords(c);
      return `${base} dollars and ${cWords} cents`;
    },
  );

  t = t.replace(
    /\bR\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{1,2}))?\b/gi,
    (_m, whole, cents) => {
      const n = parseGroupedInteger(whole);
      if (n == null) return _m;
      const base = intToWords(n);
      if (!cents || /^0+$/.test(cents)) {
        return `${base} rand`;
      }
      const c = parseInt(cents.padEnd(2, "0").slice(0, 2), 10);
      return `${base} rand and ${intToWords(c)} cents`;
    },
  );

  t = t.replace(
    /\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?\b/g,
    (_m, whole, frac) => {
      const n = parseGroupedInteger(whole);
      if (n == null) return _m;
      let out = intToWords(n);
      if (frac) {
        const f = parseInt(frac, 10);
        if (Number.isFinite(f)) {
          out += ` point ${frac.split("").map((d) => intToWords(parseInt(d, 10))).join(" ")}`;
        }
      }
      return out;
    },
  );

  t = t.replace(/\b[A-Z]{2,4}\b/g, (word) => {
    if (KNOWN_ACRONYMS.has(word)) return word;
    return word.split("").join(" ");
  });

  t = t.replace(/\b[A-Z]{2,}\b/g, (word) => {
    if (KNOWN_ACRONYMS.has(word)) return word;
    return word.toLowerCase();
  });

  t = t.replace(/\[chuckle\]/gi, "<<CHUCKLE>>");
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, " ");
  t = t.replace(/[^\w\s.,!?;:'"()\-]/gu, " ");
  t = t.replace(/<<CHUCKLE>>/g, "[chuckle]");

  t = t.replace(/\s+/g, " ").trim();
  return t;
}

module.exports = { normalizeForTts, KNOWN_ACRONYMS };
