# Self-Service Debugging & Error Visibility — Implementation Plan

## Problem Statement

A 2-hour debugging session for "agent returns empty response, no error" revealed systemic gaps:

1. Errors are swallowed at multiple levels (coordinator, handlers, LLM wiring)
2. No pre-flight validation catches misconfiguration before runtime
3. Rich debugging tools exist (MCP debug server, CLI) but are invisible to developers and AI assistants
4. Studio shows nothing when executions fail silently
5. Claude Code didn't know the debug tools existed

This plan addresses all five gaps across five pillars, phased for incremental delivery.

---

## Architecture: Five Pillars

| Pillar                          | Owner              | Goal                                                               |
| ------------------------------- | ------------------ | ------------------------------------------------------------------ |
| **P1: Error Surfacing**         | Runtime            | Never swallow functional failures; domain-specific error codes     |
| **P2: Pre-flight Validation**   | Compiler + Runtime | Catch misconfig at compile/deploy time, not runtime                |
| **P3: CLI Debug Toolkit**       | CLI + MCP Debug    | Self-service diagnostic commands for developers                    |
| **P4: Studio Debug UX**         | Studio             | Visual error surfacing, health banners, model resolution inspector |
| **P5: Claude Code Integration** | .claude/ config    | Make AI-assisted debugging effective via MCP tools and playbooks   |

---

## P1: Runtime Error Surfacing

### P1.1 Domain-Specific Error Codes

Add to `packages/shared-kernel/src/errors.ts`:

```
CREDENTIAL_NOT_FOUND      (503) - No API key for LLM provider
CREDENTIAL_DECRYPTION     (503) - Credential exists but decryption failed
MODEL_NOT_CONFIGURED      (503) - No model at any resolution level
MODEL_RATE_LIMITED         (429) - Provider returned 429
MODEL_CONTEXT_EXCEEDED    (400) - Token limit exceeded
MODEL_TIMEOUT             (504) - LLM call timed out
MODEL_API_ERROR           (502) - Provider returned 5xx
MODEL_CONTENT_FILTERED    (422) - Safety filter rejection
TOOL_BINDING_FAILED       (503) - Tool could not be wired at session start
FLOW_STEP_ERROR           (500) - Flow step execution failed
HANDOFF_TARGET_MISSING    (400) - Handoff target agent not found
EXECUTION_TIMEOUT         (504) - Overall execution timeout
```

### P1.2 Preserve AppError Codes in Coordinator

**File:** `apps/runtime/src/services/execution/execution-coordinator.ts` (catch block ~line 547)

Current: always sets `code: 'EXECUTION_FAILED'`. Fix: preserve `AppError.code` when available.

```typescript
if (err instanceof AppError) {
  execution.error = { code: err.code, message: err.message };
} else {
  execution.error = {
    code: 'EXECUTION_FAILED',
    message: err instanceof Error ? err.message : String(err),
  };
}
```

### P1.3 `toClientResponse()` Helper

**File:** `packages/execution/src/types.ts` (new export)

```typescript
export interface ExecutionClientResponse {
  ok: boolean;
  response: string;
  resultData?: Record<string, unknown>;
  error?: { code: string; message: string; statusCode: number };
}
export function toClientResponse(execution: Execution): ExecutionClientResponse;
```

All handlers use this instead of manually checking `execution.status`. Prevents the sdk-handler.ts bug where the check was missing entirely.

### P1.4 Fix All Handler Paths

| Handler  | File                              | Status               | Fix                          |
| -------- | --------------------------------- | -------------------- | ---------------------------- |
| WS debug | `websocket/handler.ts` ~L1475     | Already fixed        | Use `toClientResponse()`     |
| HTTP     | `routes/chat.ts` ~L1071           | Already fixed        | Use `toClientResponse()`     |
| WS SDK   | `websocket/sdk-handler.ts` ~L1556 | **MISSING CHECK**    | Add `toClientResponse()`     |
| Channels | `message-pipeline.ts`             | Uses direct executor | Safe, but add error handling |

### P1.5 Session Health Tracking

**File:** `apps/runtime/src/services/execution/types.ts` (add to RuntimeSession)

```typescript
interface SessionHealthEntry {
  category: 'llm' | 'tool' | 'memory' | 'audit' | 'proxy' | 'encryption' | 'database';
  severity: 'warning' | 'error';
  code: string;
  message: string;
  timestamp: number;
}
```

Populate during `llm-wiring.ts` initialization instead of just logging. Emit `session.health` trace event after init. Send `session_init_warnings` WS message to Studio.

### P1.6 Never-Swallow Audit

| Location                  | File                  | Current            | Classification | Action                   |
| ------------------------- | --------------------- | ------------------ | -------------- | ------------------------ |
| DB resolution unavailable | `llm-wiring.ts` L112  | `log.debug`        | **Functional** | → session health warning |
| Encryption unavailable    | `llm-wiring.ts` L118  | `log.debug`        | **Functional** | → session health error   |
| Audit logger init         | `llm-wiring.ts` L391  | `log.warn`         | Operational    | Keep, add to health      |
| Proxy config load         | `llm-wiring.ts` L641  | `log.error`        | Operational    | Keep, add to health      |
| Memory API wiring         | `llm-wiring.ts` L664  | `log.warn`         | Operational    | Keep, add to health      |
| `resolveEnableThinking`   | `llm-wiring.ts` L867  | Empty catch        | Operational    | Add `log.debug`          |
| `findProjectSettings`     | `llm-wiring.ts` L891  | Empty catch        | Operational    | Add `log.debug`          |
| `wireLLMClient` outer     | `llm-wiring.ts` L895  | `log.error`        | **Functional** | → session health error   |
| OTEL appendEvent          | `trace-store.ts` L163 | `.catch(() => {})` | Operational    | Add `log.debug` inside   |

**Rule:** If a failure means the agent cannot respond to user messages, it's **functional** and MUST be surfaced. Everything else is **operational** and can log-and-continue.

### P1 Phasing

