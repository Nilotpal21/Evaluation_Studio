# Platform Debugging Guide

> How to diagnose and fix agent issues using the ABL platform's built-in debugging infrastructure.

## Quick Start

**Agent returns empty response?**

```bash
# Option A: MCP (Claude Code)
debug_diagnose { sessionId: "sess-123" }

# Option B: API
curl http://localhost:3112/api/projects/proj-travel/diagnostics/sessions/sess-123?depth=deep

# Option C: Studio
Open Observatory panel → Errors tab → see findings
```

**Before deploying?**

```bash
# Option A: API
curl -X POST http://localhost:3112/api/projects/proj-travel/validate \
  -H 'Content-Type: application/json' \
  -d '{ "agentNames": ["Authentication_Agent", "Booking_Manager"] }'

# Option B: Deploy with validation (automatic)
# Deployment blocked if preflight finds errors (unless force=true)
```

---

## Where Debugging Features Surface

### 1. Studio UI

| Feature                        | Location                                            | When it Appears                                           |
| ------------------------------ | --------------------------------------------------- | --------------------------------------------------------- |
| **Session Health Banner**      | Top of chat panel (red/amber bar)                   | Automatically after agent loads, if LLM wiring has issues |
| **Errors Tab**                 | Observatory sidebar → "Errors" tab                  | Whenever error/warning trace events occur                 |
| **Model Resolution Inspector** | Observatory sidebar → Overview tab (bottom section) | When model resolution trace data is available             |
| **Empty Response Error**       | Chat message area (system message)                  | When agent returns empty response instead of silent drop  |

#### Session Health Banner

Appears as a dismissible banner above chat messages:

- **Red** = errors (agent cannot respond): missing credentials, encryption unavailable, LLM wiring failed
- **Amber** = warnings (degraded): database resolution disabled, stale credentials
- Click to expand and see each issue
- Dismiss with X; reappears if new issues detected

#### Errors Tab

In the Observatory debug panel (click "Debug" button in chat header):

- Shows all error and warning events from the session
- Filterable: All / Errors only / Warnings only
- Badge on tab shows error count
- Each row: timestamp, severity icon, error code, message, agent name

#### Model Resolution Inspector

Shows the 6-level model resolution chain:

- Level 1: Agent IR (DSL `model:` field)
- Level 2: Agent DB config (per-agent model override)
- Level 3: Project DB config (project-level model)
- Level 4: Tenant default model (workspace-level)
- Level 5: Environment variable fallback
- Level 6: Hardcoded fallback

Each level shows: ✓ matched (green), ✗ checked but failed (red), — skipped (gray)

---

### 2. Runtime API Endpoints

All endpoints require authentication and project-level permissions.

#### Diagnose an Agent's Configuration

```
GET /api/projects/:projectId/diagnostics/agents/:agentName
```

Runs infra analyzers only (quick depth). Returns model chain, credential status, tool bindings.

**Permission:** `agent:read`

#### Diagnose a Session

```
GET /api/projects/:projectId/diagnostics/sessions/:sessionId?depth=quick|standard|deep
```

| Depth      | Analyzers Run                         | Use When                     |
| ---------- | ------------------------------------- | ---------------------------- |
| `quick`    | Model, credentials, tools, encryption | "Is the config right?"       |
| `standard` | + execution status                    | "What went wrong?" (default) |
| `deep`     | + empty-response, flow-state          | "Why is it stuck/empty?"     |

**Permission:** `session:read`

**Response shape:**

```json
{
  "success": true,
  "data": {
    "status": "healthy | degraded | broken",
    "findings": [
      {
        "analyzer": "model-resolution",
        "severity": "error",
        "code": "NO_MODEL_RESOLVED",
        "title": "No model found at any resolution level",
        "detail": "Checked all 6 levels...",
        "suggestion": "Add a default TenantModel or set MODEL_ID env var"
      }
    ],
    "summary": { "errors": 1, "warnings": 0, "infos": 2, "analyzersRun": [...] },
    "config": {
      "model": { "chain": [...], "resolved": { "modelId": "...", "provider": "..." } },
      "credentials": { "provider": "...", "available": true },
      "tools": { "total": 5, "bound": 4, "failed": ["search_kb"] }
    }
  }
}
```

#### Pre-Deployment Validation

```
POST /api/projects/:projectId/validate
Content-Type: application/json

{ "agentNames": ["Agent_A", "Agent_B"] }
```

