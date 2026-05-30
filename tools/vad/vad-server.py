"""Silero VAD WebSocket server — Speech/silence detection via Silero VAD model.

WebSocket protocol:
  Client → binary Int16 PCM at 16kHz, 512-sample frames (1024 bytes)
  Server → JSON {"speech_prob": 0.92}

HTTP: GET /health → {"status": "ok"}
"""

import argparse
import asyncio
import json
import logging
import time

import numpy as np
import torch
from websockets.asyncio.server import serve
from silero_vad import load_silero_vad

logging.basicConfig(level=logging.INFO, format="[vad-server] %(message)s")
log = logging.getLogger(__name__)

SAMPLING_RATE = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2

parser = argparse.ArgumentParser(description="Silero VAD WebSocket Server")
parser.add_argument("--port", type=int, default=8125, help="WebSocket port")
parser.add_argument("--device", default="cpu", help="Device: cpu or cuda")
parser.add_argument("--onnx", action="store_true", help="Use ONNX model (faster CPU)")
args = parser.parse_args()

device = args.device
if device == "cuda" and not torch.cuda.is_available():
	log.warning("CUDA not available, falling back to CPU")
	device = "cpu"

log.info("Loading Silero VAD model (device=%s)...", device)
t0 = time.time()

model = load_silero_vad(onnx=args.onnx)
model = model.to(device)
model.eval()

log.info("Silero VAD loaded in %.1fs (onnx=%s)", time.time() - t0, args.onnx)


def detect_speech(pcm_float32: torch.Tensor) -> float:
	with torch.no_grad():
		prob = model(pcm_float32, SAMPLING_RATE).item()
	return prob


async def handle_health(websocket):
	"""Minimal HTTP health-check handler."""
	request = await websocket.recv()
	if isinstance(request, str) and request.startswith("GET /health"):
		response = (
			"HTTP/1.1 200 OK\r\n"
			"Content-Type: application/json\r\n"
			"Connection: close\r\n"
			"\r\n"
			'{"status":"ok","model":"silero-vad","device":"' + device + '"}'
		)
		await websocket.send(response)
	await websocket.close()


async def handle_vad(websocket):
	log.info("VAD client connected")
	pcm_accum = bytearray()
	try:
		async for message in websocket:
			if not isinstance(message, bytes):
				continue
			pcm_accum.extend(message)
			while len(pcm_accum) >= FRAME_BYTES:
				frame = pcm_accum[:FRAME_BYTES]
				pcm_accum = pcm_accum[FRAME_BYTES:]
				pcm = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
				tensor = torch.from_numpy(pcm).float().to(device)
				prob = detect_speech(tensor)
				await websocket.send(json.dumps({"speech_prob": round(prob, 4)}))
	except Exception:
		pass
	finally:
		log.info("VAD client disconnected")


async def main():
	async def process_request(connection, request):
		"""Handle HTTP health check at the HTTP layer, before WebSocket upgrade."""
		if request.path == "/health":
			import http
			body = json.dumps({"status": "ok", "model": "silero-vad", "device": device})
			response = connection.respond(http.HTTPStatus.OK, body)
			response.headers["Content-Type"] = "application/json"
			return response

	async def route(websocket):
		path = websocket.request.path if hasattr(websocket, "request") else "/"
		if path == "/health":
			await handle_health(websocket)
		else:
			await handle_vad(websocket)

	async with serve(route, "127.0.0.1", args.port, process_request=process_request) as server:
		log.info("VAD server listening on ws://127.0.0.1:%d", args.port)
		await asyncio.get_running_loop().create_future()


if __name__ == "__main__":
	asyncio.run(main())
