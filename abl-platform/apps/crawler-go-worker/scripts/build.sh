#!/bin/bash
# Build script for Go crawler worker

set -e

echo "🔨 Building Crawler Go Worker..."

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf bin/

# Install dependencies
echo "📦 Installing dependencies..."
go mod download
go mod tidy

# Build for current OS (development)
echo "🔨 Building for local OS..."
go build -o bin/crawler-worker ./cmd/worker

# Build for Linux (production)
echo "🔨 Building for Linux/amd64..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/crawler-worker-linux-amd64 ./cmd/worker

# Build for macOS (if needed)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "🔨 Building for macOS..."
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o bin/crawler-worker-darwin-amd64 ./cmd/worker
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o bin/crawler-worker-darwin-arm64 ./cmd/worker
fi

echo "✅ Build complete!"
echo ""
echo "Binaries created:"
ls -lh bin/
echo ""
echo "To run: ./bin/crawler-worker"
