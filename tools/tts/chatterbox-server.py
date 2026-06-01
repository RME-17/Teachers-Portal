"""Chatterbox TTS server — Streaming-capable, hybrid CPU/GPU support.
Supports /v1/audio/speech (full WAV) and /v1/audio/speech/stream (PCM chunks).
"""

import argparse
import io
import logging
import os
import sys
import time
import asyncio
from typing import Generator

# --- Optional dependency shim ---
# chatterbox's base model imports a top-level `perth` module for watermarking.
# In some environments this resolves but exposes `PerthImplicitWatermarker=None`,
# which crashes model init. We provide a no-op fallback so synthesis can proceed.
try:
	import perth as _perth  # type: ignore
except Exception:
	_perth = None
if _perth is None or getattr(_perth, "PerthImplicitWatermarker", None) is None or not callable(getattr(_perth, "PerthImplicitWatermarker", None)):
	import types as _types
	_perth_mod = _types.ModuleType("perth")
	class PerthImplicitWatermarker:  # noqa: N801
		def __init__(self, *args, **kwargs):
			pass
		def apply_watermark(self, wav, sample_rate=None, **kwargs):
			return wav
	_perth_mod.PerthImplicitWatermarker = PerthImplicitWatermarker
	sys.modules["perth"] = _perth_mod

# --- Tuning and Optimizations ---
# Set thread counts to physical core count - 1 to avoid CPU saturation
import multiprocessing
cores = multiprocessing.cpu_count()
os.environ["OMP_NUM_THREADS"] = str(max(1, cores - 1))
os.environ["MKL_NUM_THREADS"] = str(max(1, cores - 1))
# Reduce VRAM fragmentation
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
# Ensure async CUDA launches
os.environ["CUDA_LAUNCH_BLOCKING"] = "0"

import torch
import numpy as np
import soundfile as sf
import traceback
try:
    import psutil
    HAS_PSUTIL = True
except Exception:
    psutil = None
    HAS_PSUTIL = False
from fastapi import FastAPI, Response, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

try:
    import pynvml
    pynvml.nvmlInit()
    HAS_NVML = True
except Exception:
    HAS_NVML = False

if not HAS_PSUTIL:
    log = logging.getLogger(__name__)
    logging.basicConfig(level=logging.WARNING, format="[chatterbox] %(message)s")
    log.warning("psutil not available; resource monitoring will be limited. Run: python -m pip install psutil")

log = logging.getLogger(__name__)

logging.basicConfig(level=logging.INFO, format="[chatterbox] %(message)s")
log = logging.getLogger(__name__)

parser = argparse.ArgumentParser(description="Chatterbox TTS Streaming Server")
parser.add_argument("--port", type=int, default=8123, help="Port to listen on")
parser.add_argument("--device", default="auto", help="Device: cuda, cpu, auto")
parser.add_argument("--model", default="turbo", help="Model: turbo (fast), original (full quality, better prosody)")
parser.add_argument("--voice-ref", default=None, help="Path to voice reference WAV")
parser.add_argument("--default-exaggeration", type=float, default=0.5, help="Default exaggeration")
args = parser.parse_args()

# Import ChatterboxTTS based on model selection
model_name = args.model.lower()
if model_name == "original":
    try:
        from chatterbox.tts import ChatterboxTTS as ChatterboxTTS
    except ImportError as e:
        logging.error("Could not import ChatterboxTTS (base model): %s", e)
        sys.exit(1)
else:
    try:
        from chatterbox.tts_turbo import ChatterboxTurboTTS as ChatterboxTTS
    except ImportError as e:
        logging.error("Could not import ChatterboxTurboTTS: %s", e)
        sys.exit(1)

# Resolve device preference (target) but always load weights to CPU first to avoid
# OOMs when loading large models. We'll then move the T3 component to GPU if
# CUDA is available and the user requested it. This keeps VRAM usage small.
target_device = args.device
if target_device == "auto":
    target_device = "cuda" if torch.cuda.is_available() else "cpu"

if target_device == "cuda":
    log.info("Target device=cuda (CUDA available=%s)", torch.cuda.is_available())
else:
    log.info("Target device=%s", target_device)

# Always load model weights on CPU first
log.info("Loading Chatterbox model (load_device=cpu)...")
t0 = time.time()
try:
    model = ChatterboxTTS.from_pretrained(device="cpu")
    sample_rate = model.sr
    log.info("Chatterbox loaded in %.1fs, sr=%d", time.time() - t0, sample_rate)
