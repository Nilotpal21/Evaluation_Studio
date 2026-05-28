#!/bin/bash
# Start all required services for crawler testing
# Usage: ./scripts/start-crawler-services.sh

set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║          Starting Crawler Services for Testing                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if service is running
check_service() {
  local name=$1
  local check_cmd=$2

  if eval "$check_cmd" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} $name is running"
    return 0
  else
    echo -e "${RED}✗${NC} $name is NOT running"
    return 1
  fi
}

echo "Step 1: Checking Services"
echo "══════════════════════════════════════════════════════════════"
echo ""

REDIS_OK=false
MONGO_OK=false
SEARCHAI_OK=false
CRAWLER_OK=false

# Check Redis
if check_service "Redis" "redis-cli ping"; then
  REDIS_OK=true
fi

# Check MongoDB
if check_service "MongoDB" "mongosh --quiet --eval 'db.version()'"; then
  MONGO_OK=true
fi

# Check Search-AI
if check_service "Search-AI (port 3001)" "curl -s http://localhost:3001/health"; then
  SEARCHAI_OK=true
fi

# Check Go Crawler Worker
if ps aux | grep -E "crawler-go-worker|go run.*crawler" | grep -v grep > /dev/null; then
  echo -e "${GREEN}✓${NC} Go Crawler Worker is running"
  CRAWLER_OK=true
else
  echo -e "${RED}✗${NC} Go Crawler Worker is NOT running"
fi

echo ""

# Start missing services
if [ "$REDIS_OK" = false ]; then
  echo "Step 2: Starting Redis..."
  echo "══════════════════════════════════════════════════════════════"
  echo ""
  echo "Please start Redis manually:"
  echo "  redis-server &"
  echo ""
  echo "Or if using Docker:"
  echo "  docker run -d -p 6379:6379 redis:7-alpine"
  echo ""
fi

if [ "$MONGO_OK" = false ]; then
  echo "Step 3: Starting MongoDB..."
  echo "══════════════════════════════════════════════════════════════"
  echo ""
  echo "Please start MongoDB manually:"
  echo "  mongod --dbpath /usr/local/var/mongodb &"
  echo ""
  echo "Or if using Docker:"
  echo "  docker run -d -p 27017:27017 mongo:7"
  echo ""
fi

if [ "$SEARCHAI_OK" = false ]; then
  echo "Step 4: Starting Search-AI Service..."
  echo "══════════════════════════════════════════════════════════════"
  echo ""
  echo "Starting in development mode..."

  cd "$(dirname "$0")/../apps/search-ai"

  # Check if dependencies are installed
  if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    pnpm install
  fi

  # Build if needed
  echo "Building..."
  pnpm build

  # Start in background
  echo "Starting service on port 3001..."
  pnpm dev > /tmp/search-ai.log 2>&1 &
  SEARCHAI_PID=$!

  echo "Search-AI PID: $SEARCHAI_PID"
  echo "Logs: tail -f /tmp/search-ai.log"

  # Wait for service to be ready
  echo "Waiting for service to start..."
  for i in {1..30}; do
    if curl -s http://localhost:3001/health > /dev/null 2>&1; then
      echo -e "${GREEN}✓${NC} Search-AI is ready!"
      break
    fi
    echo -n "."
    sleep 1
  done
  echo ""
fi

if [ "$CRAWLER_OK" = false ]; then
  echo "Step 5: Starting Go Crawler Worker..."
  echo "══════════════════════════════════════════════════════════════"
  echo ""
  echo "Please start Go Crawler Worker manually:"
  echo ""
  echo "  cd apps/crawler-go-worker"
  echo "  go run main.go &"
  echo ""
  echo "Or build and run:"
  echo "  go build -o crawler-worker"
  echo "  ./crawler-worker &"
  echo ""
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "Service Status Summary"
echo "══════════════════════════════════════════════════════════════"
echo ""

# Re-check all services
check_service "Redis" "redis-cli ping"
check_service "MongoDB" "mongosh --quiet --eval 'db.version()'"
check_service "Search-AI" "curl -s http://localhost:3001/health"

if ps aux | grep -E "crawler-go-worker|go run.*crawler" | grep -v grep > /dev/null; then
  echo -e "${GREEN}✓${NC} Go Crawler Worker is running"
else
  echo -e "${YELLOW}⚠${NC} Go Crawler Worker is NOT running (manual start required)"
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo ""

if [ "$REDIS_OK" = true ] && [ "$MONGO_OK" = true ] && [ "$SEARCHAI_OK" = true ]; then
  echo -e "${GREEN}✓ All required services are running!${NC}"
  echo ""
  echo "Ready to run crawler tests:"
  echo "  ./scripts/test-crawl-site.sh https://docs.kore.ai/ docs.kore.ai 5 1"
  echo ""
else
  echo -e "${YELLOW}⚠ Some services are not running yet.${NC}"
  echo "Please start the missing services and re-run this script."
  echo ""
fi