Omit `agentNames` to validate all project agents.

**Permission:** `deployment:create`

**Response:**

```json
{
  "success": true,
  "data": {
    "status": "ready | warnings | errors",
    "agents": [
      {
        "agentName": "Agent_A",
        "report": {
          /* DiagnosticReport */
        }
      }
    ],
    "summary": { "total": 2, "passed": 2, "warnings": 0, "errors": 0 }
  }
}
```

#### Deployment Gate

When creating a deployment via `POST /api/projects/:projectId/deployments`:

- Preflight validation runs automatically before deployment creation
- **Errors → 422** with preflight report (deployment blocked)
- **Warnings → 201** with warnings included in response
- **`force: true`** in request body skips preflight entirely

---

### 3. MCP Debug Tools (Claude Code)

Connect first: `debug_connect` (auto-connects to localhost:3112)

#### debug_diagnose — "What went wrong?"

```
debug_diagnose { sessionId: "sess-123", depth: "deep" }
debug_diagnose { agentName: "Authentication_Agent" }
```

Returns formatted text:

```
DIAGNOSIS: Authentication_Agent — BROKEN

FINDINGS (1 error, 1 warning):

  ✗ [credential-chain] No active credential found
    No active LLM credential exists for tenant.
    → Add a credential via Settings → LLM Credentials

  ⚠ [encryption-availability] Encryption service not initialized
    ENCRYPTION_MASTER_KEY is not set.
    → Set ENCRYPTION_MASTER_KEY in environment

CONFIG:
  Model: claude-sonnet-4-5 (resolved at level 4: tenant_model)
  Credentials: ✗ none active
  Tools: 3 declared, 3 bound
```

#### debug_inspect — "What is configured?"

```
debug_inspect { agentName: "TravelDesk_Supervisor" }
```

Returns config-only output:

```
INSPECT: TravelDesk_Supervisor

MODEL RESOLUTION:
  ✓ Level 1 (Agent IR): claude-sonnet-4-5
  — Level 2 (Agent DB): skipped
  — Level 3 (Project DB): skipped
  — Level 4 (Tenant Model): skipped

CREDENTIALS:
  anthropic: ✓ active, tenant-scoped

TOOLS:
  Total: 6 | Bound: 6 | Failed: 0
```

---

### 4. Compile-Time Validation

Runs automatically when agents are compiled (save, import, deploy):

| Check                        | Code                             | What It Catches                                                                                |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Supervisor without reasoning | `SUPERVISOR_NO_REASONING_STEP`   | Supervisor with routing rules but all flow steps have reasoning disabled → agent returns empty |
| Missing model hint           | `REASONING_ZONE_NO_MODEL`        | Flow step with reasoning enabled but no model configured (may resolve from DB)                 |
| Dead flow step               | `FLOW_STEP_NO_ACTION`            | Step with no reasoning, gather, respond, or call — does nothing                                |
| Invalid routing target       | `INVALID_DEFAULT_ROUTING_TARGET` | `routing.default_agent` references nonexistent agent                                           |

---

### 5. WebSocket Messages

These messages flow from Runtime to Studio automatically:

| Message                      | When                                     | What Studio Does                                         |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `session_health`             | After agent loads + LLM wiring completes | Creates observatory events → SessionHealthBanner renders |
| `tool_warnings`              | After tool executor setup                | (Not yet consumed by Studio)                             |
| `trace_event` (type=error)   | During execution                         | ErrorsTab displays                                       |
| `trace_event` (type=warning) | During execution                         | ErrorsTab displays                                       |

---

### 6. Diagnostic Analyzers

7 analyzers registered in the diagnostic engine, grouped by category:

#### Infra (run at all depths)

| Analyzer                    | What It Checks                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **model-resolution**        | Walks 6-level model chain. Reports which level matched, or NO_MODEL_RESOLVED if none did.                             |
| **credential-chain**        | Checks active LLM credentials for the tenant. Validates provider matches model. Reports stale credentials (>30 days). |
| **tool-binding**            | Checks if tools declared in agent DSL have matching ProjectTool records. Reports unbound tools.                       |
| **encryption-availability** | Checks ENCRYPTION_MASTER_KEY and MongoDB connection. Reports if encrypted credentials can't be decrypted.             |

#### Execution (run at standard + deep depth)

| Analyzer             | What It Checks                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **execution-status** | Checks session health entries for errors. Detects missing LLM client. Reports last execution failures. |

