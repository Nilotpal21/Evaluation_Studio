# Agent Blueprint Language (ABL) - Implementation Status

> **Last Updated**: 2026-03-25
> **Total Tests**: 14,000+ passing (67 core + 4,476 compiler + 8,861+ runtime + 111 CLI) | 32 skipped (require LLM API key)
> **Packages**: 8 libraries + 3 apps

---

## Quick Status

| Layer                                         | Status             | Coverage                                                                                                                |
| --------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Parser** (`@abl/core`)                      | ✅ Complete        | 100% of core constructs including guardrails                                                                            |
| **Compiler** (`@abl/compiler`)                | ✅ Complete        | 100% of constructs + graph extraction + guardrails                                                                      |
| **Runtime** (`@agent-platform/server`)        | 🔶 Mostly Complete | ~97% (guardrail execution not wired; HOOKS, ON_ERROR, ESCALATE, ACTION_HANDLERS, behavior profiles, voice IR now wired) |
| **Observatory UI** (`@agent-platform/studio`) | ✅ Complete        | Full debugging interface (breakpoints not implemented)                                                                  |
| **MCP Debug** (`@agent-platform/mcp-debug`)   | ✅ Complete        | 15 debug tools for Claude Code integration                                                                              |
| **CLI** (`@agent-platform/cli`)               | ✅ Complete        | Login, run, debug, MCP server mode                                                                                      |
| **Analyzer** (`@abl/analyzer`)                | ✅ Complete        | Static analysis + conflict detection                                                                                    |
| **Extensions**                                | ❌ Not Started     | Design docs only                                                                                                        |

---

## Package Overview

| Package                      | Name                              | Tests   | Status               |
| ---------------------------- | --------------------------------- | ------- | -------------------- |
| `packages/core`              | `@abl/core`                       | 67/67   | ✅                   |
| `packages/compiler`          | `@abl/compiler`                   | 641/641 | ✅                   |
| `packages/analyzer`          | `@abl/analyzer`                   | 20/20   | ✅                   |
| `packages/observatory`       | `@agent-platform/observatory`     | —       | ✅                   |
| `packages/mcp-debug`         | `@agent-platform/mcp-debug`       | 58/58   | ✅                   |
| `packages/kore-platform-cli` | `@agent-platform/cli`             | 148/148 | ✅                   |
| `packages/editor`            | `@abl/editor`                     | —       | ✅                   |
| `packages/nl-parser`         | `@abl/nl-parser`                  | —       | ✅                   |
| `apps/runtime`               | `@agent-platform/server`          | 8,861+  | 🔶 (32 need API key) |
| `apps/studio`                | `@agent-platform/studio`          | —       | ✅                   |
| `apps/observatory-cli`       | `@agent-platform/observatory-cli` | —       | ✅                   |

---

## Core Constructs

| Construct                   | Parser | Compiler | Runtime                                         | Tests |
| --------------------------- | ------ | -------- | ----------------------------------------------- | ----- |
| `AGENT`                     | ✅     | ✅       | ✅                                              | 50+   |
| `MODE` (reasoning/scripted) | ✅     | ✅       | ✅                                              | 30+   |
| `GOAL`                      | ✅     | ✅       | ✅                                              | 10+   |
| `PERSONA`                   | ✅     | ✅       | ✅                                              | 10+   |
| `LIMITATIONS`               | ✅     | ✅       | ✅                                              | 5+    |
| `TOOLS`                     | ✅     | ✅       | ✅ Real HTTP/MCP/Lambda/Sandbox                 | 80+   |
| `GATHER`                    | ✅     | ✅       | ✅                                              | 20+   |
| `MEMORY`                    | ✅     | ✅       | ✅ Session + persistent (MongoDB)               | 10+   |
| `CONSTRAINTS`               | ✅     | ✅       | ✅ Phase + numeric                              | 15+   |
| `GUARDRAILS`                | ✅     | ✅       | 🔶 Parsed + compiled, execution not wired       | 13    |
| `HANDOFF`                   | ✅     | ✅       | ✅                                              | 15+   |
| `DELEGATE`                  | ✅     | ✅       | 🔶 Basic                                        | 10+   |
| `COMPLETE`                  | ✅     | ✅       | ✅                                              | 10+   |
| `ON_ERROR`                  | ✅     | ✅       | ✅ ErrorHandlerRouter + retry                   | 30+   |
| `ESCALATE`                  | ✅     | ✅       | ✅ Resolution handler + ITSM + distributed lock | 25+   |
| `HOOKS`                     | ✅     | ✅       | ✅ 4 lifecycle points (before/after agent/turn) | 20+   |
| `ACTION_HANDLERS`           | ✅     | ✅       | ✅ Step-level + agent-level fallback            | 9+    |
| `BEHAVIOR_PROFILES`         | ✅     | ✅       | ✅ Per-turn re-evaluation + voice override      | 27+   |

