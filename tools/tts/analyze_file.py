import os
import numpy as np
import soundfile as sf
import matplotlib.pyplot as plt

path='tools/tts/test_outputs/test_013.wav'
if not os.path.exists(path):
    print('Missing', path); raise SystemExit(1)

y,sr=sf.read(path)
if y.ndim>1:
    y=y.mean(axis=1)
L=len(y)
window_len=2048
hop=512
window=np.hanning(window_len)
frames=[]
for i in range(0, L-window_len+1, hop):
    frames.append(y[i:i+window_len]*window)
F=np.fft.rfft(np.stack(frames),axis=1)
power=(np.abs(F)**2)+1e-12
freqs=np.fft.rfftfreq(window_len,1.0/sr)
S=10*np.log10(power.T+1e-12)
plt.figure(figsize=(10,4))
plt.imshow(S, origin='lower', aspect='auto', cmap='inferno', extent=[0, len(frames)*hop/sr, freqs[0], freqs[-1]])
plt.colorbar()
plt.xlabel('Time (s)')
plt.ylabel('Frequency (Hz)')
plt.title('test_013.wav')
out='tools/tts/diagnostics/test_013.wav.png'
plt.tight_layout(); plt.savefig(out, dpi=150); plt.close()

arith = power.mean(axis=1)
geo = np.exp(np.log(power).mean(axis=1))
flatness = geo/arith
hf_ratio = power[:, freqs>6000].sum(axis=1)/power.sum(axis=1)
flat_med, flat_std = np.median(flatness), np.std(flatness)
hf_med, hf_std = np.median(hf_ratio), np.std(hf_ratio)
flat_thresh = flat_med + 3*flat_std
hf_thresh = hf_med + 3*hf_std
idxs = np.where((flatness>flat_thresh)|(hf_ratio>hf_thresh))[0]
if idxs.size>0:
    onset = idxs[0]*hop/sr
else:
    onset = None
print('Wrote', out, 'onset=', onset)
print('pre_flat,post_flat,pre_hf,post_hf:')
if onset:
    frame_idx=int(onset*sr/hop)
else:
    frame_idx=len(frames)//2
pre_flat=np.mean(flatness[:frame_idx]); post_flat=np.mean(flatness[frame_idx:])
pre_hf=np.mean(hf_ratio[:frame_idx]); post_hf=np.mean(hf_ratio[frame_idx:])
print(pre_flat, post_flat, pre_hf, post_hf)
