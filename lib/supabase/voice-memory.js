const { getAdminClient } = require("./admin-client");
const { embed } = require("../embeddings");
const { log } = require("../log");

function redact(tag, data) {
	log.info(tag, data);
}

async function storeTurn({ userEmail, role, content, cid, userName }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const emb = await embed(content);
		if (!emb.ok) {
			redact("memory", { storeTurn: "embed_failed", role, cid, error: emb.error });
			const { error: insertErr } = await sb.from("voice_conversations").insert({
				user_email: userEmail, turn_role: role, content, cid,
				user_name: userName || null,
			});
			if (insertErr) {
				redact("memory", { storeTurn: "insert_error", error: insertErr.message, cid });
				return { ok: false, error: { code: "DB_ERROR", message: insertErr.message } };
			}
			return { ok: true, data: null };
		}
		const { error: insertErr } = await sb.from("voice_conversations").insert({
			user_email: userEmail, turn_role: role, content, cid,
			user_name: userName || null,
			embedding: emb.data,
		});
		if (insertErr) {
			redact("memory", { storeTurn: "insert_error", error: insertErr.message, cid });
			return { ok: false, error: { code: "DB_ERROR", message: insertErr.message } };
		}
		return { ok: true, data: null };
	} catch (e) {
		redact("memory", { storeTurn: "exception", error: e instanceof Error ? e.message : String(e), cid });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function recallSemantic({ userEmail, queryText, k = 5, userName, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		if (!queryText || typeof queryText !== "string") {
			return { ok: false, error: { code: "BAD_INPUT", message: "queryText required" } };
		}
		const emb = await embed(queryText);
		if (!emb.ok) {
			return { ok: false, error: emb.error };
		}
			const { data, error } = await sb.rpc("match_voice_memories", {
			query_embedding: emb.data,
			match_count: k,
			user_email_filter: userEmail,
		});
		if (error) {
			redact("memory", { recallSemantic: "rpc_error", error: error.message });
			return { ok: false, error: { code: "RPC_ERROR", message: error.message } };
		}
		let out = data || [];
		const sId = speakerId || userName || null;
		if (sId) {
			out = out.filter(d => (d.speaker_id || d.user_name || 'unknown') === sId);
		}
		return { ok: true, data: out };
	} catch (e) {
		redact("memory", { recallSemantic: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function storeFact({ userEmail, key, value, sourceCid, confidence, userName, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const emb = await embed(key + ": " + value);

		/* Fetch previous value for contradiction detection (scope by user_name when provided) */
		let existingQuery = sb.from("voice_facts").select("fact_value, speaker_id").eq("user_email", userEmail).eq("fact_key", key).maybeSingle();
		const sId = speakerId || userName || 'unknown';
		existingQuery = sb.from("voice_facts").select("fact_value").eq("user_email", userEmail).eq("fact_key", key).eq("speaker_id", sId).maybeSingle();
		const { data: existing } = await existingQuery;
		let previousValue = null;
		if (existing && existing.fact_value) {
			previousValue = existing.fact_value;
		}

		const payload = {
			user_email: userEmail, fact_key: key, fact_value: value, source_cid: sourceCid,
			confidence: typeof confidence === "number" ? confidence : 1.0,
			user_name: userName || null,
			speaker_id: sId,
		};
		if (previousValue) payload.previous_value = previousValue;
		if (emb.ok) payload.embedding = emb.data;

		let upsertErr = null;
        // Use upsert so duplicate facts update instead of erroring. Include speaker_id
        // in the conflict target so facts scoped to different speakers don't collide.
        const res = await sb.from("voice_facts").upsert(payload, { onConflict: 'user_email,fact_key,speaker_id' });
		// Log raw PostgREST response so callers see literal response for debugging
		console.log('voice_facts upsert response:', JSON.stringify(res));
		upsertErr = res.error;
		const success = !upsertErr;
		if (_dreamMode) {
			_dreamOps.push({ op: "store", key, before: previousValue, after: value, timestamp: new Date().toISOString(), success, error: upsertErr ? upsertErr.message : null });
			console.log('dreamOps (push store):', JSON.stringify(_dreamOps));
		}
		if (upsertErr) {
			redact("memory", { storeFact: "upsert_error", error: upsertErr.message, key, cid: sourceCid });
			return { ok: false, error: { code: "DB_ERROR", message: upsertErr.message } };
		}

		/* Compute contradiction flag */
		let contradiction = false;
		if (previousValue && previousValue !== value) {
			contradiction = true;
		}

		return { ok: true, data: null, contradiction, previousValue };
	} catch (e) {
		redact("memory", { storeFact: "exception", error: e instanceof Error ? e.message : String(e), key, cid: sourceCid });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function listFacts({ userEmail, userName, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const sId = speakerId || userName || null;
		let query = sb.from("voice_facts").select("fact_key, fact_value, confidence, access_count, last_accessed_at, created_at, updated_at, speaker_id").eq("user_email", userEmail);
		if (sId) query = query.eq("speaker_id", sId);
		query = query.order("updated_at", { ascending: false });
		const { data, error } = await query;
		if (error) {
			redact("memory", { listFacts: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		redact("memory", { listFacts: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

let _dreamMode = false;
let _dreamOps = [];
let _dreamSessionPageId = null;

function enableDreamMode(enabled, pageId = null) {
	_dreamMode = !!enabled;
	_dreamSessionPageId = pageId || null;
	if (!_dreamMode) {
		_dreamOps.length = 0;
	}
}

function getDreamOps() {
	return _dreamOps.slice();
}

function clearDreamOps() {
	_dreamOps.length = 0;
}

async function forgetFact({ userEmail, key, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const sId = speakerId || 'unknown';
		let beforeVal = null;
		if (_dreamMode) {
			try {
				const q = await sb.from("voice_facts").select("fact_value").eq("user_email", userEmail).eq("fact_key", key).eq("speaker_id", sId).maybeSingle();
				if (q && q.data && q.data.fact_value) beforeVal = q.data.fact_value;
			} catch {}
		}
		const { error } = await sb.from("voice_facts")
			.delete()
			.eq("user_email", userEmail)
			.eq("fact_key", key)
			.eq("speaker_id", sId);
		if (error) {
			redact("memory", { forgetFact: "delete_error", error: error.message, key });
			if (_dreamMode) {
				_dreamOps.push({ op: "delete", key, before: beforeVal, after: null, timestamp: new Date().toISOString(), success: false, error: error.message });
			}
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		if (_dreamMode) {
			_dreamOps.push({ op: "delete", key, before: beforeVal, after: null, timestamp: new Date().toISOString(), success: true, error: null });
			console.log('dreamOps (push delete):', JSON.stringify(_dreamOps));
		}
		return { ok: true, data: null };
	} catch (e) {
		redact("memory", { forgetFact: "exception", error: e instanceof Error ? e.message : String(e), key });
		if (_dreamMode) {
			_dreamOps.push({ op: "delete", key, before: null, after: null, timestamp: new Date().toISOString(), success: false, error: e instanceof Error ? e.message : String(e) });
		}
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function getRecentConversations({ userEmail, userName, speakerId, limit = 100 }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const sId = speakerId || userName || null;
		let query = sb.from("voice_conversations").select("turn_role, content, user_name, speaker_id").eq("user_email", userEmail);
		if (sId) query = query.eq("speaker_id", sId);
		query = query.order("created_at", { ascending: false }).limit(limit);
		const { data, error } = await query;
		if (error) {
			redact("memory", { getRecentConversations: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		redact("memory", { getRecentConversations: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function searchFacts({ userEmail, search, limit = 5, userName, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		if (!search || typeof search !== "string" || !search.trim()) {
			return { ok: false, error: { code: "BAD_INPUT", message: "search string required" } };
		}
		const pattern = `%${search.trim()}%`;
		const sId = speakerId || userName || null;
		let query = sb.from("voice_facts").select("fact_key, fact_value, confidence, access_count, last_accessed_at, created_at, updated_at, speaker_id").eq("user_email", userEmail);
		if (sId) query = query.eq("speaker_id", sId);
		query = query.or(`fact_key.ilike.${pattern},fact_value.ilike.${pattern}`).order("updated_at", { ascending: false }).limit(limit);
		const { data, error } = await query;
		if (error) {
			redact("memory", { searchFacts: "select_error", error: error.message, search });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		redact("memory", { searchFacts: "exception", error: e instanceof Error ? e.message : String(e), search });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function searchConversations({ userEmail, query, lookback = '7d', limit = 5 }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		if (!query || typeof query !== 'string') return { ok: false, error: { code: 'BAD_INPUT', message: 'query required' } };
		let q = sb.from("voice_conversations").select("created_at, speaker_id, user_name, content").eq("user_email", userEmail);
		const now = new Date();
		if (lookback === '7d') {
			const since = new Date(now.getTime() - 7*24*60*60*1000).toISOString();
			q = q.gte("created_at", since);
		} else if (lookback === '30d') {
			const since = new Date(now.getTime() - 30*24*60*60*1000).toISOString();
			q = q.gte("created_at", since);
		}
		q = q.ilike("content", `%${query}%`).order("created_at", { ascending: false }).limit(limit);
		const { data, error } = await q;
		if (error) {
			redact("memory", { searchConversations: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		redact("memory", { searchConversations: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function bumpAccess({ userEmail, key, userName, speakerId }) {
    try {
        const sb = getAdminClient();
        if (!sb) return;
        const sId = speakerId || userName || null;
        let query = sb.from("voice_facts").update({ last_accessed_at: new Date().toISOString() }).eq("user_email", userEmail).eq("fact_key", key);
        if (sId) query = query.eq("speaker_id", sId);
        await query;
    } catch {}
}

function isDreamModeActive() { return _dreamMode === true; }

module.exports = { storeTurn, recallSemantic, storeFact, listFacts, forgetFact, getRecentConversations, searchFacts, searchConversations, bumpAccess, enableDreamMode, getDreamOps, clearDreamOps, isDreamModeActive };
