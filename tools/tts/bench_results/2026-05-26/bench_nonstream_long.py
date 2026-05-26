import requests, time, json
with open('payload.json','r',encoding='utf-8') as f:
    p = json.load(f)
url='http://127.0.0.1:8123/v1/audio/speech'
start=time.time()
r=requests.post(url,json=p,timeout=600)
elapsed=time.time()-start
print('status',r.status_code)
if r.status_code==200:
    with open('tts_out_long.wav','wb') as f:
        f.write(r.content)
print('elapsed',elapsed)
print('len_bytes', len(r.content) if r.content else 0)
print('text_or_json:', r.text[:200])