---

## Compiler Features

| Feature                    | Status      | Location                                                            |
| -------------------------- | ----------- | ------------------------------------------------------------------- |
| `compileDSLtoIR()`         | ✅ Complete | `compiler/src/platform/ir/compiler.ts`                              |
| IR Schema (50+ types)      | ✅ Complete | `compiler/src/platform/ir/schema.ts`                                |
| Static graph extraction    | ✅ Complete | `compiler/src/platform/ir/graph-extractor.ts`                       |
| App-level graph extraction | ✅ Complete | `compiler/src/platform/ir/app-graph-extractor.ts`                   |
| Flow executor              | ✅ Complete | `compiler/src/platform/constructs/executors/flow-executor.ts`       |
| Constraint executor        | ✅ Complete | `compiler/src/platform/constructs/executors/constraint-executor.ts` |
| Guardrails compilation     | ✅ Complete | Compiles to `AgentIR.constraints.guardrails[]`                      |
| Digression handling        | ✅ Complete | Intent-based escapes with goto/delegate/respond                     |
| Sub-intent handling        | ✅ Complete | Scoped intents within steps                                         |
| Correction detection       | ✅ Complete | Patterns for "actually X", "no Y"                                   |
| LLM response caching       | ✅ Complete | 100% cache hit rate in tests (1555 cached entries)                  |

---

## Flow Mode Constructs (Scripted)

| Construct                 | Parser | Compiler | Runtime | Tests |
| ------------------------- | ------ | -------- | ------- | ----- |
| `FLOW`                    | ✅     | ✅       | ✅      | 45+   |
| `PROMPT`                  | ✅     | ✅       | ✅      | 20+   |
| `COLLECT`                 | ✅     | ✅       | ✅      | 20+   |
| `CALL`                    | ✅     | ✅       | ✅      | 80+   |
| `RESPOND`                 | ✅     | ✅       | ✅      | 30+   |
| `ON_INPUT`                | ✅     | ✅       | ✅      | 15+   |
| `ON_SUCCESS/ON_FAIL`      | ✅     | ✅       | ✅      | 10+   |
| `SET`                     | ✅     | ✅       | ✅      | 15+   |
| `CHECK` (constraints)     | ✅     | ✅       | ✅      | 8+    |
| `THEN`                    | ✅     | ✅       | ✅      | 20+   |
| `PRESENT`                 | ✅     | ✅       | ✅      | 5+    |
| Navigation (back, change) | ✅     | ✅       | ✅      | 8     |

---

## Tracing & Debugging

| Feature                     | Status             | Notes                                                |
| --------------------------- | ------------------ | ---------------------------------------------------- |
| WebSocket real-time events  | ✅ Complete        | 22+ event types                                      |
| `flow_step` events          | ✅ Complete        | Step transitions tracked                             |
| `tool_call` events          | ✅ Complete        | Tool execution with inputs/outputs                   |
| `dsl_call` events           | ✅ Complete        | Higher-level CALL construct                          |
| `dsl_respond` events        | ✅ Complete        | Response with template info                          |
| `entity_extraction` events  | ✅ Complete        | LLM + regex extraction                               |
| `constraint_check` events   | ✅ Complete        | With relevant context and evaluation results         |
| `llm_call` events           | ✅ Complete        | Token counts, model, stop reason                     |
| `handoff` events            | ✅ Complete        | Inter-agent routing                                  |
| State machine visualization | ✅ Complete        | Dagre.js layout, execution highlighting              |
| App-level visualization     | ✅ Complete        | Multi-agent swimlanes via AppStaticGraph             |
| Session timeline            | ✅ Complete        | LLM latency, tool times, token usage, volley metrics |
| GatherProgress panel        | ✅ Complete        | Synced with collected data (recently fixed)          |
| MCP debug server            | ✅ Complete        | 15 tools for Claude Code integration                 |
| Breakpoints                 | ❌ Not implemented | Types defined, no execution                          |
| Trace export                | ❌ Not implemented |                                                      |
| Trace playback              | ❌ Not implemented |                                                      |
| Distributed tracing         | ❌ Not implemented | Planned in multi-tenant TODO                         |

