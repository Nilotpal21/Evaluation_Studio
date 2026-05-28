# Feature: Workflow First-Class Memory, Agent Session, and Context

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: STABLE
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `integrations`, `observability`, `governance`
**Package(s)**: `apps/workflow-engine`, `apps/runtime`, `apps/studio`, `packages/database`
**Owner(s)**: Platform / Runtime Team
**Testing Guide**: `../../testing/sub-features/workflow-first-class-memory-and-context.md`
**Last Updated**: 2026-04-28 (STABLE promotion)

---

## 1. Introduction / Overview

### Problem Statement

Workflow authors currently work with a narrow runtime context: expressions resolve only `trigger`, `workflow`, `tenant`, `steps`, and `vars`, and function nodes similarly inject only that context shape. In practice this creates two gaps:

- Agent-triggered workflows cannot read agent session data or invocation context through first-class workflow objects, even though runtime already knows the calling session when a workflow is invoked as a tool.
- Workflows have no workflow-native persistent memory surface that works consistently across trigger types (`webhook`, `cron`, `event`, `studio`, and `agent`), so builders fall back to ad hoc `triggerMetadata`, duplicated project state, or custom tools.

This forces authors to route state through conventions that do not match the mental model used in code tools, where read-only session/context and explicit memory access already exist.

### Goal Statement

Expose three first-class workflow objects — `memory`, `agentSession`, and `agentContext` — so workflow authors can read agent-bound context safely and use persistent memory consistently across all workflow trigger types. The feature must preserve workflow determinism, fail-closed isolation, and existing workflow authoring patterns while making the runtime contract substantially easier to understand.

### Summary

This sub-feature adds first-class object access to workflow expressions and function nodes:

- `agentSession`: read-only agent session projection for agent-originated workflow runs
- `agentContext`: read-only invocation context for agent-originated workflow runs
- `memory`: persistent workflow memory surface available for all trigger types

Expressions gain direct reads such as `{{agentSession.channel}}` and `{{memory.workflow.lastCursor}}`. Function nodes gain direct globals such as `agentSession`, `agentContext`, and `memory`, with `memory` supporting explicit read/write/delete operations and per-write TTL overrides. The design keeps `agentSession` and `agentContext` read-only, while `memory` is the only writable persistent surface.

---

## 2. Scope

### Goals

- Add first-class top-level workflow objects `memory`, `agentSession`, and `agentContext` to the workflow expression resolver.
- Add matching first-class globals to workflow function nodes, without forcing authors to tunnel these values through `context.vars`.
- Expose read-only agent session and invocation context only for agent-originated workflow runs.
- Provide persistent workflow memory access across all trigger types, with read/write/delete operations and TTL support.
- Reuse existing persistence patterns where possible, instead of creating a parallel workflow-only storage subsystem.

### Non-Goals (Out of Scope)

- Mutating `agentSession` or `agentContext` from workflows.
- Live pull-through reads against arbitrary runtime session state after workflow start.
- New Studio admin or memory inventory pages for browsing or managing workflow memory.
- Binary attachment download or raw attachment content injection into workflow context.
- Cross-tenant, cross-project, or cross-user memory/session access.
- Vector, semantic, or search-oriented memory retrieval.
- A dedicated memory canvas node in v1; first-class reads and function-node writes are the required authoring surface.

---

## 3. User Stories

1. As a **workflow author**, I want to read `agentSession` and `agentContext` directly inside expressions so that agent-triggered workflows can branch on the same contextual data code tools already see.
2. As an **automation builder**, I want to read and update persistent `memory` from workflows regardless of trigger type so that webhook, cron, event, studio, and agent runs can share durable state.
3. As a **function-node author**, I want direct globals `agentSession`, `agentContext`, and `memory` so that I can write normal JavaScript against first-class workflow objects instead of routing everything through `context` conventions.
4. As a **platform engineer**, I want these objects to stay tenant-, project-, and user-safe so that workflows never leak session or memory state across isolation boundaries.

---

## 4. Functional Requirements

1. **FR-1**: The system must expose `agentSession`, `agentContext`, and `memory` as first-class top-level objects in workflow expressions alongside the existing `trigger`, `workflow`, `tenant`, `steps`, and `vars` objects.
2. **FR-2**: For agent-originated workflow runs, the system must populate `agentSession` with a read-only projection of the invoking agent session that is safe for workflow consumption.
3. **FR-3**: For agent-originated workflow runs, the system must populate `agentContext` with a read-only projection of invocation context, including caller/interactions fields and attachment metadata where available.
4. **FR-4**: For `webhook`, `cron`, `event`, and `studio` workflow runs, the system must reserve `agentSession` and `agentContext` as first-class names but surface them as unavailable values rather than fabricating agent data.
5. **FR-5**: Workflow function nodes must expose `agentSession`, `agentContext`, and `memory` as direct globals, not only through the existing `context` proxy.
6. **FR-6**: Workflow function nodes must reject writes to `agentSession` and `agentContext`, preserving them as read-only globals.
7. **FR-7**: The system must expose `memory` for all workflow trigger types, independent of whether the run was invoked from an agent.
8. **FR-8**: Expressions must support typed reads from `memory` via dot-path access, including at minimum `{{memory.workflow.*}}`, `{{memory.project.*}}`, and `{{memory.user.*}}` when the backing scope is available.
9. **FR-9**: Function nodes must expose a first-class `memory` object that supports at minimum `get`, `set`, and `delete` operations, plus read access to the current in-run memory projection.
10. **FR-10**: The system must provide a logical `workflow` memory scope that persists across workflow executions and is isolated by `tenantId + projectId + workflowId`.
11. **FR-11**: The system must provide a `project` memory scope isolated by `tenantId + projectId`. It must also provide a `user` memory scope scoped to `tenantId + projectId + endUserId`, where `endUserId` is the **end user the agent is interacting with**, never the workspace/admin user. Resolution per trigger type follows the User Identity Resolution Matrix (§4a). When no `endUserId` is resolvable, `memory.user` is `undefined` — any read short-circuits and any function-node operation throws.
12. **FR-12**: Persistent memory writes must default to the existing fact-store retention policy when no explicit TTL is provided. (Currently 90 days; HLD must verify the actual default in `mongodb-fact-store.ts` and lock it as the documented contract.)
13. **FR-13**: Persistent memory writes must allow an explicit per-write TTL override using the existing duration format contract (`d`, `h`, `m`, `s`). Per-write TTL values MUST NOT exceed the existing fact-store maximum retention (or tenant policy ceiling, whichever is lower); writes exceeding the ceiling are clamped to the ceiling and emit a warning trace. The feature must not promise immortal/no-expiry writes in v1.
14. **FR-14**: Persistent memory reads and writes must update the workflow’s current memory projection so downstream expressions and function nodes in the same execution see the latest values.
15. **FR-15**: `agentSession` and `agentContext` must exclude secrets, raw auth tokens, full conversation transcripts, and attachment binaries.
16. **FR-16**: All memory access and agent-object materialization must follow fail-closed tenant, project, and user isolation rules; cross-scope access must not leak existence or values through successful resolution.
17. **FR-17**: The feature must preserve deterministic workflow execution semantics by avoiding hidden network/database I/O during ordinary expression interpolation beyond explicitly materialized workflow context and memory operations.
18. **FR-18**: `agentSession` and `agentContext` MUST be materialized from a positive-list field projection (see §9 First-Class Object Schemas). Any field not on the allow-list is omitted by default. New fields can only be added by updating the schema; they cannot leak in implicitly through metadata expansion.
19. **FR-19**: Resolved values from `agentSession`, `agentContext`, and `memory` MUST be treated as inert literals during expression evaluation. Even if a resolved value contains template syntax such as `{{...}}` (e.g., end-user message text, attachment filename, or sanitized invocation args), the evaluator MUST NOT re-interpolate it. Workflow expressions resolve in a single pass against the workflow template only; nested resolution against agent-supplied or end-user-supplied data is forbidden.
20. **FR-20**: Persistent memory operations MUST enforce per-write quotas: key length ≤ 256 chars, value size ≤ 64 KB serialized, max writes per workflow run ≤ 100. Writes exceeding any quota MUST throw and fail the function-node step. Per-tenant aggregate memory budget is enforced by the fact-store; exhaustion behavior matches existing fact-store back-pressure semantics. Authors MUST NOT write keys starting with reserved prefixes `_meta:`, `_system:`, `_audit:`, or `wf:`; reserved-prefix writes throw at write time.
21. **FR-21**: Memory operation failures (storage unavailable, quota exceeded, TTL invalid, reserved-key write) MUST throw and surface to the workflow's error-handling policy. The system MUST NOT silently swallow memory failures or partially apply multi-key writes.
22. **FR-22**: Every `memory.set` and `memory.delete` MUST emit an audit log entry containing `tenantId`, `projectId`, `workflowId`, `runId`, `scope`, `key` (NOT the value), actor identity (workflow author surface plus resolved `endUserId` when relevant), and applied TTL. Audit is separate from operational tracing; traces describe what happened for debugging, audit is forensic. Deletes use tombstone semantics (soft delete with retention) in v1 to keep audit reconstructible; hard delete is deferred.
23. **FR-23**: When an end user is erased per the existing right-to-erasure cascade, all `memory.user.*` entries keyed on that user's `endUserId` MUST be purged through the same cascade. `memory.workflow.*` and `memory.project.*` are NOT scanned — authors MUST NOT write end-user PII into those scopes (see §6 anti-pattern note).

