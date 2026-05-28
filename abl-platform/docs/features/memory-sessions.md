# Feature: Memory & Session Management

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `customer experience`, `integrations`, `observability`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/database`, `packages/shared-auth`, `packages/compiler`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/memory-sessions.md](../testing/memory-sessions.md)
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

Conversational AI agents require persistent, isolated state that survives across messages, transport reconnections, pod restarts, and channel switches. Without a dedicated session and memory subsystem:

- Agents lose context mid-conversation when infrastructure changes occur (pod restarts, Redis evictions, WebSocket disconnects).
- Multi-tenant platforms risk cross-user and cross-tenant state leakage if session scoping is not enforced at every data-access layer.
- Studio operators cannot inspect, debug, or resume conversations — blocking both development iteration and production incident response.
- Long-running conversations exceed LLM context windows without a sliding-window or compaction strategy, leading to degraded response quality and token cost overruns.

### Goal Statement

Provide a session and memory foundation that keeps conversational state consistent across Runtime, Studio, and channel adapters while balancing low-latency hot-path access, durable cold-path recovery, and strict tenant/project/user isolation. The system must support creation, resolution, persistence, forking, cleanup, and long-term memory operations for every conversation in the platform.

### Summary

Memory & Session Management is the foundational subsystem that maintains conversational state across interactions between end-users and AI agents. It ensures that every conversation has a persistent, isolated context that survives across messages, WebSocket reconnections, pod restarts, and channel switches.

The system implements a tiered storage architecture: Redis serves as the hot (primary) store for low-latency access during active conversations, while MongoDB acts as the cold store for durable persistence and session restoration when Redis TTLs expire. This design provides sub-millisecond session access during execution while ensuring no session data is lost.

Beyond basic session state, the memory system includes:

- **Long-term memory** via the FactStore (REMEMBER/RECALL DSL constructs)
- **Conversation sliding windows** to bound context length (default 40 messages, first message preserved + last N-1)
- **Session forking** at thread boundaries for parallel exploration
- **Cleanup pipeline** with per-tenant retention policies
- **Encryption at rest** for sensitive session fields
- **Compression** (gzip) for large fields before encryption
- **Distributed execution locks** via Redis `SET NX PX`
- **Optimistic concurrency control** via Lua scripts with version checks
- **Session resolution** via explicit ID, channel artifact, or new creation

---

## 2. Scope

### Goals

- Preserve active conversational state across messages, reconnects, and distributed runtime execution with sub-millisecond hot-path latency.
- Provide durable rehydration from MongoDB cold storage when Redis TTLs expire, ensuring no conversation data is permanently lost.
- Expose session and memory state to Runtime, Studio, and supported channel/session resolvers with strict tenant/project/user isolation.
- Support long-term memory operations (REMEMBER/RECALL) scoped to (tenantId, userId, projectId) tuples.
- Enable session lifecycle management: creation, resolution, forking, cleanup, and per-tenant retention policies.

### Non-Goals (Out of Scope)

- This feature does not replace the trace/event pipeline used for analytics and observability (trace events are emitted but managed by the tracing subsystem).
- This feature does not provide cross-tenant or cross-project shared conversation state.
- This feature does not attempt to keep pod-local in-memory session state as the source of truth in distributed deployments (Redis is the distributed truth).
- This feature does not implement full RAG or vector-based memory retrieval (FactStore is a key-value system, not a semantic search engine).

---

## 3. User Stories

1. As a **runtime operator**, I want active sessions to survive reconnects and pod restarts so that conversations do not lose context mid-flow.
2. As a **Studio user**, I want to browse, inspect, reset, and resume sessions so that I can debug agent behavior and validate outcomes.
3. As a **platform engineer**, I want session resolution and memory retrieval to stay tenant-, project-, and user-safe so that distributed execution does not leak state across boundaries.
4. As an **agent developer**, I want to define REMEMBER triggers and RECALL instructions in the DSL so that agents can retain and leverage long-term user context across sessions.
5. As a **platform admin**, I want per-tenant session retention and cleanup policies so that storage costs are bounded and compliance requirements are met.

---

## 4. Functional Requirements

1. **FR-1**: The system must store active session state in a low-latency hot store (Redis) and support durable cold restore from MongoDB when hot-state TTLs expire, with automatic rehydration back to the hot store on cold read.
2. **FR-2**: The system must resolve sessions by explicit ID, channel artifact hash, or new-session creation path depending on transport inputs and resolution strategy (including `always_new`).
3. **FR-3**: The system must bound conversation context through sliding-window management (default 40 messages) while preserving the first (system/bootstrap) message and trimming oldest non-first messages.
4. **FR-4**: The system must support distributed execution locks (Redis `SET NX PX` with 5s TTL), optimistic concurrency via Lua version-check-then-save scripts, and conflict-safe save semantics for multi-pod runtime execution.
5. **FR-5**: The system must provide long-term memory operations for REMEMBER/RECALL flows via FactStore, scoped to (tenantId, userId, projectId) isolation, with fire-and-forget writes and error-isolated reads.
6. **FR-6**: The system must expose session management and inspection surfaces to Studio and admin/runtime APIs with appropriate authorization checks (project-scoped RBAC, session ownership middleware, admin `tenant:manage_settings` permission).
7. **FR-7**: The system must support session forking at thread boundaries, creating independent child sessions with deep-cloned state from the parent while preserving auth/identity context inheritance.
8. **FR-8**: The system must encrypt sensitive session fields at rest (`authToken`, `state`, `dataValues`, `callerContext`, `customDimensions`, `threads`, `piiVaultData`) via EncryptionService with per-tenant keys, and compress fields larger than 1KB with gzip before encryption.
9. **FR-9**: The system must provide periodic session cleanup with per-tenant retention policies (plan-based TTLs for session/message retention, idle timeout, max age), batched deletion (500 per batch), and automatic stale session reaping.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                            |
| -------------------------- | ------------ | -------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Sessions are created, listed, and managed in project-scoped routes.              |
| Agent lifecycle            | PRIMARY      | Session state and memory directly shape execution, handoff, and reset.           |
| Customer experience        | PRIMARY      | End-user conversations depend on session continuity and memory recall.           |
| Integrations / channels    | PRIMARY      | Web, SDK, voice, and A2A all rely on session resolution and storage.             |
| Observability / tracing    | SECONDARY    | Session lifecycle and memory events emit trace data for debugging.               |
| Governance / controls      | SECONDARY    | Retention, cleanup, and isolation policies govern stored conversation state.     |
| Enterprise / compliance    | SECONDARY    | Encryption, TTL, PII vaulting, and retention policies affect compliance posture. |
| Admin / operator workflows | SECONDARY    | Admin/runtime session APIs and Studio views expose operational controls.         |

### Related Feature Integration Matrix

| Related Feature                                                                                      | Relationship Type | Why It Matters                                                                                    | Key Touchpoints                                                        | Current State             |
| ---------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| [Tracing & Observability](tracing-observability.md)                                                  | emits into        | Session and memory operations generate trace events used in Studio and analytics.                 | TraceStore, session lifecycle events, memory decision traces           | Active integration        |
| [A2A Integration](a2a-integration.md)                                                                | depends on        | A2A turn routing relies on race-safe session registration and resume behavior.                    | `A2ASessionResolver`, resolution keys, session bootstrap               | Active integration        |
| [Channels](channels.md)                                                                              | depends on        | Channel adapters resolve or create sessions based on transport artifacts.                         | WebSocket/SDK session bootstrap, voice resolvers, channel artifacts    | Active integration        |
| [Agent Transfer & Multi-Agent Orchestration](agent-transfer-orchestration.md)                        | shares data with  | Handoffs and thread forking depend on session continuity and back-links.                          | parent/child sessions, thread stacks, session forking                  | Active integration        |
| [Session Timeout & Disposition Unification](sub-features/session-timeout-disposition-unification.md) | extends           | Timeout, disconnect, and end-reason behavior are being unified across runtime and transfer flows. | `TenantConfigService`, close routes, `channelLifecycle`, transfer TTLs | Planned                   |
| [Session Compaction](session-compaction.md)                                                          | extends           | Compaction summarizes old conversation segments to reclaim context window space.                  | CompactionEngine, autoCompactThreshold, compactionModel config         | Planned (not yet enabled) |
| [PII Redaction](pii-redaction.md)                                                                    | shares data with  | PII vault data is stored per-session, encrypted at rest in session state.                         | `piiVaultData`, `piiRedactionConfig` on SessionData                    | Active integration        |

---

## 6. Design Considerations

- The Studio experience provides both operational list/detail views (SessionsListPage, SessionDetailPage) and a lighter-weight live chat sidebar model (SessionSidebar) for session resume workflows.
- Session detail views are intentionally trace-heavy because debugging depends on seeing execution trees, message history, and metrics together (AgentExecutionTree, MetricsBar, OverviewTab).
- Channel-specific resolution paths are hidden behind a shared session resolver and session factory so product surfaces do not fragment by transport.
- The two-panel session detail layout (35% agent execution tree + 65% debug tabs) is designed for the primary debugging workflow.

---

## 7. Technical Considerations

- The feature uses Redis for the hot path, MongoDB for cold storage, and per-tenant TTL/cleanup policy logic to manage retention.
- Distributed execution safety depends on optimistic concurrency via Lua scripts plus Redis `SET NX PX` locks rather than pod-local guards.
- Long-term memory is coupled to FactStore and execution-time REMEMBER/RECALL flows, so changes here affect both runtime execution and compiler expectations.
- IR and CompilationOutput are stored by content hash (SHA-256, truncated to 16 chars) and resolved via a two-level cache: L1 (pod-local LRU, 50 entries) and L2 (Redis, 2h TTL). This deduplicates IR storage across sessions using the same agent version.
- The `TieredSessionStore` wraps the primary store transparently — callers use the standard `SessionStore` interface and get durable sessions without code changes.
- Cold persistence to MongoDB is fire-and-forget to avoid adding latency to the hot path. Failures are logged but do not block session operations.
- Timeout and disposition policy are still split today across tenant security config, runtime `channelLifecycle`, cleanup jobs, explicit close routes, and agent-transfer TTL settings. The convergence plan is documented in [Session Timeout & Disposition Unification](sub-features/session-timeout-disposition-unification.md).

---

## 8. How to Consume

### Studio UI

**Sessions List Page** (`SessionsListPage.tsx`): Tabular list of all sessions for a project with date filters, sorting by agent/date/messages/traces, and pagination (20 per page). Clicking a row navigates to session detail.

**Session Detail Page** (`SessionDetailPage.tsx`): Two-panel view with agent execution tree (left, 35%) and debug tabs (right, 65%). Shows metrics bar with token counts, cost, latency, and LLM calls. Trace events are replayed into the observatory store for visualization.

**Session Sidebar** (`SessionSidebar.tsx`): Collapsible sidebar listing previous sessions for the current agent. Supports resuming active sessions via WebSocket, loading historical sessions via HTTP, per-session delete, and "Clear All" for bulk cleanup.

**Session Health Banner** (`SessionHealthBanner.tsx`): Displays health status warnings for degraded sessions.

**Session Analysis Panel** (`SessionAnalysisPanel.tsx`): Trace analysis and diagnostics panel for deep session inspection.

### API (Runtime)

| Method | Path                                                            | Purpose                                              |
| ------ | --------------------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/api/projects/:projectId/sessions`                             | Create a new test session                            |
| GET    | `/api/projects/:projectId/sessions`                             | List all sessions (supports filters, pagination)     |
| GET    | `/api/projects/:projectId/sessions/export`                      | Export traces as CSV                                 |
| GET    | `/api/projects/:projectId/sessions/generations`                 | List LLM call events across sessions                 |
| GET    | `/api/projects/:projectId/sessions/:id`                         | Get session details (messages, traces, state)        |
| DELETE | `/api/projects/:projectId/sessions/:id`                         | Delete a session                                     |
| POST   | `/api/projects/:projectId/sessions/bulk-close`                  | Bulk close sessions with a supplied disposition      |
| POST   | `/api/projects/:projectId/sessions/:id/close`                   | Close a specific session with a supplied disposition |
| POST   | `/api/projects/:projectId/sessions/:id/reset`                   | Reset session state                                  |
| GET    | `/api/projects/:projectId/sessions/:id/traces`                  | Get session traces (eventType, spanId filters)       |
| GET    | `/api/projects/:projectId/sessions/:id/traces/:spanId/children` | Get child events for a span                          |
| GET    | `/api/projects/:projectId/sessions/:id/metrics`                 | Get aggregated session metrics                       |
| GET    | `/api/projects/:projectId/sessions/:id/agent-spec`              | Get agent specification for session                  |
| GET    | `/api/projects/:projectId/sessions/:id/analysis`                | Get trace analysis and diagnostics                   |
| GET    | `/api/projects/:projectId/sessions/:id/messages`                | Get session messages (cursor-based pagination)       |
| POST   | `/api/v1/memory`                                                | Sandbox pod memory bridge (JWT-authed)               |

