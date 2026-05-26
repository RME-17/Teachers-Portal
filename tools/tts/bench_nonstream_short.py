import requests, time
p={'input':'Hello world','voice':'aaron'}
url='http://127.0.0.1:8123/v1/audio/speech'
start=time.time()
r=requests.post(url,json=p,timeout=300)
elapsed=time.time()-start
print('status',r.status_code)
# Save wav bytes if returned
if r.status_code==200:
    with open('tts_out_short.wav','wb') as f:
        f.write(r.content)
print('elapsed',elapsed)
print('len_bytes', len(r.content) if r.content else 0)
print('text_or_json:', r.text[:200])
