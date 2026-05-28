# ABL Platform vs XO Enterprise Pain Points: Gap Analysis

> **Date:** 2026-03-03
> **Scope:** Audit of 8 enterprise pain points from Kore.ai's XO platform against the ABL platform codebase.
> **Methodology:** Static code analysis across all packages, models, routes, services, and UI components.

---

## Executive Summary

ABL was designed from the ground up to address XO's structural limitations. Of 8 enterprise pain points, **3 are fully covered**, **3 are mostly covered** (>80% infrastructure in place, minor gaps), **1 is partially covered**, and **1 is designed but not yet built**. No pain point requires a ground-up effort — the gaps are incremental.

| #   | Pain Point                        | Status              | Gap Size                            |
| --- | --------------------------------- | ------------------- | ----------------------------------- |
| 1   | Multi-Developer Collaboration     | Mostly Covered      | Small — no real-time co-editing     |
| 2   | CI/CD & Environment Promotion     | Mostly Covered      | Small — no drift detection          |
| 3   | Extensibility (BotKit Equivalent) | Fully Covered       | None                                |
| 4   | AI Observability                  | Mostly Covered      | Medium — no alerting service        |
| 5   | Ease of Debugging                 | Fully Covered       | Small — no shareable URLs           |
| 6   | Multi-Lingual Experience          | Partially Covered   | Medium — agent-level i18n not wired |
| 7   | Custom Data in Logs               | Fully Covered       | Small — propagation gap             |
| 8   | Design Pattern Templates          | Designed, Not Built | Medium — no template catalog UI     |

**Recommended investment order:** #7 (1 week) → #5 shareable URLs (1 week) → #4 alerting (2-3 weeks) → #2 drift detection (2-3 weeks) → #8 template catalog (3-4 weeks) → #6 i18n wiring (4-6 weeks) → #1 real-time co-editing (6-8 weeks).

---

## 1. Multi-Developer Collaboration

### XO Pain Point

In XO, multiple developers editing the same bot causes **corruption** — the last person to save overwrites everyone else's work. There is no conflict detection, no locking, no merge capability, and no versioning. Teams resort to "scheduling who edits when" via Slack, which doesn't scale.

Import/export between environments breaks referential integrity (dangling intent references, orphaned dialog nodes), and import status can get permanently stuck.

### What ABL Has

ABL has a comprehensive collaboration system built from day one:

**Advisory Locking System**

- `AgentLock` model with per-agent edit/deploy locks (30-minute TTL, auto-expiry via MongoDB TTL index)
- Lock acquisition returns 409 Conflict with lock holder identity when another user holds the lock
- Lock refresh for long editing sessions, force-break for admin override
- UI endpoint: `POST/DELETE /api/projects/:projectId/agents/:agentId/lock`
- Project-wide lock listing: `GET /api/projects/:projectId/locks`
- Service layer: `packages/project-io/src/ownership/lock-service.ts` (195 lines) with optimistic concurrency

**Agent Versioning**

- `AgentVersion` model with 5-stage lifecycle: `draft → testing → staged → active → deprecated`
- Each version snapshots: DSL source, compiled IR, tool definitions (frozen at version time), source hash for dedup
- Version diff API: `fetchVersionDiff(projectId, agentName, v1, v2)` for comparing any two versions
- SWR-cached React hook: `useAgentVersions` with optimistic updates

**Git Integration**

- `GitIntegration` model supporting GitHub, GitLab, Bitbucket, and generic Git providers
- Full git sync service: `packages/project-io/src/git/git-sync-service.ts`
- **Three-way conflict resolution**: `conflict-resolver.ts` compares base (last sync) vs ours (local) vs theirs (remote)
- Auto-resolution strategies: `manual` (user decides), `local_wins`, `remote_wins`
- Sync history tracking: `GitSyncHistory` model records every push/pull with agents affected, conflicts, and resolution details
- Studio UI: `GitIntegrationTab.tsx` with setup/disconnect dialogs, push/pull actions, sync status, history viewer

**Ownership & Permissions**

- `AgentOwnership` model with individual or team ownership
- `Team` model with member roles (`lead` | `member`)
- Cascading permission resolution: project owner → agent owner → team membership → explicit grants → project role fallback
- Operations: `view`, `edit`, `deploy`, `delete`, `transfer_ownership`

**Import/Export**

- `ProjectExporter` (243 lines): serializes entire project (agents, tools, deployments) to ZIP/TAR.GZ
- `ProjectImporter` (364 lines): validates and imports with dependency resolution, change tracking (added/modified/deleted)
- Guards against memory exhaustion (max 1000 agents, 500 tools per export)