except Exception as e:
    log.exception("Could not load Chatterbox TTS: %s", e)
    sys.exit(1)

# If the user requested CUDA and it is available, move parts to GPU in a hybrid map
if target_device == "cuda" and torch.cuda.is_available():
    try:
        # Move the autoregressive T3 to GPU in fp32 and keep the vocoder on CPU
        # Put T3 on CUDA (fp16) and S3Gen on CUDA float32 (fp16 T3 doubles throughput)
        model.t3 = model.t3.to("cuda").half()
        # S3Gen uses ops that do not support fp16 (e.g. reflection_pad1d),
        # so keep S3Gen weights in float32 on CUDA and ensure its internal
        # dtype flag is float32.
        model.s3gen = model.s3gen.to("cuda").float()
        try:
            setattr(model.s3gen, 'dtype', torch.float32)
        except Exception:
            pass
        # Wrap embed_ref to ensure any incoming tensors are cast to float32
        try:
            if hasattr(model.s3gen, 'embed_ref'):
                _orig_embed_ref = model.s3gen.embed_ref

                def _embed_ref_safe(*args, **kwargs):
                    new_args = []
                    for a in args:
                        try:
                            if isinstance(a, torch.Tensor):
                                # move tensors to CUDA float32 for s3gen
                                a = a.to('cuda', dtype=torch.float32)
                        except Exception:
                            pass
                        new_args.append(a)
                    for k, v in list(kwargs.items()):
                        try:
                            if isinstance(v, torch.Tensor):
                                kwargs[k] = v.to('cuda', dtype=torch.float32)
                        except Exception:
                            pass
                    if callable(_orig_embed_ref):
                        return _orig_embed_ref(*new_args, **kwargs)
                    return None

                model.s3gen.embed_ref = _embed_ref_safe
        except Exception:
            log.exception("Failed to wrap s3gen.embed_ref safely")

        model.device = "cuda"
        device = "cuda"
        log.info("Device map applied (block 1): T3 -> CUDA (fp16), S3Gen -> CUDA (float32)")
        # Add a debug wrapper to cond_enc.forward to inspect cond object at call-time
        try:
            import types
            if hasattr(model.t3, 'cond_enc') and hasattr(model.t3.cond_enc, 'forward') and callable(model.t3.cond_enc.forward):
                _orig_cond_enc_forward = model.t3.cond_enc.forward

                def _cond_enc_forward_debug(self, cond):
                    try:
                        attrs = [a for a in dir(cond) if not a.startswith('_')][:80]
                        info = []
                        for a in attrs:
                            try:
                                v = getattr(cond, a)
                                info.append((a, type(v).__name__, getattr(v, 'dtype', None), getattr(v, 'device', None)))
                            except Exception:
                                info.append((a, 'ERROR', None, None))
                        log.info("COND DEBUG: %s", info[:40])
                    except Exception:
                        log.exception("Failed to introspect cond object")
                    # Try to coerce common cond embeddings to the T3 param dtype/device
                    try:
                        try:
                            t3_param = next(model.t3.parameters())
                            target_dtype = getattr(t3_param, 'dtype', None)
                        except Exception:
                            target_dtype = None
                        if target_dtype is not None:
                            for name in ['speaker_emb', 'cond_prompt_speech_emb', 'prompt_speech_emb', 'speech_emb', 'emotion_adv']:
                                try:
                                    if hasattr(cond, name):
                                        v = getattr(cond, name)
                                        if isinstance(v, torch.Tensor):
                                            try:
                                                setattr(cond, name, v.to(device='cuda', dtype=target_dtype))
                                            except Exception:
                                                try:
                                                    setattr(cond, name, v.to('cuda'))
                                                except Exception:
                                                    pass
                                except Exception:
                                    pass
                            # Log post-cast dtypes for visibility
                            try:
                                post_info = []
                                for name in ['speaker_emb', 'cond_prompt_speech_emb', 'prompt_speech_emb', 'speech_emb', 'emotion_adv']:
                                    try:
                                        v = getattr(cond, name)
                                        post_info.append((name, type(v).__name__, getattr(v, 'dtype', None), getattr(v, 'device', None)))
                                    except Exception:
                                        post_info.append((name, 'ERROR', None, None))
                                log.info("COND POST-CAST: %s", post_info)
                            except Exception:
                                pass
                    except Exception:
                        pass
                    if callable(_orig_cond_enc_forward):
                        return _orig_cond_enc_forward(cond)
                    return cond

                model.t3.cond_enc.forward = types.MethodType(_cond_enc_forward_debug, model.t3.cond_enc)
        except Exception:
            log.exception("Failed to wrap cond_enc.forward for debugging")
    except Exception as e:
        log.warning("Hybrid device map failed: %s. Using CPU-only model.", e)
        device = "cpu"