| Phase | What                                                     | Risk   | Impact      |
| ----- | -------------------------------------------------------- | ------ | ----------- |
| P1-A  | Error code preservation in coordinator + fix sdk-handler | Low    | **Highest** |
| P1-B  | `toClientResponse()` + refactor all handlers             | Low    | High        |
| P1-C  | Session health tracking + `session.health` trace event   | Medium | Medium      |
| P1-D  | Never-swallow audit (replace empty catches)              | Low    | Low         |

---

## P2: Pre-flight Validation

### P2.1 Compile-Time Checks (Tier 1 — Pure IR, No DB)

**File:** `packages/compiler/src/platform/ir/validate-preflight.ts` (new)

Wire into existing `validateIR()` orchestrator in `validate-ir.ts`.

| Check                      | Code                             | Severity | What                                                                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool schema completeness   | `INVALID_TOOL_INPUT_SCHEMA`      | Error    | Every non-system tool must have parameters that produce valid `input_schema`                                                                                                                                                                                                          |
| Tool parameter types       | `MISSING_TOOL_PARAMETER_TYPE`    | Error    | Each parameter needs `name` + `type`                                                                                                                                                                                                                                                  |
| Reasoning zone model hint  | `REASONING_ZONE_NO_MODEL`        | Warning  | REASONING step with no model in DSL (may resolve from DB)                                                                                                                                                                                                                             |
| Default routing target     | `INVALID_DEFAULT_ROUTING_TARGET` | Error    | `routing.default_agent` must exist in compilation                                                                                                                                                                                                                                     |
| Supervisor needs reasoning | `SUPERVISOR_NO_REASONING_STEP`   | Error    | SUPERVISOR with HANDOFF rules must have at least one flow step with `REASONING: true`. Without it, the LLM is never called and handoff conditions can never be evaluated. (Real bug: abl-dev 2026-03-15 — all steps had `REASONING: false`, agent returned empty responses silently.) |
| Dead flow step             | `FLOW_STEP_NO_ACTION`            | Warning  | Flow step with no reasoning zone, no gather, no respond, and no call — step does nothing and exits as "waiting".                                                                                                                                                                      |

### P2.2 Deploy-Time Checks (Tier 2 — DB-Aware)

**File:** `apps/runtime/src/services/preflight-validation-service.ts` (new)

```typescript
export interface PreflightReport {
  status: 'ready' | 'warnings' | 'errors';
  checks: PreflightCheckResult[];
  summary: { total: number; passed: number; warnings: number; errors: number };
}

export async function runPreflightValidation(params: {
  projectId: string;
  tenantId: string;
  agentIRs: Record<string, AgentIR>;
  allAgentNames: string[];
}): Promise<PreflightReport>;
```

| Check                | Code                     | Severity | What                                                           |
| -------------------- | ------------------------ | -------- | -------------------------------------------------------------- |
| Model resolves       | `NO_RESOLVABLE_MODEL`    | Error    | Walk 6-level chain in dry-run mode (no decrypt)                |
| Credential exists    | `NO_MATCHING_CREDENTIAL` | Error    | Provider from `inferProviderFromModelId` has active credential |
| Provider allowed     | `PROVIDER_NOT_ALLOWED`   | Error    | Provider is in `TenantLLMPolicy` allowlist                     |
| Credential freshness | `CREDENTIAL_STALE`       | Warning  | `lastValidatedAt` null or >30 days                             |

Uses existing repo functions from `llm-resolution-repo.ts`. Does NOT instantiate `ModelResolutionService` (avoids encryption dependency and cache pollution).

### P2.3 Validate Endpoint

**File:** `apps/runtime/src/routes/validate.ts` (new)

```
POST /api/projects/:projectId/validate
Body: { agentNames?: string[], environment?: string }
Response: PreflightReport
```

Runs compile-time + deploy-time checks. Requires `deployment:read` permission.

### P2.4 Deployment Gate

**File:** `apps/runtime/src/routes/deployments.ts` (modify POST handler)

After existing validation, before `createDeployment()`:

- Run `runPreflightValidation()`
- Errors → return 422 `{ success: false, preflightErrors: [...] }`
- Warnings → return 201 `{ success: true, deployment, preflightWarnings: [...] }`

### P2 Phasing

| Phase | What                                                  | Risk   | Impact      |
| ----- | ----------------------------------------------------- | ------ | ----------- |
| P2-A  | Compile-time validators (tool schema, reasoning zone) | Low    | High        |
| P2-B  | Deploy-time validation service + `/validate` endpoint | Medium | **Highest** |
| P2-C  | Deployment gate (block deploy on errors)              | Medium | High        |
| P2-D  | CLI `agents validate` + Studio CreateDeploymentDialog | Low    | Medium      |

---

## P3: Unified Diagnostic Engine

The core insight: instead of narrow symptom-specific tools (`why_empty`, `model_resolve`, `credentials_check`), build a **unified diagnostic engine** with pluggable analyzers. One tool runs ALL checks and returns a structured diagnosis. This covers every failure mode — current and future — without needing a new tool per symptom.

### P3.1 Diagnostic Engine Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Diagnostic Engine                    │
│                                                       │
│  Input: agentName | sessionId | executionId           │
│                                                       │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────┐  │
│  │ Infra        │ │ Execution    │ │ Behavioral    │  │
│  │ Analyzers    │ │ Analyzers    │ │ Analyzers     │  │
│  ├─────────────┤ ├──────────────┤ ├───────────────┤  │
│  │ Model chain  │ │ Status check │ │ Loop detect   │  │
│  │ Credentials  │ │ Error trace  │ │ Step coverage │  │
│  │ Tool binding │ │ Empty resp   │ │ LLM patterns  │  │
│  │ Encryption   │ │ Timeout      │ │ Constraint    │  │
│  │ Policy       │ │ Flow state   │ │ Escalation    │  │
│  │ DB avail     │ │ Handoff fail │ │ Gather stalls │  │
│  └─────────────┘ └──────────────┘ └───────────────┘  │
│                                                       │
│  Output: DiagnosticReport                             │
│    ├── status: healthy | degraded | broken            │
│    ├── findings[]: { analyzer, severity, code,        │
│    │     title, detail, suggestion, evidence[] }      │
│    ├── timeline: key events in execution order        │
│    └── config: resolved model, credentials, tools     │
└─────────────────────────────────────────────────────┘
```

### P3.2 Diagnostic Report Shape

**File:** `apps/runtime/src/services/diagnostics/types.ts` (new)

```typescript
export interface DiagnosticFinding {
  analyzer: string; // e.g. 'model_resolution', 'credential_chain', 'execution_status'
  severity: 'error' | 'warning' | 'info';
  code: string; // Machine-readable: 'NO_MATCHING_CREDENTIAL', 'EMPTY_RESPONSE', etc.
  title: string; // "No credential for provider 'openai'"
  detail: string; // Full explanation with context
  suggestion: string; // "Remove model from DSL to inherit tenant config"
  evidence: DiagnosticEvidence[]; // Supporting data (trace events, config values, etc.)
}

