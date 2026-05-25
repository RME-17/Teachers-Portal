/**
 * Sanitize AI output for Discord text channels:
 * - Convert [emph]...[/emph] -> **...** (Discord bold)
 * - Remove [pause=NNN] tokens entirely
 * - Strip any other bracketed SSML-like tags ([slow], [/slow], [chuckle], etc.)
 * - Collapse excessive whitespace
 */
function sanitizeForDiscord(input) {
    if (input == null) return "";
    let s = String(input);

    // Convert [emph]...[/emph] to bold **...**
    s = s.replace(/\[emph\]([\s\S]*?)\[\/emph\]/gi, (m, p1) => {
        // Trim inner text
        const inner = String(p1 || "").trim();
        if (!inner) return "";
        return `**${inner}**`;
    });

    // Remove pause tokens like [pause=300]
    s = s.replace(/\[pause=\d+\]/gi, "");

    // Remove any remaining bracketed tags like [slow], [/slow], [chuckle], [fast], [/fast], etc.
    // Preserve inner text for tags that have closing tags (e.g. [slow]text[/slow]) since those were
    // handled above for [emph]. For standalone tags like [chuckle] just drop them.
    // A broad replace will remove leftover single tags and closing tags.
    s = s.replace(/\[\/?[a-z0-9_\-]+(?:=[^\]]+)?\]/gi, "");

    // Collapse multiple blank lines and trim
    s = s.replace(/\r\n/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s.trim();
    return s;
}

// Split text into chunks for Discord following these rules:
// 1) Prefer paragraph boundaries (\n\n)
// 2) Then sentence boundaries (.!? followed by space)
// 3) Hard backstop: split at maxLen with ellipses linking chunks (append … and prefix …)
function chunkForDiscord(text, maxLen = 1900) {
    if (text == null) return [];
    let s = String(text).trim();
    const M = Math.max(50, Math.floor(Number(maxLen) || 1900));
    if (s.length <= M) return [s];

    function hardSplit(str) {
        const parts = [];
        const ell = '…';
        let pos = 0;
        while (pos < str.length) {
            const remaining = str.length - pos;
            let take;
            if (pos === 0) {
                take = remaining > M ? M - 1 : remaining;
            } else {
                take = remaining > M ? M - 2 : Math.min(remaining, M - 1);
            }
            if (take <= 0) take = Math.max(1, M - 2);
            const slice = str.slice(pos, pos + take);
            let out = slice;
            if (pos > 0) out = ell + out;
            if (pos + take < str.length) out = out + ell;
            parts.push(out);
            pos += take;
        }
        return parts;
    }

    const paragraphs = s.split(/\n{2,}/g).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let current = '';

    const pushCurrent = () => { if (current) { chunks.push(current); current = ''; } };

    for (const para of paragraphs) {
        if (para.length <= M) {
            if (!current) current = para;
            else if (current.length + 2 + para.length <= M) current = current + '\n\n' + para;
            else { pushCurrent(); current = para; }
            continue;
        }

        // Paragraph itself exceeds max. Split by sentences.
        const sentences = para.split(/(?<=[.!?])\s+/g).map(s => s.trim()).filter(Boolean);
        let curPara = '';
        for (const sent of sentences) {
            if (sent.length > M) {
                // Flush any accumulated sentence group
                if (curPara) { chunks.push(curPara); curPara = ''; }
                // Hard-split the long sentence
                const hp = hardSplit(sent);
                for (const h of hp) chunks.push(h);
                continue;
            }
            if (!curPara) curPara = sent;
            else if (curPara.length + 1 + sent.length <= M) curPara = curPara + ' ' + sent;
            else { chunks.push(curPara); curPara = sent; }
        }
        if (curPara) {
            if (!current) current = curPara;
            else if (current.length + 2 + curPara.length <= M) current = current + '\n\n' + curPara;
            else { pushCurrent(); current = curPara; }
        }
    }
    if (current) pushCurrent();

    // Final safety: hard-split any remaining overlong chunks
    const final = [];
    for (const c of chunks) {
        if (c.length <= M) final.push(c);
        else final.push(...hardSplit(c));
    }

    return final;
}

module.exports = { sanitizeForDiscord, chunkForDiscord };
