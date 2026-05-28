# Feature: Session Timeout & Disposition Unification

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Memory & Sessions](../memory-sessions.md)
**Status**: PLANNED
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `admin operations`, `integrations`, `pipelines`, `billing`, `observability`, `governance`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/database`, `packages/compiler`, `packages/agent-transfer`, `packages/eventstore`, `packages/pipeline-engine`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/session-timeout-disposition-unification.md](../../testing/sub-features/session-timeout-disposition-unification.md)
**Last Updated**: 2026-03-30

---

## 1. Introduction / Overview

### Problem Statement

Session timeout and disposition behavior are currently split across several partially overlapping mechanisms:

- runtime sessions use tenant-plan security settings for idle/max-age enforcement
- channel disconnect cleanup uses runtime `channelLifecycle` config and channel-specific defaults
- explicit session close uses runtime REST APIs and a separate status-mapping helper
- SDK `end_session` applies a per-connection override inside the WebSocket handler
- agent-transfer settings persist per-project TTLs, but the live transfer store still falls back to hardcoded channel TTL defaults unless an explicit TTL is passed
- `MongoConversationStore.endSession()` emits `session.ended`, but other terminal paths such as cleanup and explicit route-level terminalization still bypass one mandatory shared end-event path
- pipeline-engine workloads already subscribe to `abl.session.ended`, so missed or inconsistent end events create downstream analytics and automation drift
- the `Session` model still contains billing-adjacent fields such as `billingPeriod`, but billing is a separate subsystem and one conversation session may correspond to zero, one, or many downstream billing sessions or billing segments

This split makes the platform hard to reason about. Operators expect project-level timeout controls, channel-specific disposition defaults, project-admin-managed end-of-session hooks with channel override, and per-agent timeout/disconnect overrides to be enforced consistently, but the current implementation only enforces some of those knobs. The result is documentation drift, duplicated settings surfaces, terminal outcomes that are difficult to predict, and downstream pipelines that cannot rely on every session ending the same way.

### Goal Statement

Define and implement one coherent **conversation-session lifecycle** model for timeout, disconnect behavior, end-session disposition, mandatory end-session event emission, and optional end hooks across runtime sessions, channel lifecycles, SDK explicit end flows, and agent-transfer conversation end paths. The target system must preserve tenant/project isolation, keep current APIs backward-compatible during rollout, and keep billing/metering downstream from conversation lifecycle rather than making session terminalization the billing source of truth.

### Summary

This sub-feature introduces a single policy-resolution and terminalization model for conversation-session lifecycle behavior:

- tenant defaults stay in `TenantConfigService`
- project overrides become explicit and enforceable through one project-scoped lifecycle settings surface
- agent-level timeout/disconnect overrides become a real enforced runtime concept instead of a compiled-but-unused field
- runtime close, cleanup, channel disconnect, SDK end, and transfer-driven conversation end all use one shared `SessionTerminalizationService`
- every successful conversation-session terminalization emits `session.ended` through the runtime event bus so existing pipeline-engine integrations continue to work from one canonical signal
- optional end hooks are configured at project level with channel-level override and run after terminalization has been recorded and the end event has been emitted, using best-effort `ignore` or `respond` behavior
- non-user-facing automation such as API calls, webhooks, and function execution runs downstream from `session.ended` pipelines rather than from runtime hook config
- billing remains a downstream consumer of conversation-session lifecycle telemetry; this feature does not define or enforce billing-session boundaries
- the billing domain may later emit a dashboard-facing `billing.usage.updated` event after materializing usage for a configured time window or processed batch of completed sessions

The implementation is intentionally incremental. Existing routes such as `/api/projects/:projectId/sessions/:id/close`, `/api/projects/:projectId/sessions/bulk-close`, `/api/v1/agent-transfer/settings`, and `/api/v1/agent-transfer/sessions/:id/end` remain available during rollout, but they become compatibility lanes over the same lifecycle policy and terminalization services instead of independent behavior islands.

---

## 2. Scope

### Goals

- Establish one authoritative precedence chain for runtime timeout, disconnect behavior, project/channel end-hook policy, and disposition mapping.
- Add a project-scoped control-plane surface that makes conversation-session lifecycle settings explicit and enforceable.
- Enforce per-agent overrides for session timeout and disconnect policy through compiler IR and runtime resolution.
- Route every conversation-session terminal path through one shared terminalization flow that persists terminal state once and emits one canonical `session.ended` event.
- Support configurable end hooks whose default user-facing behavior can be either to send a final message or to do nothing from the user point of view.
- Route non-user-facing automation such as API calls, functions, CRM updates, or follow-up jobs to pipelines subscribed to `session.ended`.
- Wire agent-transfer TTLs and transfer-session end metadata through the same lifecycle policy model when those flows affect conversation-session end behavior.
- Keep billing and usage accounting downstream and explicitly decoupled from conversation-session terminalization.

### Non-Goals (Out of Scope)

- Replacing the hot/cold session storage architecture (`RedisSessionStore` + `TieredSessionStore` + MongoDB cold restore).
- Redesigning omnichannel live-session attach/join behavior beyond reusing shared lifecycle primitives.
- Removing existing runtime or Studio routes in the first rollout; backward-compatible shims are required.
- Defining how many billing sessions, billing windows, or billable segments a conversation session should create.
- Writing `CreditLedger`, `BillingLineItem`, billing replay/materialization artifacts, retired legacy `UsagePeriod` records, or quota-enforcement records directly from session terminalization.
- Treating `sessions.billingPeriod` or the session document itself as the billing source of truth.
- Replacing provider-specific post-agent UX flows such as CSAT dialogs or external wrap-up forms.

---

## 3. User Stories

1. As a **project admin**, I want to configure session timeout, disconnect policy, and default end-hook behavior once per project, with optional channel-level hook overrides, so that runtime and transfer-session behavior matches the settings I save.
2. As an **agent developer**, I want to override timeout or disconnect behavior for one agent so that a specific workflow can deviate safely from the project default without creating a second hook-configuration surface.
3. As a **runtime operator**, I want every conversation end path to record the same canonical disposition and always emit the same `session.ended` event so that dashboards, cleanup jobs, audits, and pipelines agree on why a session ended.
4. As a **channel owner**, I want the default end behavior to either send a closing message or stay silent from the user point of view, while still guaranteeing the underlying end event is emitted for automation and analytics.
5. As a **transfer operator**, I want transfer sessions to honor project TTL policy and accept wrap-up metadata so that human-handoff flows do not silently fall back to hardcoded defaults.
6. As a **billing/platform operator**, I want conversation-session lifecycle and billing-session accounting to stay separate so that metering can derive billable boundaries without being coupled to one terminal session row.

---

## 4. Functional Requirements

1. **FR-1**: The system must resolve effective runtime timeout and disconnect policy from a documented precedence chain: tenant default, project override, agent override, then trusted explicit session override.
2. **FR-2**: The system must resolve end-hook policy from project-level configuration with optional channel-level override. Agent definitions must not override end-hook behavior.
3. **FR-3**: Only project admins may configure end-hook policy through the project lifecycle settings surface.
4. **FR-4**: The system must expose project-scoped lifecycle configuration for runtime timeout, per-channel disconnect behavior, default end-hook behavior, and transfer-session TTL defaults, and runtime must enforce the saved values on live sessions.
5. **FR-5**: The system must enforce per-agent timeout and disconnect overrides from compiler IR when creating or resolving runtime sessions.
6. **FR-6**: The system must route runtime session close, cleanup timeout, channel disconnect, SDK `end_session`, and transfer-driven conversation end through one shared terminalization service.
7. **FR-7**: The shared terminalization service must normalize every end path to one canonical `disposition` and derived `status`, and it must remain idempotent for repeated close/end attempts.
8. **FR-8**: Every successful conversation-session terminalization must emit `session.ended` through the runtime event bus so that existing event-bus and pipeline-engine subscribers can react through the established `abl.session.ended` path.
9. **FR-9**: The system must emit the terminal `session.ended` event before any optional end-hook side effects are attempted, and end-hook failure must never prevent persisted terminal state or event emission.
10. **FR-10**: Runtime lifecycle hook configuration must support only `ignore` and `respond` modes.
11. **FR-11**: A `respond` end hook may send a best-effort final message to the user, but if the channel is already detached or closed, the session must still end successfully and the end event must still be emitted.
12. **FR-12**: Non-user-facing automation such as API calls, functions, webhooks, CRM updates, or post-processing must run from pipeline subscribers to `session.ended`, not from runtime hook configuration.
13. **FR-13**: The system must pass resolved TTLs into `TransferSessionStore.create()` and `TransferSessionStore.extendTTL()` so that project-configured transfer-session settings are the live source of truth, and it must provide a runtime-backed path to write transfer end metadata before transfer-session cleanup removes it.
14. **FR-14**: The system must provide an effective-policy inspection surface that shows the resolved value and its source for a given project, channel, and optional agent, including the resolved end-hook mode and whether it came from the project default or a channel override.
15. **FR-15**: The system must preserve backward compatibility for existing close/end/settings APIs during rollout, while clearly marking compatibility behavior in docs and observability.
16. **FR-16**: Conversation-session lifecycle must remain decoupled from billing-session accounting. One conversation session may correspond to zero, one, or many downstream billing units or billing segments, and session terminalization must not directly create or mutate billing records.
17. **FR-17**: Downstream billing systems may derive billing units from conversation/session type, interaction type, billable time windows, and addon usage, including recommendations to exclude debug sessions, exclude proactive low-interaction sessions, split billable time into 15-minute units, and meter LLM/tool usage as addon units. In the first billing implementation, billing-unit policy and billing materialization trigger basis must be tenant-level, sourced from subscription-plan defaults, and editable only by platform admins. After billing materializes usage, the billing domain should emit a dashboard-consumable `billing.usage.updated` event based on a configured `time_window` or `completed_sessions` trigger rather than a per-conversation completion event.
18. **FR-18**: The system must add automated coverage for timeout precedence, disconnect behavior, end-event emission, end-hook execution, transfer-session TTL enforcement, transfer end metadata capture, and billing separation.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| Project lifecycle          | PRIMARY      | Project-scoped lifecycle settings become an explicit control surface.                |
| Agent lifecycle            | PRIMARY      | Agent IR overrides become part of live session resolution.                           |
| Customer experience        | SECONDARY    | End-of-session user messaging becomes configurable and predictable.                  |
| Integrations / channels    | PRIMARY      | Channel disconnect and transfer TTL behavior are unified.                            |
| Pipelines / eventing       | PRIMARY      | `session.ended` becomes the guaranteed terminal signal for downstream pipeline work. |
| Billing / usage            | SECONDARY    | Billing consumes lifecycle telemetry downstream but does not drive terminalization.  |
| Observability / tracing    | PRIMARY      | Effective policy source, terminal source, and hook outcome become observable.        |
| Governance / controls      | PRIMARY      | Timeout, retention, and close behavior become auditable.                             |
| Admin / operator workflows | PRIMARY      | Studio and runtime operators gain one predictable lifecycle model.                   |

### Related Feature Integration Matrix

| Related Feature                                                        | Relationship Type | Why It Matters                                                                 | Key Touchpoints                                                                       | Current State                  |
| ---------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------ |
| [Memory & Sessions](../memory-sessions.md)                             | extends           | Runtime timeout, cleanup, hot-store TTL, and explicit close already live here. | `TenantConfigService`, `SessionFactory`, cleanup job, close routes                    | Active but fragmented          |
| [Channels](../channels.md)                                             | configured by     | Channel disconnect policy currently comes from `channelLifecycle` defaults.    | `lifecycle-manager.ts`, WebSocket handlers, runtime config                            | Active but runtime-config only |
| [Agent Transfer](../agent-transfer.md)                                 | shares data with  | Transfer TTLs and end metadata must use the same lifecycle policy model.       | `ProjectSettings.agentTransfer`, transfer store, transfer end route                   | Active but partially wired     |
| [SDK](../sdk.md)                                                       | depends on        | SDK `end_session` currently applies its own disconnect override.               | `sdk-handler.ts`, session close semantics                                             | Active                         |
| [Tracing & Observability](../tracing-observability.md)                 | emits into        | Close reasons, terminal source, and hook outcomes need trace/audit visibility. | TraceStore, session explorer, dashboards                                              | Active                         |
| [Pipeline Engine](../pipeline-engine.md)                               | triggered by      | Pipelines already subscribe to `abl.session.ended` and depend on end emission. | runtime event bus, Kafka topics, `packages/pipeline-engine` trigger definitions       | Active                         |
| [Billing & Usage](../billing.md)                                       | downstream of     | Billing must derive billable boundaries without session lifecycle owning them. | `CreditLedger`, `BillingLineItem`, replay/materialization batches, and usage metering | ALPHA                          |
| [Omnichannel Session Continuity](../omnichannel-session-continuity.md) | shares data with  | Shared sessions and cross-channel continuity depend on predictable end policy. | live-session attach/detach, contact-linked session semantics                          | ALPHA                          |

---

## 6. Design Considerations

- Studio should stop presenting timeout/disposition controls as separate unrelated settings domains. Runtime timeout, channel disconnect defaults, transfer TTLs, and project/channel end-hook defaults should read as one lifecycle policy model.
- The authoritative signal for downstream lifecycle work is the terminal `session.ended` event, not the success of a user-facing hook.
- End hooks are side effects, not the source of truth. Session terminalization must succeed and emit the event even when no hook is configured or when a hook fails.
- Runtime hooks should stay narrow and user-facing. All non-user-facing automation should be implemented as pipeline subscribers to `session.ended`.
- Billing dashboards should not infer billing completion from raw `session.ended` events. They should consume billing-domain aggregate events emitted after billing materialization.
- Operators need provenance, not just values. A lifecycle setting that says `1800` seconds is less useful than `1800 (project override over TEAM tenant default)`.
- Billing needs a clean boundary. A conversation session is the interaction container; billing may later derive one or more billable segments from that container using downstream logic.

---

## 7. Technical Considerations

- `ProjectSettings` already stores `agentTransfer`; the streamlined design can add a sibling `sessionLifecycle` section instead of introducing a second project-scoped settings collection.
- Tenant plan defaults should remain in `TenantConfigService.security`, but project resolution must stop dropping `security` fields when a `projectId` is present.
- Compiler IR already carries `execution.timeouts.session_timeout_ms`; the streamlined design should normalize this into a richer agent-level `execution.sessionLifecycle` object for timeout and disconnect overrides only. End hooks should not be configured from agent IR.
- The runtime event-bus and pipeline-engine infrastructure already exist. This feature should emit through the existing event bus rather than inventing a second pipeline trigger path.
- The current `SessionEndedPayload` and `packages/eventstore` `session.ended` schema are narrower than the lifecycle disposition model. The rollout should widen the contract to include canonical disposition fields while keeping compatibility for existing consumers.
- End-hook config should live in `ProjectSettings.sessionLifecycle` with project default plus channel override. Runtime `call` hooks should not be part of the lifecycle config surface; pipeline subscribers should own API/function/webhook side effects.
- Redis hot-store expiry is not a complete session-end mechanism because `TieredSessionStore` can cold-restore sessions after Redis eviction; lifecycle policy must distinguish hot-store TTL from terminal session outcome.
- The existing `sessions.billingPeriod` field is not currently the billing source of truth. This feature must not build new billing logic on top of that field.

---

## 8. How to Consume

### Studio UI

Studio should expose one project-scoped lifecycle settings surface that covers:

- runtime idle timeout and max age
- per-channel disconnect behavior and default disposition
- project-level default end-hook behavior, including whether the default user-facing behavior is silent or sends a final message
- channel-level end-hook override when a channel needs a different closing message or silent behavior
- transfer-session TTL defaults
- effective policy inspection for a specific channel or agent

During rollout, existing Runtime Config and Agent Transfer settings pages may remain, but they should become views over the same underlying lifecycle service instead of independent persistence paths.

### API (Runtime)

| Method | Path                                                   | Purpose                                                                      |
| ------ | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/session-lifecycle`           | Read project-scoped lifecycle settings                                       |
| PATCH  | `/api/projects/:projectId/session-lifecycle`           | Update project-scoped lifecycle settings                                     |
| GET    | `/api/projects/:projectId/session-lifecycle/effective` | Inspect resolved lifecycle policy for a channel and optional agent           |
| POST   | `/api/projects/:projectId/sessions/:id/close`          | Explicit runtime session close with normalized disposition                   |
| POST   | `/api/projects/:projectId/sessions/bulk-close`         | Bulk close runtime sessions with normalized disposition                      |
| POST   | `/api/v1/agent-transfer/sessions/:id/end`              | Compatibility transfer end route, extended to accept structured end metadata |
| GET    | `/api/v1/agent-transfer/settings`                      | Compatibility read path for transfer-specific settings                       |
| PUT    | `/api/v1/agent-transfer/settings`                      | Compatibility write path for transfer-specific settings                      |