else:
    device = "cpu"

# Hybrid Device Map & Optimizations
if device == "cuda":
    try:
        # Use fp16 for T3 on GPU (double throughput) and keep S3Gen float32 on GPU
        model.t3 = model.t3.to("cuda").half()
        model.s3gen = model.s3gen.to("cuda").float()
        try:
            setattr(model.s3gen, 'dtype', torch.float32)
        except Exception:
            pass

        # Limit KV-cache for VRAM efficiency (Approximate by modifying config if possible)
        if hasattr(model.t3, "hp"):
            # Note: Actual KV-cache limit depends on the implementation of T3.inference_turbo
            # We will set max_new_tokens to cap the total sequence length
            pass

        log.info("Device map applied (block 2): T3 -> CUDA (fp16), S3Gen -> CUDA (float32)")

        # Ensure embed_ref wrapper exists here as well
        try:
            if hasattr(model.s3gen, 'embed_ref') and not hasattr(model.s3gen, '_embed_ref_safe_wrapped'):
                _orig_embed_ref2 = model.s3gen.embed_ref

                def _embed_ref_safe2(*args, **kwargs):
                    new_args = []
                    for a in args:
                        try:
                            if isinstance(a, torch.Tensor):
                                a = a.to('cuda', dtype=torch.float32)
                        except Exception:
                            pass
                        new_args.append(a)
                    for k, v in list(kwargs.items()):
                        try:
                            if isinstance(v, torch.Tensor):
                                kwargs[k] = v.to('cuda', dtype=torch.float32)
                        except Exception:
                            pass
                    if callable(_orig_embed_ref2):
                        return _orig_embed_ref2(*new_args, **kwargs)
                    return None

                model.s3gen.embed_ref = _embed_ref_safe2
                setattr(model.s3gen, '_embed_ref_safe_wrapped', True)
        except Exception:
            log.exception("Failed to ensure s3gen.embed_ref wrapper in second block")

        # Also wrap speaker_encoder.inference to ensure inputs are on CUDA float32
        try:
            if hasattr(model.s3gen, 'speaker_encoder') and hasattr(model.s3gen.speaker_encoder, 'inference'):
                _orig_se_inference = model.s3gen.speaker_encoder.inference

                def _se_inference_safe(speech, *a, **kw):
                    try:
                        if isinstance(speech, torch.Tensor):
                            speech = speech.to('cuda', dtype=torch.float32)
                    except Exception:
                        pass
                    if callable(_orig_se_inference):
                        return _orig_se_inference(speech, *a, **kw)
                    return speech

                model.s3gen.speaker_encoder.inference = _se_inference_safe
        except Exception:
            log.exception("Failed to wrap speaker_encoder.inference")
    except Exception as e:
        log.warning("Hybrid device map failed: %s. Using single device.", e)

# Post-processing worker pool for audio encoding
from concurrent.futures import ThreadPoolExecutor
executor = ThreadPoolExecutor(max_workers=2)

# Cache for voice conditionals
_COND_CACHE = {}
_COND_DEBUG_DONE = False
DEFAULT_VOICE_REF = args.voice_ref or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "voices", "ryan.wav"
)

# --- Warmup synth to avoid cold-start on first real request ---
def _do_warmup_pass(label):
	t0 = time.time()
	try:
		if hasattr(model, 'generate'):
			model.generate("warmup test")
		elif hasattr(model, 'synthesize'):
			model.synthesize("warmup test")
		elif hasattr(model, 'tts'):
			model.tts("warmup test")
	except Exception:
		try:
			if hasattr(model, 'generate_stream'):
				for _ in model.generate_stream("warmup test"):
					pass
		except Exception:
			pass
	if device == "cuda":
		try:
			torch.cuda.synchronize()
		except Exception:
			pass
	elapsed = time.time() - t0
	log.info("warmup %s done %.0fms", label, elapsed * 1000)

try:
	log.info("Starting warmup synth (pass 1/2)...")
	_do_warmup_pass("1/2")
	log.info("Starting warmup synth (pass 2/2)...")
	_do_warmup_pass("2/2")
except Exception:
	log.exception("Warmup synth failed")

def _move_conds_to_device(conds, target_device):
    """Brute-force recursive: move every torch.Tensor in the conds object graph to target_device."""
    _move_recursive(conds, target_device, visited=set())

