"""Chatterbox-Turbo TTS server — OpenAI-compatible /v1/audio/speech endpoint.

Usage:
    pip install -r tools/tts/requirements.txt
    python tools/tts/chatterbox-server.py [--port 8123] [--device auto]

The device auto-detects CUDA, then MPS, then falls back to CPU.
"""

import argparse
import io
import logging
import os
import sys
import time

logging.basicConfig(level=logging.INFO, format="[chatterbox] %(message)s")
log = logging.getLogger(__name__)

parser = argparse.ArgumentParser(description="Chatterbox-Turbo TTS server")
parser.add_argument("--port", type=int, default=8123, help="Port to listen on")
parser.add_argument("--device", default="auto", help="Device: cuda, cpu, auto")
parser.add_argument("--model", default="turbo", choices=["turbo", "original", "multilingual"])
args = parser.parse_args()

# Resolve device
device = args.device
if device == "auto":
    import torch
    if torch.cuda.is_available():
        device = "cuda"
        log.info("CUDA detected")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
        log.info("MPS detected")
    else:
        device = "cpu"
        log.info("No GPU, using CPU")

log.info("Loading Chatterbox model (device=%s model=%s)...", device, args.model)
sys.stdout.flush()
t0 = time.time()

    model = None
    sample_rate = 24000

    # Prefer full Chatterbox model for expressive/emotional range
    try:
        from chatterbox.tts import ChatterboxTTS
        model = ChatterboxTTS.from_pretrained(device=device)
        sample_rate = getattr(model, "sr", getattr(model, "sample_rate", 24000))
        log.info("Chatterbox (full) loaded in %.1fs, sr=%d", time.time() - t0, sample_rate)
    except Exception:
        # Fallback: try turbo variant if available
        try:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            model = ChatterboxTurboTTS.from_pretrained(device=device)
            sample_rate = getattr(model, "sr", 24000)
            log.info("Chatterbox-Turbo loaded in %.1fs, sr=%d", time.time() - t0, sample_rate)
        except Exception as e:
            log.error("Could not load any Chatterbox TTS implementation: %s", str(e))
            log.error("Run: pip install -r tools/tts/requirements.txt")
            sys.exit(1)

model_sample_rate = getattr(model, "sr", getattr(model, "sample_rate", 24000))
log.info("Model sample rate: %d", model_sample_rate)

# Patch norm_loudness to preserve float32 (pyloudnorm internally converts to float64)
import numpy as _np
model.norm_loudness = lambda wav, sr: wav.astype(_np.float32) if hasattr(wav, 'astype') else wav.float()

# FastAPI server
from fastapi import FastAPI, Response
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="Chatterbox TTS")


OUTPUT_SR = 48000
VOICE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices")
VOICE_MAP = {
    "aaron": os.path.join(VOICE_DIR, "aaron.wav"),
    "andy": os.path.join(VOICE_DIR, "andy.wav"),
    "abigail": os.path.join(VOICE_DIR, "abigail.wav"),
    "lucy": os.path.join(VOICE_DIR, "lucy.wav"),
}

# Cache for voice conditionals so we don't re-extract on every request
_COND_CACHE = {}


class TTSRequest(BaseModel):
    input: str
    voice: str = "abigail"
    model: str = "tts-1"
    exaggeration: float = 0.35
    cfg_weight: float = 0.55


@app.post("/v1/audio/speech")
async def speech(req: TTSRequest):
    import soundfile as sf
    kwargs = dict(
        exaggeration=req.exaggeration,
        cfg_weight=req.cfg_weight,
    )
    ref_path = VOICE_MAP.get(req.voice)
    if not (ref_path and os.path.isfile(ref_path)):
        if req.voice and os.path.isfile(req.voice):
            ref_path = req.voice
    if ref_path and os.path.isfile(ref_path):
        if ref_path not in _COND_CACHE:
            log.info("Preparing conditionals for voice from %s", ref_path)
            model.prepare_conditionals(ref_path, exaggeration=req.exaggeration)
            _COND_CACHE[ref_path] = model.conds
        else:
            model.conds = _COND_CACHE[ref_path]
    wav = model.generate(req.input, **kwargs)
    if isinstance(wav, tuple):
        wav = wav[0]
    arr = wav.cpu().numpy() if hasattr(wav, "cpu") else wav
    if arr.ndim > 1:
        arr = arr.squeeze()
    # Resample to 48kHz preserving float32
    if model_sample_rate != OUTPUT_SR:
        import librosa as _lb
        arr = _lb.resample(arr, orig_sr=model_sample_rate, target_sr=OUTPUT_SR).astype(_np.float32)
    buf = io.BytesIO()
    sf.write(buf, arr, OUTPUT_SR, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
