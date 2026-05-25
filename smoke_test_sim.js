const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const voiceMemory = require('./lib/supabase/voice-memory');

function userDataPath() {
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || os.homedir();
  return path.join(base, 'Teachers-Portal');
}
function dreamDir() { return path.join(userDataPath(), 'dream-sessions'); }
function sessionFilePath(startedAtIso) { return path.join(dreamDir(), `dream-session-${startedAtIso.replace(/:/g,'-')}.json`); }

let _lastFired = 0;
let _active = null;

async function startDreamSession(matchedSubstring, speakerId, triggerPhrase) {
  const now = Date.now();
  if (now - _lastFired < 90000) { console.log('[dream] trigger ignored due to debounce'); return null; }
  _lastFired = now;
  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const lf = await voiceMemory.listFacts({ userEmail: 'inforecruitmyenglish@gmail.com' });
  const factsBefore = lf && lf.ok && Array.isArray(lf.data) ? lf.data : [];
  const factsBeforeCount = factsBefore.length;
  const doc = { sessionId, startedAt, triggeredBy: speakerId || 'unknown', triggerPhrase: matchedSubstring || triggerPhrase || null, factsBeforeCount, factsBefore, status: 'in_progress' };
  try { fs.mkdirSync(dreamDir(), { recursive: true }); } catch (e) {}
  const filePath = sessionFilePath(startedAt);
  try { fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8'); } catch (e) { console.error('[dream] write start file failed', e); }
  _active = { sessionId, filePath, startedAt, speakerId, triggerPhrase: doc.triggerPhrase, factsBeforeCount };
  voiceMemory.enableDreamMode(true, sessionId);
  console.log(` Dream session started: ${sessionId} by ${speakerId} → ${filePath}`);
  return _active;
}

async function endDreamSession(endReason = 'phrase', endPhrase = null) {
  if (!_active) { console.log('[dream] no active session to end'); return; }
  const { sessionId, filePath, startedAt, speakerId } = _active;
  const factsAfterRes = await voiceMemory.listFacts({ userEmail: 'inforecruitmyenglish@gmail.com' });
  const factsAfter = factsAfterRes && factsAfterRes.ok && Array.isArray(factsAfterRes.data) ? factsAfterRes.data : [];
  const factsAfterCount = factsAfter.length;
  const ops = voiceMemory.getDreamOps();
  const inserted = ops.filter(o => o.op === 'store' && (o.before == null)).length;
  const contradictions = ops.filter(o => o.op === 'store' && o.before != null && o.before !== o.after).length;
  const merged = ops.filter(o => o.op === 'store' && o.before != null && o.before === o.after).length;
  const deleted = ops.filter(o => o.op === 'delete').length;
  const summary = `${inserted} inserted, ${merged} merged, ${deleted} deleted, ${contradictions} contradictions`;
  const finalDoc = { sessionId, startedAt, endedAt: new Date().toISOString(), endReason, endPhrase: endPhrase || null, triggeredBy: speakerId || 'unknown', triggerPhrase: _active.triggerPhrase || null, factsBeforeCount: _active.factsBeforeCount, factsAfterCount, factsBefore: null, factsAfter, dreamOps: ops, summary, status: 'complete' };
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      try { const parsed = JSON.parse(raw); if (parsed && parsed.factsBefore) finalDoc.factsBefore = parsed.factsBefore; } catch {}
    }
  } catch {}
  try { fs.writeFileSync(filePath, JSON.stringify(finalDoc, null, 2), 'utf8'); } catch (e) { console.error('[dream] write end file failed', e); }
  console.log(` Dream session ended: ${sessionId}, reason: ${endReason}, ops: ${ops.length} → ${filePath}`);
  voiceMemory.enableDreamMode(false);
  voiceMemory.clearDreamOps();
  _active = null;
}

(async () => {
  try {
    // Step 2: start phrase
    const start = await startDreamSession('start the dream cycle', 'smoke-speaker');

    // Step 3: a few storeFact calls while dream mode active
    const sf1 = await voiceMemory.storeFact({ userEmail: 'inforecruitmyenglish@gmail.com', key: 'smoke_test_one', value: 'alpha', sourceCid: 'smoke1', confidence: 0.9, userName: 'smoke', speakerId: 'smoke-speaker' });
    console.log(' storeFact result 1:', JSON.stringify(sf1));
    const sf2 = await voiceMemory.storeFact({ userEmail: 'inforecruitmyenglish@gmail.com', key: 'smoke_test_two', value: 'beta', sourceCid: 'smoke2', userName: 'smoke', speakerId: 'smoke-speaker' });
    console.log(' storeFact result 2:', JSON.stringify(sf2));

    // Step 6: attempt to start again within 30s (should be ignored)
    const start2 = await startDreamSession('start the dream cycle', 'smoke-speaker');

    // Step 4: end phrase
    await endDreamSession('phrase', 'end the dream cycle');

    // Give filesystem a moment
    await new Promise(r => setTimeout(r, 200));

    // Read sample JSON
    const files = fs.readdirSync(dreamDir()).filter(f => f.startsWith('dream-session-')).sort();
    const lastFile = files.length ? path.join(dreamDir(), files[files.length-1]) : null;
    if (lastFile) {
      console.log('\n--- Sample JSON contents ---');
      console.log(fs.readFileSync(lastFile, 'utf8'));
      console.log('--- end JSON ---\n');
    } else {
      console.log(' No dream-session JSON files found under', dreamDir());
    }

    // Step 5: dream:reset (ensure active session exists)
    _lastFired = 0; // reset debounce to allow immediate start
    const start3 = await startDreamSession('begin dreaming', 'smoke-speaker');
    if (_active) {
      await endDreamSession('manual_reset', null);
      console.log(' Dream mode manually reset');
    }

    // Step 7: outside-mode isolation check
    const outside1 = await voiceMemory.storeFact({ userEmail: 'inforecruitmyenglish@gmail.com', key: 'outside_test', value: 'gamma', sourceCid: 'outs1', userName: 'smoke', speakerId: 'smoke-speaker' });
    console.log(' outside storeFact result:', JSON.stringify(outside1));
    console.log(' userData/dream-sessions/ files:', fs.readdirSync(dreamDir()).filter(f => f.startsWith('dream-session-')).length);
    console.log(' voiceMemory.getDreamOps():', JSON.stringify(voiceMemory.getDreamOps()));
    console.log(' voiceMemory.isDreamModeActive():', voiceMemory.isDreamModeActive());

  } catch (e) {
    console.error('Smoke test error', e);
  }
})();