---

## Observatory UI (`@agent-platform/studio`)

| Component           | Status      | Notes                                              |
| ------------------- | ----------- | -------------------------------------------------- |
| StateMachineView    | ✅ Complete | Dagre layout, pan/zoom, heatmap overlay, node drag |
| AppStateMachineView | ✅ Complete | Multi-agent swimlanes with inter-agent edges       |
| DebugTabs           | ✅ Complete | Context, History, IR, Logs                         |
| SpanTree            | ✅ Complete | Hierarchical view with timing                      |
| EventTimeline       | ✅ Complete | Chronological with expandable details              |
| SessionTimeline     | ✅ Complete | Metrics dashboard (latency, tokens, volleys)       |
| ConstraintMonitor   | ✅ Complete | Pass/fail tracking                                 |
| GatherProgressPanel | ✅ Complete | Data collection progress (synced)                  |
| AppNavigator        | ✅ Complete | Hierarchical agent/app selection                   |
| View mode selector  | ✅ Complete | Graph/Chat/Split/App modes                         |
| Chat interface      | ✅ Complete | WebSocket-based with streaming                     |
| ABL Editor          | ✅ Complete | Monaco editor integration                          |
| Project Dashboard   | ✅ Complete | Project selection + agent management               |
| Command palette     | ✅ Complete | Quick navigation                                   |
| Floating panels     | ✅ Complete | Activity, State, Flow, Source, Editor, Monitor     |

---

## Authentication & Security

### Unified Auth Middleware

All three auth flows converge to a fully-populated `TenantContextData` via `createUnifiedAuthMiddleware()` in `packages/shared/src/middleware/unified-auth.ts`. The middleware detects the auth method from headers and delegates to the appropriate handler.

| Header                        | Flow         | Handler                                                          |
| ----------------------------- | ------------ | ---------------------------------------------------------------- |
| `Authorization: Bearer abl_*` | API Key      | SHA-256 hash lookup → scopes, project/env restrictions           |
| `Authorization: Bearer <jwt>` | User JWT     | Verify → user lookup → tenant membership → permission resolution |
| `X-SDK-Token: <token>`        | SDK Session  | Verify aud/iss claims → channel-scoped context                   |
| None                          | Pass-through | `next()` — downstream guards reject if auth required             |

### Auth Feature Matrix

| Feature                        | Status      | Notes                                                                                                            |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| **Unified auth middleware**    | ✅ Complete | Three flows → `TenantContextData` via AsyncLocalStorage                                                          |
| User JWT (Scenario 1)          | ✅ Complete | Tenant-scoped tokens, configurable expiry                                                                        |
| SDK Session Token (Scenario 2) | ✅ Complete | `pk_*` key exchange → 4h JWT via `POST /api/v1/sdk/init`, refresh via `/api/v1/sdk/refresh`                      |
| API Key Auth (Scenario 3)      | ✅ Complete | `abl_*` keys with SHA-256 hash, scopes, project/environment restrictions                                         |
| Google OAuth                   | ✅ Complete | OIDC-based login flow                                                                                            |
| Refresh token rotation         | ✅ Complete | Reuse detection revokes all tokens                                                                               |
| Device Authorization Flow      | ✅ Complete | RFC 8628 for CLI login                                                                                           |
| Dev-login                      | ✅ Complete | Development mode without OAuth                                                                                   |
| Debug tokens                   | ✅ Complete | Scoped, expiring tokens for CLI/MCP                                                                              |
| Audit logging                  | ✅ Complete | Auth events (success/failure), fire-and-forget to AuditLog                                                       |
| Rate limiting                  | ✅ Complete | Per-tenant sliding window: auth 20/15min, API 100/min, SDK init 30/min                                           |
| RBAC                           | ✅ Complete | Role-based (OWNER/ADMIN/OPERATOR/MEMBER/VIEWER) + granular `RoleDefinition` + `ResourcePermission`               |
| Permission guards              | ✅ Complete | `requirePermission()`, `requireProjectScope()`, `requireEnvironmentScope()`, `requireAuthType()`                 |
| Tenant switching               | ✅ Complete | `GET /api/auth/tenants` + `POST /api/auth/tenants/switch`                                                        |
| SSO (SAML/OIDC)                | ✅ Complete | SP-init + IdP-init SAML, OIDC flows, encrypted config, replay protection. See [STUDIO_AUTH.md](./STUDIO_AUTH.md) |
| MFA (TOTP + Recovery)          | ✅ Complete | RFC 6238 TOTP, encrypted secrets, bcrypt-hashed recovery codes, lockout. See [STUDIO_AUTH.md](./STUDIO_AUTH.md)  |
| LinkedIn OAuth                 | ✅ Complete | OIDC-based login flow with email verification check                                                              |
| Microsoft OAuth                | ✅ Complete | MS Graph profile, id_token email verification, SSO enforcement check                                             |

