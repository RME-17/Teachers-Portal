import os,sys
import wave
import struct
import math
import numpy as np
import soundfile as sf
from scipy.signal import correlate

root=os.path.dirname(os.path.abspath(__file__))
server_log=os.path.join(root,'..','server_stdout_long.log')
stream_pcm=os.path.join(root,'..','test_stream_long.pcm')
stream_wav_out=os.path.join(root,'test_stream_long.wav')
non_wav=os.path.join(root,'..','tts_out_long.wav')

# Determine sample rate from server log if possible
sr=24000
try:
    with open(server_log,'r',encoding='utf-8',errors='ignore') as f:
        txt=f.read()
    import re
    m=re.search(r'sr=(\d+)', txt)
    if m:
        sr=int(m.group(1))
except Exception:
    pass

res={}
# Non-stream WAV metadata
if os.path.exists(non_wav):
    try:
        with wave.open(non_wav,'rb') as wf:
            nch=wf.getnchannels()
            sampwidth=wf.getsampwidth()
            fr=wf.getframerate()
            frames=wf.getnframes()
            duration=frames/fr
        res['nonstream']={
            'path':os.path.relpath(non_wav,root),
            'filesize':os.path.getsize(non_wav),
            'channels':nch,'sampwidth':sampwidth,'samplerate':fr,'frames':frames,'duration':duration
        }
    except Exception as e:
        res['nonstream']={'error':str(e)}
else:
    res['nonstream']={'error':'missing'}

# Stream raw PCM
if os.path.exists(stream_pcm):
    try:
        size=os.path.getsize(stream_pcm)
        # assume int16 mono
        bytes_per_sample=2
        channels=1
        duration_raw = size/(sr*bytes_per_sample*channels)
        res['stream']={'path':os.path.relpath(stream_pcm,root),'filesize':size,'assumed_samplerate':sr,'bytes_per_sample':bytes_per_sample,'channels':channels,'duration_raw':duration_raw}
        # convert to wav for playback
        data=np.fromfile(stream_pcm,dtype=np.int16)
        # normalize to float32
        audio=data.astype(np.float32)/32768.0
        sf.write(stream_wav_out,audio,sr,subtype='PCM_16')
        res['stream']['converted_wav']=os.path.relpath(stream_wav_out,root)
    except Exception as e:
        res['stream']={'error':str(e)}
else:
    res['stream']={'error':'missing'}

# Analyze content: compute non-silent durations and compare

def non_silent_ranges(x, sr, frame_ms=50, thresh_db=-40):
    frame_len = int(sr * (frame_ms/1000.0))
    if frame_len<=0: frame_len=1024
    rms=[]
    for i in range(0, len(x), frame_len):
        f=x[i:i+frame_len]
        if len(f)==0: break
        rms_v = math.sqrt((f*f).mean()) if f.size else 0.0
        rms.append(rms_v)
    # convert thresh_db to linear
    maxr = max(rms) if rms else 1e-9
    thresh = maxr * (10**(thresh_db/20.0))
    non_silent_frames = [i for i,v in enumerate(rms) if v>thresh]
    if not non_silent_frames:
        return 0.0,0.0
    start_frame = non_silent_frames[0]
    end_frame = non_silent_frames[-1]
    start_time = start_frame * frame_len / sr
    end_time = (end_frame+1) * frame_len / sr
    return start_time, end_time

# load arrays
arr_non=None
arr_stream=None
try:
    if 'nonstream' in res and 'error' not in res['nonstream']:
        arr_non, sr_non = sf.read(non_wav)
        if arr_non.ndim>1:
            arr_non = np.mean(arr_non,axis=1)
        res['nonstream']['detected_samplerate']=sr_non
        res['nonstream']['detected_duration']=len(arr_non)/sr_non
        ns_start, ns_end = non_silent_ranges(arr_non, sr_non)
        res['nonstream']['nonsilent_start']=ns_start
        res['nonstream']['nonsilent_end']=ns_end
except Exception as e:
    res.setdefault('nonstream',{})['error_read']=str(e)

try:
    if 'stream' in res and 'error' not in res['stream']:
        arr_stream, sr_stream = sf.read(stream_wav_out)
        if arr_stream.ndim>1:
            arr_stream = np.mean(arr_stream,axis=1)
        res['stream']['detected_samplerate']=sr_stream
        res['stream']['detected_duration']=len(arr_stream)/sr_stream
        ns_start, ns_end = non_silent_ranges(arr_stream, sr_stream)
        res['stream']['nonsilent_start']=ns_start
        res['stream']['nonsilent_end']=ns_end
except Exception as e:
    res.setdefault('stream',{})['error_read']=str(e)

# Compare first N seconds similarity
try:
    compare_sec=20
    if arr_non is not None and arr_stream is not None:
        n=min(len(arr_non), len(arr_stream), int(compare_sec*sr))
        a=arr_non[:n]
        b=arr_stream[:n]
        # normalize
        a=a/ (np.max(np.abs(a))+1e-9)
        b=b/ (np.max(np.abs(b))+1e-9)
        # compute correlation
        corr = np.correlate(a,b,mode='valid')
        corr_val = float(corr[0]) / n
        res['similarity_first20s']=corr_val
except Exception as e:
    res['similarity_error']=str(e)

# Save report
import json
with open(os.path.join(root,'audio_analysis.json'),'w',encoding='utf-8') as f:
    json.dump(res,f,indent=2)
print('wrote',os.path.join(root,'audio_analysis.json'))
