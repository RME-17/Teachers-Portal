const voiceMemory = require("./supabase/voice-memory");
const pageMemory = require("./supabase/page-memory");
const weeklySummaries = require("./supabase/weekly-summaries");
const { parseTemporalRange } = require("./temporal-query");
const { log } = require("./log");

const STOPWORDS = new Set(["a","an","the","and","or","but","if","in","on","at","to","for","of","by","with","from","up","down","out","off","over","under","again","further","then","once","here","there","when","where","why","how","what","which","who","whom","this","that","these","those","some","any","all","both","each","few","more","most","other","such","no","nor","not","only","own","same","so","than","too","very","just","about","is","are","was","were","be","been","have","has","had","do","does","did","will","would","can","could","should","may","might","shall","i","you","he","she","it","we","they","me","him","her","us","them","my","your","his","her","its","our","their","mine","yours","hers","its","ours","theirs","also","into","does","doing","done","get","got","make","made","see","saw","seen","know","knew","known","want","went","go","goes","going","say","says","said","tell","told","ask","asked","asks","look","looked","looks","find","found","finds","give","gave","given","need","needs","needed","use","used","uses","take","took","taken","come","came","comes","coming","think","thinks","thought","bring","brought","brings","call","calls","called","try","tries","tried","begin","began","begun","beginning","start","starts","started","keep","keeps","kept","hold","holds","held","write","writes","wrote","written","show","shows","showed","shown","hear","hears","heard","play","plays","played","run","runs","ran","move","moves","moved","live","lives","lived","believe","believes","believed","happen","happens","happened","provide","provides","provided","set","sets","setting","put","puts","name","names","named","help","helps","helped","doesn","anything","everything","nothing","something","someone","anyone","everyone","one","two","three","four","five","six","seven","eight","nine","ten","first","second","third","last","next","new","old","good","bad","big","small","high","low","long","short","full","empty","right","wrong","true","false","yes","no"]);

function extractKeywords(text, max) {
	if (!text || typeof text !== "string") return [];
	const raw = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
	const seen = new Set();
	const out = [];
	for (const w of raw) {
		if (w.length >= 3 && !STOPWORDS.has(w) && !seen.has(w)) {
			seen.add(w);
			out.push(w);
			if (out.length >= max) break;
		}
	}
	return out;
}

function recencyScore(updatedAt, halfLifeDays) {
	if (!updatedAt) return 0;
	const hours = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);
	return hours < 0 ? 1 : Math.pow(0.5, hours / ((halfLifeDays || 14) * 24));
}

function isOlderThanDays(updatedAt, days) {
	if (!updatedAt) return true;
	const age = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
	return age > days;
}

function rrfScore(lists, k) {
	const map = {};
	const rr = k || 60;
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			const id = item.fact_key || item.page_name || `_idx_${i}`;
			if (!map[id]) map[id] = { item, totalScore: 0 };
			map[id].totalScore += 1 / (rr + i);
		}
	}
	return Object.values(map).sort((a, b) => b.totalScore - a.totalScore);
}

function mmrSelect(items, lambda, k) {
	if (items.length <= k) return items;
	const enrich = items.map(it => ({
		item: it,
		score: it._combinedScore || 0,
		tokens: new Set(((it.fact_key || "") + " " + (it.fact_value || it.page_name || "")).toLowerCase().split(/\s+/).filter(Boolean)),
	}));
	enrich.sort((a, b) => b.score - a.score);
	const selected = [enrich.shift()];
	while (selected.length < k && enrich.length > 0) {
		let bestIdx = 0, bestVal = -Infinity;
		for (let i = 0; i < enrich.length; i++) {
			let maxSim = 0;
			for (const s of selected) {
				if (enrich[i].tokens.size === 0 || s.tokens.size === 0) continue;
				let inter = 0;
				for (const tok of enrich[i].tokens) { if (s.tokens.has(tok)) inter++; }
				const union = enrich[i].tokens.size + s.tokens.size - inter;
				const sim = union === 0 ? 0 : inter / union;
				if (sim > maxSim) maxSim = sim;
			}
			const mmr = (lambda || 0.7) * enrich[i].score - (1 - (lambda || 0.7)) * maxSim;
			if (mmr > bestVal) { bestVal = mmr; bestIdx = i; }
		}
		selected.push(enrich.splice(bestIdx, 1)[0]);
	}
	return selected.map(s => s.item);
}