---

## MCP Debug Server (`@agent-platform/mcp-debug`)

| Tool                      | Status | Purpose                         |
| ------------------------- | ------ | ------------------------------- |
| `debug_connect`           | ✅     | Connect to server WebSocket     |
| `debug_list_agents`       | ✅     | List available agents by domain |
| `debug_load_agent`        | ✅     | Load agent and create session   |
| `debug_send_message`      | ✅     | Send message to agent           |
| `debug_get_recent_traces` | ✅     | Get trace events with filters   |
| `debug_get_current_state` | ✅     | Get agent state snapshot        |
| `debug_get_span_tree`     | ✅     | Hierarchical span visualization |
| `debug_get_errors`        | ✅     | Errors and warnings             |
| `debug_search_traces`     | ✅     | Search by text, type, agent     |
| `debug_explain_decision`  | ✅     | Decision context analysis       |
| `debug_get_flow_graph`    | ✅     | Execution graph (JSON/Mermaid)  |
| `debug_analyze_session`   | ✅     | Automated diagnostics           |
| `debug_get_docs`          | ✅     | ABL documentation by topic      |
| `debug_search_docs`       | ✅     | Search documentation            |

**Tests**: 58 passing (analysis: 33, docs: 25)

---

## MCP Architect & Import Tools (`@agent-platform/cli`)

| Tool                      | Status | Purpose                                         |
| ------------------------- | ------ | ----------------------------------------------- |
| `kore_architect_analyze`  | ✅     | Analyze use case and generate architecture spec |
| `kore_architect_gaps`     | ✅     | Detect ABL limitations and suggest alternatives |
| `kore_architect_generate` | ✅     | Generate ABL files from architecture            |
| `kore_architect_scaffold` | ✅     | Create project directory with docs              |
| `kore_import_analyze`     | ✅     | Analyze Agent Platform v12 or XO11 exports      |
| `kore_import_convert`     | ✅     | Convert to ABL files                            |
| `kore_validate_abl`       | ✅     | Validate ABL syntax and structure               |

**Supported Import Formats:**

- Kore.ai Agent Platform v12 (orchestrationPrompt, MCPServers, agents)
- Kore.ai XO11 (dialogFlows, dialogTasks)

**Gap Detection:**

- 11 known ABL gaps (loops, timers, database, HTTP, etc.)
- 8 Agent Platform v12 specific gaps (processors, voice, PII)
- 2 XO11 specific gaps (script nodes, rich UX)

**Tests**: 111 passing (architect: 38, import: 45, validate: 28)

> **See [ARCHITECT_TOOLS.md](./ARCHITECT_TOOLS.md) for detailed documentation.**
> **See [ABL_IMPORT_GUIDE.md](./ABL_IMPORT_GUIDE.md) for import/migration guide.**

---

## Guardrails

| Layer             | Status       | Notes                                                                      |
| ----------------- | ------------ | -------------------------------------------------------------------------- |
| ABL Syntax        | ✅ Complete  | GUARDRAILS section with name, kind, check, action, message, priority       |
| Parser            | ✅ Complete  | All guardrail fields parsed                                                |
| IR Compilation    | ✅ Complete  | Compiles to `AgentIR.constraints.guardrails[]`                             |
| E2E Tests         | ✅ Complete  | 13 tests covering parsing, compilation, validation, integration            |
| Runtime Execution | ❌ Not wired | Constraint executor designed, not integrated in pre/post-LLM phases        |
| Example files     | ✅ Complete  | `examples/guardrails/pii_protection.agent.dsl`, `content_safety.agent.dsl` |

---

## Designed vs Implemented

Features fully designed in IR schema but not runtime-executed:

| Feature             | IR Schema | Parser | Compiled | Runtime                                                      |
| ------------------- | --------- | ------ | -------- | ------------------------------------------------------------ |
| Persistent memory   | ✅        | ✅     | ✅       | ✅ MongoDBFactStore                                          |
| REMEMBER triggers   | ✅        | ✅     | ✅       | ✅ MemoryExecutor wired to flow executor                     |
| RECALL instructions | ✅        | ✅     | ✅       | ✅ EventDetector + recall actions wired to session lifecycle |
| ON_ERROR retry      | ✅        | ✅     | ✅       | ✅ ErrorHandlerRouter + retry (fixed/exponential/linear)     |
| Guardrail execution | ✅        | ✅     | ✅       | ❌ Not wired to runtime                                      |

