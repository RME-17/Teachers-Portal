const { getAdminClient } = require("./admin-client");
const { log } = require("../log");

async function storePageRef({ userEmail, pageId, pageName, databaseId, sourceCid, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const normalized = pageName.trim().toLowerCase().replace(/\s+/g, " ");
		const sId = speakerId || 'unknown';
		const { error } = await sb.from("voice_page_refs").upsert({
			user_email: userEmail,
			page_id: pageId,
			page_name: normalized,
			database_id: databaseId || null,
			source_cid: sourceCid || null,
			speaker_id: sId,
		}, {
			onConflict: "user_email, page_name, speaker_id",
			ignoreDuplicates: false,
		});
		if (error) {
			log.info("pageMemory", { storePageRef: "upsert_error", error: error.message, pageName });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: null };
	} catch (e) {
		log.info("pageMemory", { storePageRef: "exception", error: e instanceof Error ? e.message : String(e), pageName });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function findPageRef({ userEmail, pageName, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const normalized = pageName.trim().toLowerCase().replace(/\s+/g, " ");
		const sId = speakerId || 'unknown';
		const { data, error } = await sb.from("voice_page_refs")
			.select("*")
			.eq("user_email", userEmail)
			.eq("page_name", normalized)
			.eq("speaker_id", sId)
			.maybeSingle();
		if (error) {
			log.info("pageMemory", { findPageRef: "select_error", error: error.message, pageName });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || null };
	} catch (e) {
		log.info("pageMemory", { findPageRef: "exception", error: e instanceof Error ? e.message : String(e), pageName });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function listPageRefs({ userEmail, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const sId = speakerId || 'unknown';
		const { data, error } = await sb.from("voice_page_refs")
			.select("page_id, page_name, database_id, created_at, updated_at, access_count, last_accessed_at, speaker_id")
			.eq("user_email", userEmail)
			.eq("speaker_id", sId)
			.order("updated_at", { ascending: false });
		if (error) {
			log.info("pageMemory", { listPageRefs: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		log.info("pageMemory", { listPageRefs: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function removePageRef({ userEmail, pageName, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const normalized = pageName.trim().toLowerCase().replace(/\s+/g, " ");
		const sId = speakerId || 'unknown';
		const { error } = await sb.from("voice_page_refs")
			.delete()
			.eq("user_email", userEmail)
			.eq("page_name", normalized)
			.eq("speaker_id", sId);
		if (error) {
			log.info("pageMemory", { removePageRef: "delete_error", error: error.message, pageName });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: null };
	} catch (e) {
		log.info("pageMemory", { removePageRef: "exception", error: e instanceof Error ? e.message : String(e), pageName });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function searchPageRefs({ userEmail, search, limit = 5, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		if (!search || typeof search !== "string" || !search.trim()) {
			return { ok: false, error: { code: "BAD_INPUT", message: "search string required" } };
		}
		const pattern = `%${search.trim()}%`;
		const sId = speakerId || 'unknown';
		const { data, error } = await sb.from("voice_page_refs")
			.select("page_id, page_name, database_id, created_at, updated_at, access_count, last_accessed_at, speaker_id")
			.eq("user_email", userEmail)
			.eq("speaker_id", sId)
			.ilike("page_name", pattern)
			.order("updated_at", { ascending: false })
			.limit(limit);
		if (error) {
			log.info("pageMemory", { searchPageRefs: "select_error", error: error.message, search });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		log.info("pageMemory", { searchPageRefs: "exception", error: e instanceof Error ? e.message : String(e), search });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function bumpAccess({ userEmail, pageName, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return;
		const normalized = pageName.trim().toLowerCase().replace(/\s+/g, " ");
		const sId = speakerId || 'unknown';
		await sb.from("voice_page_refs")
			.update({ last_accessed_at: new Date().toISOString() })
			.eq("user_email", userEmail)
			.eq("page_name", normalized)
			.eq("speaker_id", sId);
	} catch {}
}

module.exports = { storePageRef, findPageRef, listPageRefs, removePageRef, searchPageRefs, bumpAccess };
