# Session Timeout and Disposition Unification — High-Level Design

**Status**: DRAFT
**Date**: 2026-03-30
**Owner**: Platform team
**Related Feature Doc**: [docs/features/sub-features/session-timeout-disposition-unification.md](../features/sub-features/session-timeout-disposition-unification.md)
**Parent Feature**: [docs/features/memory-sessions.md](../features/memory-sessions.md)
**Related Testing Guide**: [docs/testing/sub-features/session-timeout-disposition-unification.md](../testing/sub-features/session-timeout-disposition-unification.md)
**Related LLD Spec**: [docs/plans/session-timeout-disposition-unification.lld.md](../plans/session-timeout-disposition-unification.lld.md)

## 1. What

This HLD defines a single **conversation-session lifecycle** model for:

- runtime session timeout (idle + max age)
- channel disconnect behavior and default disposition
- explicit runtime close and bulk-close
- SDK explicit `end_session`
- agent-transfer TTLs and transfer-driven conversation end metadata
- mandatory end-session event emission
- optional end hooks that run after terminalization

Today these behaviors are implemented across independent helpers and settings surfaces. The result is:

- tenant plan defaults are enforced, but project overrides are not consistently honored
- channel disconnect defaults are runtime-config driven, but not exposed through a project-scoped control plane
- agent IR timeout fields compile, but runtime does not consume them for session creation
- transfer TTL settings are persisted, but the live transfer store still uses hardcoded fallback defaults unless explicit TTLs are passed
- `session.ended` is already a real platform event and pipeline trigger, but not every terminal path is forced through one event-emitting service
- billing fields exist on sessions, but billing itself is a separate subsystem and one conversation session may map to multiple downstream billing segments

The goal of this design is to keep current APIs compatible while moving all of those paths behind one policy-resolution and terminalization architecture. The terminal `session.ended` event remains the authoritative downstream lifecycle signal; end hooks are layered on afterward as best-effort user-facing side effects, while non-user-facing automation stays in pipeline subscribers. Billing remains downstream and may later emit its own aggregate usage event for dashboards after materialization.

## 2. Alternatives Considered

### Option A: Patch each surface independently

- **Description**: Add project timeout fields to `project-runtime-config`, thread TTLs into agent-transfer, and keep channel disconnect logic where it already lives.
- **Pros**: Lowest immediate code churn.
- **Cons**: Preserves duplicated policy resolution, duplicated enums, duplicated settings surfaces, and inconsistent event emission.
- **Effort**: M

### Option B: Dedicated lifecycle policy service plus terminalization service (Chosen)

- **Description**: Introduce one runtime service that resolves effective lifecycle policy from tenant defaults, project settings, agent IR timeout/disconnect fields, and trusted explicit overrides. Add a second service that owns terminalization, event emission, and end-hook invocation ordering. Keep existing routes as compatibility shims.
- **Pros**: One place for precedence, one place for disposition mapping, one place for event emission, easier observability, easier test coverage, cleaner Studio story.
- **Cons**: Requires touching multiple call sites and widening the event contract.
- **Effort**: L

### Option C: Event-only patch without lifecycle unification

- **Description**: Only make every end path emit `session.ended`, but leave timeout/disconnect policy logic scattered where it exists today.
- **Pros**: Fastest route to better downstream pipeline reliability.
- **Cons**: Still leaves operators with fragmented configuration and leaves agent/project override expectations unresolved.
- **Effort**: S

### Recommendation

Choose **Option B**. The platform already has the runtime event bus, Kafka bridge, and pipeline-engine subscribers. The cleanest path is to centralize both policy resolution and terminalization while reusing that existing infrastructure, not building a parallel end-of-session mechanism.

## 3. Architecture

### 3.1 Component Model

```text
Studio Settings UI / Studio Proxies
        │
        ▼
GET/PATCH /api/projects/:projectId/session-lifecycle
        │
        ▼
SessionLifecyclePolicyService
  ├─ TenantConfigService (tenant defaults)
  ├─ ProjectSettingsRepo / ProjectSettings.sessionLifecycle (project overrides)
  ├─ ProjectSettings.agentTransfer.session.ttl (transfer TTL overrides)
  ├─ Agent IR timeout/disconnect fields (agent overrides)
  └─ Trusted explicit session overrides (SDK end_session, admin close, provider end)
        │
        ▼
SessionTerminalizationService
  ├─ Disposition normalization
  ├─ Idempotent terminal state persistence
  ├─ RuntimeEventBus.emit('session.ended')
  └─ EndHookRunner (best effort)
        │
        ├─ SessionFactory / chat routes
        ├─ SessionCleanupJob
        ├─ lifecycle-manager / channel disconnect handlers
        ├─ sessions close + bulk-close routes
        ├─ SDK WebSocket handler
        └─ agent-transfer create / extend / end flows
                     │
                     ├─ Kafka topic: abl.session.ended
                     ├─ Pipeline Engine subscribers (webhooks, functions, API calls, post-session jobs)
                     ├─ Downstream billing / metering consumers
                     └─ Dashboard consumers via billing-domain aggregate events
```

