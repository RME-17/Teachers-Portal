import codecs
import re
lines = []
with codecs.open('nvidia_log.csv','r','utf-16') as f:
    for l in f:
        l = l.strip()
        if not l: continue
        # Expect lines like: 2026-05-20T19:53.1721267+02:00 2, 3144
        parts = l.split()
        if len(parts) < 2: continue
        ts = parts[0]
        rest = ' '.join(parts[1:])
        # extract two numbers
        m = re.findall(r"(\d+)", rest)
        if len(m) >= 2:
            util = int(m[0])
            mem = int(m[1])
            lines.append((ts, util, mem))

if not lines:
    print('NO_DATA')
else:
    max_util = max(lines, key=lambda x: x[1])
    max_mem = max(lines, key=lambda x: x[2])
    print('samples', len(lines))
    print('max_gpu_util_percent', max_util[1], 'at', max_util[0])
    print('max_vram_mb', max_mem[2], 'at', max_mem[0])
    # print first and last 3 samples
    print('first3', lines[:3])
    print('last3', lines[-3:])