---

## Enhanced DSL Features (Feb 2026)

### Implemented

- [x] **GatherFieldSemantics** -- format, components, unit, lookup, convert_to, kore_entity_type
- [x] **Range support** -- range field flag + RangeValue type (`{low, high}`)
- [x] **List + Preferences** -- list flag, preferences flag, PreferenceValue type (accept/desire/avoid/refuse)
- [x] **Progressive/Dynamic GATHER** -- activation modes (required/optional/progressive/data-driven), depends_on
- [x] **Prompt mode** -- ask vs extract_only
- [x] **Enhanced validation** -- LLM validation type, retry_prompt, max_retries
- [x] **Kore entity type mapping** -- 25+ entity types (Airport, City, Currency, Date, Email, etc.)
- [x] **Enhanced ErrorHandler** -- subtypes for specific error matching, backoff strategies (fixed/exponential/linear), backtrack action
- [x] **Step-level ON_ERROR** -- per-step error handlers in FLOW definitions
- [x] **Structured ON_FAIL** -- COLLECT (inline field gathering), GOTO (step navigation), RETRY (re-attempt), THEN (post-collect behavior)
- [x] **Control flow directives** -- collect_field, goto_step, retry_step actions in constraint failure handling
- [x] **Handoff return expectation keys** -- both `EXPECT_RETURN` and `RETURN` parse in `HANDOFF`; `EXPECT_RETURN` is the preferred authored form because it is clearer
- [x] **Enhanced memory** -- session reset, persistent type/unit/default on memory fields
- [x] **Recall actions** -- inject_context, load_memory, prompt_llm recall action types
- [x] **ErrorHandlerRouter service** -- resolution order: step-level type+subtype, step-level type, step DEFAULT, agent-level type+subtype, agent-level type, agent DEFAULT
- [x] **MemoryExecutor service** -- REMEMBER trigger evaluation and RECALL action execution
- [x] **EventDetector service** -- detects session events for RECALL triggers
- [x] **PreferenceDetector service** -- categorizes user intent into accept/desire/avoid/refuse
- [x] **MongoDBFactStore service** -- persistent fact storage with tenant isolation
- [x] **Activation-aware checkGatherComplete()** -- respects activation modes when determining gather completeness
- [x] **depends_on validation with cycle detection** -- compiler validates dependency graph is acyclic
- [x] **Parser support for all new fields** -- SEMANTICS, RANGE, LIST, PREFERENCES, ACTIVATION, DEPENDS_ON, PROMPT_MODE, VALIDATION_PROCESS, RETRY_PROMPT, MAX_RETRIES, ON_ERROR subtypes, RETRY_BACKOFF, BACKTRACK, structured ON_FAIL

### Runtime Gaps (All Implemented)

- [x] **REMEMBER trigger evaluation in flow executor** -- MemoryExecutor invoked from flow step transitions after entity extraction and tool calls
- [x] **RECALL execution on session events** -- EventDetector and recall actions wired to session lifecycle (session_start, tool calls, entity extraction)
- [x] **Preference detection in extraction pipeline** -- PreferenceDetector integrated into gather extraction flow as post-processing step
- [x] **Session memory initialization from IR** -- Memory config loaded from IR on session creation, defaults applied to session.data.values
- [x] **Strategy enforcement (pattern/llm/hybrid)** -- Extraction pipeline respects strategy field: pattern-only skips LLM, llm-only skips regex fallback
- [x] **LLM validation (validateFieldWithLLM)** -- Validation type `LLM` triggers LLM call for field validation, returns `{valid, reason}`
- [x] **Semantic extraction hints in LLM prompts** -- Semantics metadata (format, components, unit, lookup) included in extraction prompts
- [x] **Mini-collect state machine in flow executor** -- ON_FAIL COLLECT directive triggers mini-collect sub-state: prompt for fields, re-evaluate constraint, continue or retry
- [x] **Enhanced corrections with LLM detection** -- `detectCorrectionWithLLM()` for complex corrections, re-validation after correction, dependent field invalidation via depends_on graph walk
- [x] **Clarification count (\_clarification_count)** -- Built-in variable initialized to 0 on session, incremented on re-prompts for same fields, reset per session.memory config