### 3.2 Policy Layers and Precedence

| Layer | Source                    | Scope          | Example                                                |
| ----- | ------------------------- | -------------- | ------------------------------------------------------ |
| 1     | Tenant defaults           | Tenant-wide    | TEAM plan idle timeout = 1800 seconds                  |
| 2     | Project overrides         | Project-scoped | Project sets `web_chat` disconnect=`end`               |
| 3     | Agent override            | Agent-scoped   | One agent sets shorter idle timeout or disconnect rule |
| 4     | Trusted explicit override | Session-scoped | SDK `end_session` forces `completed/end`               |

Rules:

- Missing project or agent settings fall back to the next broader layer.
- Explicit overrides are only allowed on trusted server-owned paths, not arbitrary client-provided request bodies.
- Timeout and disconnect behavior follow the full precedence chain above.
- End-hook policy is configured at project level with optional channel-level override and no agent-level hook override.

### 3.3 Terminalization and Event Emission

Terminalization becomes a single ordered flow:

1. Resolve lifecycle policy and normalize the terminal disposition.
2. Persist terminal session state idempotently.
3. Emit `session.ended` through `RuntimeEventBus` using the existing event-bus/Kafka infrastructure.
4. Execute the configured end hook as a best-effort side effect.
5. Record traces/logs for terminal source, event emission, and hook outcome.

Important guarantees:

- a session can end successfully even if no end hook is configured
- end-hook failure never rolls back terminal session state
- end-hook failure never suppresses the `session.ended` event
- pipelines rely on the event, not on hook success

### 3.4 Canonical Disposition Model

The shared lifecycle service normalizes every end path to one canonical reason model before updating session status or emitting the event.

| Input Reason   | Persisted `disposition` | Derived `status` | Current Producers                                             |
| -------------- | ----------------------- | ---------------- | ------------------------------------------------------------- |
| `completed`    | `completed`             | `completed`      | explicit close, SDK end_session, successful disconnect policy |
| `transferred`  | `transferred`           | `escalated`      | explicit close, handoff semantics                             |
| `abandoned`    | `abandoned`             | `abandoned`      | disconnect defaults, manual close                             |
| `agent_hangup` | `agent_hangup`          | `abandoned`      | channel/provider disconnect                                   |
| `failed`       | `failed`                | `abandoned`      | failure path / explicit close                                 |
| `timeout`      | `timeout`               | `abandoned`      | cleanup job or timeout enforcement                            |
| `unengaged`    | `unengaged`             | `abandoned`      | cleanup job for no-message sessions                           |

This keeps `status` as the coarse operator-facing bucket while preserving fine-grained end reason in `disposition`.

### 3.5 End Hook Model

End hooks are lifecycle-policy side effects, not a new workflow engine. The initial model supports:

- `ignore`: no user-facing action; still emit the event and finish terminalization
- `respond`: best-effort final message to the user if the transport is still available

Design notes:

- `respond` should reuse existing runtime message-delivery primitives where possible.
- Hooks default to fail-open so terminalization stays authoritative.
- Hooks should be configurable at project scope and overrideable per channel.
- Hooks should be manageable by project admins only.
- Webhooks, API calls, functions, CRM updates, and other non-user-facing actions should be implemented in pipeline-engine subscribers to `session.ended`, not as runtime lifecycle-hook config.

### 3.6 Control-Plane API

The design introduces one authoritative project route:

| Endpoint                                               | Method | Purpose                                       |
| ------------------------------------------------------ | ------ | --------------------------------------------- |
| `/api/projects/:projectId/session-lifecycle`           | GET    | Read saved project overrides                  |
| `/api/projects/:projectId/session-lifecycle`           | PATCH  | Update project overrides                      |
| `/api/projects/:projectId/session-lifecycle/effective` | GET    | Inspect resolved values and source provenance |

Compatibility behavior:

- `GET/PUT /api/v1/agent-transfer/settings` continue to work, but lifecycle-related TTL data is delegated to the same service.
- Existing runtime close/bulk-close and transfer end routes continue to work, but they call the shared terminalization path.

### 3.7 Billing Separation

This feature governs **conversation sessions**, not billing sessions.

- A conversation session is the user/agent interaction container and lifecycle anchor.
- Billing may derive zero, one, or many billable units or billable segments from that conversation session.
- Terminalization must not directly write billing ledgers, billing line items, replay/materialization artifacts, or legacy usage-period documents.
- The emitted `session.ended` event and other usage telemetry are inputs to downstream billing logic, not a replacement for it.
- Recommended downstream billing derivation rules are:
  - billing-unit policy is tenant-level for now, sourced from subscription-plan defaults
  - only platform admins may change billing-unit policy
  - all plan tiers may start with the same defaults, but the contract should remain plan-aware
  - project, channel, and agent lifecycle config do not override billing-unit policy
  - billing materialization trigger basis is tenant-level and configurable as `time_window` or `completed_sessions`
  - exclude debug sessions such as `web_debug`
  - exclude proactive sessions with no or below-minimum user interaction
  - split base billing units into 15-minute billable intervals
  - meter LLM and tool usage as addon billing units
