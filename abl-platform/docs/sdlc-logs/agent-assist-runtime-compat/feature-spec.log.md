# Oracle Log: Agent Assist Runtime Compat — Feature Spec Phase

**Date**: 2026-04-20
**Ticket**: ABLP-390
**Phase**: Feature Spec — Clarifying Questions
**Oracle**: product-oracle

---

## Context Consulted

- `CLAUDE.md` — Core invariants, auth patterns, isolation rules
- `docs/features/TEMPLATE.md` — Feature doc structure
- `docs/features/a2a-integration.md` — A2A protocol channel analogue (BETA)
- `docs/features/sdk.md` — SDK auth/session model (BETA)
- `docs/features/unified-deployment-endpoints.md` — Deployment endpoint abstraction (PLANNED)
- `docs/features/deployments-versioning.md` — Deployment model, endpointSlug, environment (BETA)
- `docs/features/channels.md` — Channel manifest, adapter pattern, session resolver (STABLE)
- `packages/shared-auth/src/middleware/unified-auth.ts` — API key resolution (x-api-key header, abl*\*, pk*\* prefixes)
- `apps/runtime/src/repos/auth-repo.ts` — resolveApiKey: ApiKey + PublicApiKey collections, prefix/hash matching
- `apps/runtime/src/routes/workflows-execute.ts` — External workflow execution, API key auth, error envelope
- `apps/runtime/src/routes/chat.ts` — Chat endpoint, SSE streaming, session management
- `apps/runtime/src/services/deployment-resolver.ts` — Deployment resolution strategies
- `apps/runtime/src/services/execution/types.ts` — ExecutionResult shape (response, action, richContent, actions)
- `apps/runtime/src/middleware/feature-gate.ts` — Feature gate pattern (deal + plan based)
- `apps/runtime/src/services/trace-store.ts` — Trace event architecture
- `packages/shared-kernel/src/constants/trace-event-registry.ts` — Trace event type naming conventions

---

## Answers

### A1: Endpoint scope for ABLP-390

**Classification**: DECIDED
**Answer**: The feature spec should describe all three endpoints (`runs/execute`, `sessions`, `sessions/terminate`) as the full compatibility surface, but phase them: Phase 1 delivers `runs/execute` (the critical path for Agent Assist suggestion rendering); Phase 2 adds `sessions` and `sessions/terminate` as follow-ups. The JIRA ticket covers the specification of the full surface with Phase 1 implementation.
**Evidence**: The user's context describes all three endpoints as part of "what Agent Assist calls." The POC framing suggests incremental delivery.
**Rationale**: `runs/execute` is the only endpoint needed for Agent Assist to render suggestions. Session create/terminate are lifecycle management that can follow once the core path works. Phasing reduces risk.
**Risk**: Low

### A2: POC vs production scope

**Classification**: DECIDED
**Answer**: The feature spec should describe BOTH phases: Phase 1 is a POC-grade wrapper with a stub "agent suggestion" placeholder, and Phase 2 wires it to ABL's real RuntimeExecutor. Both belong in the same feature spec since they share the same route, auth model, and response contract. Implementation is phased; the spec is holistic.
**Evidence**: User explicitly said "for quick POC ... place placeholder for real agent suggestions API" followed by "production scope wires it to ABL's real runtime executor." The SDLC pipeline (CLAUDE.md) requires feature specs to cover the full scope, not just the first slice.
**Rationale**: A single feature spec with two delivery phases is the standard SDLC pattern. The POC proves the contract; Phase 2 proves the execution.
**Risk**: Low

### A3: Channel record vs HTTP-only compatibility endpoint

**Classification**: DECIDED
**Answer**: This should be an HTTP-only compatibility endpoint, NOT a new channel type registered in `CHANNEL_MANIFEST`. Agent Assist is an external caller using a V2-compatible REST surface; it does not need `channel_connections` storage, widget builder integration, or channel-specific session resolution. It is closer in spirit to `workflows-execute.ts` (API-key-authenticated external execution) than to A2A (protocol channel with connection records).
**Evidence**: `docs/features/channels.md` shows channels require manifest entries, adapter implementations, session resolver hooks, and Studio CRUD. Agent Assist needs none of that -- it is a simple REST-in/REST-out or SSE surface. `workflows-execute.ts` at `apps/runtime/src/routes/workflows-execute.ts` is the closest analogue: API key auth, external caller, structured response envelope.
**Rationale**: Adding a channel type creates manifest entries, adapter code, Studio UI, and session-resolver hooks -- massive overhead for what is fundamentally a REST compatibility shim. The route can still create runtime sessions internally without being a registered channel.
**Risk**: Low -- if channel semantics are ever needed, the route can be promoted to a channel type later without breaking the API contract.

### A4: Server-only scope (no Agent Assist UI changes)

**Classification**: ANSWERED
**Answer**: This story is server-only (ABL side). The user explicitly stated "Without changing the code of agent assist," meaning Agent Assist's UI, widget, and configuration screens are out of scope. The only contract is HTTP API compatibility at the ABL runtime.
**Evidence**: User context: "Without changing the code of agent assist."
**Source**: User-provided context in the question prompt.
**Confidence**: HIGH

### A5: Ingestion-only vs bidirectional

**Classification**: DECIDED
**Answer**: Phase 1 is ingestion-only (Agent Assist -> ABL). The `callbackUrl` path (ABL -> Agent Assist async POST-back) should be documented in the spec as a Phase 2 capability but NOT required for the POC. Sync and SSE streaming responses cover the primary use case.
**Evidence**: The `isAsync` + `callbackUrl` fields are described as optional in the Agent Assist request body. The primary use case is live human-agent suggestion rendering, which is inherently synchronous or streaming.
**Rationale**: Sync + SSE streaming covers the real-time suggestion UX. Async callback adds complexity (webhook security, retry, delivery tracking) that is not needed for the initial integration.
**Risk**: Low

### B1: Personas in scope

**Classification**: DECIDED
**Answer**: All four personas are in scope for the feature spec: (a) Agent Assist platform operator re-pointing configs, (b) Contact Center human agent seeing suggestions, (c) ABL tenant admin minting API keys and binding deployments, (d) ABL runtime operator monitoring traffic. Personas (a) and (c) drive the setup/configuration stories. Persona (b) is the end-user whose experience validates the feature. Persona (d) drives observability requirements.
**Evidence**: Feature spec TEMPLATE.md Section 3 requires user stories; the AUTHORING_GUIDE expects 3+ personas per major feature. All four map to distinct interaction surfaces.
**Rationale**: Standard SDLC practice.
**Risk**: Low

### B2: Expected UX / content block types for MVP

**Classification**: DECIDED
**Answer**: MVP must support `text` output type only. The response envelope `output: [{type:'text', content:'...'}]` is the minimum contract Agent Assist can render. Structured content blocks (object, tool_input, recommendedAgents, cards) and streaming tokens (SSE) should be documented as Phase 2 enhancements. SSE streaming (with V1-format `data: {eventIndex,isLastEvent,output,sessionInfo}\n\n`) is Phase 1 scope since Agent Assist already consumes it.
**Evidence**: The Agent Assist expected response envelope shows `output: [{type, content}]` with `type: 'text'` as the baseline. ABL's `ExecutionResult` (`apps/runtime/src/services/execution/types.ts:488`) returns `response: string` plus optional `richContent` and `actions`. The text-only path maps cleanly: `result.response -> output: [{type:'text', content: result.response}]`.
**Rationale**: Text is the universal suggestion format. Rich content can be added incrementally.
**Risk**: Low

### B3: Rate limiting

**Classification**: ANSWERED
**Answer**: Reuse the existing `tenantRateLimit('request')` surface from ABL's rate-limiting feature. No per-deployment or per-Agent-Assist-app rate limit is needed for Phase 1. Per-endpoint rate limiting is a planned capability in `unified-deployment-endpoints.md` (FR-12) and can be adopted when that feature ships.
**Evidence**: `apps/runtime/src/routes/workflows-execute.ts` uses existing tenant-level rate limiting. `docs/features/unified-deployment-endpoints.md` FR-12 plans per-endpoint `rateLimitRpm`. `apps/runtime/src/middleware/rate-limiter.ts` provides `tenantRateLimit`.
**Source**: `docs/features/unified-deployment-endpoints.md:121` (FR-12)
**Confidence**: HIGH

### B4: Latency SLO

**Classification**: DECIDED
**Answer**: No explicit SLO is defined in existing docs. Recommend p95 < 3s for sync `runs/execute` (including LLM call) and TTFT < 1s for SSE streaming, matching the performance envelope of the existing `/api/v1/chat/agent` path which serves the same RuntimeExecutor pipeline. The compatibility layer itself (request parsing, response transformation) should add < 50ms overhead.
**Evidence**: No latency SLO exists in any feature doc for Agent Assist. The chat endpoint (`apps/runtime/src/routes/chat.ts`) has no explicit SLO either, but the `WS_MESSAGE_TIMEOUT_MS` constant defines an upper bound for execution timeout. Channel webhook endpoints return within ~50ms (enqueue only) per `docs/features/channels.md`.
**Rationale**: Agent Assist suggestions are shown to live agents during customer conversations. Sub-3s p95 is reasonable for an LLM-backed suggestion. The shim layer is pure I/O transformation and should not dominate latency.
**Risk**: Low -- this is a design target, not a contractual SLO.

### B5: Conversation history handling (aa_uamsgs)

**Classification**: DECIDED
**Answer**: ABL should accept `metadata.aa_uamsgs` from Agent Assist as supplementary context but rely on its own session-stored history (keyed by `sessionReference` mapped to a runtime session ID) as the primary conversation history source. The `aa_uamsgs` content should be passed through as `messageMetadata` on the first turn (when no ABL session history exists yet) and progressively deprioritized as ABL accumulates its own turns.
**Evidence**: ABL's session model (`apps/runtime/src/services/session/session-service.ts`) maintains its own conversation history. The A2A integration (`docs/features/a2a-integration.md` FR-11) established the pattern: external metadata passes through `messageMetadata` and is validated by `normalizeSdkMessageMetadata` without leaking reserved keys. The same boundary-metadata pattern applies here.
**Rationale**: Duplicating history management violates the single-source-of-truth principle. ABL sessions already handle multi-turn state. Accepting Agent Assist history as metadata is a safe additive pattern.
**Risk**: Medium -- the first-turn cold-start may need the AA history to provide context before ABL has accumulated any turns. This needs careful handling in the prompt/execution pipeline.

