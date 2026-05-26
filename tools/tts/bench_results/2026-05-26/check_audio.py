import os,sys
import wave
import numpy as np
import soundfile as sf

stream_pcm='tools/tts/test_stream_long.pcm'
non_wav='tools/tts/tts_out_long.wav'
out_stream_wav='tools/tts/converted_test_stream_long.wav'

print('checking files...')
print('stream exists', os.path.exists(stream_pcm), 'size', os.path.getsize(stream_pcm) if os.path.exists(stream_pcm) else None)
print('nonstream exists', os.path.exists(non_wav), 'size', os.path.getsize(non_wav) if os.path.exists(non_wav) else None)

sr=24000
# convert pcm to wav
if os.path.exists(stream_pcm):
    data=np.fromfile(stream_pcm, dtype=np.int16)
    audio=data.astype(np.float32)/32768.0
    sf.write(out_stream_wav, audio, sr, subtype='PCM_16')
    print('wrote converted stream wav', out_stream_wav)

# analyze nonstream wav
if os.path.exists(non_wav):
    with wave.open(non_wav,'rb') as wf:
        nch=wf.getnchannels(); sw=wf.getsampwidth(); fr=wf.getframerate(); frames=wf.getnframes()
        duration=frames/fr
    print('nonstream: channels',nch,'sampwidth',sw,'samplerate',fr,'frames',frames,'duration',duration)
else:
    print('nonstream missing')

# analyze converted stream wav
if os.path.exists(out_stream_wav):
    with wave.open(out_stream_wav,'rb') as wf:
        nch=wf.getnchannels(); sw=wf.getsampwidth(); fr=wf.getframerate(); frames=wf.getnframes()
        duration_s=frames/fr
    print('stream(converted): channels',nch,'sampwidth',sw,'samplerate',fr,'frames',frames,'duration',duration_s)
else:
    print('converted stream missing')

# detect nonsilent end using RMS
import math

def nonsilent_bounds(arr, sr, frame_ms=50, db_thresh=-40):
    frame_len=int(sr*(frame_ms/1000.0))
    if frame_len<=0: frame_len=1024
    rms=[]
    for i in range(0,len(arr),frame_len):
        f=arr[i:i+frame_len]
        if len(f)==0: break
        v=math.sqrt((f*f).mean()) if f.size else 0.0
        rms.append(v)
    if not rms: return 0.0,0.0
    maxr=max(rms)
    thresh=maxr*(10**(db_thresh/20.0))
    idxs=[i for i,v in enumerate(rms) if v>thresh]
    if not idxs: return 0.0,0.0
    start=idxs[0]*frame_len/sr
    end=(idxs[-1]+1)*frame_len/sr
    return start,end

if os.path.exists(non_wav):
    arr, sr_non = sf.read(non_wav)
    if arr.ndim>1: arr=np.mean(arr,axis=1)
    s,e=nonsilent_bounds(arr, sr_non)
    print('nonstream nonsilent', s, e, 'len', e-s)

if os.path.exists(out_stream_wav):
    arr2, sr2 = sf.read(out_stream_wav)
    if arr2.ndim>1: arr2=np.mean(arr2,axis=1)
    s2,e2=nonsilent_bounds(arr2, sr2)
    print('stream nonsilent', s2, e2, 'len', e2-s2)

# quick similarity on first 20s
try:
    N=int(20*sr)
    a=arr[:min(len(arr),N)]
    b=arr2[:min(len(arr2),N)]
    na=a/(np.max(np.abs(a))+1e-9)
    nb=b/(np.max(np.abs(b))+1e-9)
    m=min(len(na),len(nb))
    corr=np.dot(na[:m], nb[:m])/m
    print('first20s similarity dot', corr)
except Exception as e:
    print('similarity error',e)

# energy-envelope cross-correlation to find if nonstream appears in stream
try:
    win_ms=100
    flen=int(sr*(win_ms/1000.0))
    def envelope(x,flen):
        env=[np.sqrt((x[i:i+flen]**2).mean()) if x[i:i+flen].size else 0.0 for i in range(0,len(x),flen)]
        env=np.array(env)
        if np.max(env)>0: env=env/np.max(env)
        return env
    env_non=envelope(arr,flen)
    env_stream=envelope(arr2,flen)
    # cross-correlate
    from scipy.signal import correlate
    c=correlate(env_stream, env_non, mode='valid')
    if len(c)>0:
        peak=c.max()
        pos=int(np.argmax(c))
        peak_norm=peak/len(env_non)
        print('envelope match peak_norm', peak_norm, 'pos_frames', pos, 'pos_seconds', pos*(flen/sr))
    else:
        print('envelope correlation empty')
except Exception as e:
    print('envelope match error', e)

print('done')