### API (Studio)

Studio proxies session API calls through Next.js API routes to the runtime, adding authentication headers.

| Method | Path                                                 | Purpose                         |
| ------ | ---------------------------------------------------- | ------------------------------- |
| GET    | `/api/runtime/sessions`                              | Proxy to runtime sessions list  |
| GET    | `/api/runtime/sessions/:id`                          | Proxy to runtime session detail |
| POST   | `/api/runtime/sessions/bulk-close`                   | Bulk close sessions             |
| POST   | `/api/runtime/sessions/:id/close`                    | Close a specific session        |
| GET    | `/api/runtime/sessions/:id/traces`                   | Proxy to runtime session traces |
| GET    | `/api/runtime/sessions/:id/attachments`              | Get session attachments         |
| GET    | `/api/projects/[id]/sessions`                        | Project-scoped session proxy    |
| GET    | `/api/projects/[id]/agent-transfer/sessions`         | Agent transfer session listing  |
| POST   | `/api/projects/[id]/agent-transfer/sessions/:id/end` | End an agent transfer session   |
| GET    | `/api/archives/sessions`                             | Archived sessions listing       |

### Admin Portal

| Method | Path                                     | Purpose                              |
| ------ | ---------------------------------------- | ------------------------------------ |
| GET    | `/api/admin/runtime/sessions`            | List active sessions (tenant-scoped) |
| GET    | `/api/admin/runtime/sessions/:sessionId` | Get detailed session state           |
| GET    | `/api/admin/runtime/sessions/stats`      | Aggregate session statistics         |

