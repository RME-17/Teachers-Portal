import os,statistics,json,math
from datetime import datetime
root=os.path.dirname(os.path.abspath(__file__))
# Paths
nvidia_log=os.path.join(root,'nvidia_log_long.csv')
stream_pcm=os.path.join(os.path.dirname(os.path.dirname(root)),'test_stream_long.pcm')
non_wav=os.path.join(os.path.dirname(os.path.dirname(root)),'tts_out_long.wav')
bench_stream_out=os.path.join(root,'bench_stream_long.out')
bench_non_out=os.path.join(root,'bench_nonstream_long.out')
# Read nvidia log
rows=[]
with open(nvidia_log,'r',encoding='utf-8') as f:
    for l in f:
        l=l.strip()
        if not l: continue
        try:
            t,rest=l.split(' ',1)
            util_s,mem_s=rest.split(',')
            util=int(util_s.strip())
            mem=int(mem_s.strip())
            rows.append((t,util,mem))
        except Exception:
            continue
utils=[r[1] for r in rows]
mems=[r[2] for r in rows]
# Detect active window where util>=10
idxs=[i for i,u in enumerate(utils) if u>=10]
if idxs:
    start_i=max(0, min(idxs)-5)
    end_i=min(len(rows)-1, max(idxs)+5)
else:
    start_i=0; end_i=len(rows)-1
window=rows[start_i:end_i+1]
w_utils=[r[1] for r in window]
w_mems=[r[2] for r in window]
mean_util = statistics.mean(w_utils) if w_utils else 0
max_util = max(w_utils) if w_utils else 0
p95_util = sorted(w_utils)[max(0,math.ceil(len(w_utils)*0.95)-1)] if w_utils else 0
mean_vram = statistics.mean(w_mems) if w_mems else 0
max_vram = max(w_mems) if w_mems else 0
sample_count = len(window)
try:
    t0=datetime.fromisoformat(window[0][0])
    t1=datetime.fromisoformat(window[-1][0])
    duration=(t1-t0).total_seconds()
except Exception:
    duration=None
# Audio durations + RTF
sr=24000
stream_dur=None
non_dur=None
if os.path.exists(stream_pcm):
    bs=os.path.getsize(stream_pcm)
    stream_dur=bs/(sr*2)
if os.path.exists(non_wav):
    import wave
    wf=wave.open(non_wav,'rb')
    non_dur=wf.getnframes()/wf.getframerate()
# Parse bench outputs
bsl=open(bench_stream_out,'r',encoding='utf-8').read()
bnl=open(bench_non_out,'r',encoding='utf-8').read()
import re
m_ttfc=re.search(r'ttfc\s+([0-9.]+)', bsl)
m_total=re.search(r'total\s+([0-9.]+)', bsl)
m_bytes=re.search(r'bytes\s+([0-9]+)', bsl)
stream_ttfc=float(m_ttfc.group(1)) if m_ttfc else None
stream_total=float(m_total.group(1)) if m_total else None
stream_bytes=int(m_bytes.group(1)) if m_bytes else None
m_status=re.search(r'status\s+([0-9]+)', bnl)
m_elapsed=re.search(r'elapsed\s+([0-9.]+)', bnl)
m_len=re.search(r'len_bytes\s+([0-9]+)', bnl)
non_status=int(m_status.group(1)) if m_status else None
non_elapsed=float(m_elapsed.group(1)) if m_elapsed else None
non_len=int(m_len.group(1)) if m_len else None
stream_rtf = (stream_total/stream_dur) if (stream_total and stream_dur) else None
non_rtf = (non_elapsed/non_dur) if (non_elapsed and non_dur) else None
# Short phrase numbers (from prior runs)
short_audio_len=0.96
short_stream_ttfc=0.7160818577
short_stream_total=0.7160818577
short_non_ttfc=0.7166836262
short_non_total=0.7166836262
cpu_baseline_ttfc=3.16
cpu_baseline_total=5.16
# Build summary.md
md_lines=[]
md_lines.append('# TTS Benchmark Summary — 2026-05-26')
md_lines.append('')
md_lines.append('| Scenario | Audio (s) | TTFC (s) | Total synth (s) | RTF | Bytes |')
md_lines.append('|---|---:|---:|---:|---:|---:|')
# short phrase
md_lines.append(f"| Short (stream) | {short_audio_len:.2f} | {short_stream_ttfc:.3f} | {short_stream_total:.3f} | {short_stream_total/short_audio_len:.2f} | - |")
md_lines.append(f"| Short (non-stream) | {short_audio_len:.2f} | {short_non_ttfc:.3f} | {short_non_total:.3f} | {short_non_total/short_audio_len:.2f} | - |")
# long phrase
md_lines.append(f"| Long (stream) | {stream_dur:.2f} | {stream_ttfc:.3f} | {stream_total:.3f} | {stream_rtf:.2f} | {stream_bytes} |")
md_lines.append(f"| Long (non-stream) | {non_dur:.2f} | {non_elapsed:.3f} | {non_elapsed:.3f} | {non_rtf:.2f} | {non_len} |")
# CPU baseline
md_lines.append(f"| CPU baseline (short) | {short_audio_len:.2f} | {cpu_baseline_ttfc:.2f} | {cpu_baseline_total:.2f} | {cpu_baseline_total/short_audio_len:.2f} | - |")
md_lines.append('')
# Nvidia stats
md_lines.append('## GPU Utilization (long synth window)')
md_lines.append('')
md_lines.append(f'- Samples: {sample_count}, window: {window[0][0]} → {window[-1][0]} (duration ≈ {duration:.2f}s)')
md_lines.append(f'- GPU util — mean: {mean_util:.1f}%, max: {max_util}%, p95: {p95_util}%')
md_lines.append(f'- VRAM used — mean: {mean_vram:.0f} MB, max: {max_vram} MB')
md_lines.append('')
# Write files
with open(os.path.join(root,'summary.md'),'w',encoding='utf-8') as f:
    f.write('\n'.join(md_lines))
