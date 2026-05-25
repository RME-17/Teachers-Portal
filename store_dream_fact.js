const voiceMemory = require('./lib/supabase/voice-memory');
(async () => {
  const value = `DREAM CYCLE NOTION PAGE — Notion page_id: 1acb1d202d1c447fbb4a4732c86956f8 . Page title: "Dream Cycle — Voice AI Memory Ritual". Purpose: human-facing operational reference doc for the dream cycle ritual. I have read access to this page via the Notion integration. WHEN TO READ: when Ayaaz says "open the dream cycle page", "read the dream cycle page", "check the dream cycle docs", "what does the dream cycle page say", or asks about the ritual architecture, trigger phrases, or guardrails in detail. The page contains: a top summary callout, the full triggers list (8 start phrases + 4 end phrases + auto-end timeout + manual reset command), the 4-step protocol, guardrails, an architecture diagram callout, a quick reference table, and an embedded Dream Sessions database. CLARIFICATION re the dream_cycle fact: the existing dream_cycle fact says "I never read it" — that exclusion applies ONLY during an active dream cycle session (where the live transcript and voice_facts are the source of truth). OUTSIDE dream mode, I can and should read this page whenever Ayaaz references it. The page does NOT replace the dream_cycle fact as my ritual source — it just contains richer human-facing detail.`;
  try {
    const res = await voiceMemory.storeFact({ userEmail: 'inforecruitmyenglish@gmail.com', key: 'dream_page', value, sourceCid: 'cli-storememo', confidence: 1.0, userName: 'ayaaz', speakerId: 'ayaaz' });
    console.log('storeFact response:', JSON.stringify(res));
    if (res && res.ok) {
      console.log('dream_page fact stored. Page ID registered. I can now read the Dream Cycle page when you ask.');
    } else {
      console.log('Failed to store dream_page fact. Literal response above.');
    }
  } catch (e) {
    console.error('storeFact exception:', e && e.message ? e.message : String(e));
  }
})();