### C1: appId mapping to ABL identifiers

**Classification**: DECIDED
**Answer**: Use a new lightweight `AgentAssistBinding` record (or similar) that maps `{appId, environment} -> {tenantId, projectId, deploymentId}`. Do NOT reuse `Deployment.endpointSlug` (which is auto-generated and not human-configurable). Do NOT directly use ABL `projectId` as `appId` (format mismatch: `aa-<uuid>` vs ABL UUID).
**Evidence**: `docs/features/unified-deployment-endpoints.md` shows `endpointSlug` is auto-generated, not user-configurable (Resolved Decision 1), and the feature is PLANNED (not implemented). `docs/features/deployments-versioning.md` shows `Deployment.endpointSlug` is unique but has its own format. Agent Assist uses `aa-<uuid>` format which does not match any ABL identifier format.
**Rationale**: A binding record is the simplest approach that (a) decouples Agent Assist's identifier namespace from ABL's, (b) allows one-to-many bindings if needed, (c) can be migrated to unified deployment endpoints when that feature ships. The binding collection is small (one record per AA app configuration) and indexes on `{appId, environment}` with `tenantId` isolation.
**Risk**: Low -- the binding is a thin pointer. If unified-deployment-endpoints ships, the binding can delegate to it.

### C2: Environment path param mapping

**Classification**: DECIDED
**Answer**: Map the `:env` path param to ABL's environment model case-insensitively: normalize to lowercase (`dev`, `staging`, `production`) before lookup. Agent Assist uses title-case ("Dev") in its UI, so the compatibility layer must handle `Dev` -> `dev`, `Staging` -> `staging`, `Production` -> `production`.
**Evidence**: `docs/features/deployments-versioning.md` shows ABL environments are `dev | staging | production` (lowercase enum). The user context states Agent Assist UI shows "Dev" with capital D. The `AgentAssistBinding` record (C1) stores the target `environment` in ABL's lowercase format; the route normalizes on ingress.
**Rationale**: Case-insensitive matching is a standard HTTP compatibility practice and costs nothing.
**Risk**: Low

### C3: API key format compatibility

**Classification**: DECIDED
**Answer**: ABL does NOT need to mint `kg-<uuid>.<uuid>` format keys. The `x-api-key` header in `unified-auth.ts` already accepts ANY string via the `x-api-key` header path -- it passes the raw key to `config.resolveApiKey()` without prefix gating. The `abl_*` / `pk_*` prefix check only applies to `Authorization: Bearer` header extraction. Since Agent Assist sends keys via `x-api-key` header, any key format (including `kg-*`) will be passed through to the resolution function.

The minimum change: add a resolution path in `resolveApiKey` (or a separate resolver) that can look up keys stored in the `AgentAssistBinding` collection by hash match, scoped to the `appId` and `environment` from the route params. Alternatively, use ABL's existing `ApiKey` collection and let the tenant admin mint a standard `abl_*` key, then store a reference to it in the binding.

**Evidence**: `packages/shared-auth/src/middleware/unified-auth.ts:319-325` -- the `x-api-key` header value is used as-is without prefix filtering. `apps/runtime/src/repos/auth-repo.ts:326-372` -- `resolveApiKey` takes a hash and prefix, checking both `ApiKey` and `PublicApiKey` collections.
**Rationale**: Since Agent Assist stores "any string" as its API key (`aK` field), the simplest approach is: (1) the ABL admin mints a standard ABL API key and stores it in the binding, OR (2) the compatibility route performs its own key lookup from the binding. Option 1 is cleaner because it reuses the existing auth pipeline.
**Risk**: Low

### C4: HTTP status code split (200+error status vs 4xx)

**Classification**: INFERRED
**Answer**: Yes, this split is consistent with ABL's existing conventions. `workflows-execute.ts` returns HTTP 401/403/404/400 for auth and validation errors (lines 109, 119, 176, 159), and the chat endpoint follows the same pattern. For runtime/business errors during execution, returning HTTP 200 with `sessionInfo.status='error'` in the body matches Agent Assist's V1 expectations and is acceptable as a compatibility behavior. The compatibility route should document this as an intentional V1-compat deviation from ABL's standard `{success, error: {code, message}}` envelope.
**Evidence**: `apps/runtime/src/routes/workflows-execute.ts:108-192` -- 401/403/404/400 for pre-execution errors. Chat endpoint SSE streams errors inline rather than via HTTP status. The V1 Agent Assist envelope wraps errors inside `sessionInfo.status`.
**Source**: `apps/runtime/src/routes/workflows-execute.ts`
**Confidence**: HIGH

### C5: Code placement

**Classification**: DECIDED
**Answer**: New route file `apps/runtime/src/routes/agent-assist.ts` mounted at `/api/v2/apps/:appId/environments/:envName`. This should NOT be a new package (`packages/agent-assist`) -- it is a thin compatibility shim (request transformation, response transformation, binding resolution) that belongs in the runtime app alongside other external-facing routes like `workflows-execute.ts` and `chat.ts`. A supporting service file `apps/runtime/src/services/agent-assist/binding-resolver.ts` can hold the binding lookup and response transformation logic.
**Evidence**: CLAUDE.md cross-package rules: "Max 3 packages per commit." The route is runtime-specific and has no consumers outside `apps/runtime`. `workflows-execute.ts` and `chat.ts` are peer routes in the same directory. The route file + one service file is small enough for a single focused commit.
**Rationale**: Adding a new package creates Dockerfile sync requirements, Turbo config, and package.json overhead for what is < 500 LOC of compatibility logic. Route-level placement follows the established pattern.
**Risk**: Low

### C6: Extracting answer content from ExecutionResult

**Classification**: ANSWERED
**Answer**: `ExecutionResult.response` (string) is the canonical agent response text. Map it to `output: [{type:'text', content: result.response}]`. For rich content, `ExecutionResult.richContent` (optional `RichContentIR`) can be serialized as additional output blocks in Phase 2. There is no existing shared presenter/serializer for this transformation -- each channel adapter does its own (`transformOutput` method per `ChannelAdapter` interface). The compatibility route should implement its own lightweight transformer as a pure function.
**Evidence**: `apps/runtime/src/services/execution/types.ts:488-496` -- `ExecutionResult` has `response: string`, `richContent?: RichContentIR`, `actions?: ActionSetIR`. `docs/features/channels.md` describes per-adapter `transformOutput` methods. No shared presenter exists across channels.
**Source**: `apps/runtime/src/services/execution/types.ts:488`
**Confidence**: HIGH

### C7: POC placeholder behavior and cutover plan

**Classification**: DECIDED
**Answer**: The POC stub should return a recognizable mock: `output: [{type:'text', content:'[ABL Agent Suggestion Placeholder] Echo: <query>'}]` with proper `sessionInfo` structure. This makes it immediately obvious during integration testing whether responses come from the stub or a real agent. Cutover from placeholder to real executor should use a simple code-level switch (replace the stub function with the real executor call) rather than a feature flag or separate route. The route contract stays identical -- only the internal implementation changes.
**Evidence**: The A2A integration did NOT use feature flags for its phased rollout (`docs/features/a2a-integration.md` -- no feature flag mentioned). Feature gates in `apps/runtime/src/middleware/feature-gate.ts` are deal/plan-based, not dev-phase toggles.
**Rationale**: A feature flag adds complexity for a POC-to-production transition that will happen in a single development cycle. The route interface is stable; only the backing implementation changes. A simple code swap with a commit is cleaner and more auditable than flag management.
**Risk**: Low

### C8: Tenant/project/user isolation for non-project-scoped routes

**Classification**: INFERRED
**Answer**: The compatibility route is NOT under `/api/projects/:projectId/...`, so `requireProjectPermission` does not apply directly. Instead, implement a bespoke guard pattern similar to `workflows-execute.ts`: (1) authenticate via `authMiddleware` (API key flow), (2) resolve the binding by `{appId, envName}`, (3) verify the API key's `tenantId` matches the binding's `tenantId` (cross-tenant returns 404), (4) verify the API key's `projectScope` includes the binding's `projectId` (cross-project returns 404). This is the same pattern used in `workflows-execute.ts:183-192` where project scope is checked against the workflow's `projectId`.
**Evidence**: `apps/runtime/src/routes/workflows-execute.ts:108,183-192` -- API key auth followed by project scope verification against the resolved resource. `CLAUDE.md` Core Invariant 1: "Cross-scope access returns 404 (not 403)." The binding record provides the `tenantId` and `projectId` for the scope check.
**Source**: `apps/runtime/src/routes/workflows-execute.ts:183-192`
**Confidence**: HIGH

### C9: SSE streaming frame translation

**Classification**: DECIDED
**Answer**: Implement a translator inside the compatibility route that converts ABL's native stream events into V1-format SSE frames (`data: {eventIndex,isLastEvent,output,sessionInfo}\n\n`). This is a thin pure function that maps each ABL stream chunk to the Agent Assist expected frame format. Do NOT create a separate streaming code path -- reuse ABL's existing streaming infrastructure (the same `SessionLLMClient` SSE pipeline used by `/api/v1/chat/agent`) and transform the output at the response boundary.
**Evidence**: ABL's chat endpoint (`apps/runtime/src/routes/chat.ts`) already has SSE streaming infrastructure. The compatibility route adds a response-level transform, not a new streaming engine. Agent Assist's V1 format (`data: {eventIndex,isLastEvent,output,sessionInfo}\n\n`) is a simple envelope around content chunks.
**Rationale**: Translation at the response boundary is the standard compatibility pattern. It keeps ABL's streaming internals clean and confines V1-format knowledge to the compatibility shim.
**Risk**: Low

### C10: Async callback implementation