export interface DiagnosticEvidence {
  type: 'config' | 'trace_event' | 'db_record' | 'execution' | 'ir_node' | 'config_hash';
  label: string; // "Model resolution chain"
  data: Record<string, unknown>;
  traceId?: string; // Per-turn trace ID (from STI Phase -1) for correlation
}

export interface DiagnosticReport {
  status: 'healthy' | 'degraded' | 'broken';
  target: {
    type: 'agent' | 'session' | 'execution';
    id: string;
    agentName: string;
  };
  findings: DiagnosticFinding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    analyzersRun: string[];
  };

  // Structured config snapshot (always included)
  config: {
    model?: {
      chain: Array<{
        level: number;
        name: string;
        checked: boolean;
        matched: boolean;
        value?: string;
        reason: string;
      }>;
      resolved?: { modelId: string; provider: string; source: string };
    };
    credentials?: {
      provider: string;
      available: boolean;
      scope?: 'tenant' | 'user';
      isActive?: boolean;
      isEncrypted?: boolean;
      policy?: string;
    };
    tools?: {
      total: number;
      bound: number;
      failed: string[];
      systemTools: string[]; // handoff_to_*, delegate_to_*, etc.
    };
    session?: {
      healthEntries: Array<{ category: string; severity: string; message: string }>;
      llmClientConfigured: boolean;
      flowStep?: string;
    };
  };

  // Execution timeline (for session/execution targets)
  timeline?: Array<{
    timestamp: string;
    type: string;
    summary: string;
    isError: boolean;
  }>;
}
```

### P3.3 Analyzer Modules

**Directory:** `apps/runtime/src/services/diagnostics/analyzers/` (new)

Each analyzer is a pure function: `(context: DiagnosticContext) => DiagnosticFinding[]`

| Analyzer                      | Category   | What It Checks                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`model-resolution`**        | Infra      | Walks 6-level chain in dry-run mode. Reports which levels were checked/skipped/matched. Detects: no model at any level, DSL model locks out DB levels, model doesn't map to known provider.                                                                                                                                     |
| **`credential-chain`**        | Infra      | For the resolved provider: checks LLMCredential existence, TenantModel connections, active status, encryption status. Reports: no credential, wrong provider, stale credential, policy violation.                                                                                                                               |
| **`tool-binding`**            | Infra      | Checks all tool definitions from IR + system tools from buildTools(). Reports: missing input_schema, unknown tool_type, duplicate names, HTTP tools without endpoint.                                                                                                                                                           |
| **`encryption-availability`** | Infra      | Checks if ENCRYPTION_MASTER_KEY is set and EncryptionService initialized. Reports: encrypted credentials exist but encryption unavailable.                                                                                                                                                                                      |
| **`db-availability`**         | Infra      | Checks MongoDB connection state. Reports: DB unavailable, model resolution degraded to env-only.                                                                                                                                                                                                                                |
| **`execution-status`**        | Execution  | For session/execution targets: checks last execution status, error code/message. Detects: failed with no client-visible error (the swallowing bug), repeated failures, timeout patterns.                                                                                                                                        |
| **`empty-response`**          | Execution  | Specifically: execution completed but response is empty or undefined. Correlates with: LLM not called (check if all flow steps have `REASONING: false`), LLM called but returned empty, error caught and swallowed. Key pattern: `flow_step_exit` with `durationMs: 0` and no `llm_call_*` events = reasoning zone not entered. |
| **`flow-state`**              | Execution  | Checks current flow step, whether stuck, whether reasoning zone guard is blocking. Reports: parked on step with no message, completed prematurely, step doesn't exist in IR.                                                                                                                                                    |
| **`handoff-routing`**         | Execution  | Checks handoff targets exist in registry, routing rules can match, delegation chains don't loop.                                                                                                                                                                                                                                |
| **`trace-patterns`**          | Behavioral | The existing `analyzeSession` logic (loops, tool failures, constraint violations, escalations, high LLM calls) — refactored into analyzer form.                                                                                                                                                                                 |
| **`gather-stalls`**           | Behavioral | Checks if entity collection is stuck: required fields with no progress, repeated extraction attempts, extraction with no matches.                                                                                                                                                                                               |
| **`ir-validation`**           | Infra      | Validates deployed IR: model/provider mismatch, undefined tool refs, missing handoff targets, unreachable flow steps, template ref errors, SUPERVISOR with all reasoning disabled. See [IR Integration](#ir-as-a-diagnostic-dimension).                                                                                         |
| **`ir-drift`**                | Execution  | Compares session's pinned IR against latest deployed IR. Detects stale sessions, config drift via `config_hash_tenant` (when STI Phase 0a lands). See [IR Integration](#ir-as-a-diagnostic-dimension).                                                                                                                          |

### P3.4 Runtime Diagnostic API

**File:** `apps/runtime/src/routes/diagnostics.ts` (new)

Two endpoints — broad, not narrow. Each runs the full diagnostic engine with the appropriate analyzers for the target type.

```
GET /api/projects/:projectId/diagnostics/agents/:agentName
```

Runs: model-resolution, credential-chain, tool-binding, encryption-availability, db-availability, handoff-routing.
Returns: DiagnosticReport with config snapshot, no execution/timeline data.
Use case: "Is this agent ready to run?" — `abl doctor --agent`, Studio readiness indicator.

```
GET /api/projects/:projectId/diagnostics/sessions/:sessionId
```

Runs: ALL analyzers (infra + execution + behavioral).
Returns: Full DiagnosticReport with config, findings, timeline.
Use case: "What went wrong?" — covers every failure mode in one call.

Optional query params:

- `?analyzers=model_resolution,credential_chain` — run only specific analyzers
- `?depth=quick|standard|deep` — quick (infra only), standard (infra + execution), deep (all + trace patterns)

Both require `authMiddleware` + `requireProjectPermission('agent:read')`.

### P3.5 Enhanced MCP Debug Tools

Replace four narrow tools with **two broad ones** plus an upgrade to the existing `debug_analyze_session`:

| Tool                        | Replaces                              | Schema                                                | What                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`debug_diagnose`**        | `why_empty` + `session_health`        | `{ sessionId?, depth?: 'quick'\|'standard'\|'deep' }` | Calls `GET .../diagnostics/sessions/:id`. Returns full DiagnosticReport. This is the "I'm stuck, tell me everything" tool. Covers empty responses, credential errors, tool failures, flow stalls — any failure mode. |
| **`debug_inspect`**         | `model_resolve` + `credentials_check` | `{ agentName?, sessionId? }`                          | Calls `GET .../diagnostics/agents/:name`. Returns agent config snapshot: model chain, credentials, tools, policies. The "what is configured?" tool.                                                                  |
| **`debug_analyze_session`** | (self — upgrade)                      | Same schema                                           | Refactored to use the diagnostic engine's behavioral analyzers locally (trace patterns, loops, stalls). Stays client-side for speed (no HTTP round-trip).                                                            |

**Why two tools, not one:** `debug_diagnose` answers "what went wrong?" (needs a session with execution history). `debug_inspect` answers "what is configured?" (needs only an agent name, no session needed). Different inputs, different use cases. But both return the same `DiagnosticReport` shape.

**Why upgrade `debug_analyze_session` separately:** It runs client-side on cached traces (no HTTP call to runtime). The behavioral analyzers are refactored from its current implementation. It stays fast for the common case where traces are already loaded.

### P3.6 CLI Commands

Fewer, broader commands — matching the broad tools:

| Command                        | Backend                                       | What                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abl diagnose <sessionId>`     | `GET .../diagnostics/sessions/:id?depth=deep` | Full diagnosis of a session. Replaces `why-empty`, `replay`, `session-health`. Shows: findings (sorted by severity), config snapshot, execution timeline. Color-coded output. |
| `abl inspect <agentName>`      | `GET .../diagnostics/agents/:name`            | Full config inspection. Replaces `models resolve`, `credentials check`. Shows: model chain, credential status, tool binding, policy. Color-coded pass/warn/fail.              |
| `abl doctor --agent <name>`    | Calls `inspect` + runs preflight validation   | Comprehensive health check. Extends existing `doctor` command.                                                                                                                |
| `abl agent dry-run <file.abl>` | Upload → compile → inspect                    | Compile + full diagnostic without deploying.                                                                                                                                  |

