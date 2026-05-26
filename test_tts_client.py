import requests
import time
import io
import wave
import sys

URL = "http://127.0.0.1:8123"
PAYLOAD = {"input": "Hello.", "voice": "abigail"}


def nonstream():
    t0 = time.perf_counter()
    r = requests.post(URL + "/v1/audio/speech", json=PAYLOAD, timeout=300)
    t1 = time.perf_counter()
    if r.status_code != 200:
        print("nonstream status", r.status_code, r.text[:200])
        return None

    data = r.content
    try:
        with io.BytesIO(data) as bf:
            wf = wave.open(bf, 'rb')
            channels = wf.getnchannels()
            sr = wf.getframerate()
            frames = wf.getnframes()
            duration = frames / float(sr)
    except Exception as e:
        print("Failed to parse WAV:", e)
        return None

    print(f"NONSTREAM bytes={len(data)} total_ms={(t1-t0)*1000:.1f} sr={sr} channels={channels} frames={frames} duration_s={duration:.3f}")
    return sr


def streaming(sr_assumed=None):
    t0 = time.perf_counter()
    r = requests.post(URL + "/v1/audio/speech/stream", json=PAYLOAD, stream=True, timeout=300)
    if r.status_code != 200:
        print("stream status", r.status_code, r.text[:200])
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
        audio_dur_s = bytes_recv / (2.0 * sr_assumed)

    print(f"STREAM bytes={bytes_recv} time_to_first_chunk_ms={ttf_ms:.1f} total_ms={total_ms:.1f} audio_dur_s={audio_dur_s}")


def main():
    sr = nonstream()
    streaming(sr_assumed=sr)


if __name__ == '__main__':
    main()