**Classification**: DECIDED
**Answer**: Defer async callback (`isAsync + callbackUrl`) to Phase 2. For Phase 1, if `isAsync=true` is sent, return HTTP 400 with `{error: {code: 'ASYNC_NOT_SUPPORTED', message: 'Async execution not yet supported. Use sync or streaming mode.'}}`. Phase 2 implementation should use BullMQ (a new `agent-assist-callback` queue) to post results back to `callbackUrl`, following the same pattern as the HTTP Async channel's webhook delivery worker (`apps/runtime/src/services/queues/channel-queues.ts`).
**Evidence**: `docs/features/channels.md` shows the HTTP Async channel uses BullMQ for async delivery. `docs/features/a2a-integration.md` FR-9 shows push notification callbacks use BullMQ resume jobs. Both are established patterns.
**Rationale**: Async callback adds webhook security (HMAC signing), retry logic, delivery tracking, and SSRF validation. This is non-trivial and not needed for the primary suggestion rendering use case.
**Risk**: Low

### D1: New collection for binding records

**Classification**: DECIDED
**Answer**: Yes, create a new `agent_assist_bindings` collection with the following shape:

```
Collection: agent_assist_bindings
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - appId: string (required) -- Agent Assist app ID (aa-<uuid>)
  - environment: string (required) -- normalized lowercase (dev|staging|production)
  - deploymentId: string | null -- optional pinned deployment
  - apiKeyId: string (required) -- reference to ABL ApiKey used for auth
  - status: 'active' | 'inactive'
  - metadata: Mixed -- extensible (source system info, etc.)
  - createdBy: string
  - createdAt, updatedAt: Date
Indexes:
  - { tenantId: 1, appId: 1, environment: 1 } (unique)
  - { tenantId: 1, projectId: 1 }
  - { apiKeyId: 1 }
Plugins: tenantIsolationPlugin
```

**Evidence**: CLAUDE.md Core Invariant 1 requires `tenantId` on every query. The `channel_connections` collection (`docs/features/a2a-integration.md:202-220`) follows the same pattern with tenant isolation plugin.
**Rationale**: The binding is a thin pointer (< 10 fields) that maps Agent Assist's namespace to ABL's. The unique compound index on `{tenantId, appId, environment}` prevents duplicate bindings and enables O(1) lookup on the hot path.
**Risk**: Low

### D2: Run/session recording

**Classification**: DECIDED
**Answer**: Requests should be recorded as standard ABL runtime sessions and messages, NOT as a parallel record type. The compatibility route creates (or resumes) a runtime session via `sessionReference`, then `executeMessage()` produces the standard trace events, persisted messages, and session history. This ensures Agent Assist traffic appears in the same observability, analytics, and billing pipelines as all other ABL traffic. A `source: 'agent_assist'` tag on the session metadata distinguishes the traffic origin.
**Evidence**: The chat endpoint (`apps/runtime/src/routes/chat.ts`) creates sessions and persists messages through the standard pipeline. The `runs-service.ts` at `apps/runtime/src/services/pipeline-observability/runs-service.ts` handles run records for pipeline observability. Using the standard path means Agent Assist traffic gets traces, metrics, and message persistence for free.
**Rationale**: Creating a parallel record type fragments observability and requires duplicating billing/analytics logic. Standard session recording reuses the entire existing pipeline.
**Risk**: Low

### D3: Source attribution storage

**Classification**: DECIDED
**Answer**: Yes, store `source: 'agent_assist'` (or `AIS-AA` if that exact string is required for billing) on the session metadata at creation time. This enables analytics queries like "all sessions originating from Agent Assist" and billing attribution. The session's `channelType` can be set to `api` (matching the existing API channel family) with `metadata.source` providing the Agent Assist attribution.
**Evidence**: The channel manifest (`apps/runtime/src/channels/manifest.ts`) includes `api` as a channel type. Session metadata is a Mixed field that can store arbitrary key-value pairs. The A2A integration uses `channelType: 'a2a'` for attribution.
**Rationale**: Source attribution is essential for billing and analytics. Storing it on session metadata is the established pattern and costs nothing.
**Risk**: Low

### E1: PII handling for Agent Assist source

**Classification**: DECIDED
**Answer**: Agent Assist traffic should go through ABL's standard PII handling pipeline -- no separate rules. The `aa_uamsgs` history (if passed) contains customer conversation data and MUST go through the same PII detection/redaction pipeline as any other user input before being passed to the LLM. The `source: 'agent_assist'` tag does not create a separate compliance domain.
**Evidence**: CLAUDE.md Core Invariant 5: "Compliance: Encryption at rest/transit, data minimization with TTLs, right to erasure cascades, audit logging." No existing feature creates source-specific PII rules -- all input goes through the same pipeline.
**Rationale**: Creating separate PII rules per source would fragment compliance and create maintenance burden. The standard pipeline handles all input.
**Risk**: Low

### E2: Trace event naming

**Classification**: INFERRED
**Answer**: Follow the existing `<domain>.<action>` naming convention from `packages/shared-kernel/src/constants/trace-event-registry.ts`. Recommended events:

- `compat_execute.received` -- request received and validated
- `compat_execute.session_resolved` -- session created or resumed
- `compat_execute.stream_start` -- SSE streaming began (if streaming)
- `compat_execute.completed` -- execution completed, response sent
- `compat_execute.error` -- execution or response error

These should be registered in the trace event registry. The `compat_execute` prefix distinguishes these from `channel.*` and `a2a.*` events while signaling that this is a compatibility surface.
**Evidence**: `packages/shared-kernel/src/constants/trace-event-registry.ts` uses dot-delimited `<domain>.<action>` patterns: `session_start`, `agent_response`, `channel.response.sent`, `endpoint.invoked`. The A2A integration uses `A2ATracingPort` with `traceInbound`/`traceOutbound`.
**Source**: `packages/shared-kernel/src/constants/trace-event-registry.ts`
**Confidence**: MEDIUM -- the exact prefix (`compat_execute` vs `agent_assist`) is a naming choice.

### E3: Rollout strategy

**Classification**: DECIDED
**Answer**: Use the existing feature gate middleware (`apps/runtime/src/middleware/feature-gate.ts`) to gate the compatibility endpoint behind a `agent_assist` feature flag. This is deal/plan-based gating, meaning only tenants with the feature enabled (via active deals or subscription plan) can use the endpoint. This is preferable to a global feature flag because it enables per-tenant rollout.
**Evidence**: `apps/runtime/src/middleware/feature-gate.ts` resolves features from active deals (by organizationId) and subscription plan defaults. This is the standard gating pattern for new runtime capabilities.
**Rationale**: Per-tenant gating via the existing feature gate is the lowest-risk rollout strategy. It avoids global on/off switches and enables progressive tenant onboarding.
**Risk**: Low

### E4: Cross-linked feature docs

**Classification**: INFERRED
**Answer**: The following feature docs should be cross-linked:

- `docs/features/a2a-integration.md` -- analogous protocol integration pattern
- `docs/features/sdk.md` -- auth model and session patterns
- `docs/features/unified-deployment-endpoints.md` -- future convergence target for endpoint addressing
- `docs/features/deployments-versioning.md` -- deployment and environment resolution
- `docs/features/channels.md` -- channel manifest and adapter architecture (even though this is not a channel)
- `docs/features/rate-limiting.md` -- rate limiting reuse
- `docs/features/tracing-observability.md` -- trace event conventions

Additionally: `docs/features/multi-agent-orchestration.md` (if the agent backing Agent Assist suggestions is a multi-agent system) and `docs/features/tenant-llm-policy.md` (model resolution for the backing agent).
**Evidence**: All listed docs contain related integration surfaces, auth patterns, or infrastructure that the compatibility endpoint touches.
**Source**: Cross-referencing all feature docs read during this oracle session.
**Confidence**: HIGH

---

## Decisions Made

| #     | Decision                                                                 | Rationale                                                              | Risk |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---- |
| D-A1  | Phase 1 = runs/execute only; sessions endpoints in Phase 2               | runs/execute is the critical path; sessions are lifecycle management   | Low  |
| D-A2  | Feature spec covers full scope (POC + production) in two phases          | SDLC pipeline requires holistic specs; phased delivery                 | Low  |
| D-A3  | HTTP-only compatibility endpoint, NOT a channel type                     | Channels require manifest/adapter/Studio overhead; this is a REST shim | Low  |
| D-A5  | Ingestion-only Phase 1; async callback deferred to Phase 2               | Sync+SSE covers the primary UX; async adds non-trivial complexity      | Low  |
| D-B1  | All four personas in scope                                               | Standard SDLC practice; each maps to a distinct interaction surface    | Low  |
| D-B2  | MVP supports text output + SSE streaming; rich content in Phase 2        | Text is universal; rich content is incremental                         | Low  |
| D-B4  | p95 < 3s sync, TTFT < 1s streaming (design targets)                      | Matches existing chat endpoint performance envelope                    | Low  |
| D-B5  | Accept aa_uamsgs as messageMetadata; rely on ABL session history         | Follows A2A boundary-metadata pattern; avoids history duplication      | Med  |
| D-C1  | New AgentAssistBinding collection for appId mapping                      | Decouples AA namespace from ABL; thin pointer; future-compatible       | Low  |
| D-C2  | Case-insensitive environment normalization                               | Standard HTTP compat practice; AA uses title-case                      | Low  |
| D-C3  | Use x-api-key header (any format accepted); standard ABL key recommended | unified-auth already passes x-api-key without prefix gating            | Low  |
| D-C5  | Route in apps/runtime/src/routes/agent-assist.ts                         | Follows existing route patterns; avoids new package overhead           | Low  |
| D-C7  | Recognizable placeholder with echo; code-level cutover (no feature flag) | POC-to-production is a single dev cycle; code swap is cleaner          | Low  |
| D-C9  | Translator at response boundary; reuse existing streaming infra          | Standard compat pattern; confines V1 format to the shim                | Low  |
| D-C10 | Async callback deferred to Phase 2; 400 for isAsync in Phase 1           | Non-trivial; not needed for primary suggestion UX                      | Low  |
| D-D1  | New agent_assist_bindings collection                                     | Thin pointer with tenant isolation; O(1) lookup on hot path            | Low  |
| D-D2  | Standard ABL sessions/messages, NOT parallel records                     | Reuses entire observability/billing pipeline                           | Low  |
| D-D3  | Store source:'agent_assist' on session metadata                          | Enables billing/analytics attribution at zero cost                     | Low  |
| D-E1  | Standard PII pipeline; no source-specific rules                          | Avoids fragmenting compliance; all input treated equally               | Low  |
| D-E3  | Feature gate middleware for per-tenant rollout                           | Reuses existing deal/plan-based gating; enables progressive rollout    | Low  |