### API (Studio)

| Method | Path                                                              | Purpose                                     |
| ------ | ----------------------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/projects/:projectId/session-lifecycle`                      | Studio proxy for lifecycle settings         |
| PATCH  | `/api/projects/:projectId/session-lifecycle`                      | Studio proxy for lifecycle settings updates |
| POST   | `/api/runtime/sessions/:id/close`                                 | Existing session close proxy                |
| POST   | `/api/runtime/sessions/bulk-close`                                | Existing bulk close proxy                   |
| POST   | `/api/projects/:projectId/agent-transfer/sessions/:sessionId/end` | Transfer-session end proxy                  |

### Channel / SDK / Voice / A2A / MCP Integration

- `web_chat`, `web_debug`, `api`, `voice`, `sms`, `whatsapp`, and `email` use one shared disconnect-policy resolver.
- SDK `end_session` remains a trusted explicit session override, but it stops bypassing the same terminalization path used elsewhere.
- Agent-transfer chat/email/voice/messaging/campaign TTLs are resolved from the same project policy service instead of hardcoded store defaults.
- End hooks may only influence user-facing end behavior (`ignore` or `respond`), while downstream calls, automations, and analytics are owned by `session.ended` pipelines.

---

## 9. Data Model

### Collections / Tables

```text
Collection: project_settings
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed, unique with tenantId)
  - agentTransfer: {
      session?: {
        ttl?: {
          chat?: number
          email?: number
          voice?: number
          messaging?: number
          campaign?: number
        }
      }
    } | null
  - sessionLifecycle: {
      runtime?: {
        idleSeconds?: number
        maxAgeSeconds?: number
      }
      endHook?: {
        mode: 'ignore' | 'respond'
        message?: string
      }
      channels?: {
        voice?: {
          defaultDisposition?: string
          disconnectBehavior?: 'end' | 'detach'
          endHook?: { ... }
        }
        web_chat?: {
          defaultDisposition?: string
          disconnectBehavior?: 'end' | 'detach'
          endHook?: { ... }
        }
        web_debug?: {
          defaultDisposition?: string
          disconnectBehavior?: 'end' | 'detach'
          endHook?: { ... }
        }
        api?: {
          defaultDisposition?: string
          disconnectBehavior?: 'end' | 'detach'
          endHook?: { ... }
        }
        sms?: {
          defaultDisposition?: string
          disconnectBehavior?: 'end' | 'detach'
          endHook?: { ... }
        }
        whatsapp?: {
          defaultDisposition?: string
          disconnectBehavior?: 'end' | 'detach'
          endHook?: { ... }
        }
        email?: {
          defaultDisposition?: string
          disconnectBehavior?: 'end' | 'detach'
          endHook?: { ... }
        }
      }
    } | null
