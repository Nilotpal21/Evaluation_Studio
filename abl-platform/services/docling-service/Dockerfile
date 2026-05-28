# Docling Service — multi-stage build (GPU-capable single image)
# Builder: compiles native extensions (fasttext C++) with build-essential
# Production: python:3.11-slim + CUDA 12.6/cuDNN via pip wheels
#
# GPU strategy: Single image that auto-detects GPU at runtime.
# - onnxruntime-gpu[cuda,cudnn] pulls NVIDIA pip wheels (no system CUDA needed)
# - PyTorch cu126 wheel includes CUDA runtime stubs
# - AcceleratorOptions(device=AUTO) picks CUDA → MPS → CPU in order
# - On CPU-only hosts, torch.cuda.is_available() → False, falls back to CPU

FROM python:3.11-slim AS builder

WORKDIR /app

# build-essential needed for fasttext C++ compilation (stays out of final image)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files — both manifest and lock so the install is reproducible
COPY pyproject.toml uv.lock ./

# Install production dependencies pinned to uv.lock (hash-verified)
# --no-emit-project excludes the local package (file:///app) from the export,
# which has no hash and would fail --require-hashes. The app code is copied later.
#
# CRITICAL — two flags work together to handle uv's override-dependencies:
#   cd /tmp — prevents uv from discovering pyproject.toml and re-applying
#             override-dependencies, which strips hashes from overridden packages
#             (causes "no hash provided for aiohttp==3.13.4")
#   --no-deps — prevents uv from re-resolving the dependency tree. Without this,
#               uv rejects override-pinned versions that fall outside upstream
#               constraints (e.g. transformers==5.0.0rc3 vs docling-ibm-models'
#               requirement for transformers>=5.4.dev0). The exported file is
#               already fully resolved by `uv export --frozen`, so re-resolution
#               is unnecessary and harmful.
RUN uv export --frozen --no-dev --no-emit-project --output-file /tmp/requirements-locked.txt && \
    cd /tmp && uv pip install --system --no-cache --no-deps --require-hashes -r /tmp/requirements-locked.txt

# Override torch AND torchvision with CUDA-capable wheels from the cu126 index
# AFTER the pyproject install. This replaces the CPU-only wheels with CUDA
# variants that include runtime stubs and cuDNN. Falls back to CPU when no GPU.
#
# CRITICAL: torchvision MUST be overridden alongside torch — otherwise the
# torchvision installed by docling (linked against CPU torch) has an ABI
# mismatch with CUDA torch, causing "operator torchvision::nms does not exist"
# at import time. torchvision 0.25.0 is the official match for torch 2.10.0
# (see https://github.com/pytorch/vision#installation).
#
# Pin versions to match uv.lock (torch==2.10.0, torchvision==0.25.0). Without
# pins, a rebuild could silently pull a newer torch from the cu126 index and
# break compatibility with docling / docling-ibm-models / accelerate.
# When bumping deps, update uv.lock AND these pins together.
#
# Also install onnxruntime-gpu with [cuda,cudnn] extras to pull NVIDIA pip
# wheels (nvidia-cuda-runtime-cu12, nvidia-cudnn-cu12) — no system CUDA needed.
# Why cu126 not cu124: torch 2.10.0 is not published on cu124 (max 2.6.0).
# cu126 has 2.10.0 and its CUDA 12.6 pip wheels are ABI-compatible with
# onnxruntime-gpu's nvidia-cuda-runtime-cu12~=12.0 requirement.
# UV_HTTP_TIMEOUT raised for CUDA wheel downloads (nvidia-cufft-cu12 ~191MB,
# nvidia-cudnn-cu12 ~674MB) which exceed uv's default 30s timeout on slower CI.
RUN UV_HTTP_TIMEOUT=300 uv pip install --system --no-cache --force-reinstall \
    "torch==2.10.0" "torchvision==0.25.0" --index-url https://download.pytorch.org/whl/cu126 && \
    UV_HTTP_TIMEOUT=300 uv pip install --system --no-cache "onnxruntime-gpu[cuda,cudnn]==1.23.2"

# Production stage — same python:3.11-slim base as builder.
# CUDA/cuDNN libraries are supplied as pip wheels (nvidia-cuda-runtime-cu12,
# nvidia-cudnn-cu12) pulled in by onnxruntime-gpu[cuda,cudnn] and by
# the PyTorch cu126 wheel — no NVIDIA base image needed.
# On CPU-only hosts, these libs are inert: torch and onnxruntime fall back to CPU.
FROM python:3.11-slim

WORKDIR /app

# Patch OS-level CVEs + install runtime system deps
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Python dependencies from builder and strip build tools
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
RUN rm -rf /usr/local/lib/python3.11/site-packages/pip* \
           /usr/local/lib/python3.11/site-packages/setuptools* \
           /usr/local/lib/python3.11/site-packages/wheel* \
           /usr/local/lib/python3.11/site-packages/_distutils_hack \
           /usr/local/lib/python3.11/site-packages/distutils-precedence.pth
COPY --from=builder /usr/local/bin/uvicorn /usr/local/bin/uvicorn