---

## Proposed Extensions (Not Implemented)

> Design documents in `docs/proposals/extensions/`. None are implemented.

| Extension      | Design | Parser | Runtime | Priority |
| -------------- | ------ | ------ | ------- | -------- |
| Scheduling     | ✅     | ❌     | ❌      | Low      |
| Localization   | ✅     | ❌     | ❌      | Low      |
| Interrupts     | ✅     | ❌     | ❌      | Medium   |
| Advanced Nodes | ✅     | ❌     | ❌      | Low      |

---

## Test Files

| Package                     | File                                       | Tests  | Focus                                                  |
| --------------------------- | ------------------------------------------ | ------ | ------------------------------------------------------ |
| `@abl/core`                 | `agent-based-parser.test.ts`               | 21     | Parser constructs                                      |
| `@abl/core`                 | `expression-parser.test.ts`                | 25     | Expression evaluation                                  |
| `@abl/core`                 | `lexer.test.ts`                            | 21     | Tokenization                                           |
| `@abl/compiler`             | `constructs/executor.test.ts`              | 15     | Construct execution                                    |
| `@abl/compiler`             | `constructs/evaluator.test.ts`             | 43     | Expression evaluation                                  |
| `@abl/compiler`             | `constructs/fact-store.test.ts`            | 35     | Memory/fact management                                 |
| `@abl/compiler`             | `constructs/gather-executor.test.ts`       | 20     | Entity extraction                                      |
| `@abl/compiler`             | `constructs/types.test.ts`                 | 18     | Type system                                            |
| `@abl/compiler`             | `graph-extractor.test.ts`                  | 34     | Graph extraction                                       |
| `@abl/compiler`             | `graph-extractor-integration.test.ts`      | 19     | Integration tests                                      |
| `@abl/compiler`             | `guardrails/guardrails-e2e.test.ts`        | 13     | Guardrails E2E                                         |
| `@abl/compiler`             | `examples.test.ts`                         | varies | Example validation                                     |
| `@abl/analyzer`             | `analyzer.test.ts`                         | 20     | Static analysis                                        |
| `@agent-platform/mcp-debug` | `analysis.test.ts`                         | 33     | Diagnostics                                            |
| `@agent-platform/mcp-debug` | `docs.test.ts`                             | 25     | Documentation tools                                    |
| `@agent-platform/cli`       | `mcp/server.test.ts`                       | 37     | MCP server integration                                 |
| `@agent-platform/cli`       | `mcp/architect.test.ts`                    | 38     | Gap detection, analysis                                |
| `@agent-platform/cli`       | `mcp/import.test.ts`                       | 45     | Format detection, conversion                           |
| `@agent-platform/cli`       | `mcp/validate.test.ts`                     | 28     | ABL syntax validation                                  |
| `@agent-platform/server`    | `version-service.test.ts`                  | 56     | Version lifecycle, tenant isolation, RBAC, transitions |
| `@agent-platform/server`    | `runtime-executor.test.ts`                 | varies | Runtime execution                                      |
| `@agent-platform/server`    | `hotel-booking.e2e.test.ts`                | 65     | Multi-agent E2E                                        |
| `@agent-platform/server`    | `yaml-flow.test.ts`                        | varies | YAML flow parsing                                      |
| `@agent-platform/server`    | `secrets-provider.test.ts`                 | 18     | Multi-layer secret resolution, caching, expiry, OAuth  |
| `@agent-platform/server`    | `tool-oauth-service.test.ts`               | 13     | OAuth flow, token exchange, state management           |
| `@agent-platform/server`    | `proxy-config-service.test.ts`             | 8      | Proxy config loading, decryption, caching              |
| `@agent-platform/server`    | `route-validation.test.ts`                 | 21     | OAuth env config, provider validation, redirect URI    |
| `@abl/compiler`             | `constructs/http-tool-executor.test.ts`    | 80+    | SSRF, redirect, auth, response limits                  |
| `@abl/compiler`             | `constructs/proxy-resolver.test.ts`        | 22     | URL matching, priority, auth, mTLS, CA certs           |
| `@abl/compiler`             | `constructs/middleware-chain.test.ts`      | 17     | Middleware wiring, trace dedup, composition            |
| `@abl/compiler`             | `constructs/tool-binding-executor.test.ts` | 10     | Tool dispatch, fallback, binding                       |
| `@abl/compiler`             | `constructs/trace-scrubber.test.ts`        | 7      | PII/secret scrubbing for traces                        |
| `@abl/compiler`             | `constructs/audit-middleware.test.ts`      | 6      | SOC2 audit trail, hash, context                        |
| `@abl/compiler`             | `constructs/result-validation.test.ts`     | 8      | Response schema validation                             |
| `@agent-platform/shared`    | `unified-auth.test.ts`                     | 14     | Three auth flows, events, isSuperAdmin, requireAuth    |
| `@agent-platform/shared`    | `permission-guard.test.ts`                 | 16     | Scope enforcement, permissions, auth types             |
| `@agent-platform/server`    | `reasoning-gather-handoff.test.ts`         | 32     | 🔶 Requires ANTHROPIC_API_KEY                          |