def _move_recursive(obj, target_device, visited, depth=0):
    if obj is None:
        return
    oid = id(obj)
    if oid in visited:
        return
    visited.add(oid)
    if isinstance(obj, torch.Tensor):
        return
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if isinstance(v, torch.Tensor):
                obj[k] = v.to(target_device)
            else:
                _move_recursive(v, target_device, visited, depth + 1)
        return
    if isinstance(obj, (list, tuple)):
        lst = list(obj)
        for i, v in enumerate(lst):
            if isinstance(v, torch.Tensor):
                lst[i] = v.to(target_device)
            else:
                _move_recursive(v, target_device, visited, depth + 1)
        return
    # Walk __dict__ first (stored attributes)
    d = getattr(obj, '__dict__', None)
    if d:
        for attr_name, val in list(d.items()):
            if isinstance(val, torch.Tensor):
                try:
                    setattr(obj, attr_name, val.to(target_device))
                    if depth <= 1:
                        log.info("[chatterbox] moved conds.%s to %s", attr_name, target_device)
                except Exception:
                    if depth <= 1:
                        log.warning("[chatterbox] FAILED moving conds.%s", attr_name)
            else:
                _move_recursive(val, target_device, visited, depth + 1)
    # Walk dir() for descriptor-based attributes
    for attr_name in dir(obj):
        if attr_name.startswith('_'):
            continue
        try:
            val = getattr(obj, attr_name)
        except Exception:
            continue
        if val is None or isinstance(val, (str, bytes, int, float, bool)):
            continue
        if isinstance(val, torch.Tensor):
            try:
                setattr(obj, attr_name, val.to(target_device))
                if depth <= 1:
                    log.info("[chatterbox] moved conds.%s (property) to %s", attr_name, target_device)
            except Exception:
                if depth <= 1:
                    log.info("[chatterbox] skipped conds.%s (read-only property)", attr_name)
        elif hasattr(val, '__dict__') or hasattr(val, '__slots__'):
            _move_recursive(val, target_device, visited, depth + 1)
        # Also walk objects that look like they might contain tensors
        elif hasattr(val, 'to') or hasattr(val, 'dtype') or hasattr(val, 'device'):
            _move_recursive(val, target_device, visited, depth + 1)
    for attr_name in dir(obj):
        if attr_name.startswith('_'):
            continue
        try:
            val = getattr(obj, attr_name)
        except Exception:
            continue
        if val is None or isinstance(val, (str, bytes, int, float, bool)):
            continue
        if isinstance(val, torch.Tensor):
            try:
                setattr(obj, attr_name, val.to(target_device))
            except Exception:
                pass
        elif hasattr(val, '__dict__'):
            _move_recursive(val, target_device, visited)

def get_conditionals(ref_path: str, exaggeration: float):
    """Load voice conditionals from ref_path.
    Returns model.conds on success, \"builtin\" to signal built-in default, None on error.
    Stores deep-copy in cache; restores by assigning the copy back whole."""
    import copy
    try:
        model_device = next(model.parameters()).device
    except Exception:
        model_device = torch.device("cpu")
    if ref_path not in _COND_CACHE:
        if not os.path.isfile(ref_path):
            log.info("[chatterbox] Jennifer voice via built-in default (ref file missing: %s)", ref_path)
            _COND_CACHE[ref_path] = "builtin"
            return "builtin"
        log.info("[chatterbox] Preparing conditionals ONCE for voice from %s", ref_path)
        prev_model_device = getattr(model, "device", None)
        try:
            model.device = "cpu"
            prep = getattr(model, "prepare_conditionals", None)
            if callable(prep):
                prep(ref_path, exaggeration=exaggeration)
            else:
                log.warning("prepare_conditionals is not callable")
                existing = getattr(model, "conds", None)
                if existing is None:
                    return None
        finally:
            if prev_model_device is not None:
                model.device = prev_model_device
        # Move live conds to model device immediately (prepare_conditionals ran on CPU)
        log.info("[chatterbox] Moving live conds to %s...", model_device)
        _move_conds_to_device(getattr(model, "conds", None), model_device)
        log.info("[chatterbox] Live conds moved to %s", model_device)
        # Deep-copy the FULL Conditionals object once (copy.deepcopy handles tensors natively)
        src = getattr(model, "conds", None)
        if src is None:
            log.error("[chatterbox] model.conds is None after prepare_conditionals")
            return None
        try:
            saved = copy.deepcopy(src)
            log.info("[chatterbox] Conditionals deep-copied to cache (type=%s)", type(src).__name__)
        except Exception as e:
            log.warning("[chatterbox] deepcopy failed: %s — falling back to per-call recompute", str(e))
            _COND_CACHE[ref_path] = src
            return src
        _COND_CACHE[ref_path] = saved

    cached = _COND_CACHE[ref_path]
    if cached == "builtin":
        return "builtin"

    # Restore from cache — assign reference (deep-copy only on first store, not per-chunk)
    if isinstance(cached, dict):
        # Stale dict format from old cache — clear and recompute
        _COND_CACHE.pop(ref_path, None)
        return get_conditionals(ref_path, exaggeration)
    try:
        model.conds = cached
    except Exception as e:
        log.warning("[chatterbox] conds restore failed: %s — recomputing", str(e))
        _COND_CACHE.pop(ref_path, None)
        return get_conditionals(ref_path, exaggeration)
    # Verify device matches model
    try:
        for attr_name in dir(model.conds):
            if attr_name.startswith('_'):
                continue
            val = getattr(model.conds, attr_name, None)
            if isinstance(val, torch.Tensor) and val.device != model_device:
                log.warning("[chatterbox] conds tensor %s on %s != %s — fixing", attr_name, val.device, model_device)
                _move_conds_to_device(model.conds, model_device)
                break
    except Exception:
        pass
    return model.conds


