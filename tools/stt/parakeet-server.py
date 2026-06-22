"""Parakeet-TDT-0.6B STT server — NVIDIA NeMo ASR sidecar.

Endpoints:
  GET  /health       → {"status":"ok","model":"parakeet-tdt-0.6b-v3","device":"cuda"}
  POST /transcribe   → multipart WAV file in, {"text":"...","ok":true} out

Loads model once at startup. Runs on RME_PARAKEET_PORT (default 8127).
Device from RME_PARAKEET_DEVICE (default cuda). FP32 only (Pascal safe).
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
import io
import tempfile
import traceback
from pathlib import Path

import torch
import numpy as np
import soundfile as sf
from aiohttp import web

_ffmpeg_bin = Path(__file__).resolve().parent.parent / "voice" / "ffmpeg" / "bin"
if _ffmpeg_bin.is_dir():
	os.environ["PATH"] = str(_ffmpeg_bin) + os.pathsep + os.environ.get("PATH", "")
	_ffmpeg_exe = _ffmpeg_bin / "ffmpeg.exe"
	os.environ["FFMPEG_BINARY"] = str(_ffmpeg_exe) if _ffmpeg_exe.is_file() else "ffmpeg"
	os.environ["FFPROBE_BINARY"] = str(_ffmpeg_bin / "ffprobe.exe") if (_ffmpeg_bin / "ffprobe.exe").is_file() else "ffprobe"

logging.basicConfig(level=logging.INFO, format="[parakeet] %(message)s")
log = logging.getLogger(__name__)

parser = argparse.ArgumentParser(description="Parakeet-TDT STT Server")
parser.add_argument("--port", type=int, default=int(os.environ.get("RME_PARAKEET_PORT", "8127")),
	help="Port to listen on")
parser.add_argument("--device", default=os.environ.get("RME_PARAKEET_DEVICE", "cuda"),
	help="Device: cuda or cpu")
parser.add_argument("--model", default=os.environ.get("RME_PARAKEET_MODEL", "parakeet-tdt-0.6b-v2"),
	help="NeMo ASR model repo id")
args = parser.parse_args()

device = args.device
if device == "cuda" and not torch.cuda.is_available():
	log.warning("CUDA not available, falling back to CPU")
	device = "cpu"

model_name = args.model
if "/" not in model_name:
	model_name = "nvidia/" + model_name

log.info("Loading Parakeet model %s (device=%s, fp32)...", model_name, device)
t0 = time.time()

from nemo.collections.asr.models import ASRModel

model = ASRModel.from_pretrained(model_name)
model = model.to(device)
model.eval()
if hasattr(model, "preprocessor"):
	model.preprocessor.featurizer.dither = 0.0
	model.preprocessor.featurizer.pad_to = 0

load_s = time.time() - t0
log.info("Parakeet loaded in %.1fs on %s", load_s, device)

inference_lock = asyncio.Lock()


async def handle_health(request):
	return web.json_response({
		"status": "ok",
		"model": model_name,
		"device": device,
	})


async def handle_transcribe(request):
	t0 = time.time()
	tmp_path = None
	try:
		reader = await request.multipart()
		field = await reader.next()
		if field is None:
			return web.json_response({"ok": False, "error": "No audio file in request"}, status=400)

		data = b""
		while True:
			chunk = await field.read_chunk(65536)
			if not chunk:
				break
			data += chunk

		if len(data) < 100:
			return web.json_response({"ok": False, "error": "Audio too short (less than 100 bytes)"}, status=400)

		wav_io = io.BytesIO(data)
		audio_np, sr = sf.read(wav_io, dtype="float32")
		if audio_np.ndim > 1:
			audio_np = audio_np.mean(axis=1)

		if sr != 16000:
			log.warning("Resampling from %d Hz to 16000 Hz", sr)
			import scipy.signal
			num_samples = int(len(audio_np) * 16000 / sr)
			audio_np = scipy.signal.resample(audio_np, num_samples).astype(np.float32)
			sr = 16000

		duration_s = len(audio_np) / 16000
		if duration_s < 0.3:
			return web.json_response({"ok": False, "error": "Audio too short (< 0.3s)"}, status=400)

		tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
		os.close(tmp_fd)
		sf.write(tmp_path, audio_np, 16000, subtype="PCM_16")

		async with inference_lock:
			with torch.no_grad():
				hypotheses = model.transcribe([tmp_path], batch_size=1)

		if isinstance(hypotheses, list) and len(hypotheses) > 0:
			h0 = hypotheses[0]
			if isinstance(h0, str):
				text = h0.strip()
			elif hasattr(h0, "text"):
				text = str(h0.text).strip()
			else:
				text = str(h0).strip()
		else:
			text = str(hypotheses).strip()

		total_ms = (time.time() - t0) * 1000
		log.info("transcribed %.1fs audio in %.0f ms → \"%s\"", duration_s, total_ms, text[:120])
		return web.json_response({"ok": True, "text": text, "duration_s": round(duration_s, 2), "ms": round(total_ms)})

	except Exception:
		log.exception("Transcription error")
		return web.json_response({"ok": False, "error": traceback.format_exc()}, status=500)
	finally:
		if tmp_path:
			try:
				os.unlink(tmp_path)
			except OSError:
				pass


async def main():
	app = web.Application()
	app.router.add_get("/health", handle_health)
	app.router.add_post("/transcribe", handle_transcribe)

	runner = web.AppRunner(app)
	await runner.setup()
	site = web.TCPSite(runner, "127.0.0.1", args.port)
	await site.start()

	log.info("Parakeet server listening on http://127.0.0.1:%d", args.port)

	stop_event = asyncio.Event()

	def _shutdown_handler(sig, frame):
		log.info("Received signal %s, shutting down...", sig)
		stop_event.set()

	signal.signal(signal.SIGTERM, _shutdown_handler)
	signal.signal(signal.SIGINT, _shutdown_handler)

	await stop_event.wait()

	log.info("Shutting down Parakeet server...")
	await runner.cleanup()
	if hasattr(model, "cpu"):
		model.cpu()
	del model
	if device == "cuda":
		torch.cuda.empty_cache()
	log.info("Parakeet server shut down cleanly")


if __name__ == "__main__":
	asyncio.run(main())