**Implementation files:**

- `kore-platform-cli/src/commands/diagnose.ts` (new) — `abl diagnose`
- `kore-platform-cli/src/commands/inspect.ts` (new) — `abl inspect`
- `kore-platform-cli/src/commands/doctor.ts` (extend) — `--agent` flag
- `kore-platform-cli/src/commands/agents.ts` (extend) — `dry-run` subcommand

### P3.7 Example Output

**`abl diagnose sess-12345`** (or `debug_diagnose` in Claude Code):

```
DIAGNOSIS: session sess-12345 (TravelDesk_Supervisor) — BROKEN

FINDINGS (2 errors, 1 warning):

  ✗ [credential_chain] No credential for provider 'openai'
    Agent resolves to model 'gpt-4.1' (provider: openai) via agent IR (level 1).
    Tenant 'travel-demo' has credentials for: anthropic.
    No active credential for 'openai' found.
    → Remove 'model: gpt-4.1' from EXECUTION to inherit tenant model (anthropic).

  ✗ [execution_status] Execution failed but error was not surfaced to client
    Last execution: status=failed, error="No credential found for provider 'openai'..."
    The WebSocket handler did not check execution.status before sending response.
    → This is a known issue fixed in commit e3a1ba268. Ensure deployment is current.

  ⚠ [encryption_availability] Encryption service not initialized
    ENCRYPTION_MASTER_KEY is not set. Encrypted credentials cannot be decrypted.
    → Set ENCRYPTION_MASTER_KEY in environment.

CONFIG:
  Model: gpt-4.1 (from agent IR, level 1)
    Level 1 (agent_ir): ✓ matched → gpt-4.1
    Level 2 (agent_db): skipped (level 1 matched)
    Level 3 (project_db): skipped
    Level 4 (tenant_model): skipped
  Credential: ✗ none for openai
    anthropic: ✓ active, encrypted, tenant-scoped
  Tools: 3 defined, 2 system (handoff_to_Sales_Agent, handoff_to_Fallback_Handler)
  Session LLM: not configured
  IR: v3, pinned at deploy d-a1b2c3 (2026-03-14T10:00:00Z)
    Drift: none (current = pinned)
    Validation: 1 error — model 'gpt-4.1' requires provider 'openai' but no credential exists

TIMELINE:
  11:58:25 [trace:abc123] session_start → TravelDesk_Supervisor loaded
  11:58:25 [trace:abc123] dsl_respond → Welcome template sent
  11:58:28 [trace:def456] execution.started → "hi"
  11:58:28 [trace:def456] execution.failed → "No credential found for provider 'openai'..."
  11:58:28 [trace:def456] (no client response sent)
```

**`abl inspect TravelDesk_Supervisor`** (or `debug_inspect` in Claude Code):

