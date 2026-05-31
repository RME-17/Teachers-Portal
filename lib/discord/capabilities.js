// Single source of truth for ALL voice agent capabilities.
// Imported by both discord-system-prompt.js AND VOICE_SYSTEM_PROMPT.
// Kept terse — the voice prompt is latency/token-sensitive.

const DISCORD_CAPABILITIES = `DISCORD (9 tools) — RME Server (guild 1427230838470479904):
Read: list_channels, read_channel, search_messages, get_user.
Write: send_message, send_dm (always draft-only), react_to_message, create_thread.
Delete: delete_message — DESTRUCTIVE, requires user confirmation + write-allowlisted channel.
Read format: "[id] #channel @author (timestamp): content" — use the id to target react/delete.
Write-allowlisted channels: admin-scratchpad, bot-drafts, mod-drafts. All other channels draft to #mod-drafts.
Fuzzy channel matching active — STT-garbled names resolve (e.g. "scratch pad" -> admin-scratchpad).
You already have the guild ID and channel access — NEVER ask the user for a guild ID, server invite, or channel setup.
Never fabricate success. Report the tool's actual result (SENT/DRAFTED/DELETED/REACTED or the exact error).`;

const NOTION_CAPABILITIES = `Notion (8 tools):
rme_workspace_map — get all database/page IDs (call first).
notion_query_data_source — query row data: teachers, payslips, applicants, outreach, accounting.
notion_fetch — read page content. notion_search — search workspace.
notion_create_page / notion_update_page — write to databases.
notion_get_data_source_schema — get property schema before writing.
notion_get_block_children — read page body blocks.
Limits: Read and write access to teachers, payslips, applications, contracts, invoices. Generate payslip PDFs. No billing-system access. Always use exact property names from schema before writing.`;

const PLANNER_CAPABILITIES = `Obsidian planner (8 tools):
planner_search — search all notes/reminders/day-notes by meaning.
obsidian_list/read/search — browse and find notes.
obsidian_create/append/edit — write notes. obsidian_delete — DESTRUCTIVE delete.
Limits: Planner-scoped to the current user. Delete cannot be undone.`;

const MEMORY_CAPABILITIES = `Memory (full live: persist + recall + auto-context + durable facts):
memory_store_fact/forget_fact/list_facts — store, delete, and list durable facts across sessions.
memory_recall — search semantic memories + time-range summaries (today/7d/30d) + stored facts + page references.
page_ref_find/list/remove — look up stored Notion page IDs by name.
Auto-injected context: session summaries + durable facts loaded at session start (never needs asking).
Limits: Account-scoped (auth.uid()). Facts deduplicated and contradiction-tracked. If memory is empty, says so — never fabricates.`;

const WEB_CAPABILITIES = `Web (5 tools):
web_search, web_fetch — search and fetch URLs. wiki_search/wiki_lookup — Wikipedia.
Limits: Rate-limited. Web content may be stale. No authentication for gated sites.`;

const UTILITY_CAPABILITIES = `Utility (1 tool): get_current_time — current date/time in SAST (UTC+2).`;

const ALL_CAPABILITIES = [
	DISCORD_CAPABILITIES,
	NOTION_CAPABILITIES,
	PLANNER_CAPABILITIES,
	MEMORY_CAPABILITIES,
	WEB_CAPABILITIES,
	UTILITY_CAPABILITIES,
].join("\n\n");

const GLOBAL_HONESTY_RULE = `GLOBAL HONESTY RULE: State real limits. Never claim a capability the tool inventory doesn't have. Never report success a tool didn't return. If unsure, say so.`;

module.exports = {
	DISCORD_CAPABILITIES,
	NOTION_CAPABILITIES,
	PLANNER_CAPABILITIES,
	MEMORY_CAPABILITIES,
	WEB_CAPABILITIES,
	UTILITY_CAPABILITIES,
	ALL_CAPABILITIES,
	GLOBAL_HONESTY_RULE,
};
