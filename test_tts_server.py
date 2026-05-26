import subprocess
import requests
import time
import os
import sys

# Configuration
PYTHON_EXE = r"C:\Users\infor\AppData\Local\Programs\Python\Python311\python.exe"
SERVER_SCRIPT = r"C:\Users\infor\Desktop\Desktop payslip app\tools\tts\chatterbox-server.py"
URL = "http://127.0.0.1:8123"

def test_server():
    print("Starting server...")
    process = subprocess.Popen(
        [PYTHON_EXE, SERVER_SCRIPT],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1
    )

    try:
        # Wait for server to be healthy
        print("Waiting for server health check...")
        healthy = False
        for i in range(60):
            try:
                resp = requests.get(f"{URL}/health")
                if resp.status_code == 200:
                    print("Server is healthy!")
                    healthy = True
                    break
            except requests.exceptions.ConnectionError:
                pass
            time.sleep(2)
            if i % 5 == 0:
                print(f"Still waiting... ({i*2}s)")

        if not healthy:
            print("Server failed to become healthy in time.")
            print("Server logs so far:")
            print(process.stdout.read())
            return False

        # Test non-streaming endpoint
        print("Testing /v1/audio/speech...")
        payload = {"input": "Hello world", "voice": "abigail"}
        resp = requests.post(f"{URL}/v1/audio/speech", json=payload)
        if resp.status_code == 200 and len(resp.content) > 0:
            print(f"Non-streaming test succeeded: {len(resp.content)} bytes")
        else:
            print(f"Non-streaming test failed: {resp.status_code}")
            return False

        # Test streaming endpoint
        print("Testing /v1/audio/speech/stream...")
        resp = requests.post(f"{URL}/v1/audio/speech/stream", json=payload, stream=True)
        if resp.status_code == 200:
            bytes_received = 0
            for chunk in resp.iter_content(chunk_size=1024):
                if chunk:
                    bytes_received += len(chunk)
            if bytes_received > 0:
                print(f"Streaming test succeeded: {bytes_received} bytes")
            else:
                print("Streaming test failed: no bytes received")
                return False
        else:
            print(f"Streaming test failed: {resp.status_code}")
            return False

        print("All tests passed!")
        return True

    finally:
        print("Stopping server...")
        process.terminate()
        process.wait()

if __name__ == "__main__":
    try:
        test_server()
    except Exception as e:
        print(f"Unexpected error during test: {e}")
        sys.exit(1)
