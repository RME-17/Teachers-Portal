import subprocess
import threading
import time
import requests
import sys
import os

PYTHON_EXE = r"C:\Users\infor\AppData\Local\Programs\Python\Python311\python.exe"
SCRIPT = r"C:\Users\infor\Desktop\Desktop payslip app\tools\tts\chatterbox-server.py"


def kill_existing():
    try:
        import psutil
    except Exception:
        return
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmd = " ".join(p.info.get("cmdline") or [])
            if "chatterbox-server.py" in cmd and "python" in (p.info.get("name") or "").lower() or "python.exe" in cmd:
                print(f"Killing existing chatterbox process {p.pid} {cmd}")
                p.kill()
        except Exception:
            pass


def stream_reader(pipe, acc):
    try:
        for line in iter(pipe.readline, ""):
            acc.append(line)
    except Exception:
        pass


def main():
    kill_existing()
    out_lines = []
    err_lines = []
    cmd = [PYTHON_EXE, SCRIPT, "--port", "8123"]
    print("Starting server:", cmd)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)

    t_out = threading.Thread(target=stream_reader, args=(proc.stdout, out_lines), daemon=True)
    t_err = threading.Thread(target=stream_reader, args=(proc.stderr, err_lines), daemon=True)
    t_out.start()
    t_err.start()

    healthy = False
    for i in range(120):
        try:
            r = requests.get("http://127.0.0.1:8123/health", timeout=2)
            if r.status_code == 200:
                healthy = True
                print("Server healthy:", r.json())
                break
        except Exception:
            pass
        time.sleep(1)

    if not healthy:
        print("Server failed to become healthy. Dumping logs (tail 200):")
        print("STDOUT:\n", "".join(out_lines[-200:]))
        print("STDERR:\n", "".join(err_lines[-200:]))
        try:
            proc.kill()
        except Exception:
            pass
        sys.exit(1)

    # Run a single non-streaming synthesis test with timeout
    payload = {"input": "Hello.", "voice": "abigail"}
    t0 = time.perf_counter()
    try:
        r = requests.post("http://127.0.0.1:8123/v1/audio/speech", json=payload, timeout=60)
        t1 = time.perf_counter()
        print("Request status", r.status_code, "elapsed_ms", (t1 - t0) * 1000)
        if r.status_code == 200:
            print("Bytes returned", len(r.content))
        else:
            print("Response text (first 1000):", r.text[:1000])
    except Exception as e:
        print("Request error:", e)

    print("--- Server stdout tail ---\n", "".join(out_lines[-200:]))
    print("--- Server stderr tail ---\n", "".join(err_lines[-200:]))

    try:
        proc.terminate()
    except Exception:
        pass


if __name__ == '__main__':
    main()
