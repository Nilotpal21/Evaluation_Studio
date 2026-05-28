#!/bin/bash
# Test script for Go crawler worker

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "🧪 Running tests..."

# Run tests with coverage
go test -v -race -coverprofile=coverage.out ./...

# Generate coverage report
echo ""
echo "📊 Generating coverage report..."
go tool cover -func=coverage.out

# Generate HTML coverage report
go tool cover -html=coverage.out -o coverage.html

echo ""
echo "✅ Tests complete!"
echo "📄 Coverage report: coverage.html"
echo ""
echo "To view coverage:"
echo "  open coverage.html"