**Key Files:**
| File | Purpose |
|------|---------|
| `packages/database/src/models/agent-lock.model.ts` | Lock schema with TTL index |
| `packages/database/src/models/agent-version.model.ts` | Version lifecycle schema |
| `packages/database/src/models/git-integration.model.ts` | Git provider config + sync state |
| `packages/project-io/src/git/conflict-resolver.ts` | Three-way merge logic |
| `packages/project-io/src/ownership/lock-service.ts` | Lock acquisition/release service |
| `packages/project-io/src/ownership/permission-checker.ts` | Cascading permission resolution |
| `apps/studio/src/components/settings/GitIntegrationTab.tsx` | Git integration UI |

### What's Missing

**Real-time co-editing**: No live cursors, no WebSocket-based presence, no simultaneous editing of the same agent. The lock-first model prevents corruption but doesn't enable collaboration — it serializes it. Multiple developers can work on _different_ agents in the same project concurrently, but not the same agent.

### Design Recommendation

**Phase 1 — Presence awareness (low effort, high value):**
Add a lightweight WebSocket presence channel per project. When a user opens an agent editor, broadcast `{ userId, agentName, action: 'editing' }`. Show avatar badges on agent cards in the agent list. No conflict resolution needed — just awareness.

Implementation: Add a `presence` event type to the existing Studio WebSocket. Store active editors in a Redis hash `project:{id}:editors` with 60-second TTL (heartbeat refresh). Studio subscribes on project load.

**Phase 2 — Operational Transform / CRDT (high effort):**
True simultaneous editing requires OT or CRDT on the DSL text. This is a large investment (6-8 weeks) and should only be pursued if customer demand justifies it. The lock model + presence is sufficient for most enterprise teams.

### Priority: **Low** (locks + git + versioning cover 95% of enterprise needs)

---

## 2. CI/CD & Environment Promotion

### XO Pain Point

XO lacks a proper CI/CD pipeline. Moving bots between environments (dev → staging → production) requires manual export/import. This is error-prone: imports break referential integrity, status gets stuck, and there's no way to validate that what's in production matches what was tested.

There's no environment variable management, no model override per environment, and no rollback capability.

### What ABL Has

ABL has a complete deployment pipeline with environment promotion:

**Deployment Model**

- `Deployment` document with: environment (`dev`/`staging`/`production`), `agentVersionManifest` (agent→version pinning), `entryAgentName`, `compilationHash`, `modelOverrides`, `settingsVersionId`
- Status lifecycle: `active → draining → retired`
- Lineage tracking: `previousDeploymentId` (rollback chain), `promotedFromDeploymentId` (promotion chain)
- Endpoint slug for SDK routing (globally unique)

**Environment Promotion**

- `POST /deployments/:id/promote` with `targetEnvironment`
- Copies agent version manifest from source deployment
- Merges model overrides: `{ ...sourceOverrides, ...requestOverrides }`
- Auto-drains previous active deployment in target environment
- Auto-follows channels with `followEnvironment: true`
- Full audit trail: `createdBy`, `promotedFromDeploymentId`

**Draining & Rollback**

- When a new deployment is created, the previous active deployment transitions to `draining` status
- 30-minute grace period (configurable): existing sessions can complete
- Auto-retire after grace period via `DeploymentResolver` (fire-and-forget)
- `POST /deployments/:id/rollback`: retires current, reactivates previous

**Environment Variables**

- `EnvironmentVariable` model with AES-256-GCM encryption at rest (tenant-scoped DEKs)
- Scoped by `(tenantId, projectId, environment, key)` — same key can have different values per environment
- `POST /env-vars/copy`: bulk copy from source → target environment (with overwrite option)
- `POST /env-vars/validate`: scans agent IRs for `{{env.KEY}}` references, reports missing/defined
- UI: full CRUD + copy + validation in Studio

**Settings Versioning**

