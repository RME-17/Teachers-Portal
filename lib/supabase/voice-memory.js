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
			const { data: rows, error: insertErr } = await sb.from("voice_conversations").insert({
				user_email: userEmail, turn_role: role, content, cid,
				user_name: userName || null,
			}).select("id");
			if (insertErr) {
				redact("memory", { storeTurn: "insert_error", error: insertErr.message, cid });
				console.warn("[memory] storeTurn FAILED:", role, cid, insertErr.message);
				return { ok: false, error: { code: "DB_ERROR", message: insertErr.message } };
			}
			const rowId = rows && rows[0] ? rows[0].id : "unknown";
			console.log(`[memory] stored turn: ${role} id=${rowId} cid=${cid} chars=${content ? content.length : 0} session=${_currentSessionId}`);
			return { ok: true, data: { id: rowId } };
		}
		const { data: rows, error: insertErr } = await sb.from("voice_conversations").insert({
			user_email: userEmail, turn_role: role, content, cid,
			user_name: userName || null,
			embedding: emb.data,
		}).select("id");
		if (insertErr) {
			redact("memory", { storeTurn: "insert_error", error: insertErr.message, cid });
			console.warn("[memory] storeTurn FAILED:", role, cid, insertErr.message);
			return { ok: false, error: { code: "DB_ERROR", message: insertErr.message } };
		}
		const rowId = rows && rows[0] ? rows[0].id : "unknown";
		console.log(`[memory] stored turn: ${role} id=${rowId} cid=${cid} chars=${content ? content.length : 0} session=${_currentSessionId}`);
		return { ok: true, data: { id: rowId } };
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
		const sId = speakerId || userName || null;
		const { data, error } = await sb.rpc("match_voice_memories", {
			query_embedding: emb.data,
			match_count: k,
			user_email_filter: userEmail,
			speaker_filter: sId,
		});
		if (error) {
			redact("memory", { recallSemantic: "rpc_error", error: error.message });
			return { ok: false, error: { code: "RPC_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
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
		const sId = speakerId || userName || 'unknown';
		const existingQuery = sb.from("voice_facts").select("fact_value").eq("user_email", userEmail).eq("fact_key", key).eq("speaker_id", sId).maybeSingle();
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
let _summariesTableMissingWarned = false;

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
		let query = sb.from("voice_conversations")
			.select("turn_role, content, user_name, speaker_id, created_at")
			.eq("user_email", userEmail)
			.order("created_at", { ascending: false })
			.limit(limit);
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

// ---- SECTION 1: recallConversations with timeRange ----

async function recallConversations({ userEmail, timeRange, query, k = 5, userName, speakerId }) {
	if (query && typeof query === 'string' && query.trim()) {
		// Semantic path: embed query and match
		return recallSemantic({ userEmail, queryText: query, k, userName, speakerId });
	}
	if (timeRange) {
		// TimeRange path: return summary of that time window
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		try {
			let q = sb.from("voice_conversations").select("*").eq("user_email", userEmail);
			const now = new Date();
			if (timeRange === 'today') {
				const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
				q = q.gte("created_at", start);
			} else if (timeRange === '7d') {
				q = q.gte("created_at", new Date(now.getTime() - 7*24*60*60*1000).toISOString());
			} else if (timeRange === '30d') {
				q = q.gte("created_at", new Date(now.getTime() - 30*24*60*60*1000).toISOString());
			}
			q = q.order("created_at", { ascending: false }).limit(50);
			const { data, error } = await q;
			if (error) return { ok: false, error: { code: "DB_ERROR", message: error.message } };
			const turnsByDate = {};
			for (const row of (data || [])) {
				const d = new Date(row.created_at).toISOString().slice(0, 10);
				if (!turnsByDate[d]) turnsByDate[d] = [];
				turnsByDate[d].push(`${row.turn_role === 'assistant' ? 'Retron' : 'You'}: ${(row.content || '').slice(0, 200)}`);
			}
			const summary = Object.entries(turnsByDate)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([date, lines]) => `${date}: ${lines.length} turn(s). ${lines.slice(0, 3).join(' | ')}`)
				.join('\n');
			return { ok: true, data: summary.slice(0, 3000) };
		} catch (err) {
			return { ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } };
		}
	}
	// Default: recent N turns
	return searchConversations({ userEmail, query: '', limit: k });
}

// ---- SECTION 2: Session summaries ----

async function storeSessionSummary({ userEmail, sessionId, summary, userName }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const emb = await embed(summary);
		const payload = {
			user_email: userEmail,
			session_id: sessionId || null,
			speaker_id: userName || null,
			summary,
		};
		if (emb.ok) payload.embedding = emb.data;
		const { error } = await sb.from("voice_session_summaries").insert(payload);
		if (error) {
			redact("memory", { storeSessionSummary: "insert_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: null };
	} catch (err) {
		redact("memory", { storeSessionSummary: "exception", error: err instanceof Error ? err.message : String(err) });
		return { ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } };
	}
}

async function getRecentSummaries({ userEmail, k = 3 }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const { data, error } = await sb.from("voice_session_summaries")
			.select("summary, created_at")
			.eq("user_email", userEmail)
			.order("created_at", { ascending: false })
			.limit(k);
		if (error) {
			if (!_summariesTableMissingWarned) {
				_summariesTableMissingWarned = true;
				console.warn("[memory] voice_session_summaries table missing — run tools/migrations/voice-session-summaries.sql in Supabase SQL Editor (summaries unavailable, turns+facts still work)");
			}
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (err) {
		return { ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } };
	}
}

async function searchSummaries({ userEmail, queryText, k = 3 }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const emb = await embed(queryText);
		if (!emb.ok) return { ok: false, error: emb.error };
		const { data, error } = await sb.rpc("match_voice_summaries", {
			query_embedding: emb.data,
			match_count: k,
			user_email_filter: userEmail,
		});
		if (error) return { ok: false, error: { code: "RPC_ERROR", message: error.message } };
		return { ok: true, data: data || [] };
	} catch (err) {
		return { ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } };
	}
}

