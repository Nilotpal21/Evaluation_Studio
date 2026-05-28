#!/bin/bash
# Docker build script for Go crawler worker

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

IMAGE_NAME=${IMAGE_NAME:-"crawler-go-worker"}
IMAGE_TAG=${IMAGE_TAG:-"latest"}

echo "🐳 Building Docker image..."
echo "  Image: $IMAGE_NAME:$IMAGE_TAG"
echo ""

# Build Docker image
docker build -t "$IMAGE_NAME:$IMAGE_TAG" .

# Tag with version if provided
if [ -n "$VERSION" ]; then
    echo "🏷️  Tagging as $IMAGE_NAME:$VERSION"
    docker tag "$IMAGE_NAME:$IMAGE_TAG" "$IMAGE_NAME:$VERSION"
fi

echo ""
echo "✅ Docker image built successfully!"
echo ""
echo "To run:"
echo "  docker run --rm -it \\"
echo "    -e REDIS_URL=redis://host.docker.internal:6379 \\"
echo "    $IMAGE_NAME:$IMAGE_TAG"
echo ""
echo "To push to registry:"
echo "  docker push $IMAGE_NAME:$IMAGE_TAG"