## Escalations (AMBIGUOUS items)

None. All questions were answerable from the codebase, existing patterns, or reasonable judgment calls with low risk. No AMBIGUOUS items require user input before the feature spec can proceed.

---

## Phase-Auditor Round 1

**Date**: 2026-04-20
**Auditor**: phase-auditor
**Artifact**: `docs/features/agent-assist-runtime-compat.md`
**Phase**: FEATURE-SPEC
**Round**: 1 of 2

### VERDICT: NEEDS_REVISION

---

### CRITICAL (must fix before next phase)

- **[FS-2] FR-2 specifies `501 NOT_IMPLEMENTED` but CLAUDE.md mandates structured error envelopes `{ success, data?, error?: { code, message } }`, and the spec's own FR-9 says runtime errors use HTTP 200 with `sessionInfo.status: "error"`. The 501 return for Phase 1 `sessions` endpoints contradicts the V1 error contract.**
  Location: `docs/features/agent-assist-runtime-compat.md` line 86 (FR-2)
  Fix: Clarify the error envelope shape for FR-2's 501: it should still be `{ error: { code: "NOT_IMPLEMENTED", message: "..." } }` (which is already partially stated), but explicitly state that this is an HTTP-level rejection (like 400/401/404), NOT a runtime error wrapped in 200. This avoids contradiction with FR-9. If Agent Assist's client code does not handle 501 (many HTTP clients treat 5xx as retryable), consider whether 400 or 404 would be more appropriate for Phase 1 session endpoints to avoid retry storms.

- **[FS-6] User isolation is underspecified. The spec describes session keying by `sessionReference + tenantId + projectId + appId` but does not address whether two different API keys within the same tenant/project can see each other's sessions.**
  Location: `docs/features/agent-assist-runtime-compat.md` lines 333-334 (section 12, User isolation row)
  Fix: Specify whether session isolation is per-API-key (i.e., `apiKeyId` is part of the session lookup key) or per-binding. Since Agent Assist operates as a machine principal (API key), not a user, document that user isolation semantics map to "API key principal isolation" in this context: sessions created by binding B1 (which carries apiKeyId K1) should not be accessible via binding B2 (which carries apiKeyId K2), even within the same tenant/project. If this is intentional, state it explicitly. If sessions ARE shared across bindings for the same project, justify why.

### HIGH (should fix)

- **[FS-3] FR-11 references A2A `docs/features/a2a-integration.md FR-11` for the boundary-metadata pattern, but does not specify exactly which reserved transport keys are stripped.** The feature spec says `history` is a reserved key, but CLAUDE.md's "Boundary metadata normalization" invariant says "reserved transport keys (for example `history` during A2A handoff)" -- this is an A2A-specific example. The compat surface has its own transport context.
  Location: `docs/features/agent-assist-runtime-compat.md` line 95 (FR-11)
  Fix: Enumerate the specific reserved keys for the compat surface (at minimum: `history`, `token`, `credentials`, `apiKey`, `authorization`). The test spec's INT-4 already tests `history`, `token`, `credentials` -- align FR-11's text to match.

- **[FS-7] `AgentAssistBinding` data model is missing `createdBy` in indexes.** The TEMPLATE.md guidance says user-owned resources should have `createdBy` indexed. While bindings are admin-created (not user-owned in the traditional sense), the `createdBy` field exists in the schema but is not indexed, making audit queries by actor inefficient.
  Location: `docs/features/agent-assist-runtime-compat.md` lines 219-240 (section 9)
  Fix: Either add an index on `{ tenantId: 1, createdBy: 1 }` for admin audit queries, or add a brief justification for why `createdBy` does not need an index (e.g., "audit queries by actor use the audit-logging collection, not the binding collection directly").

- **[FS-8] Delivery plan Phase 1 is missing an explicit subtask for wiring the route into `apps/runtime/src/server.ts`.** The route file is created in subtask 1.2 ("wire into server.ts") but this is bundled with schema creation. Wiring a new route mount is a separate concern and should be its own subtask to ensure it is not overlooked during implementation.
  Location: `docs/features/agent-assist-runtime-compat.md` lines 379-380 (subtask 1.2)
  Fix: Split 1.2 into two subtasks: "1.2 Add Zod-strict request schemas for `runs/execute` in `agent-assist.schemas.ts`" and "1.3 Wire `agent-assist.ts` route into `server.ts` behind `AGENT_ASSIST_ENABLED` + feature gate middleware" (renumber subsequent subtasks).

- **[FS-10] Studio API table (section 8) does not indicate which endpoints are Phase 1 vs Phase 2.** The Runtime API table has a "Phase" column, but the Studio API table and Admin Portal section do not.
  Location: `docs/features/agent-assist-runtime-compat.md` lines 196-201 (Studio API table)
  Fix: Add a "Phase" column to the Studio API table. All four Studio routes are Phase 2. Also add phase annotation to the Admin Portal section (Phase 1: admin CRUD; Phase 2: Studio panel).

- **[FS-3] FR-18 (audit logging for binding CRUD) is testable but the testing matrix in section 17 does not have a dedicated row for it.** Scenario 12 in the testing matrix covers placeholder-vs-active behavior; there is no scenario for audit-log verification.
  Location: `docs/features/agent-assist-runtime-compat.md` lines 448-462 (section 17)
  Fix: Add a row: `| 13 | Binding create/update/disable emits structured audit-logging entries with actor + binding ID + before/after status | integration | NOT TESTED | apps/admin/src/__tests__/agent-assist-bindings-audit.test.ts |`. This aligns with FR-18 and the test spec's INT-6.

### MEDIUM (recommended)

- **[FS-9] Testing section does not explicitly state the minimum 5 E2E + 5 integration scenario requirement.** While the test spec placeholder meets this (7 E2E, 7 integration), the feature spec's section 17 "Required Test Coverage" table only lists 12 scenarios without calling out the E2E/integration minimums.
  Location: `docs/features/agent-assist-runtime-compat.md` line 463
  Fix: Add a note after the table: "Phase 1 ships with 5 E2E scenarios (rows 1-5) and 5 integration scenarios (rows 6-10). Phase 2 adds E2E-6, E2E-7, and additional integration scenarios per the testing guide."

- **[FS-5] Integration matrix lists `normalizeSdkMessageMetadata` as a key touchpoint for the A2A relationship, but the compat surface will have its own normalizer (`metadata-normalizer.ts`), not reuse `normalizeSdkMessageMetadata` directly.** The touchpoint should reference the pattern, not the specific SDK function.
  Location: `docs/features/agent-assist-runtime-compat.md` line 127
  Fix: Change the touchpoint from `normalizeSdkMessageMetadata` to `boundary-metadata normalization pattern (see sdk-message-metadata.ts for reference)` to avoid implying direct reuse of an SDK-specific function.

---

### Cross-Phase Consistency

- [XP-1] All FRs are self-contained within this feature spec. No backward traceability issues (this is Phase 1 of SDLC).
- [XP-2] Forward compatibility: the spec enables test-spec generation. All 18 FRs are testable. The testing placeholder already maps every FR to a coverage row. PASS.
- [XP-3] No scope creep detected. Goals and non-goals are well-separated. Phase 3 items are explicitly scoped out as "separate spec."
- [XP-4] Terminology is consistent: `AgentAssistBinding`, `sessionReference`, `appId`, `envName` used uniformly throughout.
- [XP-5] `apps/runtime/agents.md` has no compat-specific learnings yet (expected for PLANNED status). `packages/database/agents.md` notes about tenant isolation patterns (cross-tenant returns empty/null, not 403) are reflected in the spec's 404 semantics. PASS.

---

### Verified

- [x] [FS-1] Template completeness -- all 18 sections of TEMPLATE.md addressed. No sections missing or marked N/A without justification.
- [x] [FS-2] Code grounding -- `resolveApiKey()` exists in `apps/runtime/src/repos/auth-repo.ts`, `feature-gate.ts` exists in middleware, `workflows-execute.ts` exists as the stated analogue, `SessionService.createSession/loadSession` exist, `deployment-resolver.ts` exists, `trace-event-registry.ts` exists, `normalizeSdkMessageMetadata` exists in `apps/runtime/src/services/identity/sdk-message-metadata.ts`. All 10 referenced feature docs exist under `docs/features/`.
- [x] [FS-3] Requirement quality -- 18 FRs, all use "The system must..." language, all are testable.
- [x] [FS-4] User stories -- 6 stories (exceeds minimum 3), each has persona + capability + benefit.
- [x] [FS-5] Integration matrix -- 10 related features with relationship types specified (exceeds minimum 2).
- [x] [FS-6] Tenant and project isolation explicitly addressed in section 12, with 404 (not 403) semantics.
- [x] [FS-7] Data model has `tenantId` indexed, `projectId` indexed, unique compound index on `(tenantId, appId, environment)`.
- [x] [FS-8] Delivery plan has 3 parent tasks with numbered subtasks (1.1-1.10, 2.1-2.8, 3.1-3.3).
- [x] [FS-9] Testing section links to testing guide, coverage matrix present with 12 rows.
- [x] [FS-10] Scope clarity -- goals and non-goals well-separated with 7 explicit non-goals.
- [x] No TODO/TBD/??? placeholders found in the spec text.
- [x] No contradictions between Phase 1 and Phase 2 detected.
- [x] Feature and testing indexes (`docs/features/README.md`, `docs/testing/README.md`) are updated.
- [x] Runtime API table has a "Phase" column distinguishing Phase 1 from Phase 2 endpoints.
- [x] Open questions section has 6 genuine questions (exceeds minimum 1).
- [x] Gaps table has 6 entries with severity and status.
- [x] Success metrics table has 6 measurable metrics.
- [x] CLAUDE.md invariants reflected: centralized auth (FR-3), 404 not 403 (FR-5), structured errors (FR-9), error sanitization (FR-10), payload size guards (FR-17), stateless distributed (section 7), no console.log (testing notes mention no vi.mock).

