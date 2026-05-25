const fetch = globalThis.fetch || require('node-fetch');

async function serpstackSearch(query, limit = 5) {
  const key = process.env.SERPSTACK_API_KEY || process.env.SERPSTACK_KEY;
  if (!key) return { ok: false, error: 'SERPSTACK_API_KEY not configured' };
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query required' };
  const num = Number(limit) || 5;
  const url = `http://api.serpstack.com/v1/search?access_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&num=${num}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();

    // serpstack payloads vary; try common fields
    const items = body.organic_results || body.organic || body.organic_results || body.data || body.results || [];
    const results = (Array.isArray(items) ? items : []).slice(0, num).map((it) => {
      return {
        title: it.title || it.name || it.heading || '',
        url: it.url || it.link || it.linked || it.source || '',
        snippet: it.snippet || it.description || it.excerpt || it.summary || '',
      };
    });
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { serpstackSearch };
