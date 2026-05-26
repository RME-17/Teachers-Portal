# TTS Benchmark Summary — 2026-05-26

| Scenario | Audio (s) | TTFC (s) | Total synth (s) | RTF | Bytes |
|---|---:|---:|---:|---:|---:|
| Short (stream) | 0.96 | 0.716 | 0.716 | 0.75 | - |
| Short (non-stream) | 0.96 | 0.717 | 0.717 | 0.75 | - |
| Long (stream) | 78.60 | 7.159 | 58.359 | 0.74 | 3772800 |
| Long (non-stream) | 40.16 | 23.131 | 23.131 | 0.58 | 1927724 |
| CPU baseline (short) | 0.96 | 3.16 | 5.16 | 5.38 | - |

## GPU Utilization (long synth window)

- Samples: 323, window: 2026-05-26T20:32:45.805745 → 2026-05-26T20:34:11.488803 (duration ≈ 85.68s)
- GPU util — mean: 48.4%, max: 100%, p95: 84%
- VRAM used — mean: 2930 MB, max: 5576 MB

## Audio files metadata

- `test_stream_long.pcm` (raw PCM produced by streaming): file size 3,772,800 bytes; emitted format: 16-bit PCM little-endian, mono, sample rate 24000 Hz (converted WAV: tools/tts/converted_test_stream_long.wav).
- `tts_out_long.wav` (non-stream WAV): file size 1,927,724 bytes; WAV header: 1 channel, 16-bit PCM, 24000 Hz; duration ≈ 40.16 s.

Notes: the streaming PCM file converts to ≈78.60 s of audio; the non-stream WAV is ≈40.16 s. The streaming output contains substantive audio (not just trailing silence) and does not appear to be a simple repeat of the non-stream output.

RTF for non-stream on a warmed server is ~0.60 steady-state (paragraph-length inputs).

## FP32 Device Map Follow-up (2026-05-26)

- Change applied: T3 -> CUDA (float32), S3Gen -> CUDA (float32); warmup synth kept.
- Measured runs (post-change):
	- `test_011.wav` (Hello): duration 1.00s, synth 0.841s, RTF 0.841 — verdict: clean
	- `test_014.wav` (Payslip): duration 0.80s, synth 0.635s, RTF 0.794 — verdict: clean
	- `test_013.wav` (Interview): duration 11.76s, synth 8.624s, RTF 0.734 — verdict: clean
	- `test_015.wav` (Multi-sentence): duration 7.08s, synth 4.565s, RTF 0.645 — verdict: clean
	- `test_016.wav` (Long paragraph): duration 27.08s, synth 15.935s, RTF 0.588 — verdict: clean

- GPU snapshot (mid-synth, long paragraph) saved: `tools/tts/bench_results/nvidia_snapshot_phrase5.txt`

Conclusion: switching T3 to fp32 eliminated the observed audio corruption while keeping RTF well below 1.0. See findings.md for details.