---

## TODOs by Priority

### High Priority

| Item                      | Package         | Effort    | Notes                                                                        |
| ------------------------- | --------------- | --------- | ---------------------------------------------------------------------------- |
| Wire guardrail execution  | compiler/server | Medium    | Pre/post-LLM check phases                                                    |
| ~~Real tool integration~~ | ~~server~~      | ~~Large~~ | ✅ HTTP/MCP/Lambda/Sandbox executors with SSRF, auth, middleware, proxy      |
| Multi-tenant architecture | server/studio   | Large     | See [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md) |
| Persistent trace storage  | server          | Medium    | ClickHouse for analytics, MongoDB for hot traces                             |

### Medium Priority

| Item                         | Package     | Effort     | Notes                                                                    |
| ---------------------------- | ----------- | ---------- | ------------------------------------------------------------------------ |
| ~~Persistent memory store~~  | ~~runtime~~ | ~~Medium~~ | ✅ MongoDBFactStore with tenant isolation                                |
| ~~REMEMBER/RECALL triggers~~ | ~~runtime~~ | ~~Small~~  | ✅ MemoryExecutor + EventDetector wired to executors                     |
| ~~RETRY logic in ON_ERROR~~  | ~~runtime~~ | ~~Small~~  | ✅ ErrorHandlerRouter with fixed/exponential/linear backoff              |
| ~~Human agent routing~~      | ~~runtime~~ | ~~Medium~~ | ✅ EscalationResolutionHandler with distributed locks + ITSM integration |
| IR caching                   | server      | Small      | ✅ Compile-at-version-time implemented; deployment-aware caching planned |
| Breakpoint system            | server      | Medium     | Types exist, execution needed                                            |

### Low Priority

| Item                     | Package  | Effort | Notes                         |
| ------------------------ | -------- | ------ | ----------------------------- |
| Trace export (JSON/OTel) | platform | Small  | Download traces               |
| Trace playback           | platform | Medium | Replay past sessions          |
| Distributed tracing      | runtime  | Large  | W3C Trace Context propagation |
| Performance benchmarks   | all      | Medium | Latency measurements          |
| Extensions (all)         | all      | Large  | Schedule/Locale/Interrupts    |

---

## Known Limitations

1. ~~**Tools are mocked**~~: ✅ Real tool execution via HTTP, MCP, Lambda, Sandbox executors with SSRF protection, auth injection, middleware chain, and proxy support
2. **Single-threaded**: One request at a time per session
3. **No persistence**: Session state and traces in-memory only (lost on restart). Redis session store designed but not deployed.
4. **No multi-tenancy UI**: Unified auth (3 flows), tenant isolation, RBAC, and permission guards enforced at API level; no organization management UI yet
5. **Guardrails not wired**: Parsed and compiled but not executed at runtime
6. ~~**Memory triggers**~~: ✅ REMEMBER/RECALL triggers fully wired to flow executor and session lifecycle
7. **Extensions not implemented**: Design docs only
8. **32 tests require LLM**: `reasoning-gather-handoff` tests need ANTHROPIC_API_KEY
9. ~~**HOOKS/ON_ERROR/ESCALATE not wired**~~: ✅ All three fully wired with trace events, tests, and production code paths
10. **GATHER attachment validation**: `AttachmentFieldIR` MIME type/file size validation not wired at executor layer — attachments work via generic tool calls

> **See [ENTERPRISE_ROADMAP.md](./ENTERPRISE_ROADMAP.md) for comprehensive gap analysis.**
> **See [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md) for multi-tenant architecture plan.**

---

## Recent Changes (Feb 2026)