Admin routes require authentication + `tenant:manage_settings` permission. The `tenantId` is derived from the authenticated user's tenant context (not query params) to prevent cross-tenant access.

### Channel / SDK / Voice / A2A / MCP Integration

**Digital (WebSocket/SDK)**: Session created on connection, resolved via explicit sessionId or channel artifact. Conversation state maintained through WebSocket lifetime, persisted to Redis on every turn. SDK sessions use `SessionFactory.createFromDSLs()` for working-copy sessions or `DeploymentResolver` for deployed agents.

**Voice**: Voice sessions use `VoiceSessionResolver` for Twilio/KoreVG media streams. Session resolution maps SIP URIs and caller IDs to existing sessions.

**A2A**: Sessions resolved via `A2ASessionResolver` with atomic `registerSessionIfAbsent` (Redis `SET NX`) for race-safe first-turn creation. Supports `InMemoryA2ASessionResolver` and `RedisA2ASessionResolver`.

---

## 9. Data Model

### Collections / Tables

```text
Collection: sessions
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - contactId: string | null
  - callerNumber: string | null
  - initiatedById: string | null
  - customerId: string | null
  - anonymousId: string | null
  - currentAgent: string (required)
  - agentVersion: string | null
  - environment: 'dev' | 'staging' | 'production'
  - entryAgentName: string | null
  - workflowId: string | null
  - workflowStepId: string | null
  - parentId: string | null
  - channel: 'web' | 'web_chat' | 'web_debug' | 'voice' | 'sms' | 'whatsapp' | 'email' | 'api' | 'sdk'
  - channelHistory: string[]
  - status: 'active' | 'idle' | 'ended' | 'completed' | 'escalated' | 'abandoned' | 'archived'
  - disposition: string | null (completed, abandoned, agent_hangup, transferred, failed, timeout, unengaged)
  - dispositionCode: string | null
  - outcome: 'contained' | 'contained_resolved' | 'contained_partial' | 'contained_unresolved' | 'escalated' | 'abandoned' | null
  - context: Mixed
  - metadata: Mixed
  - deploymentId: string | null
  - channelArtifact: string | null (SHA-256 hashed, max 64 chars)
  - channelArtifactType: string | null (caller_id, cookie, device_id, psid, aad_id, phone, email_thread, api_client, sip_uri)
  - identityTier: number (0=anonymous, 1=unverified, 2=verified)
  - verificationMethod: string | null (none, cookie, caller_id, hmac, otp, oauth, provider)
  - channelId: string | null
  - projectSlug: string | null
  - region: string | null
  - callDuration: number | null
  - messageCount: number (default: 0)
  - tokenCount: number (default: 0)
  - estimatedCost: number (default: 0)
  - errorCount: number (default: 0)
  - handoffCount: number (default: 0)
  - traceEventCount: number (default: 0)
  - billingPeriod: string | null
  - isTest: boolean (default: false)
  - tags: string[]
  - startedAt: Date (required)
  - lastActivityAt: Date (required)
  - endedAt: Date | null
  - archivedAt: Date | null
  - _v: number (default: 1)
Indexes:
  - { tenantId: 1, status: 1, lastActivityAt: -1 }
  - { tenantId: 1, projectId: 1, status: 1, lastActivityAt: -1 }
  - { lastActivityAt: -1, status: 1 }
  - { tenantId: 1, contactId: 1 }
  - { tenantId: 1, customerId: 1 }
  - { tenantId: 1, anonymousId: 1 }
  - { tenantId: 1, callerNumber: 1 }
  - { tenantId: 1, workflowId: 1 }
  - { tenantId: 1, projectId: 1, environment: 1 }
  - { tenantId: 1, initiatedById: 1 }
  - { tenantId: 1, billingPeriod: 1, isTest: 1 }
  - { tenantId: 1, projectSlug: 1, status: 1 }
  - { tenantId: 1, entryAgentName: 1, startedAt: -1 }
  - { tenantId: 1, environment: 1, status: 1 }
  - { deploymentId: 1, status: 1 }
  - { customerId: 1 }
  - { anonymousId: 1 }
  - { parentId: 1 }
  - { tenantId: 1, channelId: 1, channelArtifact: 1, status: 1 } (partial: channelArtifact exists)
  - { tenantId: 1, contactId: 1, startedAt: -1 } (partial: contactId exists)
  - { endedAt: 1 } TTL index (400 days safety net)
Plugins: tenantIsolationPlugin
```

