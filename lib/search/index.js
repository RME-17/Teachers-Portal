const { webSearch } = require("./web");
const { wikiSearch, wikiLookup } = require("./wiki");
const { fetchUrl } = require("./fetch");
const { serpstackSearch } = require("./serpstack");

function buildToolDefs() {
	return [
		{
			name: "web_search",
			description: "Search the web for current information using DuckDuckGo. Returns up to 5 results with title, URL, and snippet. Use this when the user asks about recent events, facts you're unsure about, or anything outside your training data.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string", description: "The search query" },
				},
				required: ["query"],
			},
		},
		{
			name: "serpstack_search",
			description: "Search the web using the SERPSTACK API. Returns up to N results with title, URL, and snippet. Set API key in SERPSTACK_API_KEY environment variable.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string", description: "The search query" },
					limit: { type: "number", description: "Maximum results to return" },
				},
				required: ["query"],
			},
		},
		{
			name: "web_fetch",
			description: "Fetch and read the text content of a webpage by URL. Use this to get full details from a search result or any URL the user provides.",
			input_schema: {
				type: "object",
				properties: {
					url: { type: "string", description: "The full URL to fetch" },
				},
				required: ["url"],
			},
		},
		{
			name: "wiki_search",
			description: "Search Wikipedia for articles matching a query. Returns article titles, page IDs, and short snippets. Call this first before wiki_lookup.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string", description: "The topic to search for" },
				},
				required: ["query"],
			},
		},
		{
			name: "wiki_lookup",
			description: "Get the full summary of a Wikipedia article by its exact title. Use wiki_search first to find the correct title, then call this to get the article content.",
			input_schema: {
				type: "object",
				properties: {
					title: { type: "string", description: "The exact Wikipedia article title" },
				},
				required: ["title"],
			},
		},
	];
}

async function callTool(toolName, args, signal) {
	switch (toolName) {
		case "web_search": {
			const query = String(args?.query || "").trim();
			if (!query) return { ok: false, data: [{ type: "text", text: "query required" }], isError: true };
			const results = await webSearch(query);
			if (results.length === 0) return { ok: true, data: [{ type: "text", text: "No web results found." }], isError: false };
			const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet || "No preview"}`);
			return { ok: true, data: [{ type: "text", text: lines.join("\n\n") }], isError: false };
		}
		case "serpstack_search": {
			const query = String(args?.query || "").trim();
			if (!query) return { ok: false, data: [{ type: "text", text: "query required" }], isError: true };
			const limit = typeof args?.limit === 'number' ? args.limit : 5;
			const result = await serpstackSearch(query, limit);
			if (!result.ok) return { ok: false, data: [{ type: "text", text: result.error || 'Search failed' }], isError: true };
			const results = result.results || [];
			if (results.length === 0) return { ok: true, data: [{ type: "text", text: "No web results found." }], isError: false };
			const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet || "No preview"}`);
			return { ok: true, data: [{ type: "text", text: lines.join("\n\n") }], isError: false };
		}
		case "web_fetch": {
			const url = String(args?.url || "").trim();
			if (!url) return { ok: false, data: [{ type: "text", text: "url required" }], isError: true };
			const result = await fetchUrl(url, { signal });
			if (!result.ok) return { ok: false, data: [{ type: "text", text: result.error }], isError: true };
			return { ok: true, data: [{ type: "text", text: result.text.slice(0, 8000) }], isError: false };
		}
		case "wiki_search": {
			const query = String(args?.query || "").trim();
			if (!query) return { ok: false, data: [{ type: "text", text: "query required" }], isError: true };
			const results = await wikiSearch(query);
			if (results.length === 0) return { ok: true, data: [{ type: "text", text: "No Wikipedia articles found." }], isError: false };
			const lines = results.map((r, i) => `${i + 1}. ${r.title} (ID: ${r.pageId})\n   ${r.snippet || ""}`);
			return { ok: true, data: [{ type: "text", text: lines.join("\n\n") }], isError: false };
		}
		case "wiki_lookup": {
			const title = String(args?.title || "").trim();
			if (!title) return { ok: false, data: [{ type: "text", text: "title required" }], isError: true };
			const result = await wikiLookup(title);
			if (!result) return { ok: true, data: [{ type: "text", text: `No Wikipedia article found for "${title}". Use wiki_search to find the correct title.` }], isError: false };
			const text = `# ${result.title}\n${result.extract || result.description || ""}\n\nSource: ${result.content_urls?.desktop?.page || "https://en.wikipedia.org/wiki/" + encodeURIComponent(result.title)}`;
			return { ok: true, data: [{ type: "text", text }], isError: false };
		}
		default:
			return { ok: false, data: [{ type: "text", text: `Unknown search tool: ${toolName}` }], isError: true };
	}
}

module.exports = { buildToolDefs, callTool };