> FR-9 intentionally leaves the exact JavaScript API shape open between `memory.get('workflow.path')` and scoped helpers such as `memory.workflow.get('path')`. The feature spec defines the capability contract; HLD/LLD must lock the final API.

### 4a. User Identity Resolution Matrix

`endUserId` (used by `memory.user.*`) is the identity of the **end user the agent is interacting with**, never the workspace/admin user, the tenant admin, or the workflow author. Resolution per trigger type:

| Trigger                          | `endUserId` source                                                                                                              | `memory.user.*` resolves? |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `agent` (public/channel session) | `Session.source` end-user identity, in priority order: `contactId` → `customerId` → `anonymousId` → channel-artifact identifier | YES                       |
| `agent` (Studio debug session)   | none — Studio debug sessions are project-owned, not user-owned                                                                  | NO                        |
| `studio` (direct workflow run)   | none — operator identity is workspace-level, not end-user                                                                       | NO                        |
| `webhook`                        | none in v1 — no standard contract for "this webhook represents end user X"                                                      | NO                        |
| `cron`                           | none                                                                                                                            | NO                        |
| `event`                          | `event.userId` only if the event explicitly carries one                                                                         | conditional               |

When `memory.user` does not resolve:

- expressions like `{{memory.user.foo}}` short-circuit to `undefined`
- function-node operations such as `memory.user.get(...)`, `.set(...)`, `.delete(...)` throw

`anonymousId` is a valid `endUserId` for cookie-based channels. Two consequences authors must understand:

- `anonymousId` is PII for compliance purposes — the right-to-erasure cascade applies (see §12).
- A user clearing cookies starts a fresh `endUserId`. Prior `memory.user.*` is not reachable from the new identity. This is correct behavior; do not assume durability across cookie resets.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                            |
| -------------------------- | ------------ | -------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Extends workflow authoring and cross-run state handling.                         |
| Agent lifecycle            | PRIMARY      | Agent-triggered workflows gain first-class access to agent session/context.      |
| Customer experience        | SECONDARY    | End-user outcomes improve indirectly through simpler stateful automation.        |
| Integrations / channels    | SECONDARY    | Trigger-type-independent memory makes webhook/cron/event automations consistent. |
| Observability / tracing    | SECONDARY    | Memory operations and agent-object materialization need trace/debug visibility.  |
| Governance / controls      | PRIMARY      | Isolation, sanitization, and retention are core to the feature contract.         |
| Enterprise / compliance    | SECONDARY    | TTL, secret minimization, and non-leaky behavior matter for compliance.          |
| Admin / operator workflows | NONE         | No dedicated admin workflow surface in v1.                                       |

### Related Feature Integration Matrix

| Related Feature                                                 | Relationship Type | Why It Matters                                                                                             | Key Touchpoints                                                | Current State         |
| --------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------- |
| [Workflows & Human Tasks](../workflows.md)                      | extends           | Adds new first-class runtime objects to workflow authoring and execution.                                  | expression resolver, function node, workflow execution context | Active parent surface |
| [Workflow-as-Tool](../workflow-as-tool.md)                      | shares data with  | Agent-originated workflow runs already carry workflow tool metadata and session linkage.                   | runtime workflow tool executor, trigger metadata               | Active integration    |
| [Memory & Session Management](../memory-sessions.md)            | depends on        | Persistent memory semantics, TTL, and isolation derive from existing session/memory foundations.           | fact store, session identity, retention rules                  | Active integration    |
| [Workflow Function Node](workflow-function-node.md)             | extends           | Function nodes are the writable authoring surface for first-class `memory` in v1.                          | function executor, Studio function editor                      | Active integration    |
| [Variable Resolution Across Tool Types](variable-resolution.md) | shares data with  | This feature introduces workflow-native first-class objects analogous to tool-side placeholder resolution. | `{{session.*}}`, context injection patterns                    | Active integration    |

---

## 6. Design Considerations (Optional)

- Function-node ergonomics matter because v1 memory writes are expected to happen there. The feature should extend the existing function-node authoring docs/help text so builders know these globals exist.
- Expression authoring should surface the new object names where workflow builders already discover path syntax, such as expression helper copy, validation, or autocomplete surfaces.
- The feature intentionally avoids a new dedicated memory node to keep v1 focused on the first-class object contract rather than canvas expansion.
- **`memory.workflow.*` is workflow-global, not per-invoker.** A single key is shared across every end user that triggers the workflow, every concurrent run, and every trigger type. Authors must NOT use `memory.workflow.*` for per-user state — reach for `memory.user.*` instead. Anti-pattern example: `memory.workflow.lastQuery` set during one end user's run will be read by the next end user's run on the same workflow, which is a privacy hazard. Authoring docs and Studio helper copy should reinforce this distinction.

---

## 7. Technical Considerations (Optional)

- Existing workflow context construction is synchronous and currently materializes only `trigger`, `workflow`, `tenant`, `steps`, and `vars`. Adding first-class objects therefore requires explicit workflow-context expansion rather than conventions layered on `vars`.
- Runtime code-tool memory already has an imperative bridge (`get_content`, `set_content`, `delete_content`) and fact-store persistence. This feature should mirror those semantics where possible instead of inventing a new workflow-only persistence model.
- The current persistent fact model supports `user` and `project` scopes, not a native `workflow` scope. V1 implements logical workflow scope by reserved key prefixing within project-scoped facts (`wf:<workflowId>:<key>`) — see §9 Data Model. This avoids a fact-store schema migration and inherits project isolation.
- The existing `execution_tree` runtime memory scope is not, by itself, a substitute for cross-invocation workflow memory; the workflow feature needs durable persistence semantics across separate workflow executions.
- **Read-only enforcement:** `agentSession` and `agentContext` are deep-frozen (`Object.freeze` recursively) at materialization time. Mutation attempts throw in strict mode. This is cheaper than a Proxy with set-trap and aligns with the immutability contract of these objects for the workflow run.
- **Function-node API shape:** v1 uses scoped helpers — `memory.workflow.get('foo')`, `memory.workflow.set('foo', value, { ttl })`, `memory.workflow.delete('foo')`, with `memory.project.*` and `memory.user.*` mirroring. Scope is explicit at the call site; this is more discoverable in editor autocomplete and avoids the "magic dot path" footgun of `memory.get('workflow.foo')`.

---

## 8. How to Consume

### Studio UI

Workflow authors consume this feature through existing workflow authoring surfaces:

- **Expression-authored nodes**: authors can reference `{{memory.*}}`, `{{agentSession.*}}`, and `{{agentContext.*}}` anywhere workflow expressions are already supported.
- **Function node editor**: authors can read `agentSession`, `agentContext`, and `memory` as direct globals in workflow JavaScript.
- **Workflow run inspection**: v1 does not require new Studio debugging panels; existing execution inspection remains the baseline, with richer debug surfacing deferred to follow-on work.

### Surface Semantics Matrix