def _move_tensors_in_obj(obj, device):
    """Recursively move any torch.Tensor found in dict/list/tuple to target device."""
    try:
        if isinstance(obj, dict):
            for k, v in list(obj.items()):
                obj[k] = _move_tensors_in_obj(v, device)
            return obj
        elif isinstance(obj, (list, tuple)):
            moved = [ _move_tensors_in_obj(v, device) for v in obj ]
            return type(obj)(moved)
        # Numpy arrays -> torch tensors with appropriate dtype
        elif 'numpy' in str(type(obj)) or (('numpy' in globals() and isinstance(obj, numpy.ndarray)) if 'numpy' in globals() else False):
            try:
                import numpy as _np
                if isinstance(obj, _np.ndarray):
                    if _np.issubdtype(obj.dtype, _np.integer):
                        t = torch.from_numpy(obj).long()
                    else:
                        t = torch.from_numpy(obj).float()
                    return t.to(device)
            except Exception:
                try:
                    t = torch.from_numpy(obj)
                    return t.to(device)
                except Exception:
                    return obj
        # Plain python scalar numbers -> convert with explicit dtype
        elif isinstance(obj, bool):
            try:
                t = torch.tensor(int(obj), dtype=torch.long)
                return t.to(device)
            except Exception:
                return obj
        elif isinstance(obj, int):
            try:
                t = torch.tensor(obj, dtype=torch.long)
                return t.to(device)
            except Exception:
                return obj
        elif isinstance(obj, float):
            try:
                t = torch.tensor(obj, dtype=torch.float32)
                return t.to(device)
            except Exception:
                return obj
        elif isinstance(obj, (list,)) and len(obj) > 0 and all(isinstance(x, int) for x in obj):
            try:
                t = torch.tensor(obj, dtype=torch.long)
                return t.to(device)
            except Exception:
                return obj
        elif isinstance(obj, (list,)) and len(obj) > 0 and all(isinstance(x, (int, float)) for x in obj):
            try:
                t = torch.tensor(obj, dtype=torch.float32)
                return t.to(device)
            except Exception:
                return obj
        elif hasattr(obj, 'to') and hasattr(obj, 'device'):
            try:
                return obj.to(device)
            except Exception:
                return obj
        # If it's a custom object (Conditionals), try moving its attributes
        elif hasattr(obj, '__dict__'):
            try:
                for k, v in list(vars(obj).items()):
                    try:
                        setattr(obj, k, _move_tensors_in_obj(v, device))
                    except Exception:
                        pass
                return obj
            except Exception:
                return obj
        else:
            return obj
    except Exception:
        return obj


def _cast_tensors_in_obj(obj, device, dtype=None):
    """Recursively cast any torch.Tensor found in obj to the target device and dtype."""
    try:
        if isinstance(obj, dict):
            for k, v in list(obj.items()):
                obj[k] = _cast_tensors_in_obj(v, device, dtype)
            return obj
        elif isinstance(obj, (list, tuple)):
            moved = [ _cast_tensors_in_obj(v, device, dtype) for v in obj ]
            return type(obj)(moved)
        elif hasattr(obj, '__dict__'):
            try:
                for k, v in list(vars(obj).items()):
                    try:
                        setattr(obj, k, _cast_tensors_in_obj(v, device, dtype))
                    except Exception:
                        pass
                return obj
            except Exception:
                return obj
        elif isinstance(obj, torch.Tensor):
            try:
                if dtype is not None:
                    return obj.to(device=device, dtype=dtype)
                else:
                    return obj.to(device=device)
            except Exception:
                try:
                    return obj.to(device=device)
                except Exception:
                    return obj
        else:
            return obj
    except Exception:
        return obj