- `ProjectSettingsVersion` with same 5-stage lifecycle as agent versions
- Pins execution settings (thinking budget, prompt overrides) to a deployment
- Dedup via SHA256 source hash (won't create duplicate versions for unchanged settings)

**CI Pipeline (Harness)**

- `.harness/pipelines/ci-build.yaml` (544 lines)
- **Stage 1**: Tag generation (commit SHA + date)
- **Stage 2**: Build + test with MongoDB/Redis service containers (8Gi memory, 4 CPU)
- **Stage 3**: Docker build (Kaniko) → Trivy vulnerability scan (CRITICAL+HIGH) → Push to ACR (matrix: 5 apps in parallel)
- **Stage 4**: Seed image build + push
- **Stage 5**: Semgrep SAST + Gitleaks secret scan
- **Stage 6**: Auto-update `values-dev.yaml` in deploy repo → ArgoCD auto-sync
- **Trigger**: Push to `main` branch (filtered to `apps/`, `packages/` paths)

**Deployment Resolver (3 strategies)**

1. By `deploymentId` — load pinned versions, check draining/retired status
2. By `environment` — find active deployment, fallback to per-agent `activeVersions` map
3. Working copy — fresh compile from DSL (dev/debug only)

- L1/L2 cache via `compilationHash`

**Key Files:**
| File | Purpose |
|------|---------|
| `packages/database/src/models/deployment.model.ts` | Deployment schema (94 lines) |
| `apps/runtime/src/routes/deployments.ts` | Create/list/retire/rollback/promote (881 lines) |
| `apps/runtime/src/services/deployment-resolver.ts` | 3-strategy resolution (830 lines) |
| `apps/runtime/src/routes/environment-variables.ts` | Env var CRUD + copy + validate |
| `.harness/pipelines/ci-build.yaml` | CI pipeline (544 lines) |

### What's Missing

**Drift detection**: No mechanism to compare what's deployed in production against what was tested in staging. If someone promotes a different set of agent versions or changes model overrides, there's no alarm. The promotion chain is tracked via `promotedFromDeploymentId`, but there's no active comparison service.

**Environment comparison UI**: No side-by-side view in Studio showing "dev has version X, staging has version Y, production has version Z" for each agent.

### Design Recommendation

**Environment comparison dashboard:**
Add a `GET /api/projects/:projectId/deployments/compare` endpoint that returns the active deployment per environment with agent version diffs. Studio renders this as a matrix: rows = agents, columns = environments, cells = version number (with color coding for mismatches).

**Drift detection service:**
After each promotion, compute a "deployment fingerprint" (hash of sorted agent versions + model overrides + settings version). Store on the deployment document. A scheduled job (or on-demand API) compares fingerprints across environments and flags drift. Emit a trace event `deployment_drift_detected` for alerting.

### Priority: **Medium** (promotion works; drift detection is a nice-to-have for SOC 2 audit trails)

---

## 3. Extensibility (BotKit Equivalent)

### XO Pain Point

XO's BotKit SDK allows developers to write custom JavaScript logic that hooks into the bot lifecycle. However, it's a monolithic SDK with poor separation of concerns, limited to JavaScript, and tightly coupled to the XO runtime. Extending bot behavior beyond the visual builder requires deep BotKit knowledge.

### What ABL Has

ABL has a **significantly more extensible architecture** than XO's BotKit:

**Pluggable Tool Executors (5 types)**

- **HTTP**: Full-featured executor with SSRF protection, OAuth2, secret resolution, rate limiting, circuit breaker, automatic retry. File: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- **MCP (Model Context Protocol)**: Connects to external MCP servers (stdio, SSE, HTTP transports). Circuit breaker per server, tenant-scoped. File: `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts` (335 lines)
- **Sandbox**: Executes JavaScript and Python in isolated environments (gVisor for Docker, Lambda for AWS). File: `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts`
- **Connector**: Framework for pre-built integrations (Slack, Stripe, etc.) with OAuth, dynamic dropdowns, key-value state. File: `packages/connectors/src/executor/connector-tool-executor.ts`
- **Workflow**: Triggers Restate durable workflows. File: referenced in `tool-binding-executor.ts`

**Composable Middleware Chain**

- Express/Koa-style onion model: `composeMiddleware()` in `tool-middleware.ts`
- Built-in: logging, secret scrubbing (regex patterns for Bearer/API key/PEM/AWS), secret validation, audit (SOC2/HIPAA), result validation, timing
- Custom middleware: implement `(ctx: ToolCallContext, next: ToolMiddlewareNext) => Promise<ToolCallResult>`

**MCP Server Management**

- `MCPServerRegistryService`: loads configs from DB, decrypts env vars, SSRF validates URLs, 60-second TTL cache
- `MCPServerManager`: connection pooling, tenant-scoped server pools, health monitoring, tool/resource/prompt aggregation
- `MCPClient`: command allowlist for stdio, env var sanitization (blocks PATH, LD_PRELOAD), max pending requests, audit hooks

**Connector Framework (Full SDK)**

- Connector definition: `name`, `displayName`, `auth`, `triggers[]`, `actions[]`
- Auth types: `oauth2` (with PKCE), `api_key`, `bearer`, `basic`, `custom`, `none`
- Property builder: `Property.string('field').required().default('value')`
- Dynamic dropdowns with `refreshers` for dependent fields
- Trigger strategies: `webhook` (with signature verification + replay protection), `polling` (BullMQ), `cron`
- Action context: auth (decrypted), params, tenantId, projectId, key-value store
- Compiler bridge: `connectorActionToToolDefinition()` converts connector actions to Agent IR tool definitions

**Web SDK**

- `packages/web-sdk/`: `AgentSDK`, `SessionManager`, `ChatClient`, `VoiceClient`, `AudioCapture`, `VADAdapter`
- UI components: `UnifiedWidget`, `ChatWidget`, `VoiceWidget` (web components for embedding)
- Event emitter pattern, multi-channel support, audio/video streaming, Twilio integration

**LLM Provider Abstraction**

- 10 providers: Anthropic, OpenAI, Azure, Vertex, Gemini, Cohere, Bedrock, LiteLLM, Ultravox, Custom
- Model tiers: `fast`, `balanced`, `powerful`
- Vercel AI SDK integration for streaming

**Custom HTTP Guardrail Provider**

- Extensible safety evaluation: `CustomHTTPProviderConfig` with Handlebars body templates, dot-notation response mapping, SSRF protection, response size limits

**Key Files:**
| File | Purpose |
|------|---------|
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Central executor (520 lines) |
| `packages/compiler/src/platform/constructs/executors/tool-middleware.ts` | Middleware chain |
| `packages/compiler/src/platform/mcp/server-manager.ts` | MCP server lifecycle |
| `packages/compiler/src/platform/mcp/client.ts` | MCP client (3 transports) |
| `packages/connectors/src/types.ts` | Connector SDK types |
| `packages/connectors/src/registry.ts` | Connector registry |
| `packages/web-sdk/src/index.ts` | Web SDK entry |

### What's Missing

**Nothing material.** ABL's extensibility significantly exceeds BotKit. The tool binding architecture with 5 executor types, composable middleware, MCP integration, and the connector framework covers every integration pattern BotKit supported — plus several it didn't (MCP, sandboxed code execution, durable workflows, webhook triggers with replay protection).

### Priority: **None** (fully covered)

---

## 4. AI Observability

### XO Pain Point

XO has no unified observability for AI agent behavior. There's no way to see LLM token usage, cost, latency percentiles, or error rates across agents. Teams rely on external logging (Splunk, DataDog) and manually correlate events. There's no understanding of _why_ the agent made a particular decision or _what_ the LLM actually received/returned.

### What ABL Has

ABL has a purpose-built observability stack:

**22 Trace Event Types**
Defined in `packages/observatory/src/schema/trace-events.ts` (406 lines):

- **Core (7)**: `llm_call`, `tool_call`, `decision`, `constraint_check`, `handoff`, `escalation`, `error`
- **Lifecycle (10)**: `session_start/end`, `agent_enter/exit`, `flow_step_enter/exit/transition`, `entity_extraction`, `delegate_start/complete`
- **Attachments (5)**: `attachment_upload/scan/process/index/delete`
- **DSL-level (5)**: `dsl_collect`, `dsl_prompt`, `dsl_respond`, `dsl_set`, `dsl_on_input`, `dsl_call`

All events carry: `sessionId`, `agentName`, `tenantId`, `traceId`, `spanId`, `parentSpanId` (W3C Trace Context compatible).

**Three-Tier Storage**

1. **Memory/Ring Buffer**: 500 events per session, real-time WebSocket broadcast, subscription with replay
2. **Redis**: Distributed trace store for multi-pod deployments, automatic failover to memory
3. **ClickHouse**: Production persistence with encrypt-then-compress, tenant-scoped DEKs, 90/365/730-day TTL tiers

**ClickHouse Analytics Tables**

- `abl_platform.traces`: Full trace events (ReplicatedMergeTree, bloom filter on trace_id)
- `abl_platform.llm_metrics`: Per-call metrics (model, tokens in/out, estimated cost, latency, tool call count, success/error)
- `abl_platform.llm_metrics_hourly_dest`: Hourly aggregations (SimpleAggregateFunction)
- `abl_platform.llm_metrics_daily_dest`: Daily aggregations
- `abl_platform.messages`: Encrypted message store with PII scrubbing flags

**OpenTelemetry Bridge**

- `apps/runtime/src/observability/otel-trace-bridge.ts`: bridges TraceStore events to OTel spans
- Reads `OTEL_EXPORTER_OTLP_ENDPOINT` for collector configuration
- Each trace event becomes an OTel span with proper parent context and attributes

**Trace Emission Pipeline**

- `TraceEmitterConfig`: sessionId, WebSocket, tenant/project context, PII scrubbing flag
- Dual-write: TraceStore (real-time) + EventStore analytics (fire-and-forget)
- PII/secret scrubbing on tool calls and LLM messages

**Key Files:**
| File | Purpose |
|------|---------|
| `packages/observatory/src/schema/trace-events.ts` | 22 event type definitions (406 lines) |
| `apps/runtime/src/services/trace-store.ts` | Ring buffer store (434 lines) |
| `apps/runtime/src/services/stores/clickhouse-trace-store.ts` | ClickHouse persistence |
| `apps/runtime/src/observability/otel-trace-bridge.ts` | OTel span bridge |
| `packages/database/src/clickhouse-schemas/init.ts` | DDL for traces + metrics tables |

### What's Missing

**Alerting service**: There's no system to fire alerts when metrics cross thresholds (e.g., error rate > 5%, p99 latency > 10s, cost spike). ClickHouse has the data, but there's no consumer that evaluates conditions and sends notifications (email, Slack, webhook).

**Aggregated dashboard in Studio**: The ClickHouse metrics tables exist with hourly/daily rollups, but Studio has no analytics dashboard page that surfaces charts (token usage trends, cost per agent, error rates over time, latency percentiles). The data is fully available via ClickHouse queries — the gap is the visualization layer.

### Design Recommendation

**Alerting service (2-3 weeks):**

1. **Alert Rule Model**: `AlertRule` in MongoDB with: `tenantId`, `projectId`, `metric` (error_rate, p99_latency, hourly_cost, etc.), `operator` (gt, lt, gte), `threshold`, `windowMinutes`, `channelType` (webhook, email), `channelConfig`, `cooldownMinutes`, `enabled`

2. **Alert Evaluator**: A lightweight scheduled process (BullMQ repeatable job, every 5 minutes) that:
   - Loads active AlertRules
   - Queries ClickHouse `llm_metrics_hourly_dest` or runs aggregation queries
   - Evaluates conditions
   - Fires notifications via webhook/email
   - Records alert history in `AlertHistory` collection

3. **Studio UI**: Settings page under project settings with alert rule CRUD (metric dropdown, threshold input, channel configuration).

**Analytics dashboard (3-4 weeks):**
Add a "Metrics" tab in Studio with pre-built ClickHouse queries rendered as charts (Recharts or similar). Queries already exist in the hourly/daily materialized views — the work is purely frontend.

### Priority: **High** (enterprise customers expect alerting; the data infrastructure is 100% in place)

---

## 5. Ease of Debugging

### XO Pain Point

Debugging in XO is a nightmare. The debugging UI is fragmented across 4-5 separate pages (utterance testing, conversation testing, NLP training, dialog task trace, intent scoring). There's no unified timeline, no way to see the full execution path, and no ability to set breakpoints or inspect state at specific points. Sharing a debug session with a colleague requires screenshots.

### What ABL Has

ABL has the most comprehensive agent debugging system in the market:

**Debug Server with Full Debugger Protocol**

- `packages/observatory/src/protocol/debug-server.ts` (721 lines)
- WebSocket-based debug protocol on port 9229
- Commands: `attach`, `detach`, `break`, `unbreak`, `pause`, `resume`, `step` (over/into/out), `state`, `stack`, `evaluate`, `follow`
- **Breakpoint types**: by agent name, by flow step, by event type, conditional (expression evaluation against state, e.g., `"budget > 5000"`)
- Session state inspection with dot-notation paths
- Call stack visualization for multi-agent hierarchies

**13 Studio Observatory Components**

- `FloatingDebugPanel.tsx`: Draggable, resizable, dockable debug panel
- `DebugTabs.tsx`: 10-tab interface: timeline, gather, constraints, context, history, llm, ir, analysis, test-context, logs
- `SessionTimeline.tsx`: Time-based event visualization
- `SpanTree.tsx`: Hierarchical span tree with parent-child relationships
- `LLMCallsTab.tsx` / `LLMCallCard.tsx`: Token counts, latency, model, full prompt/response
- `ConstraintMonitor.tsx`: Real-time guardrail/constraint status
- `GatherProgressPanel.tsx`: Data collection progress tracking
- `ToolCallViewer.tsx`: Tool execution details
- `AgentFlowGraph.tsx`: Visual flow graph
- `StateMachineView.tsx`: State machine visualization

**Observatory CLI**

- `apps/observatory-cli/`: command-line debugger with interactive REPL
- 12 commands: `connect`, `sessions`, `attach`, `break`, `unbreak`, `breaks`, `pause`, `resume`, `step`, `state`, `stack`, `eval`, `follow`
- Color-coded event types (chalk), breakpoint status display

**MCP Debug Tools (18 tools)**

- `packages/mcp-debug/`: MCP server for Claude integration
- Connection management, agent loading, message sending
- Trace analysis: recent traces, search, span tree, decision explanation
- Session diagnostics: state inspection, error listing, flow graph (JSON/Mermaid), automated analysis
- Multi-session: list active sessions, subscribe/unsubscribe for live observation
- Documentation: embedded ABL docs (7 topics)

**Session Replay**

- `apps/studio/src/utils/replay-trace-events-into-observatory.ts`: hydrates observatory store from historical trace events
- Used by `useSessionDetail` hook — click any historical session to replay its full execution

**Observatory Store (Zustand)**

- Spans, events, active span stack, step metrics, constraint history, LLM metrics
- Breakpoint management, UI state (selected spans/events, panel open/closed)
- Canvas view modes: graph, chat, split, app (multi-agent)

**Key Files:**
| File | Purpose |
|------|---------|
| `packages/observatory/src/protocol/debug-server.ts` | Debug protocol (721 lines) |
| `apps/studio/src/components/observatory/` | 13 UI components |
| `apps/studio/src/store/observatory-store.ts` | Debug state management |
| `apps/observatory-cli/src/index.ts` | CLI debugger (393 lines) |
| `packages/mcp-debug/src/tools/index.ts` | 18 MCP debug tools |

### What's Missing

**Shareable debug URLs**: There's no way to generate a URL that links to a specific session's debug trace that a colleague can open. The debug data is all there (session replay works), but there's no deep-link mechanism. You can't say "here, look at session X, step Y" via a URL.

**Auto-RCA (root cause analysis)**: The `debug_analyze_session` MCP tool provides automated diagnostics, but this isn't surfaced in Studio. Adding a "Why did this fail?" button that runs the same analysis logic and presents findings in the debug panel would be high-value.

### Design Recommendation

**Shareable debug URLs (1 week):**
Add a "Share" button to the debug panel that generates a URL like `/projects/:projectId/sessions/:sessionId?tab=timeline&span=:spanId`. Studio already has session replay — the work is just routing + query parameter parsing.

**Auto-RCA in Studio (2-3 weeks):**
Port the `debug_analyze_session` logic (from MCP debug tools) into a Studio API endpoint. Add an "Analyze" button to the debug panel's analysis tab that calls this endpoint and renders the findings (detected issues, suggestions) inline.

### Priority: **Medium-High** (debugging is a competitive advantage; shareable URLs are table stakes for enterprise support workflows)

---

## 6. Multi-Lingual Experience

### XO Pain Point

XO requires creating **duplicate bots for each language**. Each language variant is a separate bot with its own intents, dialog tasks, and training. Changes to the English bot must be manually replicated to Spanish, French, etc. This is unscalable — customers with 10+ languages maintain 10x the bots, with inevitable drift between language versions.

### What ABL Has

ABL takes a fundamentally different approach — **single multi-lingual agent**:

**Agent-Level Language Configuration (IR)**

- `NLUIRConfig` in `packages/compiler/src/platform/ir/schema.ts`:
  - `languages: string[]` — supported language list
  - `defaultLanguage: string` — fallback language
  - `allowCodeSwitching: boolean` — multi-language in single message
  - `languageModels: Record<string, string>` — per-language model mapping

**Language Detection**

- Dedicated NLU task: `language-detector.ts` in `packages/compiler/src/platform/nlu/tasks/`
- Detects primary language + code-switching (multilingual mixing)
- Returns ISO 639-1 codes with confidence scoring

**Language-Aware Prompts**

- All NLU prompt templates include `{{#if language}}The user speaks {{language}}.{{/if}}`
- 6 embedded templates (intent, entity, correction, category, combined, language) in `prompt-loader.ts`
- Field-level locale: `GatherFieldSemantics.locale` for formatting dates, numbers, currency

**Platform i18n Package**

- `packages/i18n/`: ErrorCatalog (40+ codes, ICU MessageFormat), RTL support (5 locales), BCP 47 locale resolution, Accept-Language parsing
- 13 supported locale names: en, ar, de, es, fr, he, hi, ja, ko, pt, pt-BR, ru, zh
- Studio integration via `next-intl` (currently English-only, Phase 1)

**Voice Language Support**

- Ultravox realtime provider: `languageHint` parameter for primary language hint to voice model

**Key Files:**
| File | Purpose |
|------|---------|
| `packages/compiler/src/platform/ir/schema.ts` | NLUIRConfig with language fields |
| `packages/compiler/src/platform/nlu/prompt-loader.ts` | Language-aware prompt templates |
| `packages/i18n/src/` | i18n core (6 modules) |
| `packages/i18n/locales/en/studio.json` | Studio strings (4,931 lines, English) |

### What's Missing

**Agent-level response language control**: The NLU pipeline detects the user's language and injects it into prompts, but there's no explicit `RESPOND_IN_LANGUAGE` directive in the ABL DSL. The LLM naturally responds in the detected language (most modern LLMs do this), but there's no guarantee or enforcement.

**Studio i18n (Phase 2)**: Studio UI is locked to English. The infrastructure is ready (next-intl configured, 4,931 lines of English strings extracted), but no other locale files exist yet.

**Translation management**: No mechanism for a non-technical user to translate agent responses. ABL templates are in code (DSL); there's no translation UI or integration with translation management systems (Crowdin, Lokalise, Phrase).

**Multi-locale testing**: No built-in way to test an agent in different languages from Studio. The debug panel sends messages in whatever language the developer types, but there's no language-specific test scenario system.

### Design Recommendation

**Phase 1 — Response language enforcement (2 weeks):**
Add a `LANGUAGE:` section to ABL DSL that compiles to `execution.responseLanguage` in IR. The reasoning executor reads this and appends "Always respond in {language}" to the system prompt. Scripted executor uses it for template selection. This is simple and high-impact.

**Phase 2 — Studio locale expansion (3-4 weeks):**
Create locale files for top 5 requested languages (es, fr, de, ja, pt-BR). Wire `next-intl` locale routing (already designed but commented as "Phase 1: single locale"). This is frontend-only work.

**Phase 3 — Agent response translation UI (4-6 weeks):**
Add a "Translations" tab to the agent editor that extracts all `RESPOND` strings from the DSL and presents them in a translation grid. Export/import as XLIFF for translation management system integration.

### Priority: **Medium** (single multi-lingual agent is the right architecture; gaps are incremental)

---

## 7. Custom Data in Logs

### XO Pain Point

XO provides no mechanism to attach custom business metadata to conversation logs. Enterprise customers need to tag conversations with business context (order ID, customer tier, department, campaign source) for analytics and compliance. Without this, log analysis requires manual correlation with external systems.

### What ABL Has

ABL has comprehensive metadata propagation:

**CallerContext on Every Session**

- Every session carries: `customerId`, `anonymousId`, `tenantId`, `channel`, `initiatedById`
- Set at session creation from edge auth (WebSocket, SDK, REST)
- Propagated to every trace event, tool call, and audit log

**Trace Events with Structured Data**

- Every `TraceEvent` includes: `sessionId`, `agentName`, caller identity (`tenantId`, `identityTier`, `channel`), `timestamp`, `durationMs`, structured `data` field
- The `data` field is a typed discriminated union per event type — not a generic JSON blob
- ClickHouse stores with tenant-scoped encryption

**Session Context Values**

- `session.data.values`: arbitrary key-value store accessible throughout agent execution
- DSL: `SET order_id = {{input.order_id}}` stores values
- Flow steps: `COLLECT` gathers structured data into context
- Available in: guardrail context, tool call parameters, trace event data

**LLM Metrics with Business Context**

- `llm_metrics` ClickHouse table includes: `session_id`, `project_id`, `user_id`, `agent_name`
- Can be joined with trace events for full business context correlation

**Audit Store**

- `AuditStore` interface with ClickHouse and MongoDB backends
- Records: actor identity, action type, resource, timestamp, metadata
- Every tool call, authentication event, permission change is audited

**Key Files:**
| File | Purpose |
|------|---------|
| `packages/compiler/src/platform/core/types.ts` | CallerContext, ClientInfo types |
| `packages/observatory/src/schema/trace-events.ts` | TraceEvent with structured data |
| `apps/runtime/src/services/stores/clickhouse-trace-store.ts` | Encrypted trace persistence |
| `apps/runtime/src/services/trace-emitter.ts` | Trace emission with dual-write |

### What's Missing

**Custom metadata propagation to ClickHouse dimensions**: While `session.data.values` can store arbitrary business data, and trace events include session context, there's no dedicated `custom_metadata` column in the ClickHouse traces table that's indexed for efficient querying. To find "all sessions where order_id = X", you'd need to query the encrypted `data` JSON blob, which is neither indexed nor queryable.

**Studio custom field UI**: No UI for customers to define "always include these fields in traces" at the project level. The mechanism exists (session values), but there's no configuration surface.

### Design Recommendation

**Add indexed custom dimensions to ClickHouse traces (1 week):**
Add a `custom_dimensions` Map(String, String) column to the `traces` table. In `TraceEmitter`, extract a configurable set of session values (defined per project in `ProjectSettings.traceDimensions: string[]`) and populate this column. Add a ClickHouse index on the map keys.

**Project-level trace dimension configuration (3 days):**
Add `traceDimensions` to `ProjectSettings` (array of session value keys to extract). Studio UI: a multi-select input under project settings → observability.

This is the highest ROI gap to close — small effort, high enterprise value for compliance and analytics.

### Priority: **High** (smallest effort, biggest enterprise impact)

---

## 8. Design Pattern Templates

### XO Pain Point

XO offers no starter templates or design patterns. Every new bot starts from a blank canvas. Enterprise teams repeatedly build the same patterns (FAQ bot, appointment scheduling, order status lookup, escalation flow) from scratch. There's no way to share best practices across teams or projects.

### What ABL Has

**Three Project Creation Paths (Studio)**

1. **Start with Arch** (AI-guided, recommended): Uses the Arch AI assistant for iterative agent design
2. **Blank Project**: manual setup
3. **From Template**: pre-built domain starters — the path exists but **the template catalog is empty**

**Agent Skeleton Generation**

- `CreateAgentDialog.tsx`: generates skeleton ABL based on execution mode
- Reasoning mode: AGENT + MODE + PERSONA + GOAL
- Scripted mode: adds FLOW with entry_point, steps (greet, complete)

**Tool Code Templates**

- HTTP tools: body template constants with `{{input.param}}`, `{{secrets.KEY}}`, `{{memory.field}}` interpolation
- Sandbox tools: code templates for JavaScript and Python (Hello World + parameter extraction)

**Example ABL Files**

- `examples/flow-test/`: 7 hotel booking variations (simple → advanced → with constraints)
- `examples/guardrails/`: PII protection, content safety
- `examples/search-ai-strategies/`: Knowledge retrieval patterns
- `examples/DisputeTransaction/`: Multi-agent supervisor pattern
- `examples/banknexus/`: Banking domain examples
- Total: 15+ example agents covering different patterns

**Named Response Templates (IR)**

- `templates?: Record<string, string>` in AgentIR — reusable response snippets referenced by name
- IDE/tooling support for template management

**Key Files:**
| File | Purpose |
|------|---------|
| `apps/studio/src/components/creation/NewProjectDropdown.tsx` | 3 creation paths |
| `apps/studio/src/components/agents/CreateAgentDialog.tsx` | Skeleton generation |
| `examples/` | 15+ ABL example agents |

### What's Missing

**Template catalog UI**: The "From Template" path in `NewProjectDropdown` exists but leads to an empty catalog. There's no `ProjectTemplate` model, no API to list/search templates, and no UI to browse/preview/instantiate templates.

**Community/marketplace**: No mechanism for sharing templates across organizations or publishing to a catalog.

**Pattern documentation in Studio**: The example ABL files exist in the repo but aren't accessible from the Studio UI. A developer must know to look in the `examples/` directory.

### Design Recommendation

**Phase 1 — Template catalog backend + UI (3-4 weeks):**

1. **Model**: `ProjectTemplate` in MongoDB with: `name`, `description`, `category` (FAQ, Booking, Support, Custom), `thumbnail`, `tags`, `agentDSLs` (array of agent ABL content), `toolDefinitions`, `requiredSecrets`, `creator` (platform | tenant), `featured`

2. **Seed data**: Convert the 15+ example ABL files into template records. Categorize: "Hotel Booking Flow" (scripted), "PII-Protected Agent" (guardrails), "Multi-Agent Supervisor" (coordination), "Knowledge Base Agent" (search-ai).

3. **API**: `GET /api/templates` (list with filters), `GET /api/templates/:id` (detail with preview), `POST /api/projects/:projectId/from-template/:templateId` (instantiate)

4. **Studio UI**: Replace the empty "From Template" path with a grid of template cards (thumbnail, name, description, tags). Click → preview (show agent DSL, tool list, architecture diagram) → instantiate into project.

**Phase 2 — Tenant-scoped templates (2 weeks):**
Allow organizations to create their own templates from existing projects. `POST /api/projects/:projectId/export-as-template` creates a `ProjectTemplate` with `creator: 'tenant'` scoped to the tenant. These appear alongside platform templates in the catalog.

### Priority: **Medium** (high value for onboarding and adoption; the content exists, just needs a delivery mechanism)

---

## Priority Matrix

| #   | Gap                                                   | Effort        | Impact     | Priority            | Dependency                      |
| --- | ----------------------------------------------------- | ------------- | ---------- | ------------------- | ------------------------------- |
| 7   | Custom metadata ClickHouse dimensions                 | **1 week**    | **High**   | **P0 — Do first**   | None                            |
| 5   | Shareable debug URLs                                  | **1 week**    | **High**   | **P0 — Do second**  | None                            |
| 4   | Alerting service                                      | **2-3 weeks** | **High**   | **P1 — Do third**   | ClickHouse metrics (exists)     |
| 5   | Auto-RCA in Studio                                    | **2-3 weeks** | **Medium** | **P1 — Do fourth**  | MCP debug analysis (exists)     |
| 8   | Template catalog (backend + UI)                       | **3-4 weeks** | **Medium** | **P2 — Do fifth**   | Example ABL files (exist)       |
| 6   | Agent-level i18n (response language + Studio locales) | **4-6 weeks** | **High**   | **P2 — Do sixth**   | i18n package (exists)           |
| 2   | Drift detection                                       | **2-3 weeks** | **Medium** | **P2 — Do seventh** | Deployment model (exists)       |
| 1   | Real-time co-editing                                  | **6-8 weeks** | **Low**    | **P3 — Future**     | Advisory locks (sufficient now) |

**Total estimated effort for P0+P1:** ~7 weeks
**Total estimated effort for all gaps:** ~22-30 weeks

---

## Conclusion

ABL fundamentally re-architected every area where XO had structural limitations:

- **XO's save-and-pray editing** → ABL's advisory locks + versioning + git integration with three-way merge
- **XO's manual export/import** → ABL's deployment pipeline with environment promotion, rollback, draining, and CI/CD
- **XO's monolithic BotKit** → ABL's 5-type tool executor + middleware chain + MCP + connector framework
- **XO's fragmented debug pages** → ABL's unified observatory with 10-tab debug panel, breakpoints, step execution, and CLI
- **XO's per-language bot duplication** → ABL's single multi-lingual agent with language detection and code-switching

The remaining gaps are incremental — adding dimensions to existing ClickHouse tables, building UI over existing APIs, and wiring infrastructure that's already designed. No gap requires a ground-up effort or architectural change.
