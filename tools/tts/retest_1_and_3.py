import requests, wave, io, time, os
url='http://localhost:8123/v1/audio/speech'
phrases=[('Hello.','test_014.wav'),('Welcome to Recruit My English. Your interview with Talking Global is confirmed for tomorrow at three p.m. South African time. Please make sure your camera and microphone are working before the call.','test_015.wav')]
OUT='tools/tts/test_outputs'
os.makedirs(OUT, exist_ok=True)
for i,(text,fn) in enumerate(phrases, start=1):
    payload={'input': text}
    t0=time.perf_counter()
    r=requests.post(url,json=payload,timeout=300)
    t1=time.perf_counter()
    synth=t1-t0
    if r.status_code!=200:
        print('Error', r.status_code, r.text); continue
    path=os.path.join(OUT,fn)
    open(path,'wb').write(r.content)
    try:
        with wave.open(io.BytesIO(r.content),'rb') as w:
            dur=w.getnframes()/w.getframerate()
    except Exception:
        dur=None
    print(fn,'chars',len(text),'dur',dur,'synth',synth)
print('done')
