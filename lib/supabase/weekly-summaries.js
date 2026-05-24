const { getAdminClient } = require("./admin-client");
const { log } = require("../log");
const Anthropic = require("@anthropic-ai/sdk");

const GENERATION_MODEL = "claude-haiku-3-5-20241022";

function redact(tag, data) {
	log.info(tag, data);
}

async function getSummary({ userEmail, weekStart, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE" } };
		const sId = speakerId || 'unknown';
		const { data, error } = await sb.from("voice_weekly_summaries")
			.select("*")
			.eq("user_email", userEmail)
			.eq("week_start", weekStart)
			.eq("speaker_id", sId)
			.maybeSingle();
		if (error) {
			redact("weekly-summaries", { getSummary: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || null };
	} catch (e) {
		redact("weekly-summaries", { getSummary: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function getSummariesInRange({ userEmail, startDate, endDate, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE" } };
		const sId = speakerId || 'unknown';
		const { data, error } = await sb.from("voice_weekly_summaries")
			.select("*")
			.eq("user_email", userEmail)
			.eq("speaker_id", sId)
			.gte("week_start", startDate)
			.lte("week_end", endDate)
			.order("week_start", { ascending: false });
		if (error) {
			redact("weekly-summaries", { getSummariesInRange: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		redact("weekly-summaries", { getSummariesInRange: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function storeSummary({ userEmail, weekStart, weekEnd, summaryText, topicTags, turnCount, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE" } };
		const sId = speakerId || 'unknown';
		const { error } = await sb.from("voice_weekly_summaries").upsert({
			user_email: userEmail,
			week_start: weekStart,
			week_end: weekEnd,
			summary_text: summaryText,
			topic_tags: topicTags || [],
			turn_count: turnCount || 0,
			speaker_id: sId,
		}, { onConflict: "user_email, week_start, speaker_id" });
		if (error) {
			redact("weekly-summaries", { storeSummary: "upsert_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: null };
	} catch (e) {
		redact("weekly-summaries", { storeSummary: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function fetchConversationsInRange({ userEmail, startDate, endDate, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE" } };
		const sId = speakerId || 'unknown';
		const { data, error } = await sb.from("voice_conversations")
			.select("turn_role, content, created_at, speaker_id")
			.eq("user_email", userEmail)
			.eq("speaker_id", sId)
			.gte("created_at", startDate)
			.lte("created_at", endDate)
			.order("created_at", { ascending: true });
		if (error) {
			redact("weekly-summaries", { fetchConversationsInRange: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		redact("weekly-summaries", { fetchConversationsInRange: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

const SUMMARY_PROMPT = `Read the conversation history below and produce a concise weekly summary.

Include:
- Key topics discussed
- Teachers or people mentioned
- Actions taken or requested
- Decisions made or changes recorded

Then list 3-5 topic tags as a comma-separated line starting with "TAGS:".

Output format:
SUMMARY: <2-3 paragraph summary>
TAGS: <tag1, tag2, tag3>`;

async function generateSummary({ userEmail, weekStart, weekEnd }) {
	try {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			return { ok: false, error: { code: "NO_KEY", message: "ANTHROPIC_API_KEY not set" } };
		}

		const convResult = await fetchConversationsInRange({
			userEmail,
			startDate: new Date(weekStart).toISOString(),
			endDate: new Date(weekEnd.getTime() + 86400000).toISOString(),
		});
		if (!convResult.ok || !Array.isArray(convResult.data) || convResult.data.length === 0) {
			return { ok: false, error: { code: "NO_DATA", message: "No conversations in range" } };
		}

		const turns = convResult.data
			.map(row => `${row.turn_role === "assistant" ? "Assistant" : "User"}: ${row.content}`)
			.join("\n\n");

		const anthropic = new Anthropic({ apiKey });
		const res = await anthropic.messages.create({
			model: GENERATION_MODEL,
			max_tokens: 1024,
			system: SUMMARY_PROMPT,
			messages: [{ role: "user", content: turns }],
		});

		const text = res.content?.[0]?.text || "";
		if (!text.trim()) {
			return { ok: false, error: { code: "EMPTY", message: "Empty summary from model" } };
		}

		let summaryText = text;
		let topicTags = [];

		const tagsMatch = text.match(/TAGS:\s*(.+)/i);
		if (tagsMatch) {
			topicTags = tagsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
			summaryText = text.replace(/TAGS:\s*.+/i, "").replace(/SUMMARY:\s*/i, "").trim();
		} else {
			summaryText = text.replace(/SUMMARY:\s*/i, "").trim();
		}

		const storeResult = await storeSummary({
			userEmail,
			weekStart,
			weekEnd,
			summaryText,
			topicTags,
			turnCount: convResult.data.length,
		});

		redact("weekly-summaries", {
			generateSummary: "done", weekStart: weekStart.toISOString().slice(0, 10),
			turns: convResult.data.length, tags: topicTags.length, ok: storeResult.ok,
		});

		return {
			ok: true,
			data: {
				summaryText,
				topicTags,
				turnCount: convResult.data.length,
				weekStart,
				weekEnd,
			},
		};
	} catch (e) {
		redact("weekly-summaries", { generateSummary: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

async function searchConversationsInRange({ userEmail, startDate, endDate, searchTerms, speakerId }) {
	try {
		const sb = getAdminClient();
		if (!sb) return { ok: false, error: { code: "SUPABASE_UNAVAILABLE" } };
		if (!Array.isArray(searchTerms) || searchTerms.length === 0) {
			return { ok: true, data: [] };
		}
		const orConditions = searchTerms.map(term => {
			const pattern = `%${term}%`;
			return `content.ilike.${pattern}`;
		}).join(",");
		const sId = speakerId || 'unknown';
		const { data, error } = await sb.from("voice_conversations")
			.select("turn_role, content, created_at, speaker_id")
			.eq("user_email", userEmail)
			.eq("speaker_id", sId)
			.gte("created_at", startDate)
			.lte("created_at", endDate)
			.or(orConditions)
			.order("created_at", { ascending: true })
			.limit(20);
		if (error) {
			redact("weekly-summaries", { searchConversationsInRange: "select_error", error: error.message });
			return { ok: false, error: { code: "DB_ERROR", message: error.message } };
		}
		return { ok: true, data: data || [] };
	} catch (e) {
		redact("weekly-summaries", { searchConversationsInRange: "exception", error: e instanceof Error ? e.message : String(e) });
		return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
	}
}

module.exports = { getSummary, getSummariesInRange, storeSummary, generateSummary, searchConversationsInRange };