def _deep_cast_attrs(obj, device, dtype=None, max_depth=6):
    """Recursively walk objects using dir()/getattr and attempt to cast tensor-like attributes.
    This handles objects that don't expose __dict__ (e.g., classes using __slots__)."""
    seen = set()
    def walk(o, depth=0):
        if o is None or depth > max_depth:
            return
        oid = id(o)
        if oid in seen:
            return
        seen.add(oid)
        try:
            for a in dir(o):
                if a.startswith('_'):
                    continue
                try:
                    v = getattr(o, a)
                except Exception:
                    continue
                try:
                    if isinstance(v, torch.Tensor):
                        try:
                            if dtype is not None:
                                setattr(o, a, v.to(device=device, dtype=dtype))
                            else:
                                setattr(o, a, v.to(device=device))
                            continue
                        except Exception:
                            try:
                                setattr(o, a, v.to(device=device))
                                continue
                            except Exception:
                                pass
                    # numpy arrays / lists
                    if 'numpy' in str(type(v)) or isinstance(v, (list, tuple)):
                        try:
                            t = torch.tensor(v)
                            if dtype is not None:
                                t = t.to(device=device, dtype=dtype)
                            else:
                                t = t.to(device=device)
                            try:
                                setattr(o, a, t)
                                continue
                            except Exception:
                                pass
                        except Exception:
                            pass
                    # recurse into nested objects
                    if hasattr(v, '__class__') and not isinstance(v, (str, bytes, int, float, bool)):
                        walk(v, depth + 1)
                except Exception:
                    continue
        except Exception:
            return
    try:
        walk(obj, 0)
    except Exception:
        pass


def _dump_conds_summary(obj, max_items=50):
    """Return a short summary of tensor-like objects inside conds for debugging."""
    out = []
    seen = 0
    def walk(o, path="root"):
        nonlocal seen
        if seen >= max_items:
            return
        try:
            if isinstance(o, dict):
                for k, v in o.items():
                    walk(v, path + f".{k}")
                    if seen >= max_items:
                        return
            elif isinstance(o, (list, tuple)):
                for i, v in enumerate(o[:5]):
                    walk(v, path + f"[{i}]")
                    if seen >= max_items:
                        return
            else:
                if hasattr(o, 'dtype') or hasattr(o, 'device') or 'numpy' in str(type(o)):
                    desc = None
                    try:
                        if hasattr(o, 'dtype') and hasattr(o, 'device'):
                            desc = f"{type(o).__name__} dtype={getattr(o,'dtype',None)} device={getattr(o,'device',None)}"
                        elif 'numpy' in str(type(o)):
                            desc = f"numpy array shape={getattr(o,'shape',None)} dtype={getattr(o,'dtype',None)}"
                        else:
                            desc = str(type(o))
                    except Exception:
                        desc = str(type(o))
                    out.append((path, desc))
                    seen += 1
        except Exception:
            return
    walk(obj)
    return out


def safe_generate(*args, **kwargs):
    """Call model.generate without silent CPU fallback — fail fast on errors."""
    try:
        return model.generate(*args, **kwargs)
    except Exception as e:
        # Log full traceback to console AND to temp file
        log.exception("safe_generate FAILED: %s", str(e))
        try:
            with open(os.path.join(os.getenv('LOCALAPPDATA', '.'), 'Temp', 'chatterbox_generate_error.log'), 'a', encoding='utf-8') as f:
                import traceback
                f.write('\n--- safe_generate error ---\n')
                f.write(f'Exception: {type(e).__name__}: {e}\n')
                traceback.print_exc(file=f)
        except Exception:
            pass
        raise

# FastAPI server
# Resource Governor State
metrics_state = {
    "gpuUtil": 0,
    "vramUsedMb": 0,
    "cpuUtil": 0,
    "rssMb": 0,
    "warnings": []
}

async def resource_monitor():
    global metrics_state
    while True:
        try:
            # CPU and Memory
            if HAS_PSUTIL and psutil is not None:
                cpu_util = psutil.cpu_percent()
                rss_mb = psutil.Process().memory_info().rss / (1024 * 1024)
            else:
                cpu_util = 0
                rss_mb = 0
            
            gpu_util = 0
            vram_used = 0
            if HAS_NVML:
                handle = pynvml.nvmlDeviceGetHandleByIndex(0)
                util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                gpu_util = util.gpu
                mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                vram_used = mem.used / (1024 * 1024)

            metrics_state.update({
                "gpuUtil": gpu_util,
                "vramUsedMb": vram_used,
                "cpuUtil": cpu_util,
                "rssMb": rss_mb,
            })

            if gpu_util > 90:
                metrics_state["warnings"].append(f"High GPU util: {gpu_util}%")
            if cpu_util > 90:
                metrics_state["warnings"].append(f"High CPU util: {cpu_util}%")
            
            if len(metrics_state["warnings"]) > 10:
                metrics_state["warnings"].pop(0)

        except Exception as e:
            log.error("Monitor error: %s", e)
        
        await asyncio.sleep(2)

app = FastAPI(title="Chatterbox TTS Streaming")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(resource_monitor())

@app.get("/metrics")
async def get_metrics():
    return metrics_state

class TTSRequest(BaseModel):
    input: str
    voice: str = "ryan-english"
    model: str = "tts-1"
    exaggeration: float = 0.35
    cfg_weight: float = 0.55
    temperature: float = 0.8

VOICE_MAP = {
    "jennifer-english": os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices", "jennifer.wav"),
    "ryan-english": os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices", "ryan.wav"),
}