// ---- SECTION 3: Durable long-term memory digest ----

async function getMemoryDigest({ userEmail, maxTokens = 500, userName, speakerId, currentCid }) {
	try {
		const sId = speakerId || userName || null;
		console.log("[memory] getMemoryDigest: userEmail=" + userEmail + " speakerId=" + sId);
		// Load top active facts sorted by recency
		let factsResult = { ok: false, data: [] };
		let summariesResult = { ok: false, data: [] };
		let recentTurnsResult = { ok: false, data: [] };
		let priorTurnsResult = { ok: false, data: [] };
		try { factsResult = await listFacts({ userEmail, userName, speakerId: sId }); } catch (e) { console.warn("[memory] digest: facts fetch failed:", e instanceof Error ? e.message : String(e)); }
		try { summariesResult = await getRecentSummaries({ userEmail, k: 2 }); } catch (e) { console.warn("[memory] digest: summaries fetch failed:", e instanceof Error ? e.message : String(e)); }
		try { recentTurnsResult = await getRecentConversations({ userEmail, userName, speakerId: sId, limit: 10 }); } catch (e) { console.warn("[memory] digest: turns fetch failed:", e instanceof Error ? e.message : String(e)); }
		// Prior-session turns: all turns EXCEPT current cid, ordered by recency
		if (currentCid) {
			try {
				const sb = require("./admin-client").getAdminClient();
				if (sb) {
					const { data, error } = await sb.from("voice_conversations")
						.select("turn_role, content, created_at")
						.eq("user_email", userEmail)
						.neq("cid", currentCid)
						.order("created_at", { ascending: false })
						.limit(15);
					if (!error && Array.isArray(data)) priorTurnsResult = { ok: true, data };
				}
			} catch (e) { console.warn("[memory] digest: prior turns fetch failed:", e instanceof Error ? e.message : String(e)); }
		}

		console.log("[memory] digest: facts=" + (factsResult.ok ? factsResult.data.length : "ERR") +
			" summaries=" + (summariesResult.ok ? (summariesResult.data ? summariesResult.data.length : 0) : "ERR") +
			" turns=" + (recentTurnsResult.ok ? (Array.isArray(recentTurnsResult.data) ? recentTurnsResult.data.length : 0) : "ERR") +
			" priorTurns=" + (priorTurnsResult.ok ? (Array.isArray(priorTurnsResult.data) ? priorTurnsResult.data.length : 0) : "ERR"));
		// (per-source errors already logged once at source)

		const parts = [];

		if (summariesResult.ok && summariesResult.data.length > 0) {
			parts.push("## Memory: Recent sessions");
			for (const s of summariesResult.data) {
				parts.push(`- ${new Date(s.created_at).toLocaleDateString()}: ${s.summary.slice(0, 200)}`);
			}
		}

		if (factsResult.ok && factsResult.data.length > 0) {
			const active = factsResult.data.filter(f => f.confidence >= 0.6).slice(0, 15);
			if (active.length > 0) {
				parts.push("## Memory: What I know about you");
				for (const f of active) {
					parts.push(`- ${f.fact_key}: ${f.fact_value}`);
				}
			}
		}

		if (recentTurnsResult.ok && Array.isArray(recentTurnsResult.data) && recentTurnsResult.data.length > 0) {
			parts.push("## Memory: Recent conversation (last 10 turns)");
			const recent = recentTurnsResult.data.slice(0, 10).reverse();
			for (const t of recent) {
				const who = t.turn_role === 'assistant' ? 'Retron' : 'User';
				parts.push(`${who}: ${(t.content || '').slice(0, 200)}`);
			}
		}

		const digest = parts.join('\n').slice(0, maxTokens * 4); // ~4 chars per token
		const currentTurns = (recentTurnsResult.ok && Array.isArray(recentTurnsResult.data)) ? recentTurnsResult.data.length : 0;
		if (digest) {
			console.log("[memory] digest preview: " + digest.slice(0, 200).replace(/\n/g, " | "));
		} else {
			console.warn("[memory] WARNING: digest is EMPTY! No turns/summaries/facts found for userEmail=" + userEmail);
		}
		return {
			ok: true,
			data: digest,
			counts: {
				currentTurns,
				priorSessionTurns: (priorTurnsResult.ok && Array.isArray(priorTurnsResult.data)) ? priorTurnsResult.data.length : 0,
				summaries: (summariesResult.ok && summariesResult.data) ? summariesResult.data.length : 0,
				facts: (factsResult.ok && factsResult.data) ? factsResult.data.length : 0,
				tokens: Math.ceil(digest.length / 4),
			},
		};
	} catch (err) {
		return { ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } };
	}
}

// Track session state
let _currentSessionId = null;
let _turnCountInSession = 0;

function getCurrentSessionId() {
	if (!_currentSessionId) _currentSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
	return _currentSessionId;
}

function newSession() {
	_currentSessionId = null;
	_turnCountInSession = 0;
}

function bumpTurnCount() {
	_turnCountInSession++;
	return _turnCountInSession;
}

function getTurnCount() {
	return _turnCountInSession;
}

module.exports = {
	storeTurn,
	recallSemantic,
	recallConversations,
	storeFact,
	listFacts,
	forgetFact,
	getRecentConversations,
	searchFacts,
	searchConversations,
	bumpAccess,
	enableDreamMode,
	getDreamOps,
	clearDreamOps,
	isDreamModeActive,
	storeSessionSummary,
	getRecentSummaries,
	searchSummaries,
	getMemoryDigest,
	getCurrentSessionId,
	newSession,
	bumpTurnCount,
	getTurnCount,
};