```text
Collection: session_states (Cold Storage)
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed)
  - projectId: string (required)
  - agentName: string (required)
  - version: number (required, default: 0)
  - stateData: Buffer (gzipped, encrypted)
  - threads: ISessionStateThread[] (embedded)
    - threadId: string
    - agentName: string
    - status: 'active' | 'waiting' | 'completed' | 'escalated'
    - irSourceHash: string
    - parentThreadId: string (optional)
    - forkPoint: number (optional)
    - handoffFrom: string (optional)
    - dataValues: Buffer
    - gatheredKeys: string[]
    - state: Buffer
    - conversationHistory: Buffer
    - lastCompactionSeq: number (optional)
    - compactionSummary: string (optional)
  - activeThreadId: string (required)
  - threadStack: string[]
  - headSeq: number (default: 0)
  - lastCompactionSeq: number (default: -1)
  - compactionSummary: string (optional)
  - pendingAsyncTasks: string[]
  - irData: Buffer (gzipped, encrypted — optional)
  - compilationData: Buffer (gzipped, encrypted — optional)
  - resolutionKeys: [{ channelId, artifactHash, ttlSeconds }]
  - encryptedFields: string[]
  - parentSessionId: string (optional)
  - forkPoint: number (optional)
  - expiresAt: Date (required)
  - lastActivityAt: Date (required)
Indexes:
  - { tenantId: 1, _id: 1 }
  - { tenantId: 1, projectId: 1, lastActivityAt: -1 }
  - { tenantId: 1, 'resolutionKeys.artifactHash': 1 } (partial: resolutionKeys[0] exists)
  - { expiresAt: 1 } TTL index (auto-expire)
Plugins: tenantIsolationPlugin, encryptionPlugin (stateData, irData, compilationData)
```

### Redis Key Layout (Hot Storage)

```text
sess:{tenantId}:{sessionId}       HASH   - Session mutable state (24h default TTL, dynamic per-tenant)
sess:{tenantId}:{sessionId}:conv  LIST   - Conversation history (same TTL as session)
sess-tid:{sessionId}              STRING - Reverse lookup: sessionId -> tenantId (same TTL)
ir:{hash}                         STRING - AgentIR gzipped JSON (2h TTL, tenant-agnostic)
comp:{hash}                       STRING - CompilationOutput gzipped JSON (2h TTL)
registry:{tenantId}:{sessionId}   HASH   - Agent registry for handoff (same TTL)
lock:exec:{tenantId}:{sessionId}  STRING - Execution mutex (5s TTL)
resolve:{tenantId}:{channelId}:{hash}  STRING - Session resolution key (configurable TTL)
```

### Key Relationships

