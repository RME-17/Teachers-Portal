(async () => {
  try {
    const path = require('path');
    const fs = require('fs');
    const child_process = require('child_process');
    // require TTS API
    const tts = require('./lib/tts');

    const maybeFetch = (globalThis.fetch) ? globalThis.fetch : (name => require('node-fetch'));
    const fetch = (globalThis.fetch) ? globalThis.fetch : (await import('node-fetch')).default;

    function log(...a) { console.log(...a); }

    log('\n=== TTS: warmTts() ===');
    const t0 = Date.now();
    try {
      await tts.warmTts();
      log('warmTts completed, elapsedMs=', Date.now() - t0);
    } catch (e) {
      console.error('warmTts error:', e && e.message ? e.message : e);
    }

    // Short utterance
    const shortText = 'Quick test. Hello from the app.';
    log('\n=== TTS: synthesizeUtterance short ===');
    try {
      const r = await tts.synthesizeUtterance({ text: shortText });
      log('synthesizeUtterance short - result:', JSON.stringify({ chunks: r.chunks, durationMs: r.durationMs, speechMs: r.speechMs, bytes: r.bytes }));
      // write sample wav to disk
      try { fs.writeFileSync(path.join(__dirname, 'temp_tts_short.wav'), r.merged); log('wrote temp_tts_short.wav'); } catch (e) {}
    } catch (e) {
      console.error('synthesizeUtterance short error:', e && e.message ? e.message : e);
    }

    // Long utterance
    const longText = 'This is a longer test sentence to exercise chunking and synthesis. It should create multiple chunks if the chunker splits longer text. The goal is to measure synthMs, audioMs, and chunk counts, and ensure prosody tags are preserved if present.';
    log('\n=== TTS: synthesizeUtterance long ===');
    try {
      const r2 = await tts.synthesizeUtterance({ text: longText });
      log('synthesizeUtterance long - result:', JSON.stringify({ chunks: r2.chunks, durationMs: r2.durationMs, speechMs: r2.speechMs, bytes: r2.bytes }));
      try { fs.writeFileSync(path.join(__dirname, 'temp_tts_long.wav'), r2.merged); log('wrote temp_tts_long.wav'); } catch (e) {}
    } catch (e) {
      console.error('synthesizeUtterance long error:', e && e.message ? e.message : e);
    }

    // STT: call whisper /inference with 1s silent wav
    log('\n=== STT: Whisper inference (1s silent WAV) ===');
    function generateSilentWav16k(durationSec) {
      const sampleRate = 16000;
      const numSamples = Math.round(sampleRate * durationSec);
      const dataSize = numSamples * 2;
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + dataSize, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(sampleRate * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(dataSize, 40);
      const pcm = Buffer.alloc(dataSize, 0);
      return Buffer.concat([header, pcm]);
    }
    const wav = generateSilentWav16k(1);
    const boundary = `----RMEWarm${Date.now()}`;
    const preamble = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="silence.wav"\r\nContent-Type: audio/wav\r\n\r\n`, 'utf8');
    const mid = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response"\r\n\r\njson\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([preamble, wav, mid]);

    const whisperUrl = process.env.RME_WHISPER_SERVER_URL || 'http://127.0.0.1:8780';
    const infUrl = whisperUrl.replace(/\/+$/, '') + '/inference';
    const st0 = Date.now();
    try {
      const res = await fetch(infUrl, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      const stime = Date.now() - st0;
      log('whisper /inference status=', res.status, 'elapsedMs=', stime);
      log('whisper response (truncated 200 chars):', text.slice(0, 200));
      try { fs.writeFileSync(path.join(__dirname, 'temp_whisper_response.json'), text); log('wrote temp_whisper_response.json'); } catch (e) {}
    } catch (e) {
      console.error('whisper inference error:', e && e.message ? e.message : e);
    }

    // Process list checks (tasklist + netstat)
    log('\n=== System: process list and netstat ===');
    try {
      const ps = child_process.execSync('tasklist', { timeout: 30000, windowsHide: true }).toString();
      const pythonLines = ps.split('\n').filter(l => /python/i.test(l) || /whisper-server/i.test(l) || /chatterbox/i.test(l));
      log('tasklist lines (python/chatterbox):');
      pythonLines.slice(0, 20).forEach(l => log(l));
    } catch (e) { console.error('tasklist error', e && e.message ? e.message : e); }

    try {
      const net = child_process.execSync('netstat -ano', { timeout: 30000, windowsHide: true }).toString();
      const lines = net.split('\n').filter(l => /:8123|:8780|LISTENING|ESTABLISHED/i.test(l));
      log('netstat lines (8123/8780/...):');
      lines.slice(0, 40).forEach(l => log(l));
    } catch (e) { console.error('netstat error', e && e.message ? e.message : e); }

    // getTtsStatus
    try {
      log('\n=== TTS status via getTtsStatus() ===');
      const s = tts.getTtsStatus();
      log('getTtsStatus:', JSON.stringify(s));
    } catch (e) { console.error('getTtsStatus error', e && e.message ? e.message : e); }

    log('\n=== TEMP CHECK SCRIPT DONE ===');
  } catch (err) {
    console.error('FATAL:', err);
    process.exit(2);
  }
})();
