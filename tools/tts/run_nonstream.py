import time, requests, json
p=json.load(open('payload.json'))
url='http://127.0.0.1:8123/v1/audio/speech'
start=time.time()
r=requests.post(url,json=p,timeout=600)
print('status',r.status_code)
print('elapsed',time.time()-start)
open('tts_out.wav','wb').write(r.content if r.status_code==200 else b'')