| Asset / Entity Type | Source of Truth / Ownership                                   | Design-Time Surface(s)              | Editable or Read-Only?                                  | Consumer Reference / Binding Model     | Runtime Materialization / Resolution                                                       | Notes / Unsupported State                                                       |
| ------------------- | ------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `agentSession`      | Runtime agent session for agent-triggered workflow invocation | Expression fields, function node JS | Read-only                                               | `{{agentSession.*}}`, `agentSession.*` | Materialized into workflow execution context only for agent-originated runs                | Unavailable for non-agent triggers                                              |
| `agentContext`      | Agent invocation metadata and sanitized context               | Expression fields, function node JS | Read-only                                               | `{{agentContext.*}}`, `agentContext.*` | Materialized into workflow execution context only for agent-originated runs                | Attachment metadata only; no binaries                                           |
| `memory.workflow.*` | Persistent fact storage scoped logically to a workflow        | Expression fields, function node JS | Read/write via `memory`; read-only in plain expressions | `{{memory.workflow.*}}`, `memory.*`    | Loaded into workflow memory projection and synchronized through explicit memory operations | Logical workflow scope; physical persistence strategy is implementation-defined |
| `memory.project.*`  | Persistent fact storage scoped to project                     | Expression fields, function node JS | Read/write via `memory`; read-only in plain expressions | `{{memory.project.*}}`, `memory.*`     | Materialized from project-scoped persistent store                                          | Shared across workflow trigger types in same project                            |
| `memory.user.*`     | Persistent fact storage scoped to resolved user identity      | Expression fields, function node JS | Read/write via `memory`; read-only in plain expressions | `{{memory.user.*}}`, `memory.*`        | Available only when execution has a user identity                                          | Behavior for anonymous/non-user triggers must be explicit                       |

### Design-Time vs Runtime Behavior

Design time introduces new object names and authoring guidance, but the actual values are only resolved at workflow execution time:

- `agentSession` and `agentContext` are runtime-only objects, available only when a workflow run originates from an agent.
- `memory` is a runtime-backed persistent object. Expressions read from the workflow’s current memory projection; writes happen through explicit memory operations in function nodes.
- Expressions are read-only against `memory` — there is no expression-level write syntax. Only function nodes can mutate memory.
- Existing `trigger.metadata` remains part of the canonical runtime payload, but authors should not be required to navigate raw metadata to access agent objects.

### API (Runtime)

No new public runtime API is required for consumers in v1. Any internal memory client or service-to-service route used by the workflow engine is an implementation detail, not a new public platform API.

| Method | Path | Purpose                                                                                    |
| ------ | ---- | ------------------------------------------------------------------------------------------ |
| N/A    | N/A  | Consumer-facing behavior is exposed through workflow execution, not a new public endpoint. |

### API (Studio)

No new dedicated Studio API surface is required beyond the existing workflow authoring and execution routes.

| Method | Path | Purpose                                                       |
| ------ | ---- | ------------------------------------------------------------- |
| N/A    | N/A  | Existing workflow Studio APIs continue to own save/run flows. |

### Admin Portal

N/A in v1. This feature does not add a standalone admin memory/session management surface.

### Channel / SDK / Voice / A2A / MCP Integration

The feature is channel-neutral at the workflow layer:

- `memory` is available regardless of whether the workflow was started by webhook, cron, event, studio, or agent trigger.
- `agentSession` and `agentContext` are relevant only when the workflow run was initiated from an agent path such as workflow-as-tool or future agent-originated workflow entry points.
- **Workflow-as-tool nesting:** when a workflow run is invoked from another workflow (workflow-as-tool nesting), `agentSession` and `agentContext` propagate from the outermost agent invocation through nested workflow runs unchanged — the inner workflow sees the originating end user, not the outer workflow as a "caller." Memory scopes resolve fresh at each level: the nested workflow run sees its own `memory.workflow.*` keyed on the nested workflow's id, while `memory.project.*` and `memory.user.*` (when `endUserId` is available) are shared with the outer run.

---

## 9. Data Model

### Collections / Tables

```text
Collection: workflow_executions
Relevant fields:
  - tenantId
  - projectId
  - workflowId
  - triggerType
  - triggerMetadata
  - context
Purpose:
  - stores workflow execution snapshots and trigger metadata used to materialize first-class runtime objects for a run.
```

```text
Collection: facts
Relevant fields:
  - tenantId
  - userId
  - projectId
  - scope ('user' | 'project')
  - key
  - value
  - expiresAt
Purpose:
  - persists durable workflow memory using the existing fact-store model and TTL behavior.
```

### Key Relationships

- Agent-originated workflow executions already carry `sessionId`, `agentName`, and related metadata through workflow trigger metadata.
- Persistent `memory.project.*` can map directly to existing project-scoped facts.
- Persistent `memory.user.*` can map directly to existing user-scoped facts when a workflow run has a resolved user identity.
- Persistent `memory.workflow.*` is implemented via reserved-prefix key namespacing within project-scoped facts: a write to `memory.workflow.foo` is stored under fact key `wf:<workflowId>:foo` in the project scope. This avoids a fact-store schema migration and inherits the existing project-isolation cascade. The `wf:` prefix is reserved for platform use and is in the FR-20 author-write blocklist.
- **Cross-surface fact trust model:** workflow-written `memory.project.*` and `memory.user.*` share the same fact-store namespace as code-tool-written facts (via `tool-memory-bridge.ts`). This is intentional — the whole purpose of these scopes is project- or user-shared state across both surfaces. The trust model is: any write into a shared scope is trusted equally by future readers regardless of origin. Authors must NOT treat workflow-written values as more trustworthy than tool-written values; defensive code should not branch on origin. `memory.workflow.*` is the only origin-isolated store: only workflow runs of a specific `workflowId` write/read it.
- `memory.workflow.*` keys on `workflowId` only — **memory persists across workflow edits and republishes**. Authors are responsible for migrating keys when changing the memory schema of a workflow. Versioned isolation (`workflowId + workflowVersionId`) is explicitly NOT in v1; that would wipe memory on every republish, which is disruptive for steady-state automations.

### First-Class Object Schemas (Runtime Projections)

`agentSession` and `agentContext` are projected onto a positive-list schema. Fields not listed here are omitted at materialization time, regardless of what the underlying session metadata carries. Adding a field requires updating this section AND the §17 test matrix.

#### `agentSession`

| Field            | Type                  | Source                         | Notes                                                                                                     |
| ---------------- | --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `sessionId`      | string                | runtime session                | Stable session identifier; safe to emit.                                                                  |
| `agentName`      | string                | runtime session                | Logical agent name; never the deployment URL or credential reference.                                     |
| `channel`        | string                | runtime session                | Channel identifier (e.g., `web`, `whatsapp`, `voice`); not a channel secret.                              |
| `source`         | enum                  | `Session.source` discriminator | One of `public`, `channel`, `studio-debug`. Drives `endUserId` resolution.                                |
| `endUserId`      | string \| `undefined` | resolved per §4a matrix        | Echoes the resolved end-user identity when one exists; `undefined` for Studio debug or non-user triggers. |
| `locale`         | string \| `undefined` | runtime session                | BCP-47 tag if known.                                                                                      |
| `startedAt`      | ISO 8601 timestamp    | runtime session                | Session start time.                                                                                       |
| `lastActivityAt` | ISO 8601 timestamp    | runtime session                | Most recent end-user activity time.                                                                       |

#### `agentContext`

| Field             | Type                                                                       | Source                      | Notes                                                                                                               |
| ----------------- | -------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `caller`          | `{ type: string, id: string }`                                             | invocation metadata         | Caller principal identity (e.g., `{ type: 'agent', id: agentName }`). Never includes credential references.         |
| `invocation`      | `{ tool: string, args: sanitized record }`                                 | workflow-as-tool invocation | `args` are passed through the user-error sanitizer; secrets, raw auth tokens, and credential refs are stripped.     |
| `attachments`     | `Array<{ id: string, mimeType: string, sizeBytes: number, name: string }>` | invocation metadata         | Metadata only — binaries are NEVER materialized into workflow context.                                              |
| `messageMetadata` | sanitized record \| `undefined`                                            | invocation metadata         | Channel/transport metadata that has already been validated at boundary (per CLAUDE.md boundary normalization rule). |

#### Excluded by contract

The following are NEVER projected into `agentSession` or `agentContext`, regardless of caller request or downstream feature need:

- raw auth tokens, refresh tokens, API keys, credential references
- full conversation transcripts or model prompt history
- model identifiers, deployment URLs, internal remediation strings (per CLAUDE.md user-facing sanitization rule)
- attachment binary content
- intermediate planner output, system prompts, raw tool-call traces
- arbitrary `triggerMetadata` passthrough (this exists today and remains accessible through `trigger.metadata`, but is not laundered into `agentSession`/`agentContext`)

---

## 10. Key Implementation Files

> Updated post-impl (2026-04-28) to reflect what actually shipped across phases 0-6 (ABLP-644, 645, 646, 647, 649, 653, 658, 659).

