import os, time, io, wave, requests
BASE='http://localhost:8123/v1/audio/speech'
OUT='tools/tts/test_outputs'
os.makedirs(OUT, exist_ok=True)
phrases=[('Hello.', 'test_011.wav'),
('Okay, this is the longest one. I want to check whether real-time-factor stays under one for a paragraph-length response. Imagine this is the AI replying to a teacher who has just asked how their next payment will be calculated, including the U S D to Z A R rate, the platform fee, and the timing of the bank transfer. The audio should sound natural throughout, and the synthesis should still finish in less time than the audio itself plays.', 'test_012.wav')]
results=[]
for i,(text,fn) in enumerate(phrases, start=1):
    payload={'input': text}
    t0=time.perf_counter()
    r=requests.post(BASE, json=payload, timeout=300)
    t1=time.perf_counter()
    synth=t1-t0
    if r.status_code!=200:
        print('Error', r.status_code, r.text)
        continue
    data=r.content
    path=os.path.join(OUT, fn)
    with open(path,'wb') as f:
        f.write(data)
    # duration
    try:
        with wave.open(io.BytesIO(data),'rb') as w:
            dur = w.getnframes()/float(w.getframerate())
    except Exception:
        dur=None
    rtf = synth/dur if dur and dur>0 else None
    results.append((i, len(text), dur, synth, rtf, path))
    print(f'Phrase {i}: chars={len(text)} dur={dur:.3f} synth={synth:.3f} rtf={rtf:.3f} saved={path}')

# write small CSV
csv_path='tools/tts/bench_results/2026-05-26/retest_1_5.csv'
os.makedirs(os.path.dirname(csv_path), exist_ok=True)
with open(csv_path,'w') as f:
    f.write('phrase_num,chars,audio_duration_s,synth_time_s,rtf,output_file\n')
    for r in results:
        f.write(f"{r[0]},{r[1]},{r[2]:.3f},{r[3]:.3f},{r[4]:.3f},{r[5]}\n")
print('Wrote', csv_path)
