# BGE-M3 Embedding Service — multi-stage build
# Builder: compiles native extensions (tokenizers, torch) with build-essential
# Production: slim runtime with only Python packages + curl

FROM python:3.11-slim AS builder

WORKDIR /app

# build-essential only in builder (369MB stays out of final image)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

# Copy project files
COPY pyproject.toml .
COPY requirements.lock .

# Install Python dependencies + gunicorn from lockfile (gets CPU torch)
RUN uv pip install --system --no-cache -r requirements.lock && \
    uv pip install --system --no-cache gunicorn

# Override torch with CUDA-capable wheel from the cu126 index AFTER the
# lockfile install. This replaces the CPU-only torch==2.8.0 with the cu126
# variant that includes CUDA runtime stubs and cuDNN. Falls back gracefully
# to CPU when no GPU device is present (torch.cuda.is_available() → False).
# Pin to match requirements.lock (torch==2.8.0). Without the pin, a rebuild
# could silently pull a newer torch from the cu126 index and break
# compatibility with sentence-transformers / FlagEmbedding.
# Why cu126 not cu124: torch 2.8.0 is not published on cu124 (max 2.6.0).
# cu126 covers both 2.8.0 and 2.10.0, keeping both services on the same
# CUDA toolkit version.
# UV_HTTP_TIMEOUT raised for CUDA wheel downloads (~800MB torch + NVIDIA deps)
# which can exceed uv's default 30s timeout on slower CI networks.
RUN UV_HTTP_TIMEOUT=300 uv pip install --system --no-cache \
    "torch==2.8.0" --index-url https://download.pytorch.org/whl/cu126

# Production stage — no build tools
FROM python:3.11-slim

WORKDIR /app

# Patch OS-level CVEs + install curl for health checks
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled Python packages from builder and strip build tools
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
RUN rm -rf /usr/local/lib/python3.11/site-packages/pip* \
           /usr/local/lib/python3.11/site-packages/setuptools* \
           /usr/local/lib/python3.11/site-packages/wheel* \
           /usr/local/lib/python3.11/site-packages/_distutils_hack \
           /usr/local/lib/python3.11/site-packages/distutils-precedence.pth
COPY --from=builder /usr/local/bin/gunicorn /usr/local/bin/gunicorn

# Copy service code
COPY app.py .

# Create non-root user (PVC no longer needed — models baked into image)
RUN useradd -m -u 1001 bge && \
    mkdir -p /home/bge/.cache && \
    chown -R bge:bge /app /home/bge/.cache

# Point HuggingFace cache to the baked model directory.
# Models are pre-downloaded at build time below — no runtime download needed.
# HF_HOME is the canonical env var (TRANSFORMERS_CACHE is deprecated in v5).
ENV HF_HOME=/opt/models/huggingface
ENV SENTENCE_TRANSFORMERS_HOME=/opt/models/huggingface
# Gunicorn writes a .gunicorn control socket to $HOME — if the root filesystem
# is read-only (K8s securityContext), this fails. /tmp is always writable.
ENV HOME=/tmp

# ─── Pre-download model at build time (Solution 1: Bake into image) ──────
# Downloads BAAI/bge-m3 (~2.5 GB) into /opt/models/huggingface so that:
#   1. No PVC needed — eliminates ReadWriteOnce volume conflicts with replicas
#   2. No runtime download — pod starts in ~30s (RAM load only)
#   3. No network dependency — works in air-gapped/private clusters
#   4. Immutable — model version pinned to image tag
#
# chown after download so the non-root user can read model files.
# HF_HUB_OFFLINE set AFTER download — must be online to fetch from HuggingFace.
RUN mkdir -p /opt/models/huggingface && \
    python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3', cache_folder='/opt/models/huggingface')" && \
    echo "Model baked successfully: BAAI/bge-m3" && \
    chown -R bge:bge /opt/models/huggingface

# HF_HUB_OFFLINE=1 — set AFTER model download. Tells huggingface_hub to never
# reach out to the network and never write .no_exist/ cache metadata files.
# Without this, the hub logs "Permission denied" errors on read-only filesystem.
ENV HF_HUB_OFFLINE=1

USER bge

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 1 worker: CUDA is not fork-safe, multiple workers = multiple model copies = OOM.
# Threads: GPU mode (16) vs CPU mode (8), auto-detected at startup.
#   GPU: 16 threads — _inference_lock serializes GPU access, remaining threads
#     handle HTTP I/O (parsing, responding, health checks). Keeps GPU pipeline full.
#   CPU: 8 threads — inference holds the lock for seconds; remaining threads
#     must be free for health probes (K8s liveness) and HTTP I/O. With semaphore=2,
#     at most 2 threads block on inference, leaving 6 for health/readiness.
# 300s timeout: large batches on CPU can take minutes.
CMD ["sh", "-c", "DEVICE=$(python3 -c 'import torch; print(\"cuda\" if torch.cuda.is_available() else \"cpu\")') && THREADS=$(if [ \"$DEVICE\" = \"cuda\" ]; then echo 16; else echo 4; fi) && echo \"BGE-M3 starting: 1 worker, $THREADS threads, device=$DEVICE\" && exec gunicorn --bind 0.0.0.0:8000 --workers 1 --threads $THREADS --timeout 300 --worker-tmp-dir /tmp app:app"]