---

### Notes for Next Round

- Focus area for re-audit after fixes: FR-2 error code choice (501 vs 400), user isolation specificity, testing matrix completeness (FR-18 row), Studio API phase annotations.
- Round 2 should verify fixes are consistent across the feature spec AND the testing placeholder (`docs/testing/agent-assist-runtime-compat.md`).

---

## Phase-Auditor Round 2

**Date**: 2026-04-20
**Auditor**: phase-auditor
**Artifact**: `docs/features/agent-assist-runtime-compat.md`
**Phase**: FEATURE-SPEC
**Round**: 2 of 2

### VERDICT: APPROVED

---

### Round-1 Finding Resolution Verification

All round-1 CRITICAL and HIGH findings have been resolved:

- **[FS-2] CRITICAL -- RESOLVED.** FR-2 (line 86) now returns HTTP 400 `FEATURE_NOT_AVAILABLE` with explicit rationale about avoiding retry-storm behaviour. The error envelope `{ error: { code, message } }` is consistent with the structured error convention. No contradiction with FR-9 (which covers runtime errors, not feature-availability rejections).
- **[FS-6] CRITICAL -- RESOLVED.** FR-6 (line 90) now specifies `callerContext.bindingId` and session lookup keyed on `(tenantId, projectId, bindingId, sessionReference)`. Two different bindings within the same project cannot share a session.
- **[FS-3] HIGH (reserved keys) -- RESOLVED.** FR-11 (line 95) now enumerates the full strip list: `history`, `token`, `credentials`, `apiKey`, `authorization`, `sessionId`, `runId`, `bindingId`, `tenantId`. The testing guide's FR-11 row (line 45) lists the identical set. Cross-phase consistency confirmed.
- **[FS-7] HIGH (createdBy index) -- RESOLVED.** Section 9 data model (line 241) now includes `{ tenantId: 1, createdBy: 1 }` index with purpose annotation "supports who created which binding audit queries."
- **[FS-8] HIGH (delivery subtask split) -- RESOLVED.** Subtask 1.2 (line 381) is now schemas + handlers; subtask 1.3 (line 382) is server.ts mount wiring. Downstream subtasks renumbered correctly through 1.11.
- **[FS-10] HIGH (phase annotations) -- RESOLVED.** Studio API table (lines 196-201) now has a Phase column (all Phase 2). Admin Portal section (line 205) explicitly states "Phase 1 (Admin API)" and "Phase 2 adds the routes listed above."
- **[FS-3b] HIGH (testing matrix FR-18) -- RESOLVED.** Row 13 (line 464) added for admin binding CRUD audit coverage. Minimum-shipping-target sentence updated.
- **[FS-9] MEDIUM -- RESOLVED.** Minimum-shipping-target sentence (line 466) now states "5 E2E scenarios (rows 1-5) and 5 integration scenarios (rows 6-8, 10, 13)."
- **[FS-5] MEDIUM -- RESOLVED.** A2A integration matrix touchpoint (line 127) now references "boundary-metadata normalization pattern (compat surface ships its own `metadata-normalizer.ts`)" instead of citing `normalizeSdkMessageMetadata` directly.

### MEDIUM (recommended -- do not block next phase)

- **[FS-12.1] User isolation table inconsistency with FR-6.** Section 12 user-isolation row (line 334) says sessions are keyed by `sessionReference + tenantId + projectId + appId`, but FR-6 (line 90) says the key is `(tenantId, projectId, bindingId, sessionReference)`. FR-6 is the authoritative requirement and uses `bindingId`, which is correct since `appId` alone does not distinguish environments. The isolation table should say `bindingId` instead of `appId` to match FR-6.
  Location: `docs/features/agent-assist-runtime-compat.md` line 334 (section 12, User isolation row)
  Fix: Replace `appId` with `bindingId` in the session key description: "Sessions are keyed by `sessionReference` + `tenantId` + `projectId` + `bindingId`."

