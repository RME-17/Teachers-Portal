import requests, json, time
p={'input':'Hello world','voice':'aaron'}
url='http://127.0.0.1:8123/v1/audio/speech'
start=time.time()
r=requests.post(url,json=p,timeout=30)
print('status',r.status_code)
print(r.text)
print('elapsed',time.time()-start)