Indexes:
  - { tenantId: 1, projectId: 1 } (unique)
```

```text
Collection: sessions
Fields:
  - status: 'active' | 'idle' | 'ended' | 'completed' | 'escalated' | 'abandoned' | 'archived'
  - disposition: 'completed' | 'abandoned' | 'agent_hangup' | 'transferred' | 'failed' | 'timeout' | 'unengaged' | null
  - dispositionCode: string | null
Notes:
  - status remains the coarse UI/analytics grouping
  - disposition is the fine-grained end reason normalized by the shared lifecycle service
  - sessionId is the conversation-session correlation key, not a billing-session identifier
```

```text
Platform event: session.ended
Envelope:
  - eventId
  - type = 'session.ended'
  - tenantId
  - projectId
  - sessionId
  - agentName
  - channel
  - timestamp
Payload:
  - disposition: 'completed' | 'abandoned' | 'agent_hangup' | 'transferred' | 'failed' | 'timeout' | 'unengaged'
  - status: 'completed' | 'escalated' | 'abandoned'
  - terminalSource: 'close_api' | 'bulk_close' | 'cleanup' | 'disconnect' | 'sdk_end_session' | 'transfer_end' | 'provider_end'
  - durationMs?: number
  - turnCount?: number
  - agentsUsed?: string[]
  - reason?: string
