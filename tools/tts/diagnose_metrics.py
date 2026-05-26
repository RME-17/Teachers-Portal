import os
import csv
import numpy as np
import soundfile as sf

BASE = os.path.join('tools','tts')
report_csv = os.path.join(BASE,'diagnostics','spectrogram_report.csv')
window_len = 2048
hop = 512
window = np.hanning(window_len)
EPS = 1e-12

if not os.path.exists(report_csv):
    print('Missing report CSV:', report_csv)
    raise SystemExit(1)

with open(report_csv,'r') as f:
    rows = list(csv.DictReader(f))

for r in rows:
    fname = r['file']
    onset = r['onset_time']
    try:
        onset = float(onset) if onset and onset!='None' else None
    except Exception:
        onset = None
    path = os.path.join(BASE,'test_outputs',fname)
    if not os.path.exists(path):
        print('Missing', path)
        continue
    y, sr = sf.read(path)
    if y.ndim > 1:
        y = y.mean(axis=1)
    L = len(y)
    frames = []
    for i in range(0, L - window_len + 1, hop):
        frm = y[i:i+window_len] * window
        frames.append(frm)
    F = np.fft.rfft(np.stack(frames), axis=1)
    power = (np.abs(F) ** 2) + EPS
    arith = power.mean(axis=1)
    geo = np.exp(np.log(power).mean(axis=1))
    flatness = geo / arith
    freqs = np.fft.rfftfreq(window_len, 1.0/sr)
    hf_mask = freqs > 6000
    hf_ratio = power[:, hf_mask].sum(axis=1) / power.sum(axis=1)
    if onset is None:
        idx = len(frames)//2
    else:
        idx = int(onset * sr / hop)
        if idx < 0: idx = 0
        if idx >= len(frames): idx = len(frames)-1
    pre_flat = float(np.mean(flatness[:idx]))
    post_flat = float(np.mean(flatness[idx:]))
    pre_hf = float(np.mean(hf_ratio[:idx]))
    post_hf = float(np.mean(hf_ratio[idx:]))
    print(f"{fname}: pre_flat={pre_flat:.5f}, post_flat={post_flat:.5f}, pre_hf={pre_hf:.5f}, post_hf={post_hf:.5f}, onset={onset}")
