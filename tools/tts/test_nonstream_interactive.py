import os,requests,time,json
out_dir='tools/tts/test_outputs'
os.makedirs(out_dir,exist_ok=True)
count=0
# find next index
for fn in os.listdir(out_dir):
    if fn.startswith('test_') and fn.endswith('.wav'):
        try:
            n=int(fn.split('_')[1].split('.')[0])
            count=max(count,n)
        except Exception:
            pass
count+=1

while True:
    phrase=input('Phrase (or quit): ').strip()
    if not phrase:
        continue
    if phrase.lower() in ('quit','q','exit'):
        break
    payload={
        'input': phrase,
        'voice': 'abigail',
        'model': 'tts-1',
        'exaggeration': 0.35,
        'cfg_weight': 0.55,
        'temperature': 0.8
    }
    url='http://127.0.0.1:8123/v1/audio/speech'
    t0=time.time()
    r=requests.post(url,json=payload,timeout=600)
    t1=time.time()
    synth_time=t1-t0
    if r.status_code!=200:
        print('ERROR status', r.status_code, r.text)
        continue
    fname=f'test_{count:03d}.wav'
    path=os.path.join(out_dir,fname)
    with open(path,'wb') as f:
        f.write(r.content)
    # measure audio duration
    try:
        import wave
        with wave.open(path,'rb') as wf:
            frames=wf.getnframes(); fr=wf.getframerate(); duration=frames/fr
    except Exception:
        duration=None
    rtf = synth_time/duration if duration and duration>0 else None
    print('Saved:', path, 'size', os.path.getsize(path), 'duration', duration, 'synth', round(synth_time,3), 'RTF', round(rtf,3) if rtf else None)
    count+=1