Notes:
  - `reason` remains as a compatibility alias during rollout for existing subscribers
  - end hooks are not the source of truth for downstream pipeline execution; the emitted event is the source of truth
```

```text
Downstream billing derivation guidance (follow-on billing scope)
Rules:
  - terminalization does not create billing artifacts directly
  - billing-unit policy is tenant-level for now and sourced from subscription-plan defaults
  - all subscription plans may start with the same billing-unit defaults, but the config model must remain plan-aware
  - only platform admins may change billing-unit policy
  - project, channel, and agent lifecycle config do not override billing-unit policy
  - billing materialization trigger basis is tenant-level and configurable as `time_window` or `completed_sessions`
  - debug sessions such as `web_debug` may be excluded from billing units
  - proactive sessions with no or below-minimum user interaction may be excluded from billing units
  - base billing units may be split into 15-minute billable intervals
  - LLM and tool invocations may contribute addon billing units
Notes:
  - these are downstream billing recommendations, not runtime session-lifecycle writes
  - billing may combine `session.ended` with usage telemetry and interaction summaries to derive units
  - the billing domain should emit `billing.usage.updated` after materializing usage for a configured time window or processed batch of completed sessions
  - dashboards should consume `billing.usage.updated` for billing views instead of inferring billing completion from raw `session.ended`
