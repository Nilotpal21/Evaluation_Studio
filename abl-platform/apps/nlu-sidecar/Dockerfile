# Multi-stage Dockerfile for NLU Sidecar

FROM python:3.11-slim AS builder

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ============================================================================
# Runtime Stage
# ============================================================================
FROM python:3.11-slim

WORKDIR /app

COPY --from=builder /install /usr/local

# Patch OS-level CVEs (glibc CVE-2026-0861) + upgrade Python packages flagged by Trivy
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir --upgrade pip setuptools wheel

COPY . .

RUN groupadd -r nlu && useradd -r -g nlu nlu && chown -R nlu:nlu /app
USER nlu

EXPOSE 8090

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; r=urllib.request.urlopen('http://localhost:8090/health'); exit(0 if r.status==200 else 1)"]

CMD ["gunicorn", "--bind", "0.0.0.0:8090", "--workers", "2", "--timeout", "30", "app:app"]
