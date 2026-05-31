/**
 * Split normalized TTS text into Kokoro-sized chunks (pure function).
 */

/** @param {string} s */
function wordCount(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/** @param {string} text @param {number} limit */
function splitByWordLimit(text, limit) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  /** @type {string[]} */
  const out = [];
  let batch = [];
  for (const w of words) {
    batch.push(w);
    if (batch.length >= limit) {
      out.push(batch.join(" "));
      batch = [];
    }
  }
  if (batch.length) out.push(batch.join(" "));
  return out;
}

/** @param {string} text */
// Abbreviations whose trailing dot should NOT trigger a sentence split
const ABBREV_RE = /\b(p\.?m|a\.?m|e\.?g|i\.?e|mr|mrs|ms|dr|prof|sr|jr|vs|etc|approx|inc|ltd|dept|est|vol|ed|no|st|ave|blvd|rd)\.?\b/gi

function splitSentences(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  // First: protect abbreviation dots by replacing them temporarily
  const protected_ = t.replace(ABBREV_RE, (m) => m.replace(/\./g, '\x00'))

  const sentences = [];
  const re = /[^.!?]+[.!?]+|[^.!?]+$/g;
  let m;
  while ((m = re.exec(protected_)) !== null) {
    const s = m[0].replace(/\x00/g, '.').trim();
    if (s) sentences.push(s);
  }
  return sentences;
}

/** @param {string} sentence */
function splitClauses(sentence) {
  const parts = String(sentence || "")
    .split(/(?<=[,;])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(sentence || "").trim()].filter(Boolean);
}

/**
 * @param {string} text
 * @param {number} [maxWords]
 * @returns {string[]}
 */
function chunkForTts(text, maxWords = 40) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];

  const limit = Math.max(1, Math.floor(Number(maxWords) || 40));
  const sentences = splitSentences(normalized);
  /** @type {string[]} */
  const units = [];

  for (const sentence of sentences) {
    if (wordCount(sentence) <= limit) {
      units.push(sentence);
      continue;
    }
    for (const clause of splitClauses(sentence)) {
      if (wordCount(clause) <= limit) {
        units.push(clause);
      } else {
        units.push(...splitByWordLimit(clause, limit));
      }
    }
  }

  /** @type {string[]} */
  const chunks = [];
  let current = "";

  for (const unit of units) {
    const w = wordCount(unit);
    if (w > limit) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      chunks.push(...splitByWordLimit(unit, limit));
      continue;
    }
    const combined = current ? `${current} ${unit}` : unit;
    if (wordCount(combined) <= limit) {
      current = combined;
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter(Boolean);
}


/**
 * @param {string} normalized
 * @param {string[]} chunks
 */
/**
 * Greedy-merge units (sentences/clauses) into synth-sized lines.
 * @param {string[]} units
 * @param {number} maxWords
 * @param {number} maxChars
 */
function mergeUnitsIntoSynthChunks(units, maxWords, maxChars) {
  /** @type {string[]} */
  const out = [];
  let current = "";

  for (const unit of units) {
    const u = String(unit || "").trim();
    if (!u) continue;
    if (wordCount(u) > maxWords || u.length > maxChars) {
      if (current.trim()) {
        out.push(current.trim());
        current = "";
      }
      out.push(...splitForSynth(u, maxWords, maxChars));
      continue;
    }
    const combined = current ? `${current} ${u}` : u;
    if (wordCount(combined) <= maxWords && combined.length <= maxChars) {
      current = combined;
    } else {
      if (current.trim()) out.push(current.trim());
      current = u;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Last-resort split: pack words, but break at the last comma/period before the limit.
 * @param {string} text
 * @param {number} maxWords
 * @param {number} maxChars
 */
function splitByNaturalWordBoundary(text, maxWords, maxChars) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];

  /** @type {string[]} */
  const out = [];
  let batch = [];

  const flush = () => {
    if (!batch.length) return;
    let line = batch.join(" ");
    if (wordCount(line) <= maxWords && line.length <= maxChars) {
      out.push(line);
      batch = [];
      return;
    }
    const breakAt = Math.max(
      line.lastIndexOf(". "),
      line.lastIndexOf("? "),
      line.lastIndexOf("! "),
      line.lastIndexOf(", "),
      line.lastIndexOf("; "),
    );
    if (breakAt > 20) {
      const left = line.slice(0, breakAt + 1).trim();
      const right = line.slice(breakAt + 2).trim();
      if (left) out.push(left);
      batch = right ? right.split(/\s+/).filter(Boolean) : [];
      return;
    }
    out.push(...splitByWordLimit(line, maxWords));
    batch = [];
  };

  for (const w of words) {
    const candidate = batch.length ? `${batch.join(" ")} ${w}` : w;
    if (wordCount(candidate) <= maxWords && candidate.length <= maxChars) {
      batch.push(w);
    } else {
      flush();
      batch = [w];
    }
  }
  flush();
  return out.filter(Boolean);
}

/**
 * Split for Kokoro generate() — prefer sentence/clause boundaries over raw word count.
 * @param {string} text
 * @param {number} [maxWords]
 * @param {number} [maxChars]
 * @returns {string[]}
 */
function splitForSynth(text, maxWords = 28, maxChars = 200) {
  const t = String(text || "").trim();
  if (!t) return [];
  const maxW = Math.max(1, Math.floor(Number(maxWords) || 28));
  const maxC = Math.max(40, Math.floor(Number(maxChars) || 200));
  const MIN_CHARS = 40; // never emit chunks shorter than this
  if (wordCount(t) <= maxW && t.length <= maxC) return [t];

  const sentences = splitSentences(t);
  let candidates;
  if (sentences.length > 1) {
    candidates = mergeUnitsIntoSynthChunks(sentences, maxW, maxC);
  } else {
    const clauses = splitClauses(t);
    candidates = clauses.length > 1
      ? mergeUnitsIntoSynthChunks(clauses, maxW, maxC)
      : splitByNaturalWordBoundary(t, maxW, maxC);
  }

  // Merge micro-chunks: never emit a chunk shorter than MIN_CHARS
  const out = [];
  let buf = "";
  for (const c of candidates) {
    const ct = String(c || "").trim();
    if (!ct) continue;
    const combined = buf ? buf + " " + ct : ct;
    if (buf && combined.length <= maxC) {
      buf = combined;
    } else if (ct.length < MIN_CHARS && out.length > 0) {
      // too small to stand alone — append to previous chunk if it fits
      const prev = out[out.length - 1];
      const merged = prev + " " + ct;
      if (merged.length <= maxC) {
        out[out.length - 1] = merged;
      } else {
        out.push(ct);
      }
    } else {
      if (buf) { out.push(buf); buf = ""; }
      buf = ct;
    }
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

function assertChunkCoverage(normalized, chunks) {
  const joined = chunks.join(" ").replace(/\s+/g, " ").trim();
  const src = String(normalized).replace(/\s+/g, " ").trim();
  if (joined !== src) {
    throw new Error(
      "TTS chunk coverage mismatch (joined " +
        wordCount(joined) +
        " words, source " +
        wordCount(src) +
        " words).",
    );
  }
}

module.exports = {
  chunkForTts,
  splitForSynth,
  wordCount,
  splitSentences,
  splitByWordLimit,
  assertChunkCoverage,
};