```

```text
Downstream billing event guidance (follow-on billing scope)
Platform event: billing.usage.updated
Payload:
  - basis: 'time_window' | 'completed_sessions'
  - effectivePlan: string
  - windowStart?: string
  - windowEnd?: string
  - completedSessionCount?: number
  - baseUnitsAdded?: number
  - addonUnitsAdded?: {
      llm?: number
      tool?: number
    }
  - totalsSnapshot?: {
      baseUnits?: number
      addonUnits?: number
    }
Notes:
  - emitted by the billing domain after usage materialization, not by runtime session terminalization
  - used for dashboard-facing billing views and aggregate usage refresh
  - trigger basis is configured at the tenant/subscription-plan layer
```

```text
Redis keys / transfer session hashes
Fields:
  - ttl: number
  - dispositionCode?: string
  - wrapUpNotes?: string
Notes:
  - transfer-session TTL must be injected from resolved project policy at create/extend time
  - post-agent metadata must be written before end cleanup removes the hash
```

### Key Relationships

- Tenant defaults originate in `TenantConfigService.security`.
- Project lifecycle overrides are persisted in `ProjectSettings`.
- Agent-specific overrides originate in compiler IR and are resolved at runtime against the project defaults for timeout and disconnect behavior only.
- Cleanup jobs, explicit close routes, WebSocket disconnect handlers, and transfer-session end routes all consume the same policy and terminalization services.
- `session.ended` is emitted through the runtime event bus and consumed by Kafka-backed pipeline-engine triggers.
- Billing and metering consume lifecycle telemetry downstream and may derive multiple billing units or billing segments from one conversation session based on time spent, interaction type, session type, and addon usage.
- The billing domain may emit `billing.usage.updated` after materializing usage for a configured time window or processed batch of completed sessions so dashboards consume billing aggregates instead of raw lifecycle events.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/runtime/src/services/tenant-config.ts`                    | Current tenant-level timeout defaults and project config resolution     |
| `apps/runtime/src/channels/pipeline/session-factory.ts`         | Runtime session creation and timeout resolution                         |
| `apps/runtime/src/services/session-cleanup-job.ts`              | Timeout/unengaged terminalization for runtime sessions                  |
| `apps/runtime/src/channels/pipeline/lifecycle-manager.ts`       | Channel disconnect cleanup and DB session ending                        |
| `apps/runtime/src/websocket/sdk-handler.ts`                     | SDK `end_session` override and disconnect handling                      |
| `apps/runtime/src/services/stores/mongo-conversation-store.ts`  | Existing store-level session create/end behavior and current event emit |
| `apps/runtime/src/services/event-bus/types.ts`                  | Runtime `session.ended` payload contract                                |
| `packages/compiler/src/platform/ir/compiler.ts`                 | Compiles agent-level lifecycle fields into IR                           |
| `packages/agent-transfer/src/session/transfer-session-store.ts` | Transfer-session TTL defaults, create, extend, and end behavior         |
| `packages/agent-transfer/src/post-agent/disposition-handler.ts` | Existing transfer disposition metadata primitive to be wired            |
| `packages/database/src/models/project-settings.model.ts`        | Project-scoped persisted settings document                              |
| `packages/eventstore/src/schema/events/session-events.ts`       | EventStore schema for `session.ended`                                   |
| `packages/pipeline-engine/src/pipeline/definitions/*.ts`        | Pipeline triggers that already depend on `abl.session.ended`            |