- **[FS-12.2] Testing matrix minimum-shipping-target includes Phase 2 rows.** The sentence at line 466 claims Phase 1 ships with integration rows 6-8, but row 6 ("Phase 2 executor path") and row 7 ("Phase 2") explicitly describe Phase 2 behaviour. Row 6 could be tested in Phase 1 with the placeholder path (the test spec's INT-5 does not restrict to Phase 2), but the feature spec's row 6 scenario text says "Phase 2 executor path." Either (a) remove the "(Phase 2 executor path)" qualifier from row 6 to make it testable in Phase 1, or (b) correct the minimum-shipping-target to reference rows 8, 10, 12, 13 and add one more Phase 1 integration scenario to meet the 5-scenario minimum.
  Location: `docs/features/agent-assist-runtime-compat.md` lines 457, 466
  Fix: Simplest path: remove "(Phase 2 executor path)" from row 6's scenario text, since session continuity by `sessionReference` is testable in Phase 1 with the placeholder (placeholder creates real sessions per FR-12). Then the minimum-shipping-target sentence "rows 6-8, 10, 13" is valid because row 6 becomes Phase 1 testable and row 7 can be swapped for row 12. Alternatively, adjust the sentence to "rows 8, 10, 12, 13 plus a Phase 1 variant of row 6."

### Cross-Phase Consistency

- [XP-1] All FRs trace to the problem statement and goal statement. No orphan requirements.
- [XP-2] Forward compatibility: all 18 FRs are testable. The testing guide covers every FR in its coverage matrix (section 3). E2E scenarios (7 in test spec) and integration scenarios (7 in test spec) both exceed the 5-minimum. PASS.
- [XP-3] No new scope introduced vs round 1. Goals and non-goals unchanged. PASS.
- [XP-4] Terminology consistency: `AgentAssistBinding`, `sessionReference`, `appId`, `envName`, `bindingId`, `callerContext` used uniformly across feature spec and testing guide. One minor exception noted in FS-12.1 above (`appId` vs `bindingId` in isolation table).
- [XP-5] `apps/runtime/agents.md` has no compat-specific learnings yet (expected for PLANNED status). `packages/database/agents.md` notes that cross-tenant queries return empty/null (not 403), which is reflected in the spec's 404 semantics. PASS.

### FR-11 Reserved-Key List Cross-Doc Consistency

Feature spec FR-11 (line 95): `history`, `token`, `credentials`, `apiKey`, `authorization`, `sessionId`, `runId`, `bindingId`, `tenantId`
Testing guide FR-11 row (line 45): `history`, `token`, `credentials`, `apiKey`, `authorization`, `sessionId`, `runId`, `bindingId`, `tenantId`
Testing guide INT-4 (line 123-125): tests `history`, `token`, `credentials` explicitly; remaining keys are covered by "forbidden keys" language.
PASS -- lists are consistent.

### Fresh-Eyes Checks

- **Open questions quality**: 6 questions (lines 424-429), all genuine operational or design decisions. No rhetorical questions. Question 5 (health endpoint) and question 6 (admin session listing) are good edge cases that show depth of thought. PASS.
- **Gap severity accuracy**: GAP-003 (High -- `aa_uamsgs` not threaded into prompts) is appropriately High since it affects Phase 2 correctness. GAP-001 (Medium -- placeholder does not exercise LLM paths) is appropriately Medium since the test matrix extension handles it. GAP-004-006 are appropriately Low. PASS.
- **Success metric measurability**: All 6 metrics have baseline, target, and measurement method. "Re-point success rate >= 99% after 1 week" is measurable. "Contract parity gap = 0" is measurable via the regression suite. PASS.
- **No regressions from fixes**: Subtask renumbering (1.2/1.3 split) is consistent throughout -- no stale references to old subtask numbers found. Row 13 addition does not break the table structure. Phase column in Studio API table is formatted correctly. PASS.

### Verified

- [x] [FS-1] Template completeness -- all 18 sections addressed, no missing sections.
- [x] [FS-2] Code grounding -- all referenced code paths (`resolveApiKey`, `feature-gate.ts`, `workflows-execute.ts`, `SessionService`, `deployment-resolver.ts`, `trace-event-registry.ts`) verified as existing in the codebase.
- [x] [FS-3] Requirement quality -- 18 FRs, all testable "The system must..." statements.
- [x] [FS-4] User stories -- 6 stories with persona + capability + benefit.
- [x] [FS-5] Integration matrix -- 10 related features with relationship types.
- [x] [FS-6] Tenant, project, and user isolation explicitly addressed in section 12.
- [x] [FS-7] Data model has `tenantId`, `projectId`, `createdBy` indexed.
- [x] [FS-8] Delivery plan has parent tasks with numbered subtasks (1.1-1.11, 2.1-2.8, 3.1-3.3).
- [x] [FS-9] Testing section links to testing guide, coverage matrix has 13 rows, minimum stated.
- [x] [FS-10] Scope clarity -- goals and non-goals well separated, 7 explicit non-goals.
- [x] Round-1 CRITICAL findings (FS-2, FS-6) fully resolved.
- [x] Round-1 HIGH findings (FS-3, FS-7, FS-8, FS-10, FS-3b) fully resolved.
- [x] Round-1 MEDIUM findings (FS-9, FS-5) fully resolved.
- [x] Cross-phase consistency between feature spec and testing guide confirmed.
- [x] No contradictions introduced by the fixes.

### Notes

Two MEDIUM items identified (FS-12.1, FS-12.2) that do not block progression to the test-spec phase. They should be addressed before implementation to avoid ambiguity in session-key semantics and test-matrix phase assignment. Log these for the implementing skill to pick up during LLD or implementation.

## Post-Audit Round-2 Edits (MEDIUM fixes)

- FS-12.1 — §12 User isolation row rewritten to use `bindingId` (aligned with FR-6 canonical key).
- FS-12.2 — §17 row 6 rephrased: session continuity is covered in Phase 1 against the placeholder path and extended in Phase 2 against the real executor.

## Final State

- Feature spec: docs/features/agent-assist-runtime-compat.md — APPROVED by phase-auditor round 2 (all CRITICAL/HIGH from round 1 resolved; remaining round-2 MEDIUM items applied inline).
- Testing placeholder: docs/testing/agent-assist-runtime-compat.md — 5 E2E + 7 integration + 4 unit scenarios planned; every FR mapped in coverage matrix.
- Feature index (docs/features/README.md) and testing index (docs/testing/README.md) updated with new row #94 / #98 respectively.
- Branch: KI081/feat/ABLP-390-agent-assist-runtime-compat (new worktree at .worktrees/agent-assist-runtime-compat) — NO COMMITS yet per user instruction "without committing anything".
- Next SDLC phase (after user review): /test-spec, then /hld, then /lld.

## Phase-Auditor Round 1 (post-refactor, two-layer)

**Date**: 2026-04-20
**Auditor**: phase-auditor
**Artifact**: `docs/features/agent-assist-runtime-compat.md`
**Phase**: FEATURE-SPEC
**Round**: 1 of 2

### VERDICT: NEEDS_REVISION

---

### CRITICAL (must fix before next phase)

- **[FS-2] GET session endpoint in API table has no corresponding FR.** The canonical API table (section 8, line 222) lists `GET /api/v1/projects/:projectId/agent-suggestions/sessions/:sessionId` ("Fetch session metadata + latest state") but no FR in section 4.1 describes or requires this endpoint. FR-2 covers POST (create/resume), FR-3 covers POST turns, FR-4 covers terminate + one-shot suggest. A GET endpoint with no governing FR means no testable requirement, no coverage matrix row, and no implementation anchor.
  Location: `docs/features/agent-assist-runtime-compat.md` line 222 (API table)
  Fix: Either (a) add an FR (e.g., FR-2b or renumber to FR-2 create/resume, FR-3 fetch, FR-4 turns, etc.) with "The system must provide `GET /api/v1/projects/:projectId/agent-suggestions/sessions/:sessionId` returning session metadata, state, and turn count for the authenticated caller, scoped by `projectId` and `tenantId`", then add a testing-guide coverage row and a section-17 row; or (b) remove the GET endpoint from the API table and add it to the non-goals or follow-ups if it is not in scope.

- **[FS-6] Canonical session user-isolation is weaker than the V1-facade session isolation.** Section 12 User Isolation row states canonical sessions are keyed on `(tenantId, projectId, externalReference)`. FR-7 confirms this: sessions are resolved by `(tenantId, projectId, externalReference|sessionId)`. This means two different API keys within the same tenant+project that supply the same `externalReference` will share the same session. The V1 facade prevents this by scoping `externalReference` per `bindingId`. On the canonical surface, there is no binding; two independent third-party integrations (e.g., Google CCAI and Cresta, both scoped to the same project) using the same `externalReference` value (e.g., `"conv-123"`) would collide. This is a real isolation concern for the multi-vendor canonical surface.
  Location: `docs/features/agent-assist-runtime-compat.md` line 403 (section 12, User isolation row) and FR-7 (line 101)
  Fix: Either (a) document that canonical `externalReference` values are scoped per API key (i.e., the session lookup key is `(tenantId, projectId, apiKeyId, externalReference)`) to prevent cross-integration collision -- update FR-7 accordingly and add a testing-guide scenario; or (b) explicitly document that `externalReference` collision across API keys within the same project is expected behavior, with the justification that callers are expected to use unique references (e.g., prefixed by their integration ID), and add this to the Open Questions or Gaps table.

### HIGH (should fix)

- **[FS-3] Feature spec section 17 testing matrix has significant FR coverage gaps.** The 18-row table covers approximately 20 of 30 FRs. Missing FRs with no dedicated row: FR-4 (terminate idempotency + one-shot suggest), FR-9 (Zod validation + HTTP 413), FR-12 (canonical trace events landing in TraceStore), FR-13 (error sanitization of user-visible strings), FR-14 (shared-kernel typed contract importable + SemVer), FR-16 (POC `sessions` endpoints return 400 -- only partially in row 4 which focuses on the feature gate, not the 400 for sessions specifically), FR-23 (V1 HTTP 200 error wrapping -- partially covered in row 1 but not explicitly), FR-28 (cross-layer payload 413 on both layers), FR-30 (ADAPTERS.md exists). The testing guide's section 3 matrix covers all FRs, but the feature spec's own section 17 should at minimum have one row per FR or explicitly reference the testing guide for full coverage.
  Location: `docs/features/agent-assist-runtime-compat.md` lines 531-551 (section 17)
  Fix: Add rows for the missing FRs. At minimum: (a) FR-4: terminate idempotency + one-shot suggest lifecycle; (b) FR-9 + FR-28: payload validation and 413 on both layers; (c) FR-13: error sanitization (canonical error does not leak tenant/model IDs); (d) FR-16: POC sessions/terminate return 400 FEATURE_NOT_AVAILABLE (not just feature-gate-off); (e) FR-30: ADAPTERS.md existence and contract documentation (manual check). FR-14 and FR-23 can be folded into existing rows with explicit annotations.

- **[FS-8] Delivery plan Phase POC is missing a subtask for the V1 SSE streaming path.** Subtask 1.3 mentions "sync + small SSE sequence" in passing, but the V1 SSE frame contract (FR-22) is non-trivial (eventIndex sequencing, isLastEvent, content-type headers, no-cache, X-Accel-Buffering) and the testing guide has a dedicated E2E scenario (E2E-POC-2) for it. Streaming deserves its own implementation subtask to ensure it is not treated as a trivial add-on to the sync path.
  Location: `docs/features/agent-assist-runtime-compat.md` line 456 (subtask 1.3)
  Fix: Split subtask 1.3 into: "1.3 Implement `placeholder-responder.ts` returning the deterministic placeholder for sync requests with a valid V1 `sessionInfo` envelope" and "1.4 Implement V1 SSE streaming path in the placeholder responder (V1 SSE frame contract: eventIndex sequencing, isLastEvent terminal, Content-Type/Cache-Control/X-Accel-Buffering headers)." Renumber downstream subtasks.

- **[FS-3] FR-6 states cross-project access returns 404 (correct) but also says "scope failures with 403."** The sentence "rejecting missing/invalid auth with 401 and scope failures with 403" followed by "Cross-project access... must return 404 (never 403)" creates ambiguity. The 403 applies when the key IS scoped to the project but lacks the specific `agent_suggestions:execute` permission; the 404 applies when the key is not scoped to the project at all. This distinction is correct but the FR text does not make it clear enough -- a reader could interpret "scope failures" as including cross-project access.
  Location: `docs/features/agent-assist-runtime-compat.md` FR-6, line 100
  Fix: Rewrite FR-6 to: "...rejecting missing/invalid auth with 401, missing `agent_suggestions:execute` permission within the authorized project with 403, and cross-project access (key scoped to project A, path `:projectId` is project B) with 404 (never 403), matching ABL's existence-disclosure invariant." This makes the 403 vs 404 boundary unambiguous.

- **[FS-10] Phase POC delivery plan references Phase POC emitting trace events (subtask 1.6) and creating real sessions (design consideration "Phase POC parity" in section 6, line 174), but FR-19 says Phase POC "short-circuits to a deterministic placeholder... without calling the canonical service."** If the POC creates real sessions and emits trace events, this is more than a pure placeholder -- it has side effects. This is not a contradiction per se (the spec says "the canonical service call is bypassed" not "no sessions"), but the delivery subtasks do not include a subtask for session creation in Phase POC. The testing guide E2E-POC-1 asserts `callerContext.source = "agent_suggestions"` which implies a session exists.
  Location: `docs/features/agent-assist-runtime-compat.md` subtasks 1.1-1.8 vs section 6 "Phase POC parity"
  Fix: Add an explicit delivery subtask: "1.X Implement POC session creation via `SessionService.createSession` with `callerContext.source = 'agent_suggestions', facade: 'agent_assist_v1'` so trace events and session records are real even in placeholder mode." This makes the POC parity claim actionable.

### MEDIUM (recommended)

- **[FS-9] Testing section 17 does not state the E2E/integration minimum split explicitly.** The prior-approved spec had a note "Phase 1 ships with 5 E2E scenarios (rows 1-5) and 5 integration scenarios (rows 6-8, 10, 13)." The refactored spec's section 17 (line 552) states Phase POC and Phase Actual targets, but the minimum scenario count per type is not called out for the refactored two-layer architecture. The testing guide's section 2 health dashboard shows "0 / >=4" canonical E2E and "0 / >=5 (POC) + >=3 (Actual)" V1 facade E2E, which totals >=12 E2E and >=5 integration, but the feature spec should echo these minimums.
  Location: `docs/features/agent-assist-runtime-compat.md` line 552
  Fix: Add after line 552: "Minimum coverage: 5+ E2E per layer (canonical: rows 6-8 + Actual extras; V1 facade: rows 1-5 + Actual extras), 5+ integration (rows 10-11, 16-18), per SDLC pipeline requirements."

- **[FS-5] Integration matrix A2A row (line 153) says the canonical surface "ships its own normalizer" and references "boundary-metadata normalization pattern" but does not mention that A2A's BullMQ push-callback delivery pattern is also reused for V1 async-push (FR-25).** The "Key Touchpoints" column mentions "BullMQ push callbacks" but the notes column does not connect this to the specific FR-25 implementation.
  Location: `docs/features/agent-assist-runtime-compat.md` line 153
  Fix: Add to the A2A row's "Notes" or "Key Touchpoints": "FR-25 V1 async-push callback delivery worker follows A2A's BullMQ resume-job pattern (retry + dead-letter)."

- **[FS-7] Data model section does not mention the canonical session record shape explicitly.** The spec says "Both layers write to the existing sessions collection with `source: 'agent_suggestions'` and `channelType: 'api'` tags" (line 289), but does not show the session document fields that are specific to agent-suggestions (e.g., `callerContext.facade`, `callerContext.appId`, `callerContext.bindingId`, `callerContext.environment`). These are mentioned in the Key Relationships subsection (line 296) but not in the collection-level field listing.
  Location: `docs/features/agent-assist-runtime-compat.md` lines 289-296
  Fix: Add a brief "Session Record Extensions" block showing the `callerContext` fields that agent-suggestions traffic adds to the existing session document: `callerContext: { source: "agent_suggestions", facade: "canonical" | "agent_assist_v1", projectId, bindingId?, appId?, environment, externalReference }`.

---

### Cross-Phase Consistency

- [XP-1] All FRs (1-30) are self-contained within this feature spec. Backward traceability to the problem statement is clear. PASS.
- [XP-2] Forward compatibility: the spec enables test-spec and HLD generation. All 30 FRs are testable. The testing guide covers every FR in its coverage matrix. PASS.
- [XP-3] No scope creep detected. Goals and non-goals are well-separated. Phase Actual follow-ups (3.1-3.4) are explicitly scoped as "separate specs." PASS.
- [XP-4] Terminology is consistent: "Agent Suggestions Service" (canonical), "Agent Assist V1 Compatibility Facade" (V1), "AgentAssistBinding", "sessionReference", "externalReference", "appId", "envName", "bindingId" used uniformly. The spec consistently says "Kore.ai Agent Assist" (not generic "Agent Assist"). PASS.
- [XP-5] `apps/runtime/src/routes/agents.md` has no agent-suggestions learnings yet (expected for PLANNED). `packages/shared-kernel/src/constants/trace-event-registry.ts` exists at the claimed path. PASS.

---

### Verified

- [x] [FS-1] Template completeness -- all 18 sections of TEMPLATE.md addressed. No sections missing or marked N/A without justification.
- [x] [FS-2] Code grounding -- `resolveApiKey()` exists in `apps/runtime/src/repos/auth-repo.ts` and `apps/runtime/src/middleware/auth.ts`. `feature-gate.ts` exists at `apps/runtime/src/middleware/feature-gate.ts`. `workflows-execute.ts` exists at `apps/runtime/src/routes/workflows-execute.ts`. `SessionService` exists in `apps/runtime/src/services/session/session-service.ts`. `deployment-resolver.ts` exists at `apps/runtime/src/services/deployment-resolver.ts`. `trace-event-registry.ts` exists at `packages/shared-kernel/src/constants/trace-event-registry.ts`. `createUnifiedAuthMiddleware` exists in `apps/runtime/src/middleware/auth.ts`. `requireProjectPermission` is used extensively across 87+ route files. The `packages/shared-kernel/src/agent-suggestions/` directory does NOT yet exist (correct -- this is PLANNED).
- [x] [FS-3] Requirement quality -- 30 FRs, all use "The system must..." language, all are testable.
- [x] [FS-4] User stories -- 7 stories (exceeds minimum 3), each has persona + capability + benefit.
- [x] [FS-5] Integration matrix -- 11 related features with relationship types specified (exceeds minimum 2).
- [x] [FS-6] Tenant and project isolation explicitly addressed in section 12 with 404 (not 403) semantics. Cross-env guard added as a fourth row.
- [x] [FS-7] Data model has `tenantId` indexed (required), `projectId` indexed, `createdBy` indexed, unique compound index on `(tenantId, appId, environment)`. `tenantIsolationPlugin` + `auditLoggingPlugin` specified.
- [x] [FS-8] Delivery plan has 3 parent phases with numbered subtasks (1.1-1.8, 2.1-2.12, 3.1-3.4).
- [x] [FS-9] Testing section links to testing guide. Coverage matrix present with 18 rows. Testing guide has production-wiring verification section (section 7).
- [x] [FS-10] Scope clarity -- goals and non-goals well-separated with 9 explicit non-goals.
- [x] FR numbering is contiguous 1-30 with no gaps.
- [x] No TODO/TBD/??? placeholders found in spec text.
- [x] Phase annotations present on both Runtime API tables (canonical + V1 facade) and Studio API table.
- [x] Open questions section has 7 genuine questions (exceeds minimum 1).
- [x] Gaps table has 8 entries with severity and status.
- [x] Success metrics table has 8 measurable metrics with baseline/target/measurement method.
- [x] CLAUDE.md invariants reflected: centralized auth (FR-6, FR-17), 404 not 403 (FR-6, FR-17), structured error envelopes on canonical surface (FR-9), error sanitization (FR-13), payload size guards (FR-9, FR-28), stateless distributed (section 7), V1 HTTP-200-error-wrapping documented as intentional deviation (FR-23, section 6).
- [x] Two-layer architecture coherence: Layer A (canonical) is consistently modelled as source of truth for sessions, execution, PII, tracing, billing. Layer B (V1 facade) is consistently described as pure translation + delegation. No FR implies facade has its own session store or executor.
- [x] Phase split consistency: Phase POC never references canonical-service infrastructure that does not exist yet (FR-10, FR-19 explicitly say "canonical service does not yet exist" in POC). Phase Actual FRs and delivery subtasks match.
- [x] Testing guide section 3 coverage matrix has rows for all 30 FRs.
- [x] No contradictions between layers detected (no FR says canonical owns sessions while another implies facade has its own store).
- [x] File placements match ABL patterns: route at `apps/runtime/src/routes/agent-assist.ts`, service at `apps/runtime/src/services/agent-suggestions/`, typed contract at `packages/shared-kernel/src/agent-suggestions/types.ts`, trace events in `packages/shared-kernel/src/constants/trace-event-registry.ts`, admin routes at `apps/admin/src/routes/`.

---

### Notes for Next Round

- Focus areas for re-audit after fixes:
  1. CRITICAL: GET session endpoint -- either add FR or remove from API table
  2. CRITICAL: Canonical `externalReference` isolation across API keys
  3. HIGH: Section 17 testing matrix FR coverage completeness
  4. HIGH: FR-6 ambiguity between 403 and 404
  5. HIGH: Phase POC session creation subtask in delivery plan
  6. HIGH: V1 SSE streaming delivery subtask split
- Round 2 should verify fixes are consistent across feature spec AND testing guide.

## Phase-Auditor Round 2 (post-refactor, two-layer)

**Date**: 2026-04-20
**Auditor**: phase-auditor
**Artifact**: `docs/features/agent-assist-runtime-compat.md`
**Phase**: FEATURE-SPEC
**Round**: 2 of 2

### VERDICT: APPROVED

---

### Round-1 Finding Resolution Verification

All round-1 CRITICAL and HIGH findings have been resolved:

- **[FS-2] CRITICAL -- RESOLVED.** The GET session endpoint row has been removed from the canonical API table. Line 226 adds an explicit note: "`GET` on sessions (fetch metadata + latest state) is deliberately deferred to a follow-up (section 13.3) rather than shipped in this feature." No orphan endpoint with no governing FR remains. No regression.

- **[FS-6] CRITICAL -- RESOLVED.** FR-7 (line 101) now reads: "The system must resolve sessions through `SessionService.createSession`/`loadSession` keyed on the composite `(tenantId, projectId, apiKeyId, externalReference | sessionId)` with `callerContext.source = "agent_suggestions"` and `callerContext.apiKeyId` stamped." The `apiKeyId` inclusion prevents two different third-party integrations sharing the same project from colliding on a coincidentally identical `externalReference`. Section 12 User Isolation row (line 416) is fully aligned, explicitly stating the `(tenantId, projectId, apiKeyId, externalReference)` composite. V1 facade consistency confirmed: FR-20 (line 117) materializes `externalReference = bindingId + ":" + sessionReference` and subtask 1.5 stamps `callerContext.apiKeyId = binding.apiKeyId`. No regression.

- **[FS-3] HIGH (section 17 FR coverage gaps) -- RESOLVED.** Six new rows added (19-24): row 19 covers FR-4 (terminate idempotency + one-shot), row 20 covers FR-9 + FR-28 (413 + 400), row 21 covers FR-13 (error sanitization), row 22 covers FR-16 (POC 400 FEATURE_NOT_AVAILABLE), row 23 covers FR-23 (V1 HTTP-200 error wrapping), row 24 covers FR-30 (ADAPTERS.md existence). Each row has an explicit FR anchor in its scenario text. The 24-row matrix now covers all 30 FRs (some FRs share rows). No regression.

- **[FS-8] HIGH (POC delivery missing SSE + session creation subtasks) -- RESOLVED.** Subtask 1.3 is now sync-only placeholder. Subtask 1.4 is the V1 SSE path with explicit header/frame/terminal requirements. Subtask 1.5 is POC session creation via `SessionService.createSession` with the full `callerContext` shape, directly satisfying the section 6 "Phase POC parity" design consideration and E2E-POC-1's `callerContext.source` assertion. Downstream subtasks renumbered correctly through 1.10. No regression.

- **[FS-3/FR-6] HIGH (401 vs 403 vs 404 disambiguation) -- RESOLVED.** FR-6 (line 100) now has explicit per-outcome mapping: "(a) missing / invalid credentials -> 401 UNAUTHORIZED; (b) valid key scoped to the authorized project but missing `agent_suggestions:execute` permission -> 403 FORBIDDEN; (c) valid key NOT scoped to the path `:projectId` (cross-project access) -> 404 PROJECT_NOT_FOUND (never 403)." This is unambiguous. No regression.

- **[FS-9] MEDIUM -- RESOLVED.** Line 575 now states: "Minimum coverage per SDLC pipeline: >= 5 E2E per layer (canonical + V1 facade) and >= 5 integration scenarios total, plus unit coverage on every pure translator." No regression.

- **[FS-5] MEDIUM -- RESOLVED.** A2A integration matrix row (line 153) Key Touchpoints now includes "BullMQ push callbacks (see FR-25)" and the relationship description mentions "the async/push callback delivery shape." No regression.

- **[FS-7] MEDIUM -- RESOLVED.** Section 9 now includes a "Session Record Extensions" block (lines 292-303) listing all `callerContext` fields stamped by both layers: `source`, `facade`, `apiKeyId`, `externalReference`, `bindingId`, `appId`, `environment` -- with layer attribution and purpose for each. No regression.

### Consistency Checks on Fixes

1. **FR-7 composite key consistency across the spec.** FR-7 (line 101) says `(tenantId, projectId, apiKeyId, externalReference)`. Section 12 User Isolation (line 416) says `(tenantId, projectId, apiKeyId, externalReference)`. Session Record Extensions (line 298) says `callerContext.apiKeyId` is "Part of the session composite key (FR-7)". All three are aligned. PASS.

2. **FR-20 V1 facade session key consistency with FR-7.** FR-20 (line 117) says composite session key is `(tenantId, projectId, bindingId, sessionReference)` materialized as canonical `externalReference`. Subtask 1.5 (line 471) stamps `callerContext.apiKeyId = binding.apiKeyId` and `externalReference = bindingId + ":" + sessionReference`. This means the canonical FR-7 key becomes `(tenantId, projectId, binding.apiKeyId, bindingId:sessionReference)` -- two axes of isolation. PASS.

3. **Rows 19-24 FR anchors map cleanly.** Row 19 -> FR-4 (terminate + one-shot). Row 20 -> FR-9 + FR-28 (validation + payload). Row 21 -> FR-13 (sanitization). Row 22 -> FR-16 (POC 400). Row 23 -> FR-23 (V1 HTTP-200 error). Row 24 -> FR-30 (ADAPTERS.md). Each FR reference matches the FR's actual content. PASS.

4. **POC subtasks 1.3/1.4/1.5 vs section 6 "Phase POC parity."** Section 6 (line 174) says "The POC placeholder emits the same trace events and session records as Phase Actual would." Subtask 1.5 creates real sessions. Subtask 1.8 registers and emits `agent_assist.*` trace events. Subtask 1.4 implements V1 SSE. No contradiction -- the POC path creates real sessions and emits real traces, only the canonical-service execution call is bypassed. PASS.

5. **Testing guide alignment with feature spec section 17.** Testing guide coverage matrix (section 3) has rows for all 30 FRs, grouped by layer. Feature spec section 17 has 24 rows covering all 30 FRs. The testing guide's E2E scenarios (section 4) have 13 scenarios across both phases. The testing guide's integration scenarios (section 5) have 8 scenarios. Both exceed the minimum 5 per category. PASS.

### MEDIUM (recommended -- do not block next phase)

- **[FS-M1] Section 8 line 226 references "section 13.3" for the deferred GET session endpoint, but section 13 item 3.3 is "Add richer suggestion types," not "GET session endpoint."** The GET endpoint deferral has no dedicated follow-up item in the delivery plan.
  Location: `docs/features/agent-assist-runtime-compat.md` line 226
  Fix: Either add a follow-up item (e.g., "3.5 Add `GET /sessions/:sessionId` endpoint for session metadata retrieval") and update the reference, or change the reference to a more generic "deferred to a follow-up" without a section number.

- **[FS-M2] Section 17 row 20 has coverage type "integration" but its test file path is `apps/runtime/src/__tests__/routes/agent-suggestions.e2e.test.ts`.** Payload-size rejection is best tested E2E (real middleware chain enforcing `express.json({limit})` before Zod), so the test file path is correct but the coverage type label should be "e2e" to match.
  Location: `docs/features/agent-assist-runtime-compat.md` line 567, row 20
  Fix: Change row 20's Coverage Type from "integration" to "e2e" (the test file is already in the e2e test directory and exercises the real Express stack).

- **[FS-M3] Testing guide section 3 Cross-Layer table lists FR-29 for binding CRUD audit, but the feature spec section 17 row 18 does not explicitly cite FR-29 in its scenario text.** The scenario description ("Admin binding CRUD... emits audit-logging entries") matches FR-29's content, but adding the FR anchor would maintain the pattern established by rows 19-24.
  Location: `docs/features/agent-assist-runtime-compat.md` line 565, row 18
  Fix: Append "(FR-29)" to row 18's scenario text for consistency with the FR-anchoring pattern in rows 19-24.

---

### Cross-Phase Consistency

- [XP-1] All 30 FRs trace to the problem statement and goal statement. No orphan requirements. PASS.
- [XP-2] Forward compatibility: all 30 FRs are testable. The testing guide covers every FR. E2E scenarios (13 total: 5 POC + 5 canonical Actual + 3 V1-facade Actual) and integration scenarios (8 total) both exceed the 5-minimum. Enables test-spec and HLD generation. PASS.
- [XP-3] No new scope introduced vs round 1. Goals and non-goals unchanged. PASS.
- [XP-4] Terminology consistent: `AgentAssistBinding`, `sessionReference`, `externalReference`, `appId`, `envName`, `bindingId`, `callerContext`, `apiKeyId` used uniformly across feature spec and testing guide. One minor exception: line 226 says "section 13.3" for a non-existent follow-up (noted in FS-M1). PASS with note.
- [XP-5] `apps/runtime/agents.md`, `packages/shared-kernel/agents.md`, `packages/database/agents.md` all exist. No agent-suggestions-specific learnings yet (expected for PLANNED status). PASS.

---

### Fresh-Eyes Checks

- **Open Questions quality**: 7 questions (lines 517-523). Q4 (HMAC vs mTLS for async-push) and Q7 (per-binding rate limit) are particularly high-value because they have implementation-blocking implications. No rhetorical questions. PASS.
- **Gap severity accuracy**: GAP-003 (High -- `aa_uamsgs` not threaded into prompts) and GAP-005 (High -- rich suggestion types beyond `reply`) are correctly High. GAP-001 through GAP-008 severities are all reasonable and match the actual risk. PASS.
- **Success metric measurability**: 8 metrics with baseline/target/measurement method. "Re-point success rate >= 99% after 1 week" is measurable via session completion counts. "V1 facade overhead <= 50ms p95" is measurable via span diff. "0 breaking gaps" is measurable via parity suite. PASS.
- **No orphan references**: All FR-N references in sections 12, 13, 17 point to valid FRs. All section cross-references (e.g., "section 12 Performance," "section 6 Phase POC parity") point to existing sections. One exception: line 226 references "section 13.3" which does not correspond to the expected follow-up (noted in FS-M1). PASS with note.
- **No regressions from fixes**: FR-7 rewrite does not conflict with FR-2 (session create/resume) or FR-20 (V1 session key). Section 12 User Isolation rewrite is internally consistent. New rows 19-24 do not duplicate existing rows 1-18. Subtask renumbering (1.3-1.10) has no stale references. PASS.

---

### Verified

- [x] [FS-1] Template completeness -- all 18 sections of TEMPLATE.md addressed.
- [x] [FS-2] Code grounding -- all referenced code paths verified as existing. `packages/shared-kernel/src/agent-suggestions/` directory does NOT yet exist (correct for PLANNED).
- [x] [FS-3] Requirement quality -- 30 FRs, all testable "The system must..." statements.
- [x] [FS-4] User stories -- 7 stories with persona + capability + benefit.
- [x] [FS-5] Integration matrix -- 11 related features with relationship types. A2A row now references FR-25.
- [x] [FS-6] Tenant, project, and user isolation explicitly addressed with `apiKeyId` in the composite key.
- [x] [FS-7] Data model has `tenantId`, `projectId`, `createdBy` indexed. Session Record Extensions block added.
- [x] [FS-8] Delivery plan has 3 parent phases with numbered subtasks (1.1-1.10, 2.1-2.12, 3.1-3.4).
- [x] [FS-9] Testing section links to testing guide. Coverage matrix has 24 rows. Per-layer minimum stated.
- [x] [FS-10] Scope clarity -- goals and non-goals well-separated with 9 explicit non-goals.
- [x] Round-1 CRITICAL findings (FS-2, FS-6) fully resolved with no regressions.
- [x] Round-1 HIGH findings (FS-3, FS-8, FS-3/FR-6) fully resolved with no regressions.
- [x] Round-1 MEDIUM findings (FS-9, FS-5, FS-7) fully resolved.
- [x] FR-7 `apiKeyId` composite key is consistent across FR-7, FR-20, section 12, Session Record Extensions, and subtask 1.5.
- [x] Rows 19-24 have clean FR anchors that match the referenced FRs' actual content.
- [x] POC subtasks 1.3/1.4/1.5 are consistent with section 6 "Phase POC parity."
- [x] Testing guide coverage matrix covers all 30 FRs.
- [x] No contradictions introduced by the fixes.

---

### Notes

Three MEDIUM items identified (FS-M1, FS-M2, FS-M3) that do not block progression to the test-spec phase. FS-M1 (orphan section reference) and FS-M2 (coverage type label mismatch) are quick fixes that should be applied before implementation to avoid confusion. FS-M3 (FR-29 anchor in row 18) is a consistency polish item.

The feature spec is ready to proceed to the test-spec phase.

## Post-Refactor Round-2 MEDIUM Fixes (applied inline)

- FS-M1 — §8 note now references §13.3 subtask 3.5 and a matching "Add GET /sessions/:sessionId" follow-up is listed in §13.
- FS-M2 — §17 row 20 (oversized body → 413) coverage type changed `integration → e2e`.
- FS-M3 — §17 row 18 (binding CRUD audit) now cites FR-29 in the scenario text.

## Final State (Post-Refactor)

- Feature spec: docs/features/agent-assist-runtime-compat.md — APPROVED by phase-auditor round 2; 30 FRs across two layers (canonical Agent Suggestions Service + Agent Assist V1 Compat Facade); POC vs Actual delivery split.
- Testing placeholder: docs/testing/agent-assist-runtime-compat.md — 13 E2E + 8 integration + 4 unit scenarios; separate matrices per layer; POC ngrok smoke test in the manual checklist.
- Indexes: docs/features/README.md (#94) and docs/testing/README.md (#98) still carry the entry.
- Branch: KI081/feat/ABLP-390-agent-assist-runtime-compat (worktree at .worktrees/agent-assist-runtime-compat). No commits yet per user instruction.
- Next SDLC phase (on user's go-ahead): /test-spec.
