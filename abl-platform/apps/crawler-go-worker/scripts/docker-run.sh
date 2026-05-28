#!/bin/bash
# Docker run script for Go crawler worker

set -e

IMAGE_NAME=${IMAGE_NAME:-"crawler-go-worker"}
IMAGE_TAG=${IMAGE_TAG:-"latest"}

# Load environment variables if .env exists
if [ -f ".env" ]; then
    echo "📝 Loading environment from .env"
    export $(cat .env | grep -v '^#' | xargs)
fi

# Set defaults
export REDIS_URL=${REDIS_URL:-"redis://host.docker.internal:6379"}
export QUEUE_NAME=${QUEUE_NAME:-"static-crawl"}
export PARALLELISM=${PARALLELISM:-100}

echo "🐳 Running Docker container..."
echo "  Image: $IMAGE_NAME:$IMAGE_TAG"
echo "  Redis: $REDIS_URL"
echo "  Queue: $QUEUE_NAME"
echo ""

docker run --rm -it \
    -e REDIS_URL="$REDIS_URL" \
    -e QUEUE_NAME="$QUEUE_NAME" \
    -e PARALLELISM="$PARALLELISM" \
    -e LOG_LEVEL="${LOG_LEVEL:-info}" \
    --name crawler-go-worker \
    "$IMAGE_NAME:$IMAGE_TAG"