### Routes / Handlers

| File                                                 | Purpose                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/runtime/src/routes/sessions.ts`                | Runtime close and bulk-close APIs                                            |
| `apps/runtime/src/routes/project-runtime-config.ts`  | Current project runtime-config API that does not yet expose lifecycle fields |
| `apps/runtime/src/routes/agent-transfer-settings.ts` | Current project transfer-settings persistence API                            |
| `apps/runtime/src/routes/agent-transfer-sessions.ts` | Transfer-session list and end APIs                                           |

### UI Components

| File                                                                                     | Purpose                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------- |
| `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`                      | Current transfer TTL/settings UI        |
| `apps/studio/src/app/api/runtime/sessions/[id]/close/route.ts`                           | Studio proxy for explicit runtime close |
| `apps/studio/src/app/api/projects/[id]/agent-transfer/settings/route.ts`                 | Studio proxy for transfer settings      |
| `apps/studio/src/app/api/projects/[id]/agent-transfer/sessions/[sessionId]/end/route.ts` | Studio proxy for transfer-session end   |

### Jobs / Workers / Background Processes

| File                                                | Purpose                                                   |
| --------------------------------------------------- | --------------------------------------------------------- |
| `apps/runtime/src/services/session-cleanup-job.ts`  | Idle/max-age cleanup and timeout terminalization          |
| `apps/runtime/src/services/agent-transfer/index.ts` | Transfer store boot and adapter wrapper wiring            |
| `packages/pipeline-engine/src/pipeline/server.ts`   | Consumes `abl.session.ended` for end-of-session pipelines |

### Tests

| File                                                                           | Type        | Coverage Focus                                              |
| ------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------- |
| `apps/runtime/src/__tests__/sessions/session-routes.test.ts`                   | integration | Explicit runtime close and bulk-close                       |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`                   | integration | SDK `end_session` and disconnect overrides                  |
| `packages/agent-transfer/src/__tests__/e2e/kore-e2e.test.ts`                   | e2e         | Transfer TTL defaults and provider-driven session lifecycle |
| `packages/agent-transfer/src/__tests__/unit/disposition-handler.test.ts`       | unit        | Transfer disposition metadata helper behavior               |
| `packages/pipeline-engine/src/__tests__/integration-trigger-execution.test.ts` | integration | Existing `session.ended` pipeline trigger behavior          |

