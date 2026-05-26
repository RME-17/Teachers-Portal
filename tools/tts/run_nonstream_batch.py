import os,requests,time,wave
out_dir='tools/tts/test_outputs'
os.makedirs(out_dir,exist_ok=True)
phrases=[
"Hello.",
"Your payslip for May is ready to view.",
"Welcome to Recruit My English. Your interview with Talking Global is confirmed for tomorrow at three p.m. South African time. Please make sure your camera and microphone are working before the call.",
"Hi, this is a longer test to confirm the server stays stable on multi-sentence input. The first sentence sets context. The second sentence adds detail. The third sentence wraps up cleanly.",
"Okay, this is the longest one. I want to check whether real-time-factor stays under one for a paragraph-length response. Imagine this is the AI replying to a teacher who has just asked how their next payment will be calculated, including the U S D to Z A R rate, the platform fee, and the timing of the bank transfer. The audio should sound natural throughout, and the synthesis should still finish in less time than the audio itself plays."
]
url='http://127.0.0.1:8123/v1/audio/speech'
results=[]
count=1
for p in phrases:
    payload={'input':p,'voice':'abigail','model':'tts-1','exaggeration':0.35,'cfg_weight':0.55,'temperature':0.8}
    t0=time.time()
    try:
        r=requests.post(url,json=payload,timeout=600)
        t1=time.time()
        synth=t1-t0
        status=r.status_code
    except Exception as e:
        t1=time.time(); synth=t1-t0; status=None; r_text=str(e)
        print('Request error',e)
    fname=f'test_{count:03d}.wav'
    path=os.path.join(out_dir,fname)
    size=0; duration=None
    if status==200 and r.content:
        with open(path,'wb') as f:
            f.write(r.content)
        size=os.path.getsize(path)
        try:
            with wave.open(path,'rb') as wf:
                frames=wf.getnframes(); fr=wf.getframerate(); duration=frames/fr
        except Exception:
            duration=None
    results.append({'idx':count,'chars':len(p),'phrase':p,'status':status,'size':size,'duration':duration,'synth':synth})
    print('Done',count,'chars',len(p),'status',status,'size',size,'duration',duration,'synth',round(synth,3))
    count+=1
# nvidia snapshot
try:
    import subprocess
    nv=subprocess.check_output('nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits',shell=True).decode().strip()
except Exception as e:
    nv=str(e)
print('\nResults:')
print('|#|chars|duration_s|synth_s|RTF|size_bytes|')
for r in results:
    rtf = (r['synth']/r['duration']) if (r['duration'] and r['duration']>0) else None
    print(f"|{r['idx']}|{r['chars']}|{r['duration']}|{round(r['synth'],3)}|{round(rtf,3) if rtf else None}|{r['size']}|")
print('\nOutput folder:', out_dir)
print('nvidia snapshot:', nv)
# final health
try:
    import requests
    h=requests.get('http://127.0.0.1:8123/health',timeout=5).json()
    print('health',h)
except Exception as e:
    print('health error',e)
