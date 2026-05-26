# TTS Audio Corruption Findings — 2026-05-26

Root cause: T3 fp16 numerical instability when running on CUDA caused audio degradation: the first ~1–2 words were clean then the output degenerated into broadband static.

Fix applied: Force T3 and S3Gen to run in float32 on CUDA (set `.float()` / `dtype=torch.float32`) and keep the warmup synth.

Trade-offs: Expect a modest RTF increase for some short cases (observed short-case RTF ~0.75–0.90), but paragraph-length RTF remained well under 1.0 (measured ≈0.59). This is an acceptable production trade-off for correct audio.

Perth DummyWatermarker: previously suspected; bypassing it gave partial delay but did not fully eliminate the symptom. After switching T3→fp32 the audio is clean; the watermarker can be left enabled and investigated separately.

Measured results (post-change):

- `test_011.wav` — Hello: duration 1.00 s, synth 0.841 s, RTF 0.841 — Verdict: clean
- `test_014.wav` — Payslip: duration 0.80 s, synth 0.635 s, RTF 0.794 — Verdict: clean
- `test_013.wav` — Interview: duration 11.76 s, synth 8.624 s, RTF 0.734 — Verdict: clean
- `test_015.wav` — Multi-sentence: duration 7.08 s, synth 4.565 s, RTF 0.645 — Verdict: clean
- `test_016.wav` — Long paragraph: duration 27.08 s, synth 15.935 s, RTF 0.588 — Verdict: clean

GPU snapshot during long paragraph synth: `tools/tts/bench_results/nvidia_snapshot_phrase5.txt`

Notes:
- The server warmup remains; keep the warmup to reduce cold-start RTF for short phrases.
- No streaming changes were made.

Action items (follow-up):
- Re-enable/validate Perth watermarker in a controlled environment and test for compatibility with fp16/amp paths.
- Add NaN/Inf guards and additional tensor-move logging if the issue reappears.
# Findings: Streaming vs Non-stream regression (long phrase)

-Observation: The long phrase streaming run produced different audio content and a longer rendered output (stream **78.60 s** audio, non-stream **40.16 s** audio). The earlier numeric "2.5× regression" framing assumed both outputs were the same audio and is incorrect.

Verified numbers (audio + synth):
- Long stream total synth time: 58.36 s (audio length 78.60 s) — RTF = 0.74
- Long non-stream total synth time: 23.13 s (audio length 40.16 s) — RTF = 0.58

Both RTFs are < 1 (faster than real-time) — the performance difference is not a straightforward slowdown of identical audio, the streaming path is producing substantially more/longer audio.

Possible causes:
- Per-chunk decoder/vocoder overhead: streaming slices input into many sentences and runs full pipeline per chunk.
- Per-chunk dtype casts / coercions: repeated `_move_tensors_in_obj` / `_cast_tensors_in_obj` calls may be expensive per sentence.
- Smaller internal batches during streaming: model may run smaller inner batches or disable certain optimizations per-chunk.
- `_move_tensors_in_obj` or `_deep_cast_attrs` firing per chunk, moving/copying large tensors frequently.

Recommended investigation order:
1. Measure per-sentence breakdown in streaming: log per-sentence generation time and identify slowest stage (T3, S3Gen, postprocess).
2. Instrument `_move_tensors_in_obj` and `_cast_tensors_in_obj` to count copies and bytes moved per chunk; temporarily disable them to see impact.
3. Compare a single full-run vs sentence-split run on the same input (i.e., call non-stream multiple times versus stream) to see overheads.
4. Profile GPU kernel times (Nsight or torch.profiler) for a streaming chunk vs non-stream to find differences.

### Follow-ups:
- Remove mock ChatterboxTTS fallback entirely (landmine).
- Install `psutil` into Python 3.11 interpreter (noisy logs).
- Address FastAPI `on_event` deprecation (lifespan handlers).
- Implement real watermarker (Perth DummyWatermarker placeholder present).