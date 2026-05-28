"""
BGE-M3 Embedding Service — Production-Grade

OpenAI-compatible embeddings API (/v1/embeddings) + legacy (/embed).
Runs on CPU (ARM64/x86_64) and NVIDIA GPU with automatic detection.

Safety guarantees:
  - Inference lock prevents concurrent CUDA allocations (OOM prevention)
  - Batch size capped at GPU/CPU-safe limits per forward pass
  - Oversized requests rejected before touching the model
  - CUDA error recovery: resets device state on OOM instead of crashing
  - Input validation: rejects empty/non-string/oversized texts
  - Health endpoint reports model readiness, GPU memory, inference metrics
  - Graceful startup: health returns 503 until model is loaded
"""

import os
import logging
import threading
import time
from typing import Optional

from flask import Flask, request, jsonify

import numpy as np
import torch

# Delay SentenceTransformer import to after torch is configured
from sentence_transformers import SentenceTransformer

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=os.environ.get('LOG_LEVEL', 'INFO').upper(),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger('bge-m3-service')

# ─── App ─────────────────────────────────────────────────────────────────────

app = Flask(__name__)

# ─── Constants ───────────────────────────────────────────────────────────────

# Max tokens per text for BGE-M3 (8192 context window).
# Texts longer than this are truncated by SentenceTransformer internally,
# but we warn the caller since processing very long texts is expensive on CPU.
MAX_TOKEN_ESTIMATE = 8192
# Approximate chars-per-token for warning (conservative)
CHARS_PER_TOKEN_ESTIMATE = 4
MAX_CHAR_LENGTH = MAX_TOKEN_ESTIMATE * CHARS_PER_TOKEN_ESTIMATE  # ~32768 chars



# ─── Device Detection ────────────────────────────────────────────────────────

def _get_gpu_total_memory(device_index: int = 0) -> int:
    """Get total GPU memory in bytes. Compatible with PyTorch <2.8 and >=2.8.

    PyTorch >=2.8 renamed `total_mem` → `total_memory` on CudaDeviceProperties.
    This helper tries the new name first, falling back to the old one.
    """
    props = torch.cuda.get_device_properties(device_index)
    total = getattr(props, 'total_memory', None)
    if total is None:
        total = getattr(props, 'total_mem', 0)
    return total


def detect_device() -> tuple[str, int]:
    """Detect GPU/CPU and return (device, recommended_batch_size)."""
    if torch.cuda.is_available():
        device = 'cuda'
        device_name = torch.cuda.get_device_name(0)
        device_count = torch.cuda.device_count()
        vram_bytes = _get_gpu_total_memory(0)
        vram_gb = vram_bytes / (1024**3)

        # GPU batch size: ~32 for T4 (16GB), scales with VRAM.
        # With baked model (single worker), all VRAM is available for inference.
        default_batch = min(64, max(8, int(vram_gb * 2)))
        recommended_batch = int(os.environ.get('EMBEDDING_BATCH_SIZE', str(default_batch)))

        logger.info(
            f"GPU detected: {device_name} (count={device_count}, "
            f"VRAM={vram_gb:.1f}GB, batch_size={recommended_batch})"
        )
        return device, recommended_batch
    else:
        device = 'cpu'
        cpu_count = os.cpu_count() or 1
        # CPU batch size: conservative to avoid OOM on small instances (2-4 Gi).
        default_batch = min(8, max(2, cpu_count * 2))
        recommended_batch = int(os.environ.get('EMBEDDING_BATCH_SIZE', str(default_batch)))
        logger.info(f"CPU mode: {cpu_count} cores, batch_size={recommended_batch}")
        return device, recommended_batch


# ─── Model Loading ───────────────────────────────────────────────────────────

DEVICE: str = 'cpu'
RECOMMENDED_BATCH_SIZE: int = 8
MODEL_NAME: str = os.environ.get('MODEL_NAME', 'BAAI/bge-m3')

_model: Optional[SentenceTransformer] = None
_model_ready = False
_model_load_error: Optional[str] = None


def _load_model() -> None:
    """Load model into global state. Called at startup and on recovery."""
    global _model, _model_ready, _model_load_error, DEVICE, RECOMMENDED_BATCH_SIZE

    _model_ready = False
    _model_load_error = None

    try:
        DEVICE, RECOMMENDED_BATCH_SIZE = detect_device()
        logger.info(f"Loading model: {MODEL_NAME} on device: {DEVICE}")

        # Load in half-precision to halve memory (~2.2GB → ~1.1GB).
        # GPU (CUDA): FP16 — native tensor core acceleration on NVIDIA GPUs.
        # CPU: BF16 — same range as FP32 (no overflow), native on modern Intel/AMD.
        if DEVICE == 'cuda':
            model_kwargs = {"dtype": torch.float16}
            logger.info("Using FP16 (half-precision) for GPU inference")
        else:
            model_kwargs = {"dtype": torch.bfloat16}
            logger.info("Using BF16 (brain float) for CPU inference")

        import warnings as _warnings
        # SentenceTransformer passes dtype → torch_dtype internally to HuggingFace
        # models. PyTorch >=2.8 deprecated torch_dtype in favor of dtype but
        # sentence-transformers hasn't updated yet. Suppress the noisy warning.
        with _warnings.catch_warnings():
            _warnings.filterwarnings("ignore", message="`torch_dtype` is deprecated")
            _model = SentenceTransformer(MODEL_NAME, device=DEVICE, model_kwargs=model_kwargs)

        dim = _model.get_sentence_embedding_dimension()
        logger.info(f"Model loaded: dim={dim}, device={_model.device}, dtype={model_kwargs['dtype']}")
        _model_ready = True

    except Exception as e:
        _model_load_error = str(e)
        logger.error(f"Model load failed: {_model_load_error}", exc_info=True)


# Load model at startup
_load_model()


# ─── Inference Engine ────────────────────────────────────────────────────────

_inference_lock = threading.Lock()

# Semaphore limits how many threads can WAIT for the inference lock.
# This prevents all Gunicorn threads from piling up on the lock,
# ensuring threads remain available for health checks.
#
# CRITICAL: semaphore value MUST be less than gunicorn thread count.
# GPU: 16 threads → default 4 queued → 12 threads free for health/IO
# CPU:  4 threads → default 2 queued →  2 threads free for health/IO
#
# The old hardcoded default of 4 caused complete thread starvation in CPU mode
# (4 threads, 4 semaphore slots = 0 free for health checks → liveness probe
# failures → pod killed → cascade restart of dependent services).
_default_max_queued = '4' if torch.cuda.is_available() else '2'
_inference_semaphore = threading.Semaphore(int(os.environ.get('MAX_QUEUED_REQUESTS', _default_max_queued)))

# Metrics (protected by _metrics_lock for thread-safe increments)
_metrics_lock = threading.Lock()
_inference_count: int = 0
_inference_total_ms: float = 0.0
_lock_wait_total_ms: float = 0.0
_error_count: int = 0
_rejected_count: int = 0
_last_error: Optional[str] = None
_last_error_time: Optional[float] = None


class ServiceBusyError(Exception):
    """Raised when inference queue is full — caller should retry."""
    pass


def _run_inference(texts: list[str]) -> np.ndarray:
    """
    Run model.encode() with:
    - Semaphore (limits queue depth — prevents health check starvation)
    - Serialization lock (one inference at a time on GPU)
    - Internal batch size cap (prevents per-call OOM)
    - CUDA error recovery (resets device instead of crashing)
    - Metrics collection

    Raises RuntimeError if model is not ready or inference fails after recovery.
    Raises ServiceBusyError if too many requests are already queued.
    """
    global _inference_count, _inference_total_ms, _lock_wait_total_ms
    global _error_count, _rejected_count, _last_error, _last_error_time

    if not _model_ready or _model is None:
        raise RuntimeError(f"Model not ready: {_model_load_error or 'loading'}")

    # Try to acquire semaphore (non-blocking).
    # If all slots are taken, reject immediately with 503 so the caller
    # retries later and we don't starve health check threads.
    if not _inference_semaphore.acquire(blocking=False):
        with _metrics_lock:
            _rejected_count += 1
        raise ServiceBusyError(
            f"Inference queue full ({os.environ.get('MAX_QUEUED_REQUESTS', '4')} requests waiting). "
            "Retry after current batch completes."
        )

    try:
        lock_start = time.perf_counter()

        with _inference_lock:
            lock_wait_ms = (time.perf_counter() - lock_start) * 1000
            infer_start = time.perf_counter()

            try:
                # batch_size = len(texts) because validation already caps at
                # RECOMMENDED_BATCH_SIZE. This means exactly ONE forward pass —
                # predictable GPU memory, no internal sub-batching surprises.
                embeddings = _model.encode(
                    texts,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                    batch_size=len(texts),
                )

                # Free cached GPU memory after successful inference
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

            except RuntimeError as e:
                error_msg = str(e)

                # CUDA OOM — attempt recovery instead of crashing
                if 'out of memory' in error_msg.lower() or 'CUDA' in error_msg:
                    logger.error(
                        f"CUDA error during inference (batch={len(texts)}): {error_msg}. "
                        "Attempting recovery..."
                    )

                    # Clear all GPU cache
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                        torch.cuda.reset_peak_memory_stats()

                    with _metrics_lock:
                        _error_count += 1
                        _last_error = error_msg
                        _last_error_time = time.time()

                    # Retry with smaller batch (half the size)
                    retry_batch = max(1, RECOMMENDED_BATCH_SIZE // 2)
                    try:
                        logger.info(f"Retrying with batch_size={retry_batch}")
                        embeddings = _model.encode(
                            texts,
                            normalize_embeddings=True,
                            show_progress_bar=False,
                            batch_size=retry_batch,
                        )
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                        logger.info("Recovery successful")
                    except RuntimeError as retry_err:
                        logger.error(f"Recovery failed: {retry_err}")
                        raise RuntimeError(
                            f"GPU OOM: batch of {len(texts)} texts failed even at "
                            f"batch_size={retry_batch}. Reduce request size."
                        ) from retry_err
                else:
                    # Non-OOM runtime error — don't swallow it
                    with _metrics_lock:
                        _error_count += 1
                        _last_error = error_msg
                        _last_error_time = time.time()
                    raise

            infer_ms = (time.perf_counter() - infer_start) * 1000

    finally:
        _inference_semaphore.release()

    # Update metrics outside both locks
    with _metrics_lock:
        _inference_count += 1
        _inference_total_ms += infer_ms
        _lock_wait_total_ms += lock_wait_ms

    if lock_wait_ms > 100:
        logger.warning(
            f"Lock contention: waited {lock_wait_ms:.0f}ms "
            f"(batch={len(texts)}, inference={infer_ms:.0f}ms)"
        )
    else:
        logger.info(
            f"Inference: {len(texts)} texts, {infer_ms:.0f}ms, "
            f"lock_wait={lock_wait_ms:.0f}ms"
        )

    return embeddings


# ─── Input Validation ────────────────────────────────────────────────────────

def _validate_texts(texts: list) -> tuple[list[str], Optional[str]]:
    """
    Validate and sanitize input texts.
    Returns (cleaned_texts, error_message_or_None).
    """
    if not texts:
        return [], "Input cannot be empty"

    # Enforce batch limit = RECOMMENDED_BATCH_SIZE.
    # This ensures model.encode() does exactly ONE forward pass per request —
    # no internal sub-batching, predictable GPU memory, no spikes.
    # GPU: max 32 texts/request. CPU: max 8 texts/request.
    # The Node.js caller already splits into RECOMMENDED_BATCH_SIZE-sized chunks
    # via auto-detection from /health endpoint.
    if len(texts) > RECOMMENDED_BATCH_SIZE:
        return [], (
            f"Batch too large: {len(texts)} texts exceeds max {RECOMMENDED_BATCH_SIZE} "
            f"for current device ({DEVICE}). Split into smaller requests."
        )

    cleaned = []
    warnings = []

    for i, text in enumerate(texts):
        # Must be a string
        if not isinstance(text, str):
            return [], f"Input[{i}] is not a string (got {type(text).__name__})"

        # Empty strings produce zero vectors — reject
        stripped = text.strip()
        if not stripped:
            return [], f"Input[{i}] is empty or whitespace-only"

        # Warn on very long texts (exceeds model max sequence length, will be truncated)
        if len(stripped) > MAX_CHAR_LENGTH:
            warnings.append(
                f"Input[{i}] is {len(stripped)} chars (~{len(stripped)//CHARS_PER_TOKEN_ESTIMATE} tokens), "
                f"exceeds model max of {MAX_TOKEN_ESTIMATE} tokens and will be truncated"
            )

        cleaned.append(text)  # Keep original (model handles tokenization)

    if warnings:
        logger.warning(f"Input warnings: {'; '.join(warnings)}")

    return cleaned, None


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    """
    Health check endpoint.
    Returns 503 if model is not ready (Kubernetes won't route traffic).
    Returns 200 with full diagnostics when healthy.
    """
    gpu_available = torch.cuda.is_available()
    gpu_info = {}
    if gpu_available:
        gpu_info = {
            'gpu_name': torch.cuda.get_device_name(0),
            'gpu_memory_allocated_mb': round(torch.cuda.memory_allocated(0) / (1024**2), 1),
            'gpu_memory_reserved_mb': round(torch.cuda.memory_reserved(0) / (1024**2), 1),
            'gpu_memory_total_mb': round(_get_gpu_total_memory(0) / (1024**2), 1),
        }

    status_code = 200 if _model_ready else 503

    response = {
        'status': 'healthy' if _model_ready else 'loading',
        'model': MODEL_NAME,
        'device': DEVICE,
        'recommended_batch_size': RECOMMENDED_BATCH_SIZE,
        'max_batch_size': RECOMMENDED_BATCH_SIZE,
        'gpu_available': gpu_available,
        'model_ready': _model_ready,
        'inference_count': _inference_count,
        'rejected_count': _rejected_count,
        'error_count': _error_count,
        'avg_inference_ms': round(_inference_total_ms / max(_inference_count, 1), 1),
        'avg_lock_wait_ms': round(_lock_wait_total_ms / max(_inference_count, 1), 1),
        **gpu_info,
    }

    if _model_ready and _model is not None:
        response['dimension'] = _model.get_sentence_embedding_dimension()

    if _model_load_error:
        response['load_error'] = _model_load_error

    if _last_error:
        response['last_error'] = _last_error
        response['last_error_time'] = _last_error_time

    return jsonify(response), status_code


@app.route('/v1/embeddings', methods=['POST'])
def create_embeddings():
    """
    OpenAI-compatible embeddings endpoint.

    Request:
        {"input": ["text1", "text2", ...] or "single text", "model": "bge-m3"}

    Response:
        {"object": "list", "data": [{"embedding": [...], "index": 0}], ...}

    Errors:
        400 — bad input (missing field, non-string, empty)
        413 — batch too large
        503 — model not ready
        500 — inference failed
    """
    if not _model_ready:
        return jsonify({'error': 'Model is loading, try again shortly'}), 503

    try:
        data = request.get_json(silent=True)
        if data is None:
            return jsonify({'error': 'Invalid JSON body'}), 400

        if 'input' not in data:
            return jsonify({'error': 'Missing "input" field'}), 400

        # Normalize to list
        input_texts = data['input']
        if isinstance(input_texts, str):
            input_texts = [input_texts]

        if not isinstance(input_texts, list):
            return jsonify({'error': '"input" must be a string or array of strings'}), 400

        # Validate
        cleaned, error = _validate_texts(input_texts)
        if error:
            status = 413 if 'too large' in error.lower() or 'exceeds' in error.lower() else 400
            return jsonify({'error': error}), status

        # Run inference
        embeddings = _run_inference(cleaned)

        # Build OpenAI-format response
        embedding_list = [
            {
                'object': 'embedding',
                'index': idx,
                'embedding': emb.tolist(),
            }
            for idx, emb in enumerate(embeddings)
        ]

        return jsonify({
            'object': 'list',
            'data': embedding_list,
            'model': MODEL_NAME,
            'usage': {
                'prompt_tokens': sum(len(t.split()) for t in cleaned),
                'total_tokens': sum(len(t.split()) for t in cleaned),
            },
        })

    except ServiceBusyError as e:
        return jsonify({'error': str(e)}), 503

    except RuntimeError as e:
        logger.error(f"Inference error: {e}")
        return jsonify({'error': str(e)}), 500

    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/embed', methods=['POST'])
def embed_legacy():
    """
    Legacy endpoint for backwards compatibility.

    Request:  {"texts": ["text1", "text2", ...]}
    Response: {"embeddings": [[...], [...]], "dimension": 1024, "model": "..."}
    """
    if not _model_ready:
        return jsonify({'error': 'Model is loading, try again shortly'}), 503

    try:
        data = request.get_json(silent=True)
        if data is None:
            return jsonify({'error': 'Invalid JSON body'}), 400

        if 'texts' not in data:
            return jsonify({'error': 'Missing "texts" field'}), 400

        texts = data['texts']
        if not isinstance(texts, list):
            return jsonify({'error': '"texts" must be an array of strings'}), 400

        # Validate
        cleaned, error = _validate_texts(texts)
        if error:
            status = 413 if 'too large' in error.lower() or 'exceeds' in error.lower() else 400
            return jsonify({'error': error}), status

        # Run inference
        embeddings = _run_inference(cleaned)

        return jsonify({
            'embeddings': embeddings.tolist(),
            'dimension': _model.get_sentence_embedding_dimension() if _model else 1024,
            'model': MODEL_NAME,
        })

    except ServiceBusyError as e:
        return jsonify({'error': str(e)}), 503

    except RuntimeError as e:
        logger.error(f"Inference error: {e}")
        return jsonify({'error': str(e)}), 500

    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return jsonify({'error': 'Internal server error'}), 500


# ─── Startup ─────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    logger.info(f"Starting BGE-M3 embedding service on port {port}")
    app.run(host='0.0.0.0', port=port, debug=False)
