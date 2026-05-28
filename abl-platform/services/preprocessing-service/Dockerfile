# Preprocessing Service Dockerfile
# Multi-stage build using uv for fast, reproducible builds

FROM python:3.11-slim as builder

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Set working directory
WORKDIR /app

# Copy project files — both manifest and lock so the install is reproducible
COPY pyproject.toml uv.lock ./

# Install dependencies pinned to uv.lock (hash-verified)
RUN uv export --frozen --no-dev --output-file /tmp/requirements-locked.txt && \
    uv pip install --system --no-cache --require-hashes -r /tmp/requirements-locked.txt

# Download NLTK data
RUN python -c "import nltk; nltk.download('wordnet', quiet=True); nltk.download('omw-1.4', quiet=True)"

# Production stage
FROM python:3.11-slim

# Patch OS-level CVEs (glibc CVE-2026-0861: integer overflow in memalign)
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy Python dependencies from builder and strip build tools (setuptools/pip/wheel)
# These carry vendored CVEs (jaraco.context, wheel) and aren't needed at runtime
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
RUN rm -rf /usr/local/lib/python3.11/site-packages/pip* \
           /usr/local/lib/python3.11/site-packages/setuptools* \
           /usr/local/lib/python3.11/site-packages/wheel* \
           /usr/local/lib/python3.11/site-packages/_distutils_hack
COPY --from=builder /usr/local/bin/gunicorn /usr/local/bin/gunicorn
COPY --from=builder /root/nltk_data /usr/share/nltk_data

# Copy application code
COPY app.py .
COPY src/ ./src/

# Create non-root user
RUN useradd -m -u 1000 preprocessing && \
    chown -R preprocessing:preprocessing /app

USER preprocessing

# Expose port
EXPOSE 8003

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "from urllib.request import urlopen; urlopen('http://localhost:8003/health', timeout=5)"

# Run with Gunicorn (--config /dev/null disables default config file search on read-only FS)
CMD ["gunicorn", "--bind", "0.0.0.0:8003", "--workers", "4", "--threads", "2", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-", "--worker-tmp-dir", "/tmp", "app:app"]