```
INSPECT: TravelDesk_Supervisor — BROKEN

MODEL RESOLUTION:
  Level 1 (agent_ir):     ✓ gpt-4.1 → provider: openai
  Level 2 (agent_db):     — skipped (level 1 matched)
  Level 3 (project_db):   — skipped
  Level 4 (tenant_model): — skipped
  Resolved: gpt-4.1 (openai) from agent_ir

CREDENTIALS:
  openai:    ✗ no active credential
  anthropic: ✓ active, encrypted, tenant-scoped (claude-sonnet-4-5-20250929)

  ⚠ Model requires 'openai' but only 'anthropic' credentials exist.
  → Remove 'model: gpt-4.1' from DSL to inherit tenant model.

TOOLS:
  DSL-defined: search(query) → http, lookup_booking(ref) → http
  System: handoff_to_Sales_Agent, handoff_to_Fallback_Handler
  All schemas valid: ✓

IR:
  Version: 3, deployed 2026-03-14T10:00:00Z (deploy d-a1b2c3)
  Validation:
    ✗ Model 'gpt-4.1' → provider 'openai' has no credential
    ✓ Handoff targets: Sales_Agent (deployed), Fallback_Handler (deployed)
    ✓ Templates: welcome (defined)
    ✓ Flow steps: all reachable from ON_START

POLICY:
  Credential policy: org_first
  Allowed providers: all
```

### P3 Phasing

| Phase | What                                                        | Risk   | Impact                                    |
| ----- | ----------------------------------------------------------- | ------ | ----------------------------------------- |
| P3-A  | Diagnostic engine + analyzer modules + 2 API endpoints      | Medium | **Highest** — unlocks everything          |
| P3-B  | `debug_diagnose` + `debug_inspect` MCP tools                | Low    | High — Claude Code gets broad diagnostics |
| P3-C  | `abl diagnose` + `abl inspect` CLI commands                 | Low    | High — developer self-service             |
| P3-D  | Upgrade `debug_analyze_session` to use behavioral analyzers | Low    | Medium — better trace analysis            |
| P3-E  | `abl doctor --agent` + `abl agent dry-run`                  | Low    | Medium                                    |

---

## P4: Studio Debug UX

### P4.1 Session Health Banner

**File:** `apps/studio/src/components/chat/SessionHealthBanner.tsx` (new)

Replaces the simple `{error && ...}` block in `ChatPanel.tsx` (L211-216).

