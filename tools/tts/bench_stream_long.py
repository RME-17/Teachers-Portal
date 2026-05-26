import time
import json
import requests

url = 'http://127.0.0.1:8123/v1/audio/speech/stream'
with open('payload.json','r',encoding='utf-8') as f:
    payload = json.load(f)

out_path = 'test_stream_long.pcm'
try:
    t0 = time.time()
    r = requests.post(url, json=payload, stream=True, timeout=600)
    t_first = None
    total_bytes = 0
    if r.status_code != 200:
        print('STATUS', r.status_code)
        print(r.text)
        raise SystemExit(1)
    with open(out_path,'wb') as out:
        for chunk in r.iter_content(chunk_size=8192):
            if chunk:
                if t_first is None:
                    t_first = time.time()
                out.write(chunk)
                total_bytes += len(chunk)
    t_end = time.time()
    print('ttfc', (t_first - t0) if t_first else 0.0)
    print('total', (t_end - t0))
    print('bytes', total_bytes)
except Exception as e:
    print('ERROR', e)
    raise
