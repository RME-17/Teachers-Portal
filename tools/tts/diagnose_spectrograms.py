import os
import numpy as np
import soundfile as sf
import matplotlib.pyplot as plt

BASE = os.path.join('tools','tts')
files = [os.path.join(BASE,'test_outputs',f'test_{i:03d}.wav') for i in range(6,11)]
out_dir = os.path.join(BASE,'diagnostics')
os.makedirs(out_dir, exist_ok=True)

window_len = 2048
hop = 512
window = np.hanning(window_len)
EPS = 1e-12

report = []
for path in files:
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
    if len(frames) == 0:
        print('Too short', path)
        continue
    F = np.fft.rfft(np.stack(frames), axis=1)
    power = (np.abs(F) ** 2) + EPS
    # spectral flatness per frame
    arith = power.mean(axis=1)
    geo = np.exp(np.log(power).mean(axis=1))
    flatness = geo / arith
    # high-frequency ratio: energy above 6kHz
    freqs = np.fft.rfftfreq(window_len, 1.0/sr)
    hf_mask = freqs > 6000
    hf_ratio = power[:, hf_mask].sum(axis=1) / power.sum(axis=1)
    # detect frames where flatness and hf_ratio spike
    flat_med = np.median(flatness)
    flat_std = np.std(flatness)
    hf_med = np.median(hf_ratio)
    hf_std = np.std(hf_ratio)
    flat_thresh = flat_med + 3*flat_std
    hf_thresh = hf_med + 3*hf_std
    corruption_indices = np.where((flatness > flat_thresh) | (hf_ratio > hf_thresh))[0]
    if corruption_indices.size > 0:
        first_idx = int(corruption_indices[0])
        onset_time = first_idx * hop / sr
        pattern = 'corruption' if onset_time < (L/sr) else 'none'
    else:
        first_idx = None
        onset_time = None
        pattern = 'clean'
    report.append((os.path.basename(path), len(y), sr, onset_time, first_idx))
    # Save spectrogram image
    S = 10 * np.log10(power.T + EPS)
    plt.figure(figsize=(10,4))
    plt.imshow(S, origin='lower', aspect='auto', cmap='inferno', extent=[0, len(frames)*hop/sr, freqs[0], freqs[-1]])
    plt.colorbar(label='Power (dB)')
    plt.xlabel('Time (s)')
    plt.ylabel('Frequency (Hz)')
    if onset_time is not None:
        plt.axvline(onset_time, color='cyan')
    out_png = os.path.join(out_dir, os.path.basename(path) + '.png')
    plt.title(os.path.basename(path))
    plt.tight_layout()
    plt.savefig(out_png, dpi=150)
    plt.close()
    print(f'Wrote spectrogram {out_png}; onset_time={onset_time}')

# Print summary
print('\nSummary:')
for name, n_samples, sr, onset, idx in report:
    print(f'{name}: {n_samples} samples @ {sr} Hz; detected onset at {onset} s (frame idx {idx})')

# Save a CSV report
csvp = os.path.join(out_dir, 'spectrogram_report.csv')
with open(csvp,'w') as f:
    f.write('file,samples,sr,onset_time,frame_idx\n')
    for name, n_samples, sr, onset, idx in report:
        f.write(f'{name},{n_samples},{sr},{onset},{idx}\n')
print('Wrote', csvp)
