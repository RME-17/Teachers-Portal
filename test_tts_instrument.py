import subprocess
import requests
import time
import io
import wave
import sys

# Configuration
PYTHON_EXE = r"C:\Users\infor\AppData\Local\Programs\Python\Python311\python.exe"
SERVER_SCRIPT = r"C:\Users\infor\Desktop\Desktop payslip app\tools\tts\chatterbox-server.py"
URL = "http://127.0.0.1:8123"


def start_server():
    process = subprocess.Popen(
        [PYTHON_EXE, SERVER_SCRIPT, "--port", "8123"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    return process


def wait_health(timeout=180, poll=1.0):
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(URL + "/health", timeout=5)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(poll)
    return False


def test_non_streaming():
    payload = {"input": "Hello.", "voice": "abigail"}
    t0 = time.perf_counter()
    r = requests.post(URL + "/v1/audio/speech", json=payload, timeout=120)
    t1 = time.perf_counter()
    total_ms = (t1 - t0) * 1000
    if r.status_code != 200:
        print("Non-streaming failed status", r.status_code, r.text[:200])
        return None

    data = r.content
    # Parse WAV header using built-in wave
    try:
        with io.BytesIO(data) as bf:
            wf = wave.open(bf, 'rb')
            channels = wf.getnchannels()
            sr = wf.getframerate()
            frames = wf.getnframes()
            sampwidth = wf.getsampwidth()
            duration = frames / float(sr)
    except Exception as e:
        print("Failed to parse WAV:", e)
        print("Bytes returned:", len(data))
        return None

    print(f"Non-streaming: bytes={len(data)} total_ms={total_ms:.1f} sr={sr} channels={channels} frames={frames} duration_s={duration:.3f}")
    return sr


def test_streaming(sr_assumed=None):
    payload = {"input": "Hello.", "voice": "abigail"}
    t0 = time.perf_counter()
    r = requests.post(URL + "/v1/audio/speech/stream", json=payload, stream=True, timeout=120)
    if r.status_code != 200:
        print("Streaming failed status", r.status_code, r.text[:200])
        return

    bytes_recv = 0
    first_chunk_time = None
    last_chunk_time = None
    try:
        for chunk in r.iter_content(chunk_size=4096):
            if chunk:
                now = time.perf_counter()
                if first_chunk_time is None:
                    first_chunk_time = now
                bytes_recv += len(chunk)
                last_chunk_time = now
    except Exception as e:
        print("Error iterating stream:", e)

    if first_chunk_time is None:
        print("Streaming returned no chunks")
        return

    ttf_ms = (first_chunk_time - t0) * 1000
    total_ms = (last_chunk_time - t0) * 1000
    audio_dur_s = None
    if sr_assumed:
        # pcm16le
        audio_dur_s = bytes_recv / (2.0 * sr_assumed)

    print(f"Streaming: bytes={bytes_recv} time_to_first_chunk_ms={ttf_ms:.1f} total_ms={total_ms:.1f} audio_dur_s={audio_dur_s}")


def main():
    proc = start_server()
    try:
        ok = wait_health(timeout=180)
        if not ok:
            print("Server did not become healthy in time. Dumping logs (partial):")
            try:
                print(proc.stdout.read())
            except Exception:
                pass
            return 2

        sr = test_non_streaming()
        test_streaming(sr_assumed=sr)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == '__main__':
    sys.exit(main())