@app.post("/v1/audio/speech")
async def speech(req: TTSRequest):
    """Non-streaming endpoint: returns full WAV."""
    try:
        ref_path = VOICE_MAP.get(req.voice) or DEFAULT_VOICE_REF
        conds = get_conditionals(ref_path, req.exaggeration)
        if conds is None:
            raise HTTPException(status_code=400, detail="Invalid voice reference")
        use_builtin = conds == "builtin"

        log.info("synth start chars=%d builtin=%s", len(req.input), use_builtin)

        # When using built-in voice, clear any stale conditionals from a prior reference
        if use_builtin:
            model.conds = None
        gpu_sample_before = 0
        vram_before = 0
        if HAS_NVML:
            try:
                handle = pynvml.nvmlDeviceGetHandleByIndex(0)
                gpu_sample_before = pynvml.nvmlDeviceGetUtilizationRates(handle).gpu
                vram_before = pynvml.nvmlDeviceGetMemoryInfo(handle).used // (1024 * 1024)
            except Exception:
                pass
        synth_t0 = time.time()

        # Safety: ensure conditionals are on model device (backstop for cache edge cases)
        if device == "cuda" and getattr(model, "conds", None) is not None:
            try:
                _move_conds_to_device(model.conds, torch.device("cuda"))
                # Verify: spot-check a key tensor
                t3cond = getattr(model.conds, 't3_cond', None) or getattr(model.conds, 'cond', None)
                if t3cond:
                    tok = getattr(t3cond, 'cond_prompt_speech_tokens', None)
                    if isinstance(tok, torch.Tensor):
                        log.info("[chatterbox] VERIFY cond_prompt_speech_tokens device=%s dtype=%s", tok.device, tok.dtype)
            except Exception as e:
                log.warning("[chatterbox] conds device verify failed: %s", str(e))

        # Use standard generate for full audio
        wav = safe_generate(
            req.input,
            exaggeration=req.exaggeration,
            cfg_weight=req.cfg_weight,
            temperature=req.temperature,
        )

        synth_elapsed_ms = (time.time() - synth_t0) * 1000
        gpu_after = 0
        if HAS_NVML:
            try:
                gpu_after = pynvml.nvmlDeviceGetUtilizationRates(pynvml.nvmlDeviceGetHandleByIndex(0)).gpu
            except Exception:
                pass
        log.info("synth done chars=%d device=%s t3_dtype=%s time=%dms gpu_before=%d%% gpu_after=%d%% vram=%dMB",
            len(req.input), device,
            str(getattr(getattr(model, 't3', None), 'dtype', '?')).split('.')[-1] if hasattr(model, 't3') else '?',
            int(synth_elapsed_ms), gpu_sample_before, gpu_after, vram_before)

        if device == "cuda":
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        if isinstance(wav, tuple):
            wav = wav[0]

        arr = wav.cpu().numpy() if hasattr(wav, "cpu") else wav
        if arr.ndim > 1:
            arr = arr.squeeze()

        buf = io.BytesIO()
        sf.write(buf, arr, sample_rate, format="WAV", subtype="PCM_16")
        return Response(content=buf.getvalue(), media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as e:
        # Log full traceback to aid debugging and return 500
        log.exception("/v1/audio/speech handler error: %s", e)
        # Also persist to a temp file for offline inspection
        try:
            with open(os.path.join(os.getenv('LOCALAPPDATA', '.'), 'Temp', 'chatterbox_route_error.log'), 'a', encoding='utf-8') as f:
                import traceback

                f.write('\n--- /v1/audio/speech error ---\n')
                traceback.print_exc(file=f)
        except Exception:
            pass
        # Return full traceback for debugging
        raise HTTPException(status_code=500, detail=traceback.format_exc())

@app.post("/v1/audio/speech/stream")
async def speech_stream(req: TTSRequest):
    """Streaming endpoint: returns raw PCM chunks (16-bit LE)."""
    try:
        ref_path = VOICE_MAP.get(req.voice) or DEFAULT_VOICE_REF
        conds = get_conditionals(ref_path, req.exaggeration)
        if conds is None:
            raise HTTPException(status_code=400, detail="Invalid voice reference")
        use_builtin = conds == "builtin"

        log.info("stream start chars=%d builtin=%s", len(req.input), use_builtin)

        # When using built-in voice, clear any stale conditionals from a prior reference
        if use_builtin:
            model.conds = None

        def stream_generator() -> Generator[bytes, None, None]:
            wav = None
            try:
                # Turbo model doesn't have generate_stream. 
                # We implement sentence-level streaming for low latency.
                import re
                sentences = re.split(r'([.!?]+)', req.input)
                # Recombine delimiters with sentences
                combined = []
                for i in range(0, len(sentences)-1, 2):
                    combined.append(sentences[i] + sentences[i+1])
                if len(sentences) % 2 == 1 and sentences[-1]:
                    combined.append(sentences[-1])

                for sentence in combined:
                    sentence = sentence.strip()
                    if not sentence:
                        continue
                    
                    # Generate full audio for this sentence (fast with Turbo)
                    # Ensure conds are on correct device for each sentence generation
                    if device == "cuda" and getattr(model, "conds", None) is not None:
                        try:
                            _move_tensors_in_obj(model.conds, "cuda")
                        except Exception:
                            log.warning("Failed to move conditionals to cuda for sentence")
                    try:
                        summary = _dump_conds_summary(getattr(model, 'conds', {}), max_items=10)
                        for p, s in summary:
                            log.info("stream cond: %s -> %s", p, s)
                    except Exception:
                        pass

                    wav = safe_generate(
                        sentence,
                        exaggeration=req.exaggeration,
                        cfg_weight=req.cfg_weight,
                        temperature=req.temperature,
                    )
                    
                    if device == "cuda":
                        try:
                            torch.cuda.empty_cache()
                        except Exception:
                            pass

                    if isinstance(wav, tuple):
                        wav = wav[0]

                    arr = wav.cpu().numpy() if hasattr(wav, "cpu") else wav
                    if arr.ndim > 1:
                        arr = arr.squeeze()
                    
                    # Convert to 16-bit PCM (little-endian)
                    pcm_data = (arr * 32767).astype(np.int16).tobytes()
                    yield pcm_data
            except Exception as e:
                log.exception("Streaming error: %s", e)
                try:
                    with open(os.path.join(os.getenv('LOCALAPPDATA', '.'), 'Temp', 'chatterbox_route_error.log'), 'a', encoding='utf-8') as f:
                        import traceback

                        f.write('\n--- /v1/audio/speech/stream error ---\n')
                        traceback.print_exc(file=f)
                except Exception:
                    pass
                yield b""

        return StreamingResponse(stream_generator(), media_type="audio/pcm")
    except HTTPException:
        raise
    except Exception as e:
        log.exception("/v1/audio/speech/stream handler error: %s", e)
        try:
            with open(os.path.join(os.getenv('LOCALAPPDATA', '.'), 'Temp', 'chatterbox_route_error.log'), 'a', encoding='utf-8') as f:
                import traceback

                f.write('\n--- /v1/audio/speech/stream top-level error ---\n')
                traceback.print_exc(file=f)
        except Exception:
            pass
        # Return full traceback for debugging
        raise HTTPException(status_code=500, detail=traceback.format_exc())

@app.get("/health")
async def health():
    return {"status": "ok", "model": "chatterbox-streaming", "device": device}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