# ─── Pre-download ALL models at build time (Solution 1: Bake into image) ────
# Eliminates runtime downloads, PVC dependencies, and ReadWriteOnce conflicts.
# Each model is triggered by its first-use import pattern.
#
# CRITICAL: Set HF cache env vars BEFORE model downloads so they land in
# /opt/models/huggingface (persists in image layer). Without this, models go to
# /root/.cache/huggingface which is invisible to the runtime user.
# At runtime: HF_HOME stays the same (read-only model dir in image layer).
ENV HF_HOME=/opt/models/huggingface
ENV HF_HUB_CACHE=/opt/models/huggingface/hub
ENV TRANSFORMERS_CACHE=/opt/models/huggingface

# 1. RapidOCR models (detection + recognition, ~50 MB)
#    RapidOCR v3.x downloads on first use; without this the container fails
#    with "Read-only file system" when readOnlyRootFilesystem is enabled.
RUN python -c "from rapidocr import RapidOCR; RapidOCR()"

# 2. Docling models — TableFormer + Layout detection (~350 MB total)
#    Docling 2.92.0 uses TWO model repos:
#      - docling-project/docling-models (v2.3.0) — TableFormer table structure
#      - docling-project/docling-layout-heron (main) — Layout detection (Heron)
#
#    CRITICAL: DocumentConverter() constructor only registers model factories;
#    the actual download happens lazily on first .convert() call when
#    _init_models() → layout_factory.create_instance() → download_models()
#    triggers huggingface_hub.snapshot_download(). We must explicitly download
#    BOTH repos at build time, otherwise HF_HUB_OFFLINE=1 blocks runtime access.
#
#    Evidence from old working image (0b6598a) logs:
#      GET https://huggingface.co/api/models/docling-project/docling-layout-heron/revision/main "HTTP/1.1 200 OK"
#      GET https://huggingface.co/api/models/docling-project/docling-models/revision/v2.3.0 "HTTP/1.1 200 OK"
RUN python -c "\
from huggingface_hub import snapshot_download; \
import os; \
cache_dir = os.environ.get('HF_HUB_CACHE', '/opt/models/huggingface/hub'); \
print('Downloading docling-project/docling-models v2.3.0...'); \
snapshot_download('docling-project/docling-models', revision='v2.3.0', cache_dir=cache_dir); \
print('Downloading docling-project/docling-layout-heron (main)...'); \
snapshot_download('docling-project/docling-layout-heron', cache_dir=cache_dir); \
print('Docling models baked successfully: TableFormer + Layout-Heron') \
" && python -c "\
from docling.document_converter import DocumentConverter, PdfFormatOption; \
from docling.datamodel.base_models import InputFormat; \
from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode; \
pipeline = PdfPipelineOptions(); \
pipeline.do_table_structure = True; \
pipeline.table_structure_options.mode = TableFormerMode.ACCURATE; \
pipeline.do_ocr = True; \
converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline)}); \
print('Docling converter initialized successfully (verifies model cache)') \
"

# 3. Fasttext language identification model (lid.176.bin, ~126 MB)
#    Used by language_detector.py for quick language detection.
#    Downloads on first use to CWD — will fail on read-only filesystem.
#    Pre-download to a known location; language_detector.py reads from
#    FASTTEXT_LID_MODEL_PATH or defaults to /opt/models/fasttext/lid.176.bin.
RUN python -c "\
import urllib.request, os; \
url = 'https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin'; \
os.makedirs('/opt/models/fasttext', exist_ok=True); \
urllib.request.urlretrieve(url, '/opt/models/fasttext/lid.176.bin'); \
print('Fasttext lid.176.bin baked successfully') \
"

# Copy application code
COPY . .

# Create non-root user and pre-create cache directory
# /app/.cache is mounted as emptyDir at runtime for any transient writes
# /opt/models contains baked model weights (read-only at runtime)
RUN useradd -m -u 1001 docling && \
    mkdir -p /app/.cache && \
    chown -R docling:docling /app && \
    chown -R docling:docling /usr/local/lib/python3.11/site-packages/rapidocr/models && \
    chown -R docling:docling /opt/models

# Runtime environment:
# - XDG_CACHE_HOME=/app/.cache — mounted as writable emptyDir in K8s for
#   transient writes (torch compile cache, ONNX session cache, etc.)
# - HF_HUB_OFFLINE=1 — no network calls, no cache-miss writes to HF_HOME.
#   Models are served from /opt/models/huggingface (read-only image layer).
ENV XDG_CACHE_HOME=/app/.cache
ENV HF_HUB_OFFLINE=1
# tiktoken (used by tokenizer.py) downloads BPE encoding files on first call.
# Direct its cache to the writable emptyDir so it doesn't fail on read-only FS.
ENV TIKTOKEN_CACHE_DIR=/app/.cache/tiktoken

USER docling

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Worker count: auto-detected based on GPU/CPU at container startup.
#   GPU (T4/A10): 3 workers — fills CPU/GPU idle gaps during document processing.
#     CUDA is fork-safe with uvicorn because each worker initializes its own context
#     AFTER fork (detect_device() runs at module import time in each worker process).
#   CPU: 1 worker — avoids memory pressure on small instances (2-4 Gi).
CMD ["sh", "-c", "WORKERS=$(python -c \"import torch; print(3 if torch.cuda.is_available() else 1)\") && echo \"Docling starting: $WORKERS workers, device=$(python -c 'import torch; print(\\\"cuda\\\" if torch.cuda.is_available() else \\\"cpu\\\")')\" && exec uvicorn app:app --host 0.0.0.0 --port 8080 --workers $WORKERS"]
