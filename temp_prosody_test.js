(async () => {
  try {
    const path = require('path');
    const fs = require('fs');
    const tts = require('./lib/tts');
    const text = 'Hello there. [pause=400] [slow] This part should sound slower. [emph] And this word should be stressed.';
    console.log('\n=== PROSODY TEST: synthesizeUtterance ===');
    try {
      const r = await tts.synthesizeUtterance({ text });
      console.log('prosody result:', JSON.stringify({ chunks: r.chunks, durationMs: r.durationMs, speechMs: r.speechMs, bytes: r.bytes }));
      fs.writeFileSync(path.join(__dirname, 'temp_tts_prosody.wav'), r.merged);
      console.log('wrote temp_tts_prosody.wav');
    } catch (e) {
      console.error('prosody synth error:', e && e.message ? e.message : e);
    }

    // Also print first 200 bytes of wav header area to inspect
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'temp_tts_prosody.wav'));
      console.log('wav bytes length:', buf.length);
      console.log('wav header snippet (hex):', buf.slice(0,64).toString('hex'));
    } catch (e) { /* ignore */ }

  } catch (err) {
    console.error('FATAL:', err);
    process.exit(2);
  }
})();