---

## 11. Configuration

### Environment Variables

| Variable                               | Default     | Description                                            |
| -------------------------------------- | ----------- | ------------------------------------------------------ |
| `SESSION_TTL_MINUTES`                  | `1440`      | Base Redis hot-store TTL for session data              |
| `CHANNEL_VOICE_DEFAULT_DISPOSITION`    | `abandoned` | Voice disconnect default disposition                   |
| `CHANNEL_VOICE_DISCONNECT_BEHAVIOR`    | `end`       | Voice disconnect behavior                              |
| `CHANNEL_WEB_CHAT_DEFAULT_DISPOSITION` | `abandoned` | Web chat disconnect default disposition                |
| `CHANNEL_WEB_CHAT_DISCONNECT_BEHAVIOR` | `detach`    | Web chat disconnect behavior                           |
| `CHANNEL_API_DEFAULT_DISPOSITION`      | `completed` | API channel disconnect default disposition             |
| `CHANNEL_API_DISCONNECT_BEHAVIOR`      | `end`       | API channel disconnect behavior                        |
| `AGENT_TRANSFER_ENABLED`               | `false`     | Enables the agent-transfer subsystem                   |
| `EVENT_KAFKA_ENABLED`                  | `false`     | Enables the runtime event bus -> Kafka emission bridge |

### Runtime Configuration

- Tenant defaults currently live in `TenantConfigService.security` (`sessionIdleSeconds`, `sessionMaxAgeSeconds`, `sessionRetentionDays`).
- Channel disconnect defaults currently live in runtime `channelLifecycle`.
- The streamlined design adds a project-scoped `sessionLifecycle` settings surface backed by `ProjectSettings`, with compatibility read/write behavior for transfer TTLs during rollout.
- End-hook configuration is resolved as part of lifecycle policy and is not a separate eventing or pipeline subsystem.
- Only project-level and channel-level end-hook configuration are supported; agent definitions do not carry end-hook overrides.

### DSL / Agent IR / Schema

- Current compiler behavior: `execution.session_idle_timeout` compiles into `execution.timeouts.session_timeout_ms`.
- Target behavior: compiler normalizes lifecycle overrides into a richer `execution.sessionLifecycle` IR object while keeping the legacy timeout field as a compatibility alias.
- Target agent override surface includes timeout and disconnect behavior only.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every project-scoped lifecycle read/write must include `projectId`, and cross-project access must return 404.              |
| Tenant isolation  | Every lifecycle resolution path must remain tenant-scoped through `tenantId` in queries, config lookups, and session keys. |
| User isolation    | Session close and inspection routes must continue to apply session ownership checks for non-admin users.                   |

### Security & Compliance

- Only trusted server-side callers may apply explicit session overrides such as SDK `end_session`, admin close, or provider end.
- Lifecycle settings routes must remain behind auth middleware and project-scoped RBAC.
- Only project admins may modify project or channel end-hook configuration.
- Disposition metadata write paths must not leak cross-tenant or cross-project session existence.

### Performance & Scalability

- Effective lifecycle resolution should be cached per `(tenantId, projectId, channel, agent)` tuple with bounded TTL to avoid repeated config/IR lookups on every turn.
- Introducing a shared resolver and terminalization service must not add more than low-single-digit milliseconds to session create, close, or disconnect paths.
- Emitting `session.ended` must stay asynchronous from the caller point of view once terminal state is persisted.

### Reliability & Failure Modes

- If project settings are missing or invalid, runtime must fail closed to tenant defaults rather than silently using partially merged policy.
- If a terminal path is invoked more than once, the system must preserve one terminal outcome and avoid duplicate terminal side effects.
- Event emission must happen before end-hook execution is attempted.
- Hook failures must be recorded, but they must not roll back terminal state or suppress downstream pipeline triggers.

### Observability

- Every timeout/disconnect/end path should emit the resolved policy source, normalized disposition, terminal source, and hook outcome to traces/logs.
- The effective-policy route should help operators debug why a session used a given timeout, disconnect behavior, or end hook.

### Data Lifecycle