- After billing materializes usage, the billing domain should emit `billing.usage.updated` for dashboard consumption rather than expecting dashboards to infer billing completion from raw `session.ended`.

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern             | Design Decision                                                                                                                                                                                                               |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant Isolation    | All policy resolution starts with `tenantId` from authenticated context. Cross-tenant lifecycle access returns 404.                                                                                                           |
| 2   | Data Access Pattern | `TenantConfigService` remains the tenant-default source; `ProjectSettings` stores project settings plus channel hook overrides; agent overrides come from compiled IR for timeout/disconnect only; one service composes them. |
| 3   | API Contract        | Add a dedicated project lifecycle route instead of growing unrelated APIs. Compatibility routes stay stable during rollout.                                                                                                   |
| 4   | Security Surface    | Only authenticated project-scoped callers may read/write lifecycle settings. Only project admins may change hook config. Only trusted runtime/server flows may apply explicit per-session overrides.                          |

### Behavioral Concerns

| #   | Concern       | Design Decision                                                                                                                                                          |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | Error Model   | Missing project settings fall back to tenant defaults. Invalid updates return 400 with structured field errors. Unknown sessions remain 404.                             |
| 6   | Failure Modes | Terminal state persistence is authoritative. Event emission is mandatory on that path. End hooks fail open and never suppress terminalization.                           |
| 7   | Idempotency   | PATCH updates are merge-based. Close/end APIs stay idempotent: repeated closes keep the same normalized terminal outcome and must not emit duplicate downstream actions. |
| 8   | Observability | Every resolved lifecycle decision emits source provenance, normalized disposition, terminal source, and hook outcome to traces/logs.                                     |

### Operational Concerns

| #   | Concern            | Design Decision                                                                                                                                                                                                                       |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Performance Budget | Effective lifecycle policy should be cacheable per `(tenantId, projectId, channel, agent)` tuple. Terminalization should add only low-single-digit milliseconds on hot paths.                                                         |
| 10  | Migration Path     | Use compatibility shims for existing settings/end routes while Studio and runtime callers migrate to the dedicated lifecycle route and terminalization service.                                                                       |
| 11  | Rollback Plan      | If rollout causes regressions, disable new callers and route back to existing behavior while keeping stored settings intact. Event contract widening must remain additive during rollout.                                             |
| 12  | Test Strategy      | Add unit coverage for precedence/mapping/hook behavior, integration coverage for runtime/transfer wiring, and E2E coverage for project + channel hook enforcement, agent timeout/disconnect override enforcement, and event emission. |

## 5. Data Model and Event Contracts

### Project Settings

The design reuses `project_settings` instead of introducing a new collection.

```text
project_settings.sessionLifecycle
  runtime:
    idleSeconds?: number
    maxAgeSeconds?: number
  endHook?:
    mode: 'ignore' | 'respond'
    message?: string
  channels:
    <channel>:
      defaultDisposition?: string
      disconnectBehavior?: 'end' | 'detach'
      endHook?: { ... }
```

Transfer-session TTLs continue to live in `project_settings.agentTransfer.session.ttl`, but they are resolved through the shared lifecycle service instead of being read ad hoc by each caller.

### Session and Transfer Records

- Runtime sessions keep `status`, `disposition`, and optional `dispositionCode`.
- Transfer-session hashes keep `ttl`, `dispositionCode`, and `wrapUpNotes`, but those fields are driven by shared lifecycle rules instead of disconnected defaults.
- `sessionId` remains the conversation-session correlation key and is not treated as a billing-session identifier.

### `session.ended` Contract

The runtime and EventStore event schemas should be widened additively to carry:

- canonical `disposition`
- derived `status`
- `terminalSource`
- compatibility `reason`
- existing summary metrics such as duration/turn count/agent list

This keeps current subscribers working while giving future pipelines a stable terminal contract.
Billing dashboards should consume billing-domain aggregate events such as `billing.usage.updated`, not raw `session.ended`.

## 6. Migration and Rollout

1. Add shared lifecycle types, project persistence, and policy service.
2. Add a centralized terminalization service and widen the `session.ended` contract.
3. Route runtime create/cleanup/disconnect/close through the service.
4. Layer `ignore` / `respond` end-hook execution after event emission.
5. Keep non-user-facing automation on existing `session.ended` pipeline subscribers.
6. Thread resolved TTLs and transfer end metadata into agent-transfer flows.
7. Migrate Studio to the dedicated route while keeping compatibility shims.
8. Trim scattered direct terminalization logic only after compatibility tests are green.

## 7. Open Questions

1. Should `agentTransfer.session.ttl` eventually move under `sessionLifecycle.agentTransfer`, or remain a compatibility-managed sibling field in `ProjectSettings`?