- `sessions` collection is the authoritative DB record, linked by `_id` to the in-memory `SessionData.id`
- `session_states` mirrors `SessionData` as a compressed cold snapshot, linked by `_id`
- Trace events reference sessions via `sessionId` field
- Channel connections reference sessions via resolution keys (channelArtifact hash)
- Agent transfer sessions reference parent sessions via `parentId`
- FactStore records are scoped to (tenantId, userId, projectId) — independent of session lifecycle

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                             | Purpose                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/services/session/types.ts`                     | Core types: `SessionData`, `HydratedSession`, `SessionConfig`, `AgentThreadData`, `ConversationWindowConfig` |
| `apps/runtime/src/services/session/session-store.ts`             | `SessionStore` interface — contract for all store backends                                                   |
| `apps/runtime/src/services/session/session-service.ts`           | Orchestration: lifecycle, IR resolution (L1+L2), conversation windows, factory                               |
| `apps/runtime/src/services/session/session-operations.ts`        | Higher-order ops: session forking at thread boundaries                                                       |
| `apps/runtime/src/services/identity/session-resolver.ts`         | Session resolution: explicit ID, channel artifact, or new                                                    |
| `apps/runtime/src/services/execution/session-policy.ts`          | Session policy enforcement (guardrails, rate limits)                                                         |
| `apps/runtime/src/services/execution/memory-executor.ts`         | REMEMBER trigger evaluation and RECALL instruction execution                                                 |
| `apps/runtime/src/services/execution/memory-integration.ts`      | Memory facade connecting FactStore to execution pipeline                                                     |
| `apps/runtime/src/services/execution/tool-memory-bridge.ts`      | Tool-accessible memory bridge for sandbox pods                                                               |
| `apps/runtime/src/services/execution/memory-bridge-registry.ts`  | Registry of active memory bridges by sessionId (bounded Map, 10K max, 1h TTL)                                |
| `apps/runtime/src/services/execution/memory-suspension-store.ts` | Memory suspension store for paused sessions                                                                  |
| `apps/runtime/src/services/session/compaction-engine.ts`         | Context window compaction engine (auto-compact when usage > threshold)                                       |
| `apps/runtime/src/services/session/ir-cache.ts`                  | IR cache utilities                                                                                           |

### Infrastructure / Stores

| File                                                        | Purpose                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session/redis-session-store.ts`  | Redis backend with Lua scripts (atomic save, append+trim), encryption, compression |
| `apps/runtime/src/services/session/memory-session-store.ts` | In-memory backend with LRU eviction (10K max sessions, single-pod fallback)        |
| `apps/runtime/src/services/session/tiered-session-store.ts` | Wraps primary + MongoDB cold storage with auto-rehydration                         |
| `apps/runtime/src/services/session/session-state-repo.ts`   | MongoDB CRUD for `session_states` cold storage                                     |
| `packages/database/src/models/session.model.ts`             | Mongoose schema for `sessions` collection                                          |
| `packages/database/src/models/session-state.model.ts`       | Mongoose schema for `session_states` collection                                    |

### Routes / Handlers

| File                                                     | Purpose                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/runtime/src/routes/sessions.ts`                    | Project-scoped session API (CRUD, traces, metrics, analysis) |
| `apps/runtime/src/routes/admin-sessions.ts`              | Admin dashboard API (list, detail, stats)                    |
| `apps/runtime/src/routes/memory-api.ts`                  | Sandbox pod memory bridge endpoint                           |
| `apps/runtime/src/services/session/session-bootstrap.ts` | Shared session creation: deployment-aware + legacy DSL paths |
| `apps/runtime/src/services/session/session-factory.ts`   | Transport-agnostic session creation for WS/HTTP handlers     |
| `apps/runtime/src/services/session-cleanup-job.ts`       | Periodic cleanup with per-tenant retention                   |

### UI Components (Studio)

| File                                                           | Purpose                                           |
| -------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/components/session/SessionsListPage.tsx`      | Sessions table with filters, sorting, pagination  |
| `apps/studio/src/components/session/SessionDetailPage.tsx`     | Two-panel session detail (tree + debug tabs)      |
| `apps/studio/src/components/session/AgentExecutionTree.tsx`    | Hierarchical trace visualization                  |
| `apps/studio/src/components/session/MetricInfoIcon.tsx`        | Metric info tooltip icon                          |
| `apps/studio/src/components/session/OverviewTab.tsx`           | Session overview with state inspection            |
| `apps/studio/src/components/session/VoiceMetricsTab.tsx`       | Voice-specific metrics (call duration, STT/TTS)   |
| `apps/studio/src/components/chat/SessionSidebar.tsx`           | Previous sessions list with resume/delete         |
| `apps/studio/src/components/chat/SessionHealthBanner.tsx`      | Health status warnings for degraded sessions      |
| `apps/studio/src/components/sessions/SessionAnalysisPanel.tsx` | Session trace analysis                            |
| `apps/studio/src/components/analytics/SessionsExplorerTab.tsx` | Analytics sessions explorer                       |
| `apps/studio/src/components/analytics/SessionsTab.tsx`         | Analytics sessions tab                            |
| `apps/studio/src/components/admin/SessionDetail.tsx`           | Admin session detail view                         |
| `apps/studio/src/components/admin/SessionExplorerPage.tsx`     | Admin session explorer                            |
| `apps/studio/src/hooks/useSessionDetail.ts`                    | SWR hook for session detail + trace tree building |
| `apps/studio/src/hooks/useSessionList.ts`                      | SWR hook for sessions list (5s polling)           |
| `apps/studio/src/hooks/useAgentSessions.ts`                    | Hook for agent-specific session listing           |
| `apps/studio/src/hooks/useSessionHealth.ts`                    | Hook for session health status                    |
| `apps/studio/src/hooks/useSessionTraces.ts`                    | Hook for session trace events                     |
| `apps/studio/src/hooks/useSession.ts`                          | General session hook                              |
| `apps/studio/src/hooks/useTransferSessions.ts`                 | Hook for agent transfer sessions                  |
| `apps/studio/src/store/session-store.ts`                       | Zustand store for live chat session state         |
| `apps/studio/src/repos/session-repo.ts`                        | Studio-side session data repository               |