- Populated from: `agent_loaded` (agent.errors), `trace_event` (type=error/warning), new `session_init_warnings` WS message
- Color-coded: red for errors (agent can't function), amber for warnings (degraded)
- "[View Details]" button opens debug panel
- Stacks multiple issues vertically

Add `healthIssues: SessionHealthIssue[]` to `session-store.ts`.

### P4.2 Error-First Chat Messages

**File:** `apps/studio/src/store/session-store.ts` (modify `endStreaming`)

When `streamingMessageId && !fullText` (empty response), insert a structured error system message instead of silently dropping. Pull from `healthIssues` for context.

Also: when WS `error` message arrives, inject as chat message (not just banner).

### P4.3 Model Resolution Inspector

**File:** `apps/studio/src/components/observatory/ModelResolutionInspector.tsx` (new)

New section in `OverviewTab`. Reads `session_resolution` trace events. Displays 6-level chain as vertical stepper with check/skip/match icons. Highlights the matched level and final model/provider/credential.

Requires runtime to emit `session_resolution` trace event after model resolution completes.

### P4.4 Agent Readiness Indicator

**Endpoint:** `GET /api/projects/:projectId/agents/:agentName/health` (uses P2 validation service)

**Files:**

- `apps/studio/src/hooks/useAgentHealth.ts` (new SWR hook)
- `apps/studio/src/components/agents/AgentHealthIndicator.tsx` (new)
- Integrate into `AgentCard` and `ABLEditor` status bar

Shows: Ready / Warning / Error with details on hover.

### P4.5 Trace Error Summary Tab

**File:** `apps/studio/src/components/observatory/ErrorsTab.tsx` (new)

Add `'errors'` to `DebugTab` union in `observatory-store.ts`. Filters events for type=error/warning/violation/failed. Shows timestamp, severity, code, message, agent, step. Click jumps to span.

Error count badge on tab header.

### P4 Phasing

| Phase | What                                                                | Risk   | Impact                                  |
| ----- | ------------------------------------------------------------------- | ------ | --------------------------------------- |
| P4-A  | Error-first chat messages + Trace error tab                         | Low    | **Highest** — no backend changes needed |
| P4-B  | Session health banner (needs `session_init_warnings` WS message)    | Medium | High                                    |
| P4-C  | Model resolution inspector (needs `session_resolution` trace event) | Medium | Medium                                  |
| P4-D  | Agent readiness indicator (needs P2 validation service)             | Medium | Medium                                  |

---

## P5: Claude Code Integration

### P5.1 Fix `.mcp.json`

**File:** `.mcp.json` (modify)

Add `alwaysAllow` for all read-only debug tools (18 tools minus `debug_send_message` and `debug_reset_session`). This eliminates permission friction.

### P5.2 Add Debugging Section to CLAUDE.md

**File:** `CLAUDE.md` (modify — add between "Key Rules" and "Skills Reference")

```markdown
## Debugging Runtime Issues

CRITICAL: When a user reports a runtime bug (empty response, agent error,
unexpected behavior), use the MCP debug tools FIRST — before reading source code.

Quick sequence:

1. debug_connect — connect to runtime
2. debug_diagnose — full diagnosis (config + execution + traces)
3. debug_inspect — agent config inspection (model chain, credentials, tools)
4. debug_get_errors — all errors and warnings (if traces already loaded)
```

Add `runtime-debugging` to the skills table.

### P5.3 Create Runtime Debugging Skill

**File:** `.claude/skills/runtime-debugging.md` (new)

Contents (~250 lines):

- **Debug-First Protocol** — use MCP tools before source code
- **Symptom-to-Tool Mapping** — table mapping symptoms to first/second tool and what to look for
- **Playbook: Empty Response** — step-by-step with tool calls
- **Playbook: Agent Init Error** — step-by-step
- **Playbook: Credential/Model Error** — model resolution chain explanation
- **Playbook: Session Hangs** — step-by-step
- **Playbook: Tool Call Failure** — step-by-step
- **Connection Setup** — local vs remote, auth
- **Trace Event Reference** — all 32 event types with debugging significance
- **MCP Debug Tool Reference** — all tools categorized by use case

### P5 Phasing

| Phase | What                                                                | Risk | Impact                                    |
| ----- | ------------------------------------------------------------------- | ---- | ----------------------------------------- |
| P5-A  | CLAUDE.md debugging section + skill file + `.mcp.json` fix          | None | **Highest** — immediate behavioral change |
| P5-B  | Enhanced `debug_analyze_session` (detect model resolution failures) | Low  | Medium                                    |

---

## Unified Delivery Sequence

### Sprint 1: Stop the Bleeding (3-5 days)

**Goal:** Errors are never invisible again.

| ID   | Pillar | Work                                              | Files                                                           |
| ---- | ------ | ------------------------------------------------- | --------------------------------------------------------------- |
| S1-1 | P1-A   | Preserve AppError.code in coordinator catch       | `execution-coordinator.ts`                                      |
| S1-2 | P1-A   | Fix sdk-handler.ts missing status check           | `sdk-handler.ts`                                                |
| S1-3 | P1-B   | `toClientResponse()` helper + refactor handlers   | `execution/types.ts`, `handler.ts`, `chat.ts`, `sdk-handler.ts` |
| S1-4 | P4-A   | Error-first chat messages (empty → error msg)     | `session-store.ts`, `MessageList.tsx`                           |
| S1-5 | P4-A   | Trace error summary tab                           | `observatory-store.ts`, `DebugTabs.tsx`, `ErrorsTab.tsx`        |
| S1-6 | P5-A   | CLAUDE.md + `.mcp.json` + runtime-debugging skill | `CLAUDE.md`, `.mcp.json`, `.claude/skills/runtime-debugging.md` |

### Sprint 2: Catch Before Runtime (5-7 days)

**Goal:** Misconfigurations are caught at deploy time.

| ID   | Pillar | Work                                                  | Files                                                              |
| ---- | ------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| S2-1 | P2-A   | Compile-time validators (tool schema, reasoning zone) | `validate-preflight.ts`, `validation-types.ts`, `validate-ir.ts`   |
| S2-2 | P2-B   | Deploy-time validation service                        | `preflight-validation-service.ts`                                  |
| S2-3 | P2-B   | `/validate` endpoint                                  | `validate.ts`, `server.ts`                                         |
| S2-4 | P2-C   | Deployment gate (block on errors)                     | `deployments.ts`                                                   |
| S2-5 | P1-C   | Session health tracking                               | `types.ts`, `llm-wiring.ts`, `trace-store.ts`                      |
| S2-6 | P4-B   | Session health banner                                 | `SessionHealthBanner.tsx`, `ChatPanel.tsx`, `WebSocketContext.tsx` |

### Sprint 3: Unified Diagnostic Engine (5-7 days)

**Goal:** One command tells you everything that's wrong. Developers and AI assistants can diagnose any failure mode in < 2 minutes.

| ID   | Pillar | Work                                                                 | Files                                                               |
| ---- | ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| S3-1 | P3-A   | Diagnostic engine types + analyzer framework                         | `services/diagnostics/types.ts`, `services/diagnostics/engine.ts`   |
| S3-2 | P3-A   | Infrastructure analyzers (model, credentials, tools, encryption, DB) | `services/diagnostics/analyzers/*.ts`                               |
| S3-3 | P3-A   | Execution analyzers (status, empty response, flow state, handoff)    | `services/diagnostics/analyzers/*.ts`                               |
| S3-4 | P3-A   | 2 diagnostic API endpoints                                           | `routes/diagnostics.ts`, `server.ts`                                |
| S3-5 | P3-B   | `debug_diagnose` + `debug_inspect` MCP tools                         | `mcp-debug/src/tools/diagnose.ts`, `mcp-debug/src/tools/inspect.ts` |
| S3-6 | P3-C   | `abl diagnose` + `abl inspect` CLI commands                          | `cli/src/commands/diagnose.ts`, `cli/src/commands/inspect.ts`       |
| S3-7 | P4-C   | Model resolution inspector (reads diagnostic API)                    | `ModelResolutionInspector.tsx`, `OverviewTab.tsx`                   |
| S3-8 | P4-D   | Agent readiness indicator (reads diagnostic API)                     | `AgentHealthIndicator.tsx`, `useAgentHealth.ts`                     |

### Sprint 4: Polish & Extend (3-5 days)

| ID   | Pillar | Work                                                      | Files                                            |
| ---- | ------ | --------------------------------------------------------- | ------------------------------------------------ |
| S4-1 | P1-D   | Never-swallow audit (replace empty catches)               | `llm-wiring.ts`, `trace-store.ts`                |
| S4-2 | P3-D   | Upgrade `debug_analyze_session` with behavioral analyzers | `mcp-debug/src/tools/analysis.ts`                |
| S4-3 | P3-E   | `abl doctor --agent` + `abl agent dry-run`                | `doctor.ts`, `agents.ts`                         |
| S4-4 | P2-D   | Studio CreateDeploymentDialog + ABLEditor validation      | `CreateDeploymentDialog.tsx`, `DslEditorTab.tsx` |

---

## Cross-Cutting: IR & STI Integration

The debugging plan intersects with three existing design efforts: **IR inspection**, **STI (Spatial Trace Intelligence)**, and the **Session Trace Architecture Simplification**. Rather than adding new pillars, these integrate into P2 (Pre-flight), P3 (Diagnostic Engine), and P4 (Studio).

### IR as a Diagnostic Dimension

The compiled Agent IR is the canonical truth of what an agent _should_ do. The diagnostic engine must compare what's deployed (IR) against what's actually happening (traces/execution). Today, the Studio has `IRViewer.tsx` which renders IR as static JSON — useful for reading, but not for diagnosing discrepancies.

#### IR Analyzer (add to P3 analyzer list)

| Analyzer            | Category  | What It Checks                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ir-validation`** | Infra     | Validates deployed IR against runtime expectations. Detects: model specified in IR but no credential for that provider, tools referenced in IR but not in tool registry, handoff targets in IR but target agents not deployed, reasoning zones without model inheritance path, flow steps referencing non-existent templates. |
| **`ir-drift`**      | Execution | Compares the session's pinned IR (`RuntimeSession.versionInfo`) against the latest deployed IR. Detects: session running stale IR after redeployment, IR fields that changed between pinned and current version (model, tools, flow steps, handoff targets). Reports which changes are relevant to the current failure.       |

#### IR in Diagnostic Report (extend `config` section)

```typescript
// Add to DiagnosticReport.config
ir?: {
  pinned: {
    version: number;
    deploymentId: string;
    compiledAt: string;
  };
  current?: {
    version: number;
    deploymentId: string;
    compiledAt: string;
  };
  drift: boolean;              // pinned !== current
  driftSummary?: string[];     // e.g. ["model changed: gpt-4.1 → claude-sonnet-4-5-20250929", "tool 'search' removed"]
  validationErrors: string[];  // IR-level issues (tool refs, handoff targets, etc.)
};
```

#### IR in Pre-flight Validation (extend P2)

The compile-time checks (P2.1) already validate tool schemas and reasoning zones. Add:

| Check                     | Code                                | Severity | What                                                                       |
| ------------------------- | ----------------------------------- | -------- | -------------------------------------------------------------------------- |
| Handoff target exists     | `HANDOFF_TARGET_NOT_IN_COMPILATION` | Error    | Every `HANDOFF.TO` agent must be in the compilation unit                   |
| Template references valid | `TEMPLATE_REF_MISSING`              | Error    | Every `TEMPLATE()` call references a defined template                      |
| Flow step continuity      | `FLOW_STEP_UNREACHABLE`             | Warning  | Flow steps that can never be reached from ON_START                         |
| IR hash stability         | `IR_HASH_CHANGED`                   | Info     | IR content hash changed since last deployment (informational for CI gates) |

#### IR in Studio (extend P4)

Upgrade `IRViewer.tsx` from static display to diagnostic-aware:

- **Diff view**: When `ir-drift` analyzer reports drift, show side-by-side diff of pinned vs current IR (highlight changed fields)
- **Validation overlay**: Annotate IR nodes with pre-flight validation results (red badges on nodes with errors)
- **Link from diagnostic findings**: When `abl diagnose` or Studio diagnostic panel shows an IR-related finding, deep-link to the relevant IR node in the viewer

### STI Integration

STI (design doc: `2026-03-11-spatial-trace-intelligence-design.md`) is a parallel trace system for platform engineers. It's NOT a replacement for the diagnostic engine — STI answers "what happened in THE SYSTEM?" while the diagnostic engine answers "what's wrong with THIS agent?". But they share infrastructure and feed each other.

#### Phase -1: Per-Turn Trace IDs → Diagnostic Correlation

STI Phase -1 (`2026-03-11-sti-phase-minus-1-implementation.md`) establishes per-turn `traceId` generation via `AsyncLocalStorage` at every channel entry point. The diagnostic engine benefits directly:

- **DiagnosticReport gets `traceId`**: When diagnosing a specific execution, include the per-turn `traceId` from Phase -1. This lets developers jump from a diagnostic finding to the exact trace events for that turn.
- **`debug_diagnose` correlates by traceId**: Instead of scanning all session traces, the execution analyzers can filter to the specific turn's `traceId` for precise diagnosis.
- **Timeline entries include traceId**: Each entry in `DiagnosticReport.timeline[]` carries the per-turn `traceId`, enabling trace-level drill-down.

```typescript
// Extend DiagnosticReport.timeline entries
timeline?: Array<{
  timestamp: string;
  type: string;
  summary: string;
  isError: boolean;
  traceId?: string;  // Per-turn trace ID from Phase -1
}>;
```

**Dependency**: Phase -1 must land before the diagnostic engine can use per-turn traceIds. The diagnostic engine works without them (falls back to session-level correlation), but trace precision improves dramatically with them.

#### Phase 0a: config_hash → Config Drift Detection

STI Phase 0a (`2026-03-11-sti-phase-0a-implementation.md`) introduces three-level config hashing:

```
config_hash_full   = sha256(dsl_hash + tenant_config_hash + flags_bitmap + code_version + ir_schema_version)
config_hash_system = sha256(code_version + ir_schema_version + flags_bitmap)
config_hash_tenant = sha256(dsl_hash + tenant_config_hash)
```

The diagnostic engine reuses this infrastructure:

- **`ir-drift` analyzer uses `config_hash_tenant`**: If the session's `config_hash_tenant` differs from the current deployment's, the agent's effective configuration has changed. This is a stronger signal than comparing IR version numbers alone — it catches tenant-level config changes (model selection, guardrail policies) that don't change the IR.
- **Config snapshots for diagnostic evidence**: STI's config snapshot store (keyed by `config_hash`, containing structural configuration only) provides the exact configuration that was active during a failing execution. The diagnostic engine includes the config snapshot hash in evidence, and the snapshot can be retrieved for detailed comparison.
- **Pre-flight validation stores config hash**: When P2 deploy-time validation runs, it computes and stores the `config_hash_full`. Subsequent diagnostic runs can compare the current `config_hash_full` against the one at deployment time to detect any configuration drift.

**Dependency**: Phase 0a provides the `config_hash` computation and snapshot storage. The diagnostic engine can operate without it (uses direct config comparison), but config_hash gives a fast "has anything changed?" check before doing expensive field-by-field comparison.

#### STI ↔ Diagnostic Engine Boundary

| Concern  | Diagnostic Engine (this plan)           | STI                                     |
| -------- | --------------------------------------- | --------------------------------------- |
| Audience | Agent developers, AI assistants         | Platform engineers, SRE                 |
| Scope    | Single agent/session                    | Cross-tenant, cross-component           |
| Data     | Rich text (config, errors, suggestions) | Numerical coordinates, resource vectors |
| Access   | Tenant-scoped (project permissions)     | Platform-team-only                      |
| Storage  | Runtime in-memory + MongoDB             | ClickHouse `spatial_trace_records`      |

The engines are **complementary, not overlapping**. A platform engineer investigating a systemic issue uses STI to find the pattern, then uses the diagnostic engine (via `abl diagnose`) to drill into specific affected sessions. The per-turn `traceId` is the bridge between the two systems.

### Session Trace Architecture Alignment

The Session Trace Architecture Simplification (`2026-03-13-session-trace-architecture-design.md`) directly impacts the diagnostic API design:

#### Single Session ID

The design eliminates dual session IDs (`MongoDB _id` vs `runtime UUID`). The diagnostic API endpoints use the single session ID:

```
GET /api/projects/:projectId/diagnostics/sessions/:sessionId
```

No dual-lookup fallback needed. The `sessionId` in the URL is the only ID. This simplifies the diagnostic engine's session loading — no `findSessionByRuntimeId` fallback code.

#### WAL-Backed Traces

With `EVENTSTORE_RESILIENCE_ENABLED=true` by default, trace events survive pod restarts. The diagnostic engine's execution and behavioral analyzers can trust that ClickHouse has complete trace data. Before this, the diagnostic engine would need to handle "traces exist in-memory but not in ClickHouse" — the buffer window gap. WAL eliminates this gap.

Impact on P3 analyzers:

- **`execution-status`**: Can query ClickHouse directly instead of waterfall (in-memory → ClickHouse)
- **`trace-patterns`**: Complete trace data means pattern detection is reliable, not degraded by missing events
- **`empty-response`**: Can definitively say "LLM was never called" vs "LLM trace event was lost"

#### Milestone-Based Persistence

Session state is persisted to MongoDB on milestones (message completion, handoff, session end). The diagnostic engine's infra analyzers read session state from MongoDB. With milestone persistence, the data is guaranteed fresh after each completed turn — the `ir-drift` and `flow-state` analyzers see accurate state.

### Updated Sprint Plan Items

These IR/STI items integrate into existing sprints:

#### Sprint 2 (additions)

| ID   | Pillar | Work                                                                  | Files                   |
| ---- | ------ | --------------------------------------------------------------------- | ----------------------- |
| S2-7 | P2-A   | IR pre-flight: handoff target, template ref, flow reachability checks | `validate-preflight.ts` |

#### Sprint 3 (additions)

| ID    | Pillar | Work                                                          | Files                                             |
| ----- | ------ | ------------------------------------------------------------- | ------------------------------------------------- |
| S3-9  | P3-A   | `ir-validation` analyzer                                      | `services/diagnostics/analyzers/ir-validation.ts` |
| S3-10 | P3-A   | `ir-drift` analyzer (pinned vs current IR comparison)         | `services/diagnostics/analyzers/ir-drift.ts`      |
| S3-11 | P3-A   | Add `ir` section to `DiagnosticReport.config`                 | `services/diagnostics/types.ts`                   |
| S3-12 | P3-A   | Per-turn `traceId` in diagnostic timeline (requires Phase -1) | `services/diagnostics/engine.ts`                  |

#### Sprint 4 (additions)

| ID   | Pillar | Work                                                                 | Files                            |
| ---- | ------ | -------------------------------------------------------------------- | -------------------------------- |
| S4-5 | P4     | IRViewer diff mode (pinned vs current, validation overlay)           | `IRViewer.tsx`, `IRDiffView.tsx` |
| S4-6 | P3     | `config_hash` integration in `ir-drift` analyzer (requires Phase 0a) | `analyzers/ir-drift.ts`          |

---

## Key Architectural Decisions

1. **`toClientResponse()` is a function, not a method** — Execution is a plain interface in a pure package. A standalone function preserves serialization.

2. **Resolve-always pattern is correct** — The coordinator should keep resolving (not rejecting) on failure. The fix is making handlers check status via `toClientResponse()`, not changing the pattern.

3. **Preflight validation uses direct repo queries, not full ModelResolutionService** — Avoids encryption dependency and cache pollution. Checks credential existence, not validity.

4. **Deploy-time errors are blocking (422), warnings are advisory** — Matches existing `deploymentWarnings` pattern.

5. **All diagnostic data lives in the runtime** — CLI and MCP tools are thin HTTP clients calling diagnostic endpoints. No direct DB access from CLI.

6. **Credential diagnostics never expose plaintext keys** — Returns existence, active status, provider, scope. Never the actual key.

7. **Operational vs functional failure distinction** — If a failure means the agent cannot respond, it's functional and MUST be surfaced. Everything else can log-and-continue.

8. **Broad tools, not narrow** — Two diagnostic verbs (`diagnose` = what went wrong, `inspect` = what is configured) with pluggable analyzers. New failure modes get a new analyzer module, not a new tool/command/endpoint. The engine scales without API surface growth.

9. **Same DiagnosticReport shape everywhere** — CLI, MCP tools, Studio, and API all consume the same `DiagnosticReport`. No per-consumer formatting in the engine. Rendering is the consumer's job.

10. **IR is a diagnostic dimension, not just a viewer** — The compiled IR is the contract between DSL author and runtime. The diagnostic engine validates that contract (ir-validation) and detects when it's stale (ir-drift). Studio's IRViewer evolves from read-only display to diagnostic-annotated diff view.

11. **STI and the diagnostic engine are complementary, not overlapping** — STI serves platform engineers with numerical cross-tenant patterns (no PII). The diagnostic engine serves agent developers with rich per-session diagnosis. They share infrastructure: per-turn `traceId` (Phase -1) for correlation, `config_hash` (Phase 0a) for drift detection. The `traceId` is the bridge between the two systems.

12. **Session Trace Architecture simplification is a prerequisite, not a dependency** — The diagnostic engine works with the current dual-ID system (adds fallback logic). But it's designed for the simplified single-ID model. When Session Trace Architecture lands, the fallback code is deleted — not rewritten. WAL-backed traces eliminate the "was the trace event lost or was LLM never called?" ambiguity that would otherwise plague the `empty-response` analyzer.

---

## Success Metrics

After full implementation, the "empty response" debugging scenario should go from **2 hours** to **< 2 minutes**:

| Step                             | Before                        | After                                                               |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| Deploy agent with wrong model    | Silent success                | **422 error: "No credential for provider 'openai'"**                |
| Send message, get empty response | Nothing visible               | **Error in chat: "Execution failed: MODEL_NOT_CONFIGURED"**         |
| Developer investigates           | Read source code for 2 hours  | **`abl diagnose <sessionId>` → full diagnosis in 5 seconds**        |
| Claude Code helps debug          | Reads source code, misses CLI | **Uses `debug_diagnose` → all findings + root cause + suggestions** |
| Understand agent config          | Manual log + DB queries       | **`abl inspect <agentName>` → model chain + credentials + tools**   |
| Check if agent is ready          | Deploy and hope               | **`abl doctor --agent X` → preflight validation before deploy**     |
