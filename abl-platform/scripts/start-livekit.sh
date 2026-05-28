#!/bin/bash
# Start LiveKit server for local development
#
# Usage: ./scripts/start-livekit.sh
#
# Requires: livekit-server binary on PATH
#   Install: brew install livekit/tap/livekit-server
#
# The --node-ip 127.0.0.1 flag is critical: without it, LiveKit advertises
# the machine's network interface IP (e.g. 10.x.x.x) as its ICE candidate,
# which the browser can't reach when connecting via localhost. This causes
# "could not establish pc connection" errors in the WebRTC handshake.

set -e

BIND_ADDR="${LIVEKIT_BIND:-0.0.0.0}"
NODE_IP="${LIVEKIT_NODE_IP:-127.0.0.1}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if ! command -v livekit-server &>/dev/null; then
  echo -e "${RED}livekit-server not found on PATH${NC}"
  echo -e "${YELLOW}Install: brew install livekit/tap/livekit-server${NC}"
  exit 1
fi

# Check if already running
if lsof -iTCP:7880 -sTCP:LISTEN &>/dev/null; then
  echo -e "${YELLOW}LiveKit server already running on port 7880${NC}"
  exit 0
fi

echo -e "${GREEN}Starting LiveKit server (dev mode)${NC}"
echo -e "${GREEN}  Bind:    ${BIND_ADDR}${NC}"
echo -e "${GREEN}  Node IP: ${NODE_IP}${NC}"
echo -e "${GREEN}  Ports:   7880 (signal), 7881 (RTC TCP), 7882 (RTC UDP)${NC}"
echo

exec livekit-server --dev \
  --bind "$BIND_ADDR" \
  --node-ip "$NODE_IP"