#### Behavioral (run at deep depth only)

| Analyzer           | What It Checks                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **empty-response** | Detects why responses are empty: LLM wiring failed, no reasoning zones, no respond steps in flow. |
| **flow-state**     | Detects stuck flow steps (idle >5 min), infinite loops (backtrack count >5).                      |

---

## Debugging by Symptom

### "Agent returns empty response"

1. **Check Studio**: Look at SessionHealthBanner (top of chat) — does it show errors?
2. **Check Errors tab**: Observatory → Errors tab — any LLM or credential errors?
3. **Run diagnose**: `debug_diagnose { sessionId: "...", depth: "deep" }`
4. **Common causes**:
   - `CREDENTIAL_NOT_FOUND` → No API key for the LLM provider. Add via Settings → LLM Credentials.
   - `MODEL_NOT_CONFIGURED` → No model at any resolution level. Check agent DSL `model:` field or set a tenant default.
   - `SUPERVISOR_NO_REASONING_STEP` → All flow steps have reasoning disabled. Enable reasoning on at least one step.
   - `LLM_WIRING_FAILED` → Check runtime logs for the specific error.

### "Agent init error / won't load"

1. **Check banner**: SessionHealthBanner should show the error
2. **Run inspect**: `debug_inspect { agentName: "..." }`
3. **Common causes**:
   - `ENCRYPTION_UNAVAILABLE` → Set `ENCRYPTION_MASTER_KEY` environment variable
   - `DB_RESOLUTION_UNAVAILABLE` → MongoDB not connected. Check `MONGODB_URL`.

### "Wrong agent handles message"

1. **Run analyze**: `debug_analyze_session { sessionId: "..." }`
2. **Check decision logs**: `debug_explain_decision { sessionId: "..." }`
3. **Check routing**: Verify `routing.default_agent` and HANDOFF rules in supervisor DSL

### "Session hangs / no response"