### Middleware / Auth

| File                                                       | Purpose                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/shared-auth/src/middleware/session-ownership.ts` | Middleware verifying user owns the session (tiered identity matching) |

### Tests

| File                                                           | Type        | Coverage Focus                                        |
| -------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| `apps/runtime/src/__tests__/session-service.test.ts`           | unit        | SessionService CRUD, IR caching, conversation windows |
| `apps/runtime/src/__tests__/session-redis.e2e.test.ts`         | integration | Full Redis session store integration                  |
| `apps/runtime/src/__tests__/tiered-session-store.test.ts`      | unit        | Hot/cold tiering, rehydration                         |
| `apps/runtime/src/__tests__/session-routes.test.ts`            | integration | REST API endpoints                                    |
| `apps/runtime/src/__tests__/sessions-authz.test.ts`            | integration | Authorization matrix (88 tests)                       |
| `apps/runtime/src/__tests__/session-security.test.ts`          | unit        | Encryption, tenant isolation                          |
| `apps/runtime/src/__tests__/session-fork.test.ts`              | unit        | Session forking                                       |
| `apps/runtime/src/__tests__/session-cleanup-retention.test.ts` | unit        | Per-tenant retention                                  |
| `apps/runtime/src/__tests__/memory-integration.test.ts`        | integration | End-to-end REMEMBER/RECALL                            |
| `apps/runtime/src/__tests__/memory-executor.test.ts`           | unit        | REMEMBER trigger evaluation                           |
| `apps/runtime/src/__tests__/tool-memory-bridge.test.ts`        | unit        | Sandbox memory bridge                                 |
| `apps/studio/src/__tests__/session-store.test.ts`              | unit        | Zustand session store (60 tests)                      |
| `apps/studio/src/__tests__/session-hooks.test.ts`              | unit        | SWR hooks (49 tests)                                  |
| `packages/database/src/__tests__/model-session.test.ts`        | unit        | Mongoose schema validation (41 tests)                 |
| `packages/shared-auth/src/__tests__/session-ownership.test.ts` | unit        | Session ownership middleware                          |

---

## 11. Configuration

### Environment Variables

| Variable                    | Default      | Description                                     |
| --------------------------- | ------------ | ----------------------------------------------- |
| `SESSION_STORE`             | `memory`     | Storage backend: `redis` or `memory`            |
| `SESSION_TTL_MINUTES`       | `1440` (24h) | Redis key expiry for session data               |
| `SESSION_CLEANUP_TTL_HOURS` | plan-based   | Session retention cutoff for cleanup job        |
| `MESSAGE_CLEANUP_TTL_HOURS` | plan-based   | Message retention cutoff for cleanup job        |
| `CLEANUP_INTERVAL_MINUTES`  | configurable | How often the cleanup job runs                  |
| `COLD_STORAGE_ENABLED`      | `true`       | Whether MongoDB cold storage is active          |
| `COLD_TTL_DAYS`             | `90`         | Cold storage expiry (aligns with BUSINESS plan) |

### Runtime Configuration

```typescript
// SessionConfig defaults (from types.ts)
{
  store: 'memory',
  conversationWindow: 40,        // Max messages in sliding window
  irCacheMaxEntries: 50,         // Pod-local LRU cache for AgentIR
  lockTtlMs: 5000,              // Execution lock timeout (5s)
  sessionTtlMinutes: 1440,      // 24-hour Redis TTL
  coldStorageEnabled: true,      // MongoDB backup when Redis expires
  coldTtlDays: 90,              // 90-day cold retention
  compactionEnabled: false,      // Auto-compaction (planned, not yet enabled)
  autoCompactThreshold: 0.8,     // Context usage ratio trigger
  compactionModel: 'gpt-4o-mini' // Model for compaction summaries
}
```

Per-tenant lifecycle defaults are managed via `TenantConfigService`:

- `sessionIdleSeconds`: Idle timeout per plan
- `sessionMaxAgeSeconds`: Absolute max age per plan
- `sessionRetentionDays`: How long ended sessions are kept in DB per plan

Disconnect defaults also exist in runtime config today via `channelLifecycle.<channel>.defaultDisposition` and `channelLifecycle.<channel>.disconnectBehavior`.

Current lifecycle gaps:

- project runtime config does not yet expose timeout or `channelLifecycle` fields
- project config merging does not currently apply `security` overrides in `TenantConfigService.getProjectConfig()`
- agent DSL timeout fields compile into IR, but runtime session creation does not yet consume them end-to-end

### DSL / Agent IR

Memory is configurable via the agent DSL `REMEMBER` and `RECALL` constructs:

```
REMEMBER:
  - when: "departure_city IS SET"
    store:
      target: "travel.preferences.departure_city"
      value: "session.departure_city"
      ttl: "30d"

RECALL:
  - on: session_start
    from: "travel.preferences"
    inject: "session.preferences"
