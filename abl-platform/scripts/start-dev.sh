#!/bin/bash
# Start all services for local development
#
# Usage: ./scripts/start-dev.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Agent Platform — Development Server${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

# Force development mode
export NODE_ENV=development

# Create .env files from examples if missing
if [ ! -f "$ROOT_DIR/apps/runtime/.env" ]; then
  echo -e "${YELLOW}Creating apps/runtime/.env from example...${NC}"
  cp "$ROOT_DIR/apps/runtime/.env.example" "$ROOT_DIR/apps/runtime/.env"
  echo -e "${YELLOW}  → Edit apps/runtime/.env and add your ANTHROPIC_API_KEY${NC}"
fi

if [ ! -f "$ROOT_DIR/apps/studio/.env.local" ] && [ ! -f "$ROOT_DIR/apps/studio/.env" ]; then
  echo -e "${YELLOW}Creating apps/studio/.env.local from example...${NC}"
  cp "$ROOT_DIR/apps/studio/.env.example" "$ROOT_DIR/apps/studio/.env.local"
  echo -e "${YELLOW}  → Edit apps/studio/.env.local to configure OAuth if needed${NC}"
fi

# Verify NODE_ENV in .env files isn't set to production
for envfile in "$ROOT_DIR/apps/runtime/.env" "$ROOT_DIR/apps/studio/.env.local" "$ROOT_DIR/apps/studio/.env"; do
  if [ -f "$envfile" ] && grep -q "^NODE_ENV=production" "$envfile" 2>/dev/null; then
    echo -e "${RED}WARNING: $envfile has NODE_ENV=production — overriding to development${NC}"
  fi
done

# Install dependencies if needed
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo -e "${BLUE}Installing dependencies...${NC}"
  cd "$ROOT_DIR" && pnpm install
fi

# Build web-sdk if not built
if [ ! -f "$ROOT_DIR/packages/web-sdk/dist/agent-sdk.esm.js" ]; then
  echo -e "${BLUE}Building Web SDK...${NC}"
  cd "$ROOT_DIR/packages/web-sdk" && pnpm build
fi

echo -e "${GREEN}Starting services...${NC}"
echo

# Function to cleanup on exit
cleanup() {
  echo
  echo -e "${YELLOW}Shutting down...${NC}"
  kill $(jobs -p) 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Start LiveKit server (optional — only if binary is available)
if command -v livekit-server &>/dev/null; then
  if lsof -iTCP:7880 -sTCP:LISTEN &>/dev/null; then
    echo -e "${YELLOW}[1/4] LiveKit server already running on port 7880${NC}"
  else
    echo -e "${GREEN}[1/4] Starting LiveKit server (port 7880)...${NC}"
    "$SCRIPT_DIR/start-livekit.sh" &
    sleep 1
  fi
else
  echo -e "${YELLOW}[1/4] Skipping LiveKit (livekit-server not found)${NC}"
fi

# Start Runtime API
echo -e "${GREEN}[2/4] Starting Runtime API (port 3112)...${NC}"
cd "$ROOT_DIR/apps/runtime" && NODE_ENV=development pnpm dev &
sleep 2

# Start Studio (Next.js)
echo -e "${GREEN}[3/4] Starting Studio (port 5173)...${NC}"
cd "$ROOT_DIR/apps/studio" && NODE_ENV=development pnpm dev &
sleep 2

# Start SDK example server (optional)
if [ -d "$ROOT_DIR/packages/web-sdk/examples/vanilla-html" ]; then
  echo -e "${GREEN}[4/4] Starting SDK Example (port 8080)...${NC}"
  cd "$ROOT_DIR/packages/web-sdk/examples/vanilla-html" && python3 -m http.server 8080 &
else
  echo -e "${YELLOW}[4/4] Skipping SDK Example (directory not found)${NC}"
fi

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Services Running (development mode):${NC}"
echo -e "${GREEN}  • LiveKit:       ws://localhost:7880${NC}"
echo -e "${GREEN}  • Runtime API:   http://localhost:3112${NC}"
echo -e "${GREEN}  • Studio:        http://localhost:5173${NC}"
echo -e "${GREEN}  • SDK Example:   http://localhost:8080${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo -e "${BLUE}Press Ctrl+C to stop all services${NC}"
echo

# Wait for all background jobs
wait