async function retrieve({ userEmail, query, k, confidenceThreshold, staleDays, speakerId }) {
	k = k || 10;
	confidenceThreshold = confidenceThreshold || 0.4;
	staleDays = staleDays || 90;
	const keywords = extractKeywords(query, 5);

	const sId = speakerId || 'unknown';
	const [recentFactsRes, recentRefsRes] = await Promise.all([
		voiceMemory.listFacts({ userEmail, speakerId: sId }),
		pageMemory.listPageRefs({ userEmail, speakerId: sId }),
	]);
	const recentFacts = (recentFactsRes.ok ? recentFactsRes.data : []).slice(0, 30);
	const recentRefs = (recentRefsRes.ok ? recentRefsRes.data : []).slice(0, 30);
	const totalRecent = recentFacts.length + recentRefs.length;

	let kwFacts = [], kwRefs = [];
	if (keywords.length > 0) {
		const [kwFactRes, kwRefRes] = await Promise.all([
			Promise.all(keywords.map(kw => voiceMemory.searchFacts({ userEmail, search: kw, limit: 3, speakerId: sId }))),
			Promise.all(keywords.map(kw => pageMemory.searchPageRefs({ userEmail, search: kw, limit: 3, speakerId: sId }))),
		]);
		const fMap = new Map();
		for (const res of kwFactRes) {
			if (res.ok && Array.isArray(res.data)) {
				for (const f of res.data) fMap.set(f.fact_key, f);
			}
		}
		kwFacts = Array.from(fMap.values());
		const rMap = new Map();
		for (const res of kwRefRes) {
			if (res.ok && Array.isArray(res.data)) {
				for (const r of res.data) rMap.set(r.page_name, r);
			}
		}
		kwRefs = Array.from(rMap.values());
	}

	let semFactEntries = [], semConvEntries = [];
	if (query && (totalRecent + kwFacts.length + kwRefs.length) < k * 2) {
		const semResult = await voiceMemory.recallSemantic({ userEmail, queryText: query, k: 5, speakerId: sId });
		if (semResult.ok && Array.isArray(semResult.data)) {
			for (const d of semResult.data) {
				if (d.source_table === "voice_facts" && d.content) {
					const sep = d.content.indexOf(": ");
					semFactEntries.push({
						fact_key: sep > 0 ? d.content.slice(0, sep) : d.content,
						fact_value: sep > 0 ? d.content.slice(sep + 2) : "",
						_similarity: d.similarity || 0,
						created_at: d.created_at,
						_semantic: true,
					});
				} else if (d.source_table === "voice_conversations") {
					semConvEntries.push(d);
				}
			}
		}
	}

	const factStages = [recentFacts];
	if (kwFacts.length) factStages.push(kwFacts);
	if (semFactEntries.length) factStages.push(semFactEntries);

	const fusedFacts = rrfScore(factStages);
	const scoredFacts = fusedFacts.map(f => {
		const item = f.item;
		const rec = recencyScore(item.updated_at || item.created_at);
		const confidence = typeof item.confidence === "number" ? item.confidence : 1.0;
		const combined = (f.totalScore + rec * 0.3) * confidence;
		const stale = confidence < 1.0 && isOlderThanDays(item.updated_at || item.created_at, staleDays);
		const writeStale = isOlderThanDays(item.updated_at || item.created_at, 30);
		return { ...item, _combinedScore: combined, _stale: stale, _writeStale: writeStale };
	}).filter(f => f._combinedScore > 0 && (f.confidence || 1.0) >= confidenceThreshold)
		.sort((a, b) => b._combinedScore - a._combinedScore);

	const dedupedFacts = mmrSelect(scoredFacts, 0.7, k);
	dedupedFacts.sort((a, b) => b._combinedScore - a._combinedScore);

	const refStages = [recentRefs];
	if (kwRefs.length) refStages.push(kwRefs);

	const fusedRefs = rrfScore(refStages);
	const scoredRefs = fusedRefs.map(r => {
		const item = r.item;
		const rec = recencyScore(item.updated_at || item.created_at);
		const combined = r.totalScore + rec * 0.3;
		return { ...item, _combinedScore: combined };
	}).filter(r => r._combinedScore > 0)
		.sort((a, b) => b._combinedScore - a._combinedScore)
		.slice(0, k);

	const staleFacts = dedupedFacts.filter(f => f._stale);
	const writeStaleFacts = dedupedFacts.filter(f => f._writeStale);

	/* Temporal query detection — "last week", "yesterday", etc. */
	let temporalSummary = null;
	let temporalConversations = [];
	if (query) {
		const tr = parseTemporalRange(query);
		if (tr) {
			const existing = await weeklySummaries.getSummariesInRange({
				userEmail,
				startDate: tr.startDate.toISOString(),
				endDate: tr.endDate.toISOString(),
				speakerId: sId,
			});
			if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
				temporalSummary = existing.data[0];
				log.info("retrieval", { temporalSummary: "found", week: existing.data[0].week_start, label: tr.label });
			} else if (tr.label !== "today" && tr.label !== "this week") {
				const generated = await weeklySummaries.generateSummary({
					userEmail, weekStart: tr.startDate, weekEnd: tr.endDate, speakerId: sId,
				});
				if (generated.ok && generated.data) {
					temporalSummary = generated.data;
					log.info("retrieval", { temporalSummary: "generated", week: tr.startDate.toISOString().slice(0, 10), label: tr.label });
				}
			}
			if (keywords.length > 0) {
				const convSearch = await weeklySummaries.searchConversationsInRange({
					userEmail,
					startDate: tr.startDate.toISOString(),
					endDate: tr.endDate.toISOString(),
					searchTerms: keywords,
					speakerId: sId,
				});
				if (convSearch.ok && Array.isArray(convSearch.data)) {
					temporalConversations = convSearch.data;
				}
			}
		}
	}

	for (const f of dedupedFacts) {
		if (f.fact_key) voiceMemory.bumpAccess({ userEmail, key: f.fact_key, speakerId: sId }).catch(() => {});
	}
	for (const r of scoredRefs) {
		if (r.page_name) pageMemory.bumpAccess({ userEmail, pageName: r.page_name, speakerId: sId }).catch(() => {});
	}

	log.info("retrieval", { keywords: keywords.join(","), recent: recentFacts.length, kwFacts: kwFacts.length, semFacts: semFactEntries.length, finalFacts: dedupedFacts.length, finalRefs: scoredRefs.length, stale: staleFacts.length, writeStale: writeStaleFacts.length, temporal: temporalSummary ? 1 : 0 });

	return { facts: dedupedFacts, pageRefs: scoredRefs, memories: semConvEntries, staleFacts, writeStaleFacts, temporalSummary, temporalConversations };
}

module.exports = { retrieve, extractKeywords };