1. **Run diagnose deep**: `debug_diagnose { sessionId: "...", depth: "deep" }`
2. **Check flow-state**: Look for `FLOW_STEP_STALLED` or `FLOW_STEP_LOOP` findings
3. **Common causes**:
   - Gather step stuck on required field (user hasn't provided it)
   - Tool timeout (external service not responding)
   - Infinite loop between flow steps

### "Tool call fails"

1. **Check Errors tab**: Look for tool_call_error events
2. **Run inspect**: `debug_inspect { agentName: "..." }` → check Tools section
3. **Common causes**:
   - `UNBOUND_TOOL` → Tool declared in DSL but no implementation (ProjectTool record missing)
   - HTTP endpoint unreachable
   - MCP server not connected

### "Deployment blocked"

1. **Read the 422 response**: It contains the full `preflightReport` with findings
2. **Fix the errors** in agent DSL or configuration
3. **Force deploy** (escape hatch): Add `"force": true` to deployment request body

---

## Testing the Debug Features Locally

### Prerequisites

```bash
# Start infrastructure
docker-compose up -d  # MongoDB, Redis, ClickHouse

# Build and start runtime
pnpm build
cd apps/runtime && pnpm dev  # Runs on port 3112

# Start Studio
cd apps/studio && pnpm dev   # Runs on port 5173
```

### Test 1: Session Health Banner

1. Open Studio at `http://localhost:5173`
2. Select a project and agent
3. Click "New Chat" to start a session
4. If the agent has credential/model issues, the **red/amber banner** appears above messages
5. Click the banner to expand and see details

### Test 2: Errors Tab

1. Start a chat session with an agent
2. Send a message that triggers an error (e.g., tool failure)
3. Click the **Debug** button in the chat header
4. Click the **Errors** tab — see the error events with severity, code, message

### Test 3: Diagnostics API

```bash
# Diagnose an agent (requires auth cookie/token)
curl -b cookies.txt \
  http://localhost:3112/api/projects/proj-travel/diagnostics/agents/Authentication_Agent

# Diagnose a session
curl -b cookies.txt \
  http://localhost:3112/api/projects/proj-travel/diagnostics/sessions/sess-123?depth=deep

# Validate before deploy
curl -b cookies.txt -X POST \
  http://localhost:3112/api/projects/proj-travel/validate \
  -H 'Content-Type: application/json' \
  -d '{ "agentNames": ["Authentication_Agent"] }'
```

### Test 4: MCP Debug Tools

```bash
# In Claude Code with MCP debug server running
debug_connect
debug_list_sessions
debug_diagnose { sessionId: "...", depth: "deep" }
debug_inspect { agentName: "Authentication_Agent" }
```

### Test 5: Deployment Gate

```bash
# Deploy with preflight (will block on errors)
curl -b cookies.txt -X POST \
  http://localhost:3112/api/projects/proj-travel/deployments \
  -H 'Content-Type: application/json' \
  -d '{ "agents": [...] }'

# Force deploy (skip preflight)
curl -b cookies.txt -X POST \
  http://localhost:3112/api/projects/proj-travel/deployments \
  -H 'Content-Type: application/json' \
  -d '{ "agents": [...], "force": true }'
```

---

## Error Codes Reference

### Domain-Specific Error Codes (shared-kernel)

| Code                     | Status | Meaning                                  |
| ------------------------ | ------ | ---------------------------------------- |
| `CREDENTIAL_NOT_FOUND`   | 503    | No API key for LLM provider              |
| `CREDENTIAL_DECRYPTION`  | 503    | Credential exists but decryption failed  |
| `MODEL_NOT_CONFIGURED`   | 503    | No model at any resolution level         |
| `MODEL_RATE_LIMITED`     | 429    | LLM provider returned 429                |
| `MODEL_CONTEXT_EXCEEDED` | 400    | Token limit exceeded                     |
| `MODEL_TIMEOUT`          | 504    | LLM call timed out                       |
| `MODEL_API_ERROR`        | 502    | LLM provider returned 5xx                |
| `MODEL_CONTENT_FILTERED` | 422    | Safety filter rejection                  |
| `TOOL_BINDING_FAILED`    | 503    | Tool could not be wired at session start |
| `FLOW_STEP_ERROR`        | 500    | Flow step execution failed               |
| `HANDOFF_TARGET_MISSING` | 400    | Handoff target agent not found           |
| `EXECUTION_TIMEOUT`      | 504    | Overall execution timeout                |

### Diagnostic Finding Codes (analyzers)

| Code                          | Analyzer         | Severity | Meaning                                            |
| ----------------------------- | ---------------- | -------- | -------------------------------------------------- |
| `NO_MODEL_RESOLVED`           | model-resolution | error    | No model found at any of 6 levels                  |
| `MODEL_RESOLVED`              | model-resolution | info     | Model successfully resolved                        |
| `NO_CREDENTIAL`               | model-resolution | error    | Model resolved but no credential for its provider  |
| `NO_ACTIVE_CREDENTIAL`        | credential-chain | error    | No active LLM credential for tenant                |
| `PROVIDER_NOT_ALLOWED`        | credential-chain | error    | Credential provider not in tenant policy allowlist |
| `CREDENTIAL_STALE`            | credential-chain | warning  | Credential not validated in 30+ days               |
| `UNBOUND_TOOL`                | tool-binding     | warning  | Tool in DSL has no matching ProjectTool            |
| `ENCRYPTION_UNAVAILABLE`      | encryption       | warning  | ENCRYPTION_MASTER_KEY not set                      |
| `DB_UNAVAILABLE`              | encryption       | error    | MongoDB not connected                              |
| `SESSION_HEALTH_ERROR`        | execution-status | error    | Session init had error-severity issues             |
| `NO_LLM_CLIENT`               | execution-status | error    | Session has no LLM client configured               |
| `EMPTY_RESPONSE_LLM_FAILED`   | empty-response   | error    | LLM wiring failed → no responses possible          |
| `EMPTY_RESPONSE_NO_REASONING` | empty-response   | warning  | No reasoning zones in agent flow                   |
| `FLOW_STEP_STALLED`           | flow-state       | warning  | Flow step idle >5 minutes                          |
| `FLOW_STEP_LOOP`              | flow-state       | warning  | Step visited >5 times (possible infinite loop)     |

### Compile-Time Validation Codes

| Code                             | Severity | Meaning                                                      |
| -------------------------------- | -------- | ------------------------------------------------------------ |
| `SUPERVISOR_NO_REASONING_STEP`   | error    | Supervisor has routing but no reasoning-enabled flow step    |
| `REASONING_ZONE_NO_MODEL`        | warning  | Reasoning zone with no model configured                      |
| `FLOW_STEP_NO_ACTION`            | warning  | Flow step does nothing (no reasoning, gather, respond, call) |
| `INVALID_DEFAULT_ROUTING_TARGET` | error    | routing.default_agent references nonexistent agent           |