- Hot-store TTL and cleanup terminalization must stop being conflated; Redis expiry is storage lifecycle, while normalized disposition is conversation lifecycle.
- Transfer-session TTL defaults and runtime session cleanup policy must stay aligned at the project level.
- Billing data lifecycle remains outside this feature and should consume emitted lifecycle telemetry downstream.

---

## 13. Delivery Plan / Work Breakdown

1. Establish a shared lifecycle policy and terminalization model
   1.1 Introduce shared types for timeout, disconnect behavior, end hooks, and normalized disposition.
   1.2 Add project-scoped lifecycle persistence to `ProjectSettings`.
   1.3 Add effective-policy inspection for debugging and tests.
2. Introduce guaranteed end-event emission
   2.1 Route runtime close, cleanup, disconnect, and SDK end through one terminalization service.
   2.2 Widen the `session.ended` contract to carry canonical disposition/status/source fields while preserving compatibility.
   2.3 Emit terminal events through the existing runtime event bus so pipeline-engine subscribers continue to work unchanged.
3. Add end-hook behavior on top of terminalization
   3.1 Resolve end-hook policy from project default plus channel override.
   3.2 Support `ignore` and `respond` runtime hook modes.
   3.3 Keep end hooks fail-open and observable.
4. Route non-user-facing automation through pipelines
   4.1 Keep API calls, functions, and webhook actions out of runtime lifecycle hook config.
   4.2 Use existing `session.ended` pipeline triggers for post-session automation.
   4.3 Document that hook behavior is user-facing only.
5. Wire agent-transfer lifecycle end-to-end
   5.1 Pass resolved TTLs into transfer-session create and extend flows.
   5.2 Extend transfer-session end flow to accept structured reason/metadata.
   5.3 Route transfer-driven conversation termination through the shared terminalization service.
6. Migrate Studio and compatibility surfaces
   6.1 Add Studio proxy and settings UI for project-scoped lifecycle policy.
   6.2 Keep existing settings/end routes as compatibility shims until callers migrate.
   6.3 Refresh feature docs, testing guides, and operator-facing descriptions.

---

## 14. Success Metrics

| Metric                                      | Baseline                               | Target                                                                     | How Measured                                |
| ------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Runtime terminal paths using shared service | Split across multiple helpers          | 100% of close, cleanup, disconnect, SDK end, and transfer-driven end paths | Code inventory + integration tests          |
| Terminal end-event coverage                 | Partial and path-dependent             | Every successful terminalization emits one canonical `session.ended` event | Integration tests + event trace inspection  |
| Project timeout override enforcement        | Not reliably enforced                  | Enforced for runtime and transfer sessions                                 | E2E precedence tests                        |
| Transfer TTL source-of-truth drift          | Hardcoded defaults can win             | 0 live paths use fallback defaults when project policy exists              | Integration tests + observability           |
| Hook isolation from terminalization         | Not formalized                         | Hook failure never suppresses persisted end state or event emission        | Integration tests                           |
| Billing coupling                            | Session docs contain unused field only | 0 direct billing writes from terminalization paths                         | Code review + automated regression coverage |

---

## 15. Open Questions

1. Should legacy `agentTransfer.session.ttl` remain writable long-term, or become a read-only compatibility projection once the new lifecycle route is live?

---

## 16. Gaps, Known Issues & Limitations

- Project runtime config does not currently expose timeout, channel disconnect, or end-hook controls.
- Agent IR timeout fields compile today, but runtime session creation does not enforce them.
- `session.ended` is emitted in `MongoConversationStore.endSession()`, but not every terminal path is forced through one shared emission path.
- Current runtime and EventStore `session.ended` schemas are narrower than the full lifecycle disposition model.
- Agent-transfer settings persist TTLs in MongoDB, but live transfer-session expiry still falls back to store defaults when no explicit TTL is passed.
- Transfer `DispositionHandler` exists as a package primitive but is not constructed or invoked by runtime code.
- Session documents contain a `billingPeriod` field, but that field is not an authoritative billing mechanism and should not be used as one in this feature.

---

## 17. Testing & Validation

- Create and maintain the matching test guide in [docs/testing/sub-features/session-timeout-disposition-unification.md](../../testing/sub-features/session-timeout-disposition-unification.md).
- Require unit coverage for precedence resolution, end-event contract normalization, and end-hook execution semantics.
- Require integration coverage for runtime close/disconnect/cleanup flows, guaranteed end-event emission, transfer-session TTL injection, and hook failure handling.
- Require E2E coverage for project override enforcement, agent override enforcement for timeout/disconnect only, SDK explicit end, end-hook behavior, and transfer-session metadata capture.
- Add explicit regression coverage proving that terminalization does not write billing ledgers, billing line items, replay/materialization artifacts, or retired legacy usage-period data directly.
