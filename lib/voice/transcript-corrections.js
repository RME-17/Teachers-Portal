const CORRECTIONS = [
  [/\bthus code\b/gi, 'Discord'],
  [/\bthis code\b/gi, 'Discord'],
  [/\bdis code\b/gi, 'Discord'],
  [/\bdis course\b/gi, 'Discord'],
  [/\bdiscourse\b/gi, 'Discord'],
  [/\bthe cord\b/gi, 'Discord'],
  [/\bdisc ord\b/gi, 'Discord'],
  [/\bdiscord\s+it\b/gi, 'Discord'],
  [/\bthe score\b/gi, 'Discord'],
  // Paragraph mis-hearings
  [/\b(a |one )?pair of graph\b/gi, 'one paragraph'],
  [/\bpair of graphs\b/gi, 'paragraphs'],
  [/\bparagraph\s+of\s+update\b/gi, 'paragraph update'],
  [/\b1 pair of graph\b/gi, 'one paragraph'],
];

function correctTranscript(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of CORRECTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

module.exports = { correctTranscript, CORRECTIONS };
