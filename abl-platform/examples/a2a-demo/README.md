# A2A Demo: Sync, Streaming & Async Agent Integration

Demonstrates all three A2A agent communication patterns: synchronous, SSE streaming, and asynchronous with push notifications.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Studio UI (localhost:5173)                             │
│  "I need a risk analysis on contract CTR-2024-001"      │
└────────────────┬────────────────────────────────────────┘
                 │ WebSocket
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Contract_Supervisor (Runtime :3112)                    │
│  Routes to Compliance_Checker or Risk_Analyzer          │
└────────┬───────────────────────────────┬────────────────┘
         │                               │
    LOCAL (sync)                   REMOTE A2A (async)
         │                               │
         ▼                               ▼
┌─────────────────┐        ┌──────────────────────────┐
│ Compliance_      │        │ Risk Analysis Agent      │
│ Checker          │        │ (localhost:4002)         │
│                  │        │                          │
│ Instant response │        │ Returns 'working' state  │
│ via HANDOFF      │        │ Pushes result in ~10s    │
└─────────────────┘        └──────────────────────────┘
```

## Agents

### Contract_Supervisor (Entry Agent)

Routes user requests based on intent:

- **"compliance check"** → `Compliance_Checker` (local, sync, instant)
- **"risk analysis"** → `Risk_Analyzer` (remote A2A — auto-detects streaming from agent card, tokens stream to Studio in real-time)

### Compliance_Checker (Local Agent)

Quick compliance check against standard rules. Uses a reasoning step with a tool call. Returns immediately.

### Risk_Analyzer (Remote A2A Agent)

Standalone Express server implementing A2A protocol:

- **Agent Card**: `GET http://localhost:4002/.well-known/agent.json`
- **A2A Endpoint**: `POST http://localhost:4002/a2a`
- **Capabilities**: `streaming: true, pushNotifications: true`
- **Sync mode** (`message/send`, `blocking: true`): Returns analysis immediately
- **Streaming mode** (`message/stream`): SSE with incremental artifact chunks
- **Async mode** (`message/send`, `blocking: false`): Returns `working` state, pushes result via callback after ~10s

## Setup

### 1. Start the Remote Risk Agent

```bash
cd examples/a2a-demo/remote-risk-agent
npm install
npx ts-node --esm server.ts
```

The agent starts on port 4002. You should see the startup banner.

### 2. Verify Agent Card

```bash
curl http://localhost:4002/.well-known/agent.json | jq .
```

### 3. Start the Platform

```bash
# From project root
docker compose up -d              # Infrastructure (MongoDB, Redis, etc.)
pnpm build                        # Build all packages
pnpm --filter runtime dev         # Start runtime on :3112
pnpm --filter studio dev          # Start Studio on :5173
```

### 4. Create Project in Studio

1. Open Studio at `http://localhost:5173`
2. Create a new project (e.g., "A2A Contract Demo")
3. Create agents in the project:
   - **Contract_Supervisor** — paste `supervisor.agent.abl`
   - **Compliance_Checker** — paste `agents/compliance_checker.agent.abl`
4. Save both agents

### 5. Test

Start a chat session with `Contract_Supervisor` and try:

**Sync path (local agent):**

> "I need a compliance check on contract CTR-2024-001"

→ Routes to `Compliance_Checker` → instant response

**Streaming path (remote A2A, real-time):**

> "I need a risk analysis on contract CTR-2024-001"

→ Routes to `Risk_Analyzer` (remote) → routing-executor discovers agent card has `streaming: true` → opens SSE connection → tokens stream to Studio in real-time

### 6. Test A2A Protocol Directly

```bash
# Sync call (blocking)
curl -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-1",
        "role": "user",
        "parts": [{"kind": "text", "text": "{\"contract_id\": \"CTR-2024-001\", \"contract_type\": \"saas\"}"}]
      },
      "configuration": { "blocking": true }
    }
  }' | jq .

# Streaming call (SSE with incremental artifact chunks)
curl -N -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "message/stream",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-stream-1",
        "role": "user",
        "parts": [{"kind": "text", "text": "{\"contract_id\": \"CTR-2024-002\", \"contract_type\": \"consulting\"}"}]
      }
    }
  }'
# → Outputs SSE events: status-update(working) → artifact-update chunks → status-update(completed)

# Async call (non-blocking with push notification)
curl -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-2",
        "role": "user",
        "parts": [{"kind": "text", "text": "{\"contract_id\": \"CTR-2024-002\", \"contract_type\": \"licensing\"}"}]
      },
      "configuration": {
        "blocking": false,
        "pushNotificationConfig": {
          "url": "http://localhost:3112/api/v1/callbacks/test-callback-123",
          "token": "test-token"
        }
      }
    }
  }' | jq .
```

## Configuration

| Variable                 | Default | Description                      |
| ------------------------ | ------- | -------------------------------- |
| `RISK_AGENT_PORT`        | `4002`  | Port for the remote risk agent   |
| `RISK_ANALYSIS_DELAY_MS` | `10000` | Simulated async processing delay |
