const { getAdminClient } = require("./admin-client");
const { log } = require("../log");

async function getProfile({ userEmail, name, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		if (!name || typeof name !== "string") {
			return { ok: false, error: { code: "BAD_INPUT", message: "name required" } };
		}
		const sId = speakerId || null;
		let query = sb.from("voice_user_profiles").select("name, display_name, title, bio, suggestions, tone").eq("name", name.trim().toLowerCase());
		if (sId) query = query.eq("speaker_id", sId);
		const { data, error } = await query.maybeSingle();
		if (error) {
			log.info("voice-profiles", { getProfile: "select_error", error: error.message, name });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		if (!data) {
			return { ok: false, error: { code: "NOT_FOUND", message: `No profile for "${name}"` } };
		}
		return { ok: true, data };
	} catch (e) {
		log.info("voice-profiles", { getProfile: "exception", error: e instanceof Error ? e.message : String(e), name });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function listProfiles({ userEmail, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE", message: "Supabase not configured" } };
		const sId = speakerId || null;
		let query = sb.from("voice_user_profiles").select("name, display_name, title, bio, suggestions, tone").order("name", { ascending: true });
		if (sId) query = query.eq("speaker_id", sId);
		const { data, error } = await query;
		if (error) {
			log.info("voice-profiles", { listProfiles: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		log.info("voice-profiles", { listProfiles: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

module.exports = { getProfile, listProfiles };