# findings.md
f2=[]
f2.append('# Findings: Streaming vs Non-stream regression (long phrase)')
f2.append('')
f2.append('Observation: The long phrase streaming run took **58.36 s** total versus **23.13 s** for non-stream on the same input — streaming is ~2.5x slower.')
f2.append('')
f2.append('Numeric regression:')
f2.append(f'- Long stream total: {stream_total:.2f}s')
f2.append(f'- Long non-stream total: {non_elapsed:.2f}s')
f2.append(f'- Ratio (stream / non-stream): {stream_total/non_elapsed:.2f}x')
f2.append('')
f2.append('Possible causes:')
f2.append('- Per-chunk decoder/vocoder overhead: streaming slices input into many sentences and runs full pipeline per chunk.')
f2.append('- Per-chunk dtype casts / coercions: repeated `_move_tensors_in_obj` / `_cast_tensors_in_obj` calls may be expensive per sentence.')
f2.append('- Smaller internal batches during streaming: model may run smaller inner batches or disable certain optimizations per-chunk.')
f2.append('- `_move_tensors_in_obj` or `_deep_cast_attrs` firing per chunk, moving/copying large tensors frequently.')
f2.append('')
f2.append('Recommended investigation order:')
f2.append('1. Measure per-sentence breakdown in streaming: log per-sentence generation time and identify slowest stage (T3, S3Gen, postprocess).')
f2.append('2. Instrument `_move_tensors_in_obj` and `_cast_tensors_in_obj` to count copies and bytes moved per chunk; temporarily disable them to see impact.')
f2.append('3. Compare a single full-run vs sentence-split run on the same input (i.e., call non-stream multiple times versus stream) to see overheads.')
f2.append('4. Profile GPU kernel times (Nsight or torch.profiler) for a streaming chunk vs non-stream to find differences.')

# Follow-ups (do not fix now)
ff=[]
ff.append('- Remove mock ChatterboxTTS fallback entirely (landmine).')
ff.append('- Install `psutil` into Python 3.11 interpreter (noisy logs).')
ff.append('- Address FastAPI `on_event` deprecation (lifespan handlers).')
ff.append('- Implement real watermarker (Perth DummyWatermarker placeholder present).')

with open(os.path.join(root,'findings.md'),'w',encoding='utf-8') as f:
    f.write('\n'.join(f2+['','### Follow-ups:']+ff))

# print short report
print(json.dumps({'summary':os.path.join(root,'summary.md'),'findings':os.path.join(root,'findings.md')}))