```

At runtime, `REMEMBER` evaluation is not limited to gather/default-load paths. It also runs after flow-level state mutations, including `ON_START`, digression `SET`, `ON_INPUT`, `ON_RESULT`, action handlers, sub-intents, and navigation branches.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Project-scoped session routes must include `projectId`, and cross-project access must return 404 rather than leaking session existence.                                                                                                                                            |
| Tenant isolation  | Every session, cold-store, and Redis lookup must remain tenant-scoped through `tenantId`-prefixed keys or tenant-filtered DB queries. Redis keys use `sess:{tenantId}:{id}` prefix. MongoDB queries include `tenantId` in every filter. Cross-tenant resume returns 404 (not 403). |
| User isolation    | Session ownership middleware must ensure users can only inspect or mutate sessions they are allowed to access. Uses tiered identity matching: Tier 0 (session token), Tier 1 (channel artifact), Tier 2 (contact-linked identity).                                                 |

### Security & Compliance

- **Encryption at rest**: Sensitive fields (`authToken`, `state`, `dataValues`, `callerContext`, `customDimensions`, `threads`, `piiVaultData`) encrypted via `EncryptionService` with per-tenant keys. Redis store uses `enc:` prefix for encrypted values.
- **Compression**: Fields > 1KB are gzipped before encryption (`gz:` prefix in Redis). MongoDB cold store compresses `stateData`, `irData`, `compilationData` at the application layer.
- **Session ownership**: Fail-closed design — if ownership check encounters an error or cannot determine identity, access is denied (returns 404).
- **Execution locks**: Redis `SET NX PX` prevents concurrent execution on the same session (5s TTL).
- **PII vault**: Optional PII redaction with encrypted vault data stored per-session.
- **Sandbox JWT auth**: Memory API endpoint authenticates via sandbox-signed JWT tokens.
- **Admin auth**: Admin routes require `tenant:manage_settings` permission.

### Performance & Scalability

- **Redis reads**: Single-pipeline `HGETALL` + `LRANGE` for session load (1 round-trip).
- **Redis writes**: Lua script for atomic version-check-then-save. `saveAndReplaceConversation` batches session hash save + conversation list replace.
- **Compression**: Gzip for fields > 1KB before encryption reduces Redis memory footprint.
- **L1 cache**: Pod-local LRU (50 entries) eliminates Redis round-trips for IR resolution.
- **Conversation window**: Default 40 messages; sliding window preserves first (system) message + last N-1.
- **MemorySessionStore limits**: 10,000 sessions, 500 IR cache entries, 50,000 resolution keys with LRU eviction.
- **Cleanup batching**: 500-session batches prevent table-level locks during cleanup.
- **Cold persistence**: Fire-and-forget MongoDB writes to avoid adding latency to hot path.

### Reliability & Failure Modes

- **Redis unavailable**: Falls back to `MemorySessionStore` (single-pod, no persistence).
- **Cold storage failure**: Logged as warning, session operations continue on hot path only.
- **Version conflict**: Optimistic concurrency returns false; caller retries with fresh load.
- **Memory errors**: REMEMBER/RECALL operations emit `memory_error` trace, never throw. Fire-and-forget writes isolate memory failures from session execution.
- **Stale session reaper**: Detects and cleans orphaned sessions that missed normal cleanup.
- **TTL safety net**: MongoDB `endedAt` TTL index (400 days) ensures sessions are eventually cleaned even if cleanup job fails.

### Observability

- **Structured logging**: All session operations use `createLogger('module-name')` with contextual fields (sessionId, tenantId).
- **Trace events**: Session lifecycle events emitted to TraceStore: `session_start`, `session_end`, `session_fork`, `memory_recall`, `memory_remember`, `memory_error`.
- **Memory decision traces**: REMEMBER/RECALL operations emit decision traces with fact keys, values, and outcomes.
- **Health checks**: `useSessionHealth` hook surfaces degraded sessions in Studio UI.
- **Admin dashboard**: Aggregate statistics (total sessions, status/channel breakdown, messages/tokens/cost).

### Data Lifecycle

- **Hot storage TTL**: Redis keys expire after `sessionTtlMinutes` (default 24h). Per-tenant overrides via `maxAgeSeconds` and `idleSeconds` govern hot-store eviction, but Redis expiry is not a hard final session end because `TieredSessionStore` may cold-restore the session.
- **Cold storage TTL**: MongoDB `session_states` expire via `expiresAt` TTL index. Default 90 days.
- **Session cleanup**: Periodic job iterates tenants with plan-based retention. Pass 1 deletes terminal sessions past retention. Pass 2 marks active sessions past idle/age timeout with normalized `timeout` or `unengaged` disposition.
- **Safety net**: MongoDB `endedAt` TTL index on `sessions` collection (400 days) catches any sessions that escape cleanup.
- **Right to erasure**: Session delete cascades to Redis keys + MongoDB cold store + trace events.

---

## 13. Delivery Plan / Work Breakdown

1. Strengthen durability and isolation validation
   1.1 Add real E2E coverage for runtime restart persistence and cross-tenant isolation (GAP-001, GAP-006).
   1.2 Verify session resume and ownership behavior through transport-level integration paths.
   1.3 Add WebSocket session reconnection integration test (GAP-003).
2. Tighten storage and recovery behavior
   2.1 Evaluate whether cold restore should also rehydrate IR/compilation artifacts instead of only hashes (GAP-002).
   2.2 Revisit `saveAndReplaceConversation` atomicity tradeoffs if write contention increases (GAP-003).
3. Address security audit findings
   3.1 Fix `getAuthorizedRuntimeSession` messageType optional bypass — require messageType or default to strictest check (GAP-007).
   3.2 Add `tenantId` to Redis Pub/Sub channel keys for cross-pod event delivery (GAP-008).
4. Clean up implementation debt
   4.1 Replace remaining ad hoc logging in `MemorySessionStore` with `createLogger` (GAP-005).
   4.2 Enable compaction rollout and validate with integration tests (GAP-004).
5. Session forking with TieredSessionStore
   5.1 Add integration test for session forking with cold persistence.

---

## 14. Success Metrics

| Metric                           | Baseline                                                  | Target                                                            | How Measured                                                  |
| -------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Active-session continuity        | Session flows survive reconnects and Redis hot-path usage | Maintain durable resume across all supported transports           | Session restore tests, runtime/session support incidents      |
| Session load/restore correctness | Hot + cold restore paths covered in test inventory        | No regression in rehydration and fork flows                       | Session store/unit integration suites, trace/debug validation |
| Isolation safety                 | Docs call out project/tenant/user boundaries              | Zero cross-scope access incidents; all isolation paths E2E tested | Authz/isolation test suites and route behavior audits         |
| Test coverage                    | ~1,198 tests across 57 files                              | Maintain or increase; close open gaps (GAP-001 through GAP-008)   | `pnpm test` pass rate, test file inventory                    |
| Cold restore latency             | Not currently benchmarked                                 | < 200ms for cold restore + rehydration                            | Trace event timing on cold restore operations                 |

---

## 15. Open Questions

1. Should cold restore eventually repopulate IR and compilation payloads directly instead of relying on hash-based re-resolution? (If the L2 Redis cache has expired, the IR is lost.)
2. Does the current two-trip conversation replace path need a more strongly atomic implementation for higher-concurrency workloads?
3. When should `compactionEnabled` move from planned to active for large-session management?
4. Should the Redis Pub/Sub channel key format change require a rolling migration, or can it be deployed atomically since there is no persistent Pub/Sub state?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                               | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Session persistence across runtime restarts not E2E tested (cold restore from MongoDB after Redis TTL expiry on a different pod)                                          | Medium   | Open      |
| GAP-002 | Cold restore does not rehydrate IR/compilation data (hashes only) — if L2 Redis cache has also expired, IR must be recompiled                                             | Medium   | Open      |
| GAP-003 | `saveAndReplaceConversation` is not fully atomic (Lua + pipeline = 2 trips)                                                                                               | Low      | By design |
| GAP-004 | Auto-compaction not yet enabled (`compactionEnabled: false`) — `CompactionEngine` exists but is gated                                                                     | Low      | Planned   |
| GAP-005 | `MemorySessionStore` uses `console.warn` instead of `createLogger`                                                                                                        | Low      | Open      |
| GAP-006 | Cross-tenant session isolation not E2E tested with real multi-tenant setup                                                                                                | High     | Open      |
| GAP-007 | `getAuthorizedRuntimeSession` skips ownership check when `messageType` is falsy — allows unauthenticated session access for certain message types (Audit H1)              | High     | Open      |
| GAP-008 | Redis Pub/Sub cross-pod delivery does not include `tenantId` in channel key — in shared Redis deployments, subscribers may receive messages from other tenants (Audit M1) | Medium   | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                  | Coverage Type | Status     | Test File / Note                                                       |
| --- | ----------------------------------------- | ------------- | ---------- | ---------------------------------------------------------------------- |
| 1   | Session CRUD (create, load, save, delete) | unit          | PASS       | `session-service.test.ts` (148 tests)                                  |
| 2   | Redis session store integration           | integration   | PASS       | `session-redis.e2e.test.ts` (66 tests)                                 |
| 3   | Tiered store cold fallback                | unit          | PASS       | `tiered-session-store.test.ts` (16 tests)                              |
| 4   | Session resolution paths                  | unit          | PASS       | `session-resolver.test.ts` (13) + `session-resolver-gaps.test.ts` (21) |
| 5   | Session forking                           | unit          | PASS       | `session-fork.test.ts` (12 tests)                                      |
| 6   | Authorization matrix                      | integration   | PASS       | `sessions-authz.test.ts` (88 tests)                                    |
| 7   | Encryption at rest                        | unit          | PASS       | `session-security.test.ts` (32 tests)                                  |
| 8   | Cleanup/retention                         | unit          | PASS       | `session-cleanup-retention.test.ts` (19 tests)                         |
| 9   | REMEMBER/RECALL integration               | integration   | PASS       | `memory-integration.test.ts` + `flow-set-remember-regressions.test.ts` |
| 10  | Cross-tenant isolation E2E                | e2e           | NOT TESTED | GAP-006                                                                |
| 11  | Cold restore across restart               | e2e           | NOT TESTED | GAP-001                                                                |
| 12  | WebSocket reconnect integration           | integration   | NOT TESTED | GAP-003 (in test spec)                                                 |

### Testing Notes

Over 1,198 tests across 57 test files cover session CRUD, Redis store operations, conversation sliding windows, session resolution, forking, cleanup/retention, security/isolation, memory executor, and Studio UI components. Key gaps are in E2E testing for cross-tenant isolation and cold restore across runtime restarts.

> Full testing details: [docs/testing/memory-sessions.md](../testing/memory-sessions.md)

---

## 18. References

- Design docs: `docs/plans/2026-03-17-a2a-multi-turn-session-management.md`, `docs/specs/session-compaction.hld.md`, `docs/specs/omnichannel-session-continuity.hld.md`
- Related features: [Tracing & Observability](tracing-observability.md), [A2A Integration](a2a-integration.md), [Agent Transfer Orchestration](agent-transfer-orchestration.md), [Channels](channels.md), [Session Compaction](session-compaction.md)
- Testing guide: [docs/testing/memory-sessions.md](../testing/memory-sessions.md)
- Session ownership audit: Section 15 of this document (2026-03-20 five-auditor review)
