#!/bin/bash
# Run script for Go crawler worker

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Check if binary exists
if [ ! -f "bin/crawler-worker" ]; then
    echo "❌ Binary not found. Building..."
    ./scripts/build.sh
fi

# Load environment variables if .env exists
if [ -f ".env" ]; then
    echo "📝 Loading environment from .env"
    export $(cat .env | grep -v '^#' | xargs)
fi

# Set defaults if not provided
export REDIS_URL=${REDIS_URL:-"redis://localhost:6379"}
export QUEUE_NAME=${QUEUE_NAME:-"static-crawl"}
export PARALLELISM=${PARALLELISM:-100}
export LOG_LEVEL=${LOG_LEVEL:-"info"}

echo "🚀 Starting Crawler Go Worker..."
echo ""
echo "Configuration:"
echo "  Redis URL: $REDIS_URL"
echo "  Queue Name: $QUEUE_NAME"
echo "  Parallelism: $PARALLELISM"
echo "  Log Level: $LOG_LEVEL"
echo ""

# Run the worker
./bin/crawler-worker
