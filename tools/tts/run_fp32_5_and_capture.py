import os, time, io, wave, requests, threading, subprocess
import numpy as np
import soundfile as sf

OUT='tools/tts/test_outputs'
os.makedirs(OUT, exist_ok=True)
BASE='http://localhost:8123/v1/audio/speech'

phrases = [
    ("Hello.", 'test_014.wav'),
    ("This payslip shows your gross pay, deductions, and net pay for the month. If you have questions, contact payroll.", 'test_015.wav'),
    # phrase3 was already saved as test_013.wav (interview)
    # We'll run phrase5 (long paragraph) and capture nvidia-smi during synth
    ("Long paragraph: I want to check whether real-time-factor stays under one for a paragraph-length response. Imagine this is the AI replying to a teacher who has just asked how their next payment will be calculated, including the U S D to Z A R rate, the platform fee, and the timing of the bank transfer. The audio should sound natural throughout, and the synthesis should still finish in less time than the audio itself plays.", 'test_016.wav')
]

results = []

# helper to run nvidia-smi once after a short delay and save to file
def capture_nvidia_snapshot(delay, out_path):
    time.sleep(delay)
    try:
        p = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=10)
        with open(out_path, 'w') as f:
            f.write(p.stdout)
    except Exception as e:
        with open(out_path, 'w') as f:
            f.write('ERROR: '+str(e))

# Post first phrase (test_014)
for i, (text, fn) in enumerate(phrases, start=4):
    payload={'input': text}
    out_path = os.path.join(OUT, fn)
    if fn == 'test_016.wav':
        # Start snapshot thread to capture mid-synth
        snap_path = 'tools/tts/bench_results/nvidia_snapshot_phrase5.txt'
        os.makedirs(os.path.dirname(snap_path), exist_ok=True)
        snap_thread = threading.Thread(target=capture_nvidia_snapshot, args=(1.0, snap_path))
        snap_thread.start()
    t0 = time.perf_counter()
    r = requests.post(BASE, json=payload, timeout=600)
    t1 = time.perf_counter()
    synth = t1 - t0
    if r.status_code != 200:
        print('Error', r.status_code, r.text)
        continue
    data = r.content
    with open(out_path, 'wb') as f:
        f.write(data)
    # duration
    dur = None
    try:
        with wave.open(io.BytesIO(data),'rb') as w:
            dur = w.getnframes()/float(w.getframerate())
    except Exception:
        pass
    rtf = synth/dur if (dur and dur>0) else None
    results.append((fn, dur, synth, rtf, out_path))
    print(f'Wrote {out_path} dur={dur} synth={synth:.3f} rtf={rtf:.3f}')
    if fn == 'test_016.wav':
        snap_thread.join()

# Now run a simple spectral diagnosis on test_011..test_016
from math import isfinite
import scipy.signal

def spectral_metrics(path):
    try:
        y, sr = sf.read(path)
    except Exception:
        return None
    if y.ndim>1:
        y = y.mean(axis=1)
    # short-time frames
    window_len = 2048; hop = 512
    L = len(y)
    frames = []
    for i in range(0, L - window_len + 1, hop):
        frm = y[i:i+window_len] * np.hanning(window_len)
        frames.append(frm)
    if not frames:
        return None
    F = np.fft.rfft(np.stack(frames), axis=1)
    power = (np.abs(F)**2) + 1e-12
    arith = power.mean(axis=1)
    geo = np.exp(np.log(power).mean(axis=1))
    flatness = geo/arith
    freqs = np.fft.rfftfreq(window_len, 1.0/sr)
    hf_mask = freqs > 6000
    hf_ratio = power[:, hf_mask].sum(axis=1) / power.sum(axis=1)
    # detect spikes
    flat_med = np.median(flatness); flat_std = np.std(flatness)
    hf_med = np.median(hf_ratio); hf_std = np.std(hf_ratio)
    flat_thresh = flat_med + 3*flat_std
    hf_thresh = hf_med + 3*hf_std
    corruption_indices = np.where((flatness>flat_thresh)|(hf_ratio>hf_thresh))[0]
    onset = None
    if corruption_indices.size>0:
        onset = corruption_indices[0]*hop/sr
    return dict(flat_med=float(flat_med), flat_post= float(np.mean(flatness[corruption_indices[0]:])) if corruption_indices.size>0 else None,
                hf_med=float(hf_med), hf_post=float(np.mean(hf_ratio[corruption_indices[0]:])) if corruption_indices.size>0 else None,
                onset=onset)

metrics = {}
for idx in range(11,17):
    fname = f'test_{idx:03d}.wav'
    path = os.path.join(OUT, fname)
    if not os.path.exists(path):
        continue
    m = spectral_metrics(path)
    metrics[fname]=m

# Print summary
print('\nSummary results:')
for r in results:
    print(r)
for k,v in metrics.items():
    print(k, v)

# Write bench CSV row entries and append to existing CSV
csvp = 'tools/tts/bench_results/2026-05-26/retest_1_5_full_fp32.csv'
os.makedirs(os.path.dirname(csvp), exist_ok=True)
with open(csvp,'w') as f:
    f.write('file,audio_duration_s,synth_time_s,rtf,flat_metrics,onset\n')
    for fn,dur,synth,rtf,path in results:
        f.write(f"{fn},{dur:.3f},{synth:.3f},{rtf:.3f},{metrics.get(os.path.basename(fn))},{metrics.get(os.path.basename(fn),{}).get('onset')}\n")
print('Wrote', csvp)

# Exit