### Domain / Core Logic — Workflow Engine

| File                                                        | Status   | Purpose                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/workflow-engine/src/clients/runtime-memory-client.ts` | NEW      | Workflow-engine-side HTTP client for `/api/internal/memory/*` (`projection`, `get`, `set`, `delete`). Mints service tokens with `RUNTIME_JWT_SECRET`, classifies network/HTTP errors into `WorkflowMemoryError { code, message }`. Single instance shared across phases. |
| `apps/workflow-engine/src/context/agent-projection.ts`      | NEW      | Positive-list projection for `agentSession` / `agentContext` (Phase 3). Deep-frozen, secrets-stripped, used by the workflow handler when materializing context at execution start.                                                                                       |
| `apps/workflow-engine/src/context/expression-resolver.ts`   | MODIFIED | `KNOWN_TOP_LEVEL_KEYS` extended with `agentSession`, `agentContext`, `memory` so dot-path reads (`{{memory.workflow.foo}}`) resolve against the live context.                                                                                                            |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`     | MODIFIED | Materializes the expanded workflow context at run start. Calls `memoryClient.loadProjection(...)` to populate `context.memory.{workflow,project,user}` from the runtime memory route.                                                                                    |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`      | MODIFIED | Threads `memoryClient` + `runId` + `actor` envelope through the `case 'function'` step into `executeFunctionStep`. Derives actor identity: agent-bound → `{kind: 'end-user', endUserId}`; cron/webhook/Studio → `{kind: 'workflow-author'}`.                             |
| `apps/workflow-engine/src/executors/function-executor.ts`   | MODIFIED | Injects `memory.{workflow,project,user}.{get,set,delete}` and read-only `agentSession`/`agentContext` globals into the V8 isolate. Uses `ivm.Reference.applySyncPromise` (Phase 4) so authors get synchronous-looking memory ops without blocking the isolate-thread.    |
| `apps/workflow-engine/src/services/restate-endpoint.ts`     | MODIFIED | Threads `memoryClient` through `RestateEndpointDeps` to both top-level and dispatcher hops — single instance reused across `loadProjection` and per-function-step memory ops.                                                                                            |
| `apps/workflow-engine/src/index.ts`                         | MODIFIED | Composition root — instantiates `RuntimeMemoryClient` once with `RUNTIME_URL` + `RUNTIME_JWT_SECRET`, passes into `restateEndpoint` build (Phase 4 wiring smoke-test verified in Phase 6 §6.7).                                                                          |
| `apps/workflow-engine/src/constants.ts`                     | MODIFIED | `MEMORY_OP_TIMEOUT_MS = 5000` (per-op HTTP timeout used by `runtime-memory-client`).                                                                                                                                                                                     |
| `apps/workflow-engine/Dockerfile`                           | MODIFIED | `UV_THREADPOOL_SIZE=8` exported so libuv can absorb the in-isolate `applySyncPromise` waits without starving other workers.                                                                                                                                              |

### Domain / Core Logic — Runtime

| File                                                                    | Status   | Purpose                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/stores/mongodb-fact-store.ts`                | MODIFIED | Phase 1: deep `wf:` reserved-prefix guard via `__originAdapter: 'workflow'` marker. Phase 1b: `delete()` / `batchDelete()` now soft-delete (tombstone via `isDeleted/deletedAt`). `clear()` / `cleanup()` remain hard-delete. Reads filter `{isDeleted: {$ne: true}}`; resurrect-on-set `$unset`s the tombstone fields.                                              |
| `apps/runtime/src/services/stores/fact-store-workflow-adapter.ts`       | NEW      | Workflow-scope fact adapter. Wraps `MongoDBFactStore` with the `__originAdapter: 'workflow'` marker so `wf:<workflowId>:` keys can be written via the adapter, blocked from anywhere else.                                                                                                                                                                           |
| `apps/runtime/src/services/stores/workflow-memory-constants.ts`         | NEW      | `MAX_FACT_TTL_MS = 365d`, `MAX_VALUE_SIZE_BYTES = 64 KiB`, `MAX_KEY_LENGTH = 256`, `MAX_WRITES_PER_RUN = 100`, `DEFAULT_PROJECTION_PAYLOAD_CAP_BYTES`. Reserved prefixes: `wf:`, `_meta:`, `_system:`, `_audit:`.                                                                                                                                                    |
| `apps/runtime/src/services/stores/index.ts`                             | MODIFIED | Re-exports `FactStoreWorkflowAdapter`, `PROJECT_SCOPE_USER_ID`, `MongoDBFactStore` (with `__originAdapter` marker constants).                                                                                                                                                                                                                                        |
| `apps/runtime/src/routes/internal-memory.ts`                            | NEW      | `POST /api/internal/memory/{projection,get,set,delete}` — service-token authenticated route group. TTL parsing + clamp, per-write quotas, reserved-prefix guard, audit log via `createLogger('workflow-memory')` (NEVER logs `value`), trace events `projection_load` / `memory_op` / `ttl_clamped`. Created via `createInternalMemoryRouter(deps)` factory pattern. |
| `apps/runtime/src/middleware/internal-service-auth.ts`                  | MODIFIED | Phase 0 prerequisite: cross-checks `body.tenantId` (and `query`/`params`) against the service token's `tenantId` claim — closes the gap where a token issued for tenant A could be used against an endpoint addressing tenant B with a matching/absent `projectId`.                                                                                                  |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`          | MODIFIED | Enriches `triggerMetadata` with the agent-projection envelope so `workflow-handler.ts.buildWorkflowContext` can derive the read-only `agentSession`/`agentContext`. Source of truth for "this workflow run is agent-bound".                                                                                                                                          |
| `apps/runtime/src/services/workflow/agent-session-resolver.ts`          | MODIFIED | Resolves `endUserId` per the §4a User Identity Resolution Matrix (contact, customer, anonymous, channel-artifact paths).                                                                                                                                                                                                                                             |
| `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts` | MODIFIED | Phase 5: accepts a 6th optional constructor port `factErasure?: (tenantId, contactId) => Promise<{erased}>`. Invoked between `scrubMessages` and `clickhouseCleanup`/`hardDelete`, wrapped in try/catch — failures `log.warn`-audit and the cascade continues (mirrors `clickhouseCleanup` failure mode).                                                            |
| `apps/runtime/src/contexts/contact/fact-erasure.ts`                     | NEW      | Default `factErasure` implementation: `Fact.deleteMany({tenantId, userId: contactId, scope: 'user'})`. Workflow- and project-scope facts (`userId='__project__'`) are intentionally untouched.                                                                                                                                                                       |
| `apps/runtime/src/contexts/contact/index.ts`                            | MODIFIED | Exports `FactErasure` type and `eraseUserScopedFacts`. `ContactContextDeps.factErasure?` field added; `createContactContext` factory threads `deps.factErasure` as the 6th positional arg.                                                                                                                                                                           |
| `apps/runtime/src/contexts/contact/runtime-contact-context.ts`          | MODIFIED | Production composition wraps the factory with `factErasure: eraseUserScopedFacts` BEFORE the `...options` spread so callers can override (or pass `undefined` to opt out).                                                                                                                                                                                           |
| `apps/runtime/src/server.ts`                                            | MODIFIED | Mounts `internalMemoryRouter` at `/api/internal/memory` behind `requireServiceAuth`. CRUD routes for the contact cascade unchanged.                                                                                                                                                                                                                                  |

### Schema / Models

| File                                         | Status   | Purpose                                                                                                                                                                                                                                 |
| -------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/fact.model.ts` | MODIFIED | Two new optional fields: `deletedAt: Date \| undefined`, `isDeleted: boolean \| undefined`. The existing TTL index on `expiresAt` reaps tombstones; the unique compound index `{tenantId, userId, projectId, scope, key}` is unchanged. |

### E2E Specs (Studio)

| File                                                                | Status                      | Coverage                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts`     | NEW (Phase 6 + STABLE-prep) | E2E-3 full (`agentSession === undefined`; `memory.user.get` rejects with `UNAVAILABLE_SCOPE`) + E2E-6 full (cross-run workflow-scope memory continuity). E2E-1 / E2E-2 stay as documented `test.skip` scaffolds — residual GAP-018. |
| `apps/studio/e2e/workflows/workflow-memory-erasure.spec.ts`         | NEW (Phase 6)               | E2E-4 full: `POST /api/contacts` → service-token-auth `POST /api/internal/memory/set` (user + project) → `DELETE /api/contacts/manage/:id/gdpr` → re-projection asserts user purged AND project sentinel intact.                    |
| `apps/studio/e2e/workflows/workflow-as-tool-nesting-memory.spec.ts` | NEW (Phase 6 scaffold)      | E2E-5 — `test.skip` scaffold, GAP-018 (agent-bound chat → workflow-tool E2E harness).                                                                                                                                               |
| `apps/studio/e2e/workflows/workflow-cron-trigger-memory.spec.ts`    | NEW (STABLE-prep)           | E2E-7 (cron-fire reads memory.project.\* written by prior Studio direct-run) — GAP-019 closure.                                                                                                                                     |

### Tests — Runtime

| File                                                                          | Type        | Coverage                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/internal-memory-route.test.ts`                    | integration | INT-1 (round-trip), INT-4 (reserved-prefix two-layer guard), INT-5 (per-write quotas), INT-6 (TTL parse/clamp), INT-8 (audit emission), INT-12 (trace coverage) — 24 tests.                                                 |
| `apps/runtime/src/__tests__/internal-service-auth-tenant-cross-check.test.ts` | integration | INT-2 — Phase 0 PREREQUISITE: tenantId body cross-check fails closed with 403 across all internal route groups.                                                                                                             |
| `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts`              | unit        | UT-3: workflow-scope adapter writes `wf:<id>:` keys; reads from `MongoDBFactStore` directly without the marker fail; project-scope reads filter `wf:` prefix.                                                               |
| `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts`          | unit        | UT-4: deep `wf:` guard at `_setInternal` rejects writes from anywhere without the `__originAdapter: 'workflow'` marker; soft-delete tombstone semantics.                                                                    |
| `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts`        | integration | INT-13: `workflow-tool-executor.ts` enriches `triggerMetadata` with the positive-list agent projection — secrets / tokens / transcripts / binaries excluded.                                                                |
| `apps/runtime/src/__tests__/cascade-delete-contact-memory-erasure.test.ts`    | integration | INT-9: `factErasure` port purges `memory.user.*` for the deleted contact via real `MongoMemoryServer` + real `MongoDBFactStore` + real `CascadeDeleteContact`. 4 tests; cross-tenant isolation; fail-soft when port throws. |

### Tests — Workflow Engine

| File                                                                    | Type        | Coverage                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/workflow-engine/src/__tests__/runtime-memory-client.test.ts`      | unit        | Request shape + error classification at the HTTP boundary (mocks `fetch` only; no platform mocks).                                                                                                     |
| `apps/workflow-engine/src/__tests__/runtime-memory-client-http.test.ts` | integration | INT-1 surrogate at the workflow-engine side: real HTTP roundtrip via undici against an Express test app mounting `internal-memory.ts`. Includes the `t < 200ms` warm-Mongo perf assertion (FR-12).     |
| `apps/workflow-engine/src/__tests__/function-executor.test.ts`          | integration | INT-3: real `isolated-vm` isolate ↔ runtime memory client via `ivm.Reference.applySyncPromise`. Verifies synchronous-looking author API + 3 trace events per round-trip + isolate-thread non-deadlock. |
| `apps/workflow-engine/src/__tests__/workflow-memory-isolate.test.ts`    | integration | UT-5/UT-6: function-node sandbox enforces `agentSession`/`agentContext` read-only (deep-freeze) and `memory.*` writable; transferability constraints across the isolate boundary.                      |
| `apps/workflow-engine/src/__tests__/expression-resolver.test.ts`        | unit        | UT-1, UT-2: `KNOWN_TOP_LEVEL_KEYS` resolution for `memory`, `agentSession`, `agentContext`; `undefined` propagation when the scope is unavailable; no template re-interpolation (FR-19).               |

---

## 11. Configuration

### Environment Variables

| Variable                            | Default                                        | Description                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RUNTIME_URL`                       | `http://runtime:3112`                          | Workflow-engine reads this to call `/api/internal/memory/*`. No new env added — feature reuses existing workflow-engine ↔ runtime URL.                                         |
| `JWT_SECRET` / `RUNTIME_JWT_SECRET` | dev: `dev-jwt-secret-that-is-at-least-32chars` | Same secret runtime + workflow-engine already share. Workflow-engine `RuntimeMemoryClient` mints service tokens using this secret; runtime `requireServiceAuth` verifies them. |
| `UV_THREADPOOL_SIZE`                | `8` (set in `apps/workflow-engine/Dockerfile`) | Doubles libuv default. Required so `applySyncPromise` waits in the V8 isolate don't starve the worker pool under concurrent function-node memory ops.                          |

No new consumer-facing env vars exposed. All quotas/timeouts ship as constants (see §11 Runtime Configuration).

### Runtime Configuration

| Constant                               | Value      | Where                                                           | Notes                                                                                                             |
| -------------------------------------- | ---------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `MEMORY_OP_TIMEOUT_MS`                 | `5000`     | `apps/workflow-engine/src/constants.ts`                         | Per-op HTTP timeout for `RuntimeMemoryClient`.                                                                    |
| `MAX_FACT_TTL_MS`                      | `365d`     | `apps/runtime/src/services/stores/workflow-memory-constants.ts` | TTL ceiling enforced at runtime memory route. Out-of-bounds writes are clamped + emit a `ttl_clamped` warn trace. |
| `MAX_VALUE_SIZE_BYTES`                 | `64 KiB`   | same                                                            | Per FR-20. Hard reject — throws `QUOTA_VALUE_SIZE`.                                                               |
| `MAX_KEY_LENGTH`                       | `256`      | same                                                            | Per FR-20. Hard reject — throws `QUOTA_KEY_LENGTH`.                                                               |
| `MAX_WRITES_PER_RUN`                   | `100`      | same                                                            | Per FR-20. Enforced via Redis counter keyed on `runId`.                                                           |
| `DEFAULT_PROJECTION_PAYLOAD_CAP_BYTES` | (see file) | same                                                            | Projection responses larger than this throw `PROJECTION_TOO_LARGE` to keep workflow-context startup bounded.      |
| Default fact TTL                       | 90 days    | `mongodb-fact-store.ts` (existing)                              | Inherited from existing fact-store contract per FR-12. Authors can override per-write up to `MAX_FACT_TTL_MS`.    |

Tenant-level governance (per-tenant disable, scope restrictions, ceiling overrides) is reserved in the contract; the controls ship in v1.1 (GAP-011).

### DSL / Agent IR / Schema

This feature extends the workflow runtime contract rather than the agent DSL. The important schema/design implications are:

- workflow expression context needs new top-level names: `memory`, `agentSession`, `agentContext`
- function-node execution context needs matching globals
- persistent memory write operations must accept TTL metadata using the existing duration contract

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Every persistent memory read/write must remain project-scoped, and workflow-scoped memory must additionally bind to `workflowId` without leaking across workflows. |
| Tenant isolation  | All memory/session/materialization reads and writes must include `tenantId`; cross-tenant access must fail closed and not reveal existence.                        |
| User isolation    | `memory.user.*` must only resolve when a workflow run has a user identity and must remain owner-scoped.                                                            |

### Security & Compliance

- `agentSession` and `agentContext` are read-only by contract and are materialized from a positive-list projection (§9 First-Class Object Schemas) — no implicit field expansion.
- `agentSession` and `agentContext` are deep-frozen at materialization (`Object.freeze` recursively); top-level and deep mutation attempts throw in strict mode.
- First-class agent objects must exclude secrets, auth tokens, full transcripts, and attachment binaries.
- User-visible workflow errors must stay sanitized and must not expose raw tenant, model, or internal remediation details.
- **No template re-interpolation (FR-19).** Resolved values from `agentSession`, `agentContext`, and `memory` are inserted as inert literals. Even if a value contains `{{...}}` syntax (e.g., end-user message text or attachment filename), the workflow expression evaluator MUST NOT recursively resolve it. This blocks template injection from agent inputs into expression-only memory paths or downstream tool args.
- **Reserved key prefixes (FR-20).** Authors MUST NOT write keys starting with `_meta:`, `_system:`, `_audit:`, or `wf:`. Reserved-prefix writes throw at write time.
- **Encryption at rest:** persistent memory inherits the fact-store at-rest encryption posture (MongoDB-level). Field-level encryption for sensitive memory values is NOT in v1 scope; if needed, it is a follow-on RFC. Authors should treat memory values as encrypted-at-rest but not field-level-encrypted.
- **Cross-surface fact origin:** `memory.project.*` and `memory.user.*` share namespace with code-tool-written facts (see §9 trust model). Authors must not treat workflow-written values as more trustworthy than tool-written values. `memory.workflow.*` is the only origin-isolated store.

### Performance & Scalability

- Expression evaluation must remain cheap; plain expression interpolation cannot turn into arbitrary database traversal.
- Memory writes should reuse existing fact-store persistence and batching semantics where possible.
- The feature should avoid introducing a new per-step remote dependency when a workflow run already has the needed context projection in memory.
- **Per-write quotas (FR-20):** key length ≤ 256 chars, value size ≤ 64 KB serialized, ≤ 100 memory writes per workflow run.
- **Per-tenant aggregate budget:** inherited from existing fact-store quota; exhaustion follows fact-store back-pressure semantics.

### Reliability & Failure Modes

- If agent objects are unavailable, workflows must resolve them predictably rather than throwing hidden runtime errors during unrelated steps.
- Persistent memory operations must be explicit, traceable, and durable across workflow invocations.
- Unavailable `memory.user.*` on runs without user identity must fail in a documented way rather than silently crossing into project/shared state.
- **Memory operation failures throw (FR-21).** Storage unavailability, quota exceedance, invalid TTL, reserved-key writes — all surface as exceptions to the function node. Workflow error-handling policy then applies. No silent swallow, no partial multi-key writes.
- **Concurrency:** concurrent writes to the same memory key are last-write-wins. v1 does NOT provide atomic counters, compare-and-swap, or read-your-writes guarantees across concurrent runs. Authors needing per-event state should use unique keys per event (e.g., key on event id) rather than mutating shared keys.
- **Replay / retry idempotency:** workflow function-node retries re-execute the body, including memory writes. v1 does NOT provide write-once / exactly-once semantics. Authors must treat memory writes as idempotent — use deterministic keys, avoid `lastSeenAt = Date.now()` patterns, and assume any `memory.set` may execute more than once.

### Observability

- Memory operations and first-class object materialization MUST emit workflow-execution traces with operation type, scope, key (not value), TTL, and result.
- **Audit log (FR-22) is mandatory** for every `memory.set` and `memory.delete`: tenantId, projectId, workflowId, runId, scope, key, actor identity, applied TTL. Audit is separate from operational tracing — traces are for debugging, audit is forensic and tamper-evident.
- Deletes use tombstone semantics (soft delete with retention) in v1 to keep audit reconstructible.
- Existing workflow execution inspection remains the base surface in v1; richer dedicated memory/session debugging is follow-on work.

### Data Lifecycle

- Persistent memory inherits the current fact-store default TTL of 90 days.
- Per-write TTL overrides are allowed in v1, capped at the fact-store maximum retention (or tenant policy ceiling, whichever is lower) — see FR-13. Out-of-bounds TTL values are clamped, not rejected, with a warning trace.
- No immortal/no-expiry persistence guarantee is part of the v1 contract.
- **Right-to-erasure cascade (FR-23):** when an end user is erased, `memory.user.*` keyed on their `endUserId` is purged through the same cascade as existing user-scoped facts. `memory.workflow.*` and `memory.project.*` are NOT scanned — authors must keep end-user PII out of those scopes.

---

## 13. Delivery Plan / Work Breakdown

1. Define the workflow first-class object contract
   1.1 Add `memory`, `agentSession`, and `agentContext` to the workflow feature spec and testing guide.
   1.2 Lock the unavailable-object behavior for non-agent runs.
   1.3 Lock the persistent memory scope model and TTL contract.
2. Extend workflow runtime context surfaces
   2.1 Expand `WorkflowContextData` and the expression resolver with first-class object support.
   2.2 Expand function-node execution to inject direct globals and enforce read-only agent objects.
   2.3 Add unit coverage for unavailable objects, typed reads, and mixed-string interpolation.
3. Add persistent workflow memory semantics
   3.1 Define the logical workflow memory scope on top of existing fact persistence.
   3.2 Implement function-node `memory` read/write/delete operations with TTL override support.
   3.3 Synchronize in-run memory projection after successful writes so downstream steps see updated values.
4. Wire agent-originated workflow context
   4.1 Materialize `agentSession` and `agentContext` from workflow trigger metadata for agent runs.
   4.2 Sanitize the allowed field set and document excluded data classes.
   4.3 Add integration tests for agent-triggered and non-agent-triggered runs.
5. Improve authoring discoverability
   5.1 Update workflow expression help surfaces with the new first-class object names.
   5.2 Update function-node docs/help text to show the new globals and write patterns.
   5.3 Add regression tests covering existing workflow expression resolver, function-node executor, and sample workflows that do NOT use the new first-class objects, to confirm zero behavior change.
6. Add governance & safety controls
   6.1 Implement per-write TTL ceiling, key/value size, and write-count quotas (FR-13, FR-20).
   6.2 Implement reserved-key prefix validation at write time (`_meta:`, `_system:`, `_audit:`, `wf:`).
   6.3 Implement single-pass expression interpolation guard (FR-19) to block re-interpolation of resolved values.
   6.4 Wire `memory.set` / `memory.delete` into audit-log emission with tombstone semantics (FR-22).
   6.5 Wire `memory.user.*` into the existing right-to-erasure cascade (FR-23).
   6.6 Document positive-list projection schemas (§9 First-Class Object Schemas) and gate new fields on schema updates.

---

## 14. Success Metrics

| Metric                                      | Baseline                                           | Target                                                                                                | How Measured                                                                            |
| ------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Workflow-native access to agent context     | Authors must use `trigger.metadata` or custom vars | First-class `agentSession` / `agentContext` available in expressions and function nodes               | Workflow integration tests and Studio authoring documentation                           |
| Trigger-type-independent persistent memory  | No workflow-native persistent memory surface       | `memory` available for all workflow trigger types                                                     | End-to-end workflow tests across `webhook`, `cron`, `event`, `studio`, and `agent` runs |
| Authoring complexity for stateful workflows | Requires ad hoc conventions or custom tools        | Common stateful patterns can be implemented with first-class objects plus function-node memory writes | Sample workflows / regression tests                                                     |
| Memory retention contract clarity           | Implicit in fact-store implementation              | Explicit spec contract for default TTL and TTL overrides                                              | Feature doc + tests                                                                     |

---

## 15. Open Questions

All v1-blocking design questions have been resolved:

- **API shape:** scoped helpers — `memory.workflow.get('foo')`, `.set()`, `.delete()`; mirrored on `memory.project.*` and `memory.user.*`. See §7 Technical Considerations.
- **Unavailable resolution:** `undefined` for missing scope/field. Expressions short-circuit to `undefined`; function-node operations on an unavailable scope throw. See §4a (matrix) and §7.
- **Workflow scope storage:** reserved-prefix key namespacing within project-scoped facts (`wf:<workflowId>:<key>`). No fact-store schema migration. See §9 Data Model.

Remaining open items are tracked as gaps in §16 with explicit Severity/Status.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Severity | Status                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------- |
| GAP-001 | Workflow expressions are currently limited to `trigger`, `workflow`, `tenant`, `steps`, and `vars`; first-class objects do not exist yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | High     | Open                                    |
| GAP-002 | Function nodes currently expose only the `context` object; direct globals `memory`, `agentSession`, and `agentContext` do not exist yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | High     | Open                                    |
| GAP-003 | Existing fact persistence has only `user` and `project` scopes, so logical workflow scope needs an explicit implementation strategy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | High     | Open                                    |
| GAP-004 | The exact function-node `memory` API shape is still unresolved and must be fixed before implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Medium   | Resolved                                |
| GAP-005 | Dedicated debug-panel surfacing for first-class workflow objects is deferred from v1 and remains future work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Low      | Deferred                                |
| GAP-006 | Audit logging for `memory.set` / `memory.delete` (FR-22) is required but the workflow-engine does not yet emit audit events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | High     | Open                                    |
| GAP-007 | Right-to-erasure cascade for `memory.user.*` (FR-23) — implemented for **contact-only** scope per D-8: `CascadeDeleteContact` invokes `factErasure` port (default `eraseUserScopedFacts` runs `Fact.deleteMany({tenantId, userId: contactId, scope: 'user'})`). Workflow- and project-scope facts (stored under `userId='__project__'`) are intentionally NOT touched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | High     | Resolved                                |
| GAP-008 | Per-write TTL ceiling, key/value size limits, write-count cap, and reserved-prefix guard (FR-13, FR-20) need enforcement at the memory write boundary. **Resolved Phase 2** — `internal-memory.ts` enforces `MAX_FACT_TTL_MS` (clamp + warn), `MAX_VALUE_SIZE_BYTES`, `MAX_KEY_LENGTH`, `MAX_WRITES_PER_RUN` (Redis-keyed counter); reserved-prefix guard at the route + deep `__originAdapter` guard at `MongoDBFactStore._setInternal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | High     | Resolved                                |
| GAP-009 | Expression evaluator does not yet enforce single-pass interpolation; FR-19 requires explicit guard against re-interpolation of resolved agent/memory values. **Resolved Phase 3** — `expression-resolver.ts` extends `KNOWN_TOP_LEVEL_KEYS` and inserts resolved values as inert literals; the evaluator does not recurse into already-resolved values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | High     | Resolved                                |
| GAP-010 | Positive-list projection schemas for `agentSession` / `agentContext` (FR-18, §9) need explicit materialization gating; today nothing prevents implicit field bleed. **Resolved Phase 3** — `apps/workflow-engine/src/context/agent-projection.ts` builds the projection from a positive-list schema, deep-freezes the result, and is the only path through which `agentSession` / `agentContext` reach the workflow context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | High     | Resolved                                |
| GAP-011 | Tenant-level governance (per-tenant disable, scope restrictions, ceiling overrides) is reserved in the v1 contract but the controls themselves ship in v1.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Medium   | Deferred                                |
| GAP-012 | Atomic counters, compare-and-swap, and read-your-writes across concurrent runs are NOT in v1. Authors must use unique keys per event; document in authoring guide.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Medium   | Deferred                                |
| GAP-013 | Write-once / exactly-once semantics for `memory.set` under retry are NOT in v1. Authors must treat writes as idempotent; document in authoring guide.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Medium   | Deferred                                |
| GAP-014 | Workflow-engine ↔ runtime memory client (`apps/workflow-engine/src/clients/runtime-memory-client.ts`) does not exist yet; HLD locks the internal HTTP seam shape and routes. **Resolved Phase 4** — file shipped with `loadProjection` / `get` / `set` / `delete`, mints service tokens with `RUNTIME_JWT_SECRET`, classifies network/HTTP errors into `WorkflowMemoryError`. Single instance shared by `workflow-handler.loadProjection` and per-function-step memory ops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | High     | Resolved                                |
| GAP-015 | Field-level encryption for sensitive memory values is not in v1; persistent memory inherits MongoDB at-rest encryption only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Low      | Deferred                                |
| GAP-016 | Right-to-erasure cascade for non-contact identities (`customerId`, `anonymousId`, channel-artifact derived `userId`) is NOT in v1 per D-8 — only contacts trigger the cascade. Deferred to v1.1 once a generic identity-erasure orchestration layer exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Medium   | Deferred                                |
| GAP-017 | Workflow memory route emits structured logs via `createLogger('workflow-memory')` for `memory_op` / `projection_load` traces; full `TraceStore` integration (rich correlation with the runtime trace consumer) is deferred to v1.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Low      | Deferred                                |
| GAP-018 | Agent-bound chat → workflow-tool E2E harness does not yet exist in `apps/studio/e2e/workflows/`. **Contract-level closure shipped 2026-04-28**: `apps/workflow-engine/src/__tests__/workflow-memory-isolate.test.ts` 'INT-3 + INT-13 — agentSession ↔ memory.user actor derivation' exercises a real V8 isolate + real `/api/internal/memory` route + real Mongo with synthetic `agentSession` matching `workflow-tool-executor.ts`'s positive-list projection. Asserts (a) script reads `context.agentSession.endUserId` and `memory.user.set` persists under that same endUserId, (b) two runs sharing the actor see each other's `memory.user.*` writes (workflow-as-tool nesting surrogate), (c) different end-users see `__none__` (negative isolation). **Residual**: HTTP-end-to-end chat-WS driver (deterministic LLM mock + SDK channel session bootstrap + WS chat-frame automation) — deferred to v1.1 alongside the chat E2E harness work | Medium   | Resolved (contract) — Residual deferred |
| GAP-019 | Cron trigger E2E harness does not yet exist in `apps/studio/e2e/workflows/`. **Resolved 2026-04-28**: `apps/studio/e2e/workflows/workflow-cron-trigger-memory.spec.ts` closes the gap by registering a cron trigger via `POST /api/projects/:projectId/workflows/triggers` (with a never-fire cron expression `0 0 31 2 *` so BullMQ doesn't race) and firing it immediately via `POST /api/projects/:projectId/workflows/triggers/:registrationId/fire`. The engine's `fireWebhookTrigger()` preserves `triggerType: 'cron'` so the run exercises the same code path BullMQ would invoke. Cross-trigger continuity asserted by `status === 'completed'` on the cron-fire run after a Studio direct-run had written the sentinel value (the function-node body throws on `assertPersistence: true` payload if `previous` is not numeric).                                                                                                             | Low      | Resolved                                |
| GAP-020 | Per-run write counter is keyed on `runId` only. Restate retries replay with the same `runId`, and memory writes are NOT journaled by Restate (they go through `workflow-engine/runtime-memory-client.ts` outside `ctx.run`). A run that wrote N times before a crash will increment the counter another N+ times on retry — worst case a run that legitimately performs `MAX_WRITES_PER_RUN` writes before crashing can hit `QUOTA_WRITE_COUNT` on the retry. Counter TTL (24h) bounds the leak. Authors should treat memory.set as idempotent. v1.1 will revisit by either journaling writes via `ctx.run` (replay short-circuits without re-incrementing) or per-attempt counter keys (`runId + attemptNumber`).                                                                                                                                                                                                                                    | Medium   | Documented — Deferred to v1.1           |
| GAP-021 | `applySyncPromise` parks an isolate worker thread for the duration of each host fetch. Worst case per run: `MAX_WRITES_PER_RUN` (100) × `MEMORY_OP_TIMEOUT_MS` (5 s) = ~500 s of worker-thread occupancy if every call hits the full timeout. The libuv pool is at 8 threads (`UV_THREADPOOL_SIZE=8` in workflow-engine Dockerfile), so under pathological multi-tenant load a small set of bad-actor tenants could starve other workflows. Mitigations in v1.1: per-tenant isolate-thread budget (HLD D-9), per-run circuit breaker on consecutive timeouts, or moving memory ops off the blocking path (queue + ack pattern). The 5 s op timeout means worst case is bounded and observable today.                                                                                                                                                                                                                                                  | Medium   | Documented — Deferred to v1.1           |
| GAP-022 | `messageMetadata` is intentional pass-through (channel/transport metadata forwarded as-is). Channel adapters can include PII (voice phone numbers, email Message-Id, web SDK headers) — the HLD §10.2 / Concern 12 accepts the privacy trade-off because the runtime emits only what the channel adapter authorized. **Resolved 2026-05-01 (this PR)**: `materializeAgentContext` in `apps/workflow-engine/src/context/agent-projection.ts` now caps `messageMetadata` at 16 KiB JSON-serialized and drops oversize / non-serializable payloads at the projection boundary. Cap chosen above realistic channel header sizes; oversized records propagate as `undefined` rather than partial data. Tests in `expression-resolver.test.ts`.                                                                                                                                                                                                             | Medium   | Resolved                                |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                                                                                                                                       | Coverage Type      | Status     | Test File / Note                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Expression resolver exposes `{{agentSession.*}}`, `{{agentContext.*}}`, and `{{memory.*}}` as first-class top-level objects                                                                                                                    | unit               | DONE       | `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` (Phase 3)                                                                                                                                                                                                                                       |
| 2   | Agent-triggered workflow run materializes read-only `agentSession` / `agentContext`; non-agent triggers surface unavailable objects only                                                                                                       | integration        | DONE       | `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts` (INT-13, Phase 3) + `apps/workflow-engine/src/__tests__/workflow-memory-isolate.test.ts`                                                                                                                                                  |
| 3   | Function nodes receive direct globals and reject writes to `agentSession` / `agentContext`                                                                                                                                                     | unit / integration | DONE       | `apps/workflow-engine/src/__tests__/function-executor.test.ts` + `workflow-memory-isolate.test.ts` (Phase 4)                                                                                                                                                                                                     |
| 4   | Function node can read/write/delete persistent memory with TTL override and downstream steps observe updated memory values                                                                                                                     | integration / e2e  | DONE       | `apps/workflow-engine/src/__tests__/function-executor.test.ts` INT-3 (Phase 4) + E2E-6 cross-run continuity (`apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts`)                                                                                                                                    |
| 5   | Workflow memory works across trigger types (`webhook`, `cron`, `event`, `studio`, `agent`)                                                                                                                                                     | e2e / integration  | DONE       | Webhook covered by INT-1 (`runtime-memory-client-http.test.ts`); Studio direct-run by E2E-3 + E2E-6; cron by E2E-7 (`workflow-cron-trigger-memory.spec.ts`, GAP-019 closure); agent leg by INT-3 + INT-13 contract closure (GAP-018 residual = chat-WS driver only)                                              |
| 6   | `memory.user.*` resolves only when an `endUserId` is resolvable per the §4a matrix (e.g., agent public-channel run) and fails safely on Studio debug, webhook, cron                                                                            | integration        | DONE       | `apps/runtime/src/__tests__/internal-memory-route.test.ts` (UNAVAILABLE_SCOPE branch) + E2E-3 in `apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts`                                                                                                                                                 |
| 7   | `memory.workflow.*` is workflow-global: writes from one end user's run are visible to a different end user's run on the same workflow (regression confirming v1 scope is not per-invoker)                                                      | integration        | DONE       | `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts` UT-3 verifies `wf:` namespacing is workflow-global                                                                                                                                                                                              |
| 8   | `agentSession` / `agentContext` projection is positive-list: fields not in §9 schema are NOT present, even when underlying session metadata expands                                                                                            | unit / integration | DONE       | `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts` INT-13 — secrets/tokens/transcripts/binaries verified absent                                                                                                                                                                              |
| 9   | Expression injection: a resolved `agentContext.attachments[].name` or `agentContext.invocation.args` value containing `{{memory.project.secret}}` is NOT recursively resolved — preserved literal                                              | integration        | DONE       | `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` UT-2 — no template re-interpolation                                                                                                                                                                                                             |
| 10  | TTL ceiling: per-write TTL exceeding fact-store maximum is clamped to the ceiling and emits a warning trace (no silent acceptance, no rejection)                                                                                               | integration        | DONE       | `apps/runtime/src/__tests__/internal-memory-route.test.ts` INT-6 (TTL parse + clamp + ttl_clamped trace)                                                                                                                                                                                                         |
| 11  | Per-write quota enforcement: oversized key (>256 chars), oversized value (>64 KB), or 101st write in a run throws and fails the function-node step                                                                                             | integration        | DONE       | `apps/runtime/src/__tests__/internal-memory-route.test.ts` INT-5 (per-write quotas)                                                                                                                                                                                                                              |
| 12  | Reserved-prefix guard: writes to `_meta:*`, `_system:*`, `_audit:*`, `wf:*` throw at write time and do not reach the fact store                                                                                                                | integration        | DONE       | `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts` UT-4 + `internal-memory-route.test.ts` INT-4                                                                                                                                                                                                |
| 13  | Audit log: every `memory.set` and `memory.delete` produces an audit entry with required fields; key is captured but value is not                                                                                                               | integration        | DONE       | `apps/runtime/src/__tests__/internal-memory-route.test.ts` INT-8 (audit emission asserts `value` absent)                                                                                                                                                                                                         |
| 14  | Memory failure surfaces: fact-store unavailable, reserved-key write, and TTL-invalid all throw to the function node — no silent swallow, no partial multi-key writes                                                                           | integration        | DONE       | `apps/workflow-engine/src/__tests__/function-executor.test.ts` INT-3 + `internal-memory-route.test.ts` (RESERVED*PREFIX, QUOTA*\*, STORAGE_UNAVAILABLE error paths)                                                                                                                                              |
| 15  | Right-to-erasure cascade: erasing an end user purges `memory.user.*` keyed on their `endUserId`; `memory.workflow.*` and `memory.project.*` are unaffected                                                                                     | integration        | DONE       | `apps/runtime/src/__tests__/cascade-delete-contact-memory-erasure.test.ts` INT-9 + `apps/studio/e2e/workflows/workflow-memory-erasure.spec.ts` E2E-4                                                                                                                                                             |
| 16  | Tombstone delete: `memory.delete` produces a soft-delete tombstone visible to audit reconstruction within the v1 retention window                                                                                                              | integration        | DONE       | `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts` UT-4 (tombstone + resurrect-on-set semantics)                                                                                                                                                                                               |
| 17  | Concurrent writes to the same key from two workflow runs are last-write-wins; v1 provides no atomic counter or CAS guarantee                                                                                                                   | integration        | NOT TESTED | Concurrency suite not in v1 scope — deferred (GAP-012)                                                                                                                                                                                                                                                           |
| 18  | Replay/retry: function-node body re-execution writes the same memory key twice; authors must use idempotent patterns (v1 contract)                                                                                                             | integration        | NOT TESTED | Replay/retry suite not in v1 scope — deferred (GAP-013)                                                                                                                                                                                                                                                          |
| 19  | Workflow-as-tool nesting: nested workflow run sees the outermost agent's `agentSession`/`agentContext` unchanged; nested `memory.workflow.*` is keyed on the inner workflow id                                                                 | integration        | DONE       | `workflow-tool-executor-projection.test.ts` (INT-13) covers projection at the boundary; nesting surrogate covered by `workflow-memory-isolate.test.ts` 'agentSession ↔ memory.user actor derivation' (two-run shared-actor + cross-end-user negative). HTTP-end-to-end E2E-5 stays scaffolded (residual GAP-018) |
| 20  | Deep freeze: deep mutation of `agentSession.metadata.foo` or `agentContext.attachments[0].name` throws in strict mode                                                                                                                          | unit               | DONE       | `apps/workflow-engine/src/__tests__/workflow-memory-isolate.test.ts` UT-5/UT-6 (deep-freeze enforcement)                                                                                                                                                                                                         |
| 21  | Cross-surface fact namespace: workflow-written `memory.project.foo` and tool-written `foo` resolve to the same value (intentional); `memory.workflow.foo` is stored under `wf:<workflowId>:foo` and is invisible to tool-memory-bridge readers | integration        | DONE       | `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts` + `mongodb-fact-store-prefix-guard.test.ts` (cross-surface namespace separation)                                                                                                                                                                |

### Testing Notes

Phases 0-6 landed; v1 ships at BETA (STABLE-promotion candidate after the 2026-04-28 GAP-018/019 closures). **19 of 21** required scenarios are DONE (rows 5 and 19 promoted from PARTIAL → DONE on 2026-04-28). **2** are NOT TESTED by design (concurrency / retry semantics are explicitly out of v1 scope per GAP-012, GAP-013). The residual delta vs full STABLE is a single HTTP-end-to-end chat-WS driver (residual GAP-018) — every other contract is covered by either an E2E spec or a real-Mongo + real-isolate integration test.

Keystone regression for ALPHA: `internal-memory-route.test.ts` (24/24) + `cascade-delete-contact-memory-erasure.test.ts` (4/4) + `function-executor.test.ts` (INT-3 ivm boundary) + the workflow-engine suite (965/965 non-skipped pass). Promotion to BETA requires closing the 2 PARTIAL rows AND running 5 pr-reviewer rounds; the 2 NOT-TESTED rows stay deferred per the v1 contract.

> Full testing details: `../../testing/sub-features/workflow-first-class-memory-and-context.md`

---

## 18. References

- Parent feature: [Workflows & Human Tasks](../workflows.md)
- Related feature: [Workflow-as-Tool](../workflow-as-tool.md)
- Related feature: [Memory & Session Management](../memory-sessions.md)
- Related feature: [Workflow Function Node](workflow-function-node.md)
- Related feature: [Variable Resolution Across Tool Types](variable-resolution.md)
- Workflow expression resolver: `apps/workflow-engine/src/context/expression-resolver.ts`
- Workflow function executor: `apps/workflow-engine/src/executors/function-executor.ts`
- Workflow context builder: `apps/workflow-engine/src/handlers/workflow-handler.ts`
- Runtime workflow tool executor: `apps/runtime/src/services/workflow/workflow-tool-executor.ts`
- Runtime tool memory bridge: `apps/runtime/src/services/execution/tool-memory-bridge.ts`
- Runtime memory integration: `apps/runtime/src/services/execution/memory-integration.ts`
- Persistent fact store: `apps/runtime/src/services/stores/mongodb-fact-store.ts`
- Fact model: `packages/database/src/models/fact.model.ts`
