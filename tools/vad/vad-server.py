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
# Quiet websockets per-connection INFO logs. The /health poll returns HTTP 200
# instead of upgrading, so websockets logs it as "connection rejected (200 OK)".
# Harmless noise; our own [vad-server] diagnostics use the __main__ logger.
logging.getLogger("websockets.server").setLevel(logging.WARNING)

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
	frame_count = 0
	_last_log_at = time.time()
	try:
		async for message in websocket:
			if not isinstance(message, bytes):
				continue
			pcm_accum.extend(message)
			while len(pcm_accum) >= FRAME_BYTES:
				frame = pcm_accum[:FRAME_BYTES]
				pcm_accum = pcm_accum[FRAME_BYTES:]
				frame_count += 1
				try:
					pcm = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
					# Amplitude diagnostics: log RMS/min/max of the raw int16 frame
					pcm_int16 = np.frombuffer(frame, dtype=np.int16)
					abs_max = int(np.max(np.abs(pcm_int16)))
					rms_int = int(np.sqrt(np.mean(pcm_int16.astype(np.float64) ** 2)))
					if _last_log_at and time.time() - _last_log_at >= 5.0:
						log.info("VAD frame: count=%d int16_rms=%d int16_peak=%d float_rms=%.4f",
							frame_count, rms_int, abs_max, float(np.sqrt(np.mean(pcm ** 2))))
						_last_log_at = time.time()
					tensor = torch.from_numpy(pcm).float().to(device)
					prob = detect_speech(tensor)
					await websocket.send(json.dumps({"speech_prob": round(prob, 4)}))
				except Exception as frame_err:
					if frame_err.__class__.__name__.startswith("ConnectionClosed"):
						raise
					log.exception("VAD frame %d failed; keeping client connected", frame_count)
					try:
						if device == "cuda":
							torch.cuda.empty_cache()
					except Exception:
						pass
					continue
	except Exception as loop_err:
		if loop_err.__class__.__name__.startswith("ConnectionClosed"):
			log.info("VAD client connection closed")
		else:
			log.exception("VAD connection loop ended with error")
	finally:
		log.info("VAD client disconnected")


async def main():
	async def process_request(connection, request):
		"""Handle HTTP health check at the HTTP layer, before WebSocket upgrade."""
		try:
			log.info("process_request: path=%s", request.path)
			if request.path == "/health":
				import http
				body = json.dumps({"status": "ok", "model": "silero-vad", "device": device})
				response = connection.respond(http.HTTPStatus.OK, body)
				response.headers["Content-Type"] = "application/json"
				return response
		except Exception as e:
			log.warning("process_request error: %s", e)
		# Explicitly return None to allow WebSocket upgrade
		return None

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
