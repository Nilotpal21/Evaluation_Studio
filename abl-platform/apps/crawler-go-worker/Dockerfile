# Multi-stage Dockerfile for Go Crawler Worker

# ============================================================================
# Builder Stage
# ============================================================================
FROM golang:1.25.10-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build static binary — architecture-aware
# Docker's TARGETARCH is automatically set by buildx (amd64, arm64, etc.)
# This ensures the binary matches the host architecture (fixes Apple Silicon builds)
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} go build \
    -ldflags="-s -w" \
    -o bin/crawler-worker ./cmd/worker

# ============================================================================
# Runtime Stage — distroless static (includes ca-certificates)
# ============================================================================
FROM gcr.io/distroless/static-debian12

WORKDIR /app

COPY --from=builder /app/bin/crawler-worker .

USER nonroot:nonroot

ENV REDIS_URL=redis://localhost:6379
ENV QUEUE_NAME=static-crawl
ENV PARALLELISM=100
ENV MAX_CONCURRENCY=10
ENV LOG_LEVEL=info

CMD ["./crawler-worker"]
