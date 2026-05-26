import requests, wave, io, time, os
url='http://localhost:8123/v1/audio/speech'
phrase='Welcome to Recruit My English. Your interview with Talking Global is confirmed for tomorrow at three p.m. South African time. Please make sure your camera and microphone are working before the call.'
payload={'input': phrase}
print('Posting phrase 3...')
t0=time.perf_counter()
r=requests.post(url,json=payload,timeout=300)
t1=time.perf_counter()
print('HTTP', r.status_code)
synth=t1-t0
if r.status_code==200:
    out='tools/tts/test_outputs/test_013.wav'
    open(out,'wb').write(r.content)
    try:
        with wave.open(io.BytesIO(r.content),'rb') as w:
            dur=w.getnframes()/w.getframerate()
    except Exception:
        dur=None
    print('Saved', out, 'synth', synth, 'duration', dur)
else:
    print('Error', r.text)
