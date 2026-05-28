---
description: Runtime debugging guide — MCP debug tools, symptom-to-tool mapping, and diagnostic playbooks
---

# Runtime Debugging Skill

## Debug-First Protocol

When debugging runtime agent issues, ALWAYS use MCP debug tools before reading source code. The debug server provides real-time access to session state, traces, and diagnostics.

## Connection Setup

```
# Local development
debug_connect → connects to localhost:3112

# Custom endpoint
debug_connect with runtimeUrl parameter
```

## Symptom-to-Tool Mapping

| Symptom                     | First Tool              | Second Tool              | What to Look For                                                                 |
| --------------------------- | ----------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Empty response, no error    | `debug_diagnose`        | `debug_get_traces`       | Model not configured, credential missing, SUPERVISOR with all reasoning disabled |
| Agent returns error         | `debug_get_errors`      | `debug_get_state`        | Error code, execution status, LLM provider errors                                |
| Wrong agent handles message | `debug_analyze_session` | `debug_explain_decision` | Handoff routing logic, condition evaluation, routing rules                       |
| Session hangs / no response | `debug_analyze_session` | `debug_get_traces`       | Gather stalls, infinite loops, tool timeouts                                     |
| Tool call fails             | `debug_get_errors`      | `debug_get_traces`       | Tool binding errors, HTTP endpoint failures, schema validation                   |
| Model/credential error      | `debug_inspect`         | `debug_get_errors`       | 6-level model resolution chain, credential existence, provider policy            |
| Unexpected flow transition  | `debug_get_flow_graph`  | `debug_get_traces`       | Flow step conditions, reasoning zone evaluation, step transitions                |

## Playbook: Empty Response

1. `debug_connect` — ensure connection to runtime
2. `debug_list_sessions` — find the session ID
3. `debug_diagnose { sessionId }` — get full diagnostic report
4. Check findings for:
   - `MODEL_NOT_CONFIGURED` — no model at any resolution level
   - `CREDENTIAL_NOT_FOUND` — model resolves but no credential for its provider
   - `SUPERVISOR_NO_REASONING_STEP` — all flow steps have reasoning disabled
   - `EXECUTION_FAILED` — error swallowed in handler
5. Follow the `suggestion` field in each finding

## Playbook: Agent Init / Credential Error

1. `debug_connect`
2. `debug_inspect { agentName }` — inspect agent configuration
3. Check model resolution chain:
   - Level 1: Agent IR (DSL model field)
   - Level 2: Agent DB config
   - Level 3: Project DB config
   - Level 4: Tenant model (default)
   - Level 5: Environment variable
   - Level 6: Hardcoded fallback
4. Check credential status for the resolved provider
5. Common fix: Remove `model:` from DSL to inherit tenant-level model

## Playbook: Session Hangs

1. `debug_connect`
2. `debug_analyze_session { sessionId }` — automated analysis
3. Check for:
   - Loop detection (agent repeating same actions)
   - Gather stalls (entity extraction stuck on required fields)
   - Tool timeouts (external service not responding)
   - LLM call count (excessive calls indicate loops)
4. `debug_get_traces { sessionId, filter: 'error' }` — check for silent errors

## Playbook: Tool Call Failure

1. `debug_get_errors { sessionId }` — find tool error events
2. `debug_get_traces { sessionId, eventType: 'tool_call_error' }`
3. Check:
   - Tool type (http, mcp, sandbox, lambda)
   - Input schema validation errors
   - HTTP endpoint connectivity
   - MCP server availability
4. `debug_get_state { sessionId }` — check tool configuration in session

## MCP Debug Tool Reference

### Connection & Discovery

- `debug_connect` — Connect to runtime (required first)
- `debug_list_sessions` — List active sessions
- `debug_list_agents` — List deployed agents
- `debug_subscribe_session` — Watch session events in real-time

### Diagnosis

- `debug_diagnose` — Full diagnostic report (config + execution + traces)
- `debug_inspect` — Agent config inspection (model chain, credentials, tools)
- `debug_analyze_session` — Automated behavioral analysis (loops, stalls, escalations)
- `debug_explain_decision` — Explain specific agent decisions (handoffs, routing)

### Raw Data

- `debug_get_state` — Current session state (agent, flow step, variables)
- `debug_get_traces` — Trace events with filtering
- `debug_get_errors` — Error and warning events only
- `debug_get_spans` — Span tree hierarchy
- `debug_get_flow_graph` — Visual flow graph

### Interaction (use with caution)

- `debug_send_message` — Send a message to a session (NOT in alwaysAllow)

## Trace Event Types (Debugging Significance)

| Event Type             | When Emitted             | Debugging Use                                         |
| ---------------------- | ------------------------ | ----------------------------------------------------- |
| `session.start`        | Session created          | Verify agent loaded correctly                         |
| `session.health`       | After LLM wiring         | Check init warnings (missing credentials, encryption) |
| `execution.started`    | Message received         | Confirm message reached executor                      |
| `execution.completed`  | Response sent            | Verify response was generated                         |
| `execution.failed`     | Error occurred           | Get error code and message                            |
| `llm_call.start`       | LLM request sent         | Verify LLM is being called                            |
| `llm_call.end`         | LLM response received    | Check response content, token usage                   |
| `tool_call.start`      | Tool invoked             | Verify tool execution                                 |
| `tool_call.error`      | Tool failed              | Get tool error details                                |
| `flow_step.enter`      | Step transition          | Track flow progression                                |
| `flow_step.exit`       | Step completed           | Check step duration, exit reason                      |
| `handoff.start`        | Agent transfer initiated | Verify handoff routing                                |
| `handoff.complete`     | Agent transfer done      | Confirm target agent received control                 |
| `constraint.violation` | Guardrail triggered      | Check which constraint, what input                    |