| Change                                    | Commit    | Impact                                                                                                                                                            |
| ----------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enterprise tool calling system            | `722e8c2` | SSRF hardening, tool middleware chain, secrets provider, end-user OAuth, org proxy/gateway, audit logging, trace PII scrubbing. 641 compiler + 526 runtime tests. |
| LLM provider layer rewrite                | `18b4dac` | Shared LiteLLM-compatible providers, provider cache, tool_use_end emission, API key sanitization                                                                  |
| VersionService + REST API                 | `066d4d2` | Phase 1 compilation persistence: version lifecycle, tenant isolation, RBAC, audit, 56 tests                                                                       |
| Architect & Import MCP tools              | `78b8233` | Project generation, gap detection, format conversion                                                                                                              |
| Architect/Import/Validate tests           | `6e8f764` | 111 new tests for MCP tools                                                                                                                                       |
| ABL rename complete                       | `cc0da01` | All DSL→ABL function/type renames                                                                                                                                 |
| Entity validation in GATHER               | `50373cf` | Pattern, range, enum validation for fields                                                                                                                        |
| Delegate WHEN conditions                  | `50373cf` | Enforce preconditions before handoff                                                                                                                              |
| ABLGenerator complete                     | `e7f66f3` | Full template generation (simple-agent, supervisor, scripted)                                                                                                     |
| Rename to Agent Blueprint Language (ABL)  | `c5d6d44` | All packages renamed `@abl/*` and `@agent-platform/*`                                                                                                             |
| Rename apps: platform (API) + studio (UI) | `3affc30` | `test-server` → `platform`, `test-ui` → `studio`                                                                                                                  |
| Guardrails system                         | `6063010` | Parser, compiler, 13 E2E tests                                                                                                                                    |
| MCP debug test infrastructure             | `6063010` | 58 tests for MCP tools                                                                                                                                            |
| GatherProgress sync fix                   | `3172c8b` | Proper sync for clear/set in handoff scenarios                                                                                                                    |
| Auth security hardening                   | `00ae080` | Vulnerability fixes, improved token handling                                                                                                                      |
| Project dashboard redesign                | `186f612` | New dashboard + chat position control                                                                                                                             |
| Dev-login for CLI                         | `875209b` | CLI testing without Google OAuth                                                                                                                                  |
| Enterprise roadmap                        | `ef3ed57` | Comprehensive gap analysis + tech stack targets                                                                                                                   |

---

## File Locations

### Parser

- `packages/core/src/parser/agent-based-parser.ts`

### Compiler

- `packages/compiler/src/platform/ir/compiler.ts` (compileDSLtoIR)
- `packages/compiler/src/platform/ir/schema.ts` (IR types, 50+ definitions)
- `packages/compiler/src/platform/ir/graph-extractor.ts` (static graph)
- `packages/compiler/src/platform/ir/app-graph-extractor.ts` (multi-agent graphs)
- `packages/compiler/src/platform/constructs/executors/` (10 executor classes)

### Runtime

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/agent-loader.ts`
- `apps/runtime/src/services/trace-emitter.ts`
- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/hook-executor.ts`
- `apps/runtime/src/services/escalation/resolution-handler.ts`
- `apps/runtime/src/services/voice/voice-config-resolver.ts`

### Auth (Unified Three-Flow System)

- `packages/shared/src/middleware/unified-auth.ts` (central 3-path auth dispatcher)
- `packages/shared/src/middleware/permission-guard.ts` (scope + permission enforcement)
- `packages/shared/src/rbac/permission-resolver.ts` (role hierarchy + resource permissions)
- `apps/runtime/src/middleware/auth.ts` (runtime auth config wiring `unifiedAuth` + `authMiddleware`)
- `apps/runtime/src/middleware/sdk-auth.ts` (SDK `pk_*` key validation)
- `apps/runtime/src/routes/sdk-init.ts` (SDK token exchange + refresh)
- `apps/runtime/src/services/permission-resolution.ts` (Prisma-backed permission resolution + cache)
- `apps/studio/src/services/auth-service.ts` (Studio JWT/tenant/SDK token management)

### UI

- `apps/studio/src/components/observatory/`
- `apps/studio/src/store/observatory-store.ts`
- `apps/studio/src/contexts/WebSocketContext.tsx`

### MCP Debug

- `packages/mcp-debug/src/server.ts`
- `packages/mcp-debug/src/tools/`

### Tests

- `packages/core/src/__tests__/`
- `packages/compiler/src/__tests__/`
- `packages/mcp-debug/src/__tests__/`
- `packages/kore-platform-cli/src/__tests__/`
- `apps/runtime/src/__tests__/`
