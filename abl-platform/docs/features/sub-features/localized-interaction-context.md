# Feature: Localized Interaction Context

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Channels](../channels.md) / [NLU / Intent Classification & Entity Extraction](../nlu.md)
**Status**: PLANNED
**Feature Area(s)**: `customer experience`, `integrations`, `agent lifecycle`, `governance`
**Package(s)**: `apps/runtime`, `packages/compiler`, `packages/i18n`, `packages/a2a`, `packages/shared-kernel`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/localized-interaction-context.md](../../testing/sub-features/localized-interaction-context.md)
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

The runtime currently has no single contract for user language, locale, and timezone across inbound interactions. Different surfaces can carry pieces of this information, but they stop at different layers:

- REST chat accepts generic `metadata`, not a first-class interaction-context contract.
- A2A and the WebSocket SDK preserve message metadata, but execution does not treat `messageMetadata.locale` or `messageMetadata.language` as authoritative.
- channel adapters can expose native hints such as Teams `locale` or AudioCodes `language`, but those hints are not normalized into one shared runtime shape. In Teams, `activity.locale` is received per message and then dropped during normalization instead of being preserved as canonical turn context.
- execution paths already disagree on which key means "language context": flow extraction reads `_locale`, while behavior-profile evaluation reads `session.data.values.language`. Those are different keys with different semantics, and neither is a reliable per-turn contract today.
- date parsing is inconsistent even inside runtime execution: flow extraction passes locale into date extraction, while `normalizeDate()` calls `extractDatesFromText(value)` with no locale and silently falls back to English.
- relative-date helpers still anchor on process time and include a misleading `toISODate()` helper comment that claims UTC-safe extraction while using host-local getters, so phrases like "a week from tomorrow" or "tomorrow" can still depend on server context instead of the user's local context.
- `SessionMetadata.clientInfo.locale` and `SessionMetadata.clientInfo.timezone` already exist in the type system, but runtime ingress and execution do not populate or consume them, leaving a dead competing shape for localization data.

This fragmentation causes three user-visible failures:

1. **Per-message language switching is unreliable**. A user can switch from English to Spanish mid-session, but execution paths do not consistently re-resolve language at message scope.
2. **Relative dates are not user-local**. Date parsing uses the process clock, not a user timezone, so "today", "tomorrow", and similar phrases can be wrong near day boundaries.
3. **Channel behavior drifts**. One channel may pass locale or language hints that never reach prompts, extractors, or date parsing, while another channel behaves differently for the same user.

### Goal Statement

Provide one canonical per-turn interaction-context contract that resolves `language`, `locale`, and `timezone` from every inbound interaction, persists the resolved values in a canonical session namespace, and makes all downstream runtime consumers use that context instead of raw `_locale`, `session.data.values.language`, dead `ClientInfo` localization fields, generic metadata, or server-local time.

### Summary

Localized Interaction Context is the execution-time feature that normalizes user language and local time semantics across REST, A2A, WebSocket SDK, webhook channels, and voice surfaces. It introduces a canonical `InteractionContext` that is resolved once per turn from explicit message inputs, session state, contact preferences, channel-native hints, and safe defaults.

The feature intentionally separates:

- **current-turn context**: what should apply to this specific user message
- **session preference**: the best longer-lived preference to reuse next turn
- **contact preference fallback**: previously stored user preference data that can seed a session without overriding an explicit message-level switch

The runtime then uses this one resolved contract for:

- prompt context (`language`, `locale`, `timezone`, user-local date/time)
- entity extraction and observation pipelines
- relative date parsing and normalization
- behavior-profile language routing
- cross-channel continuity when the same user moves between channels

### Key Capabilities

- Canonical `InteractionContext` contract in `packages/shared-kernel` with explicit provenance
- Resolver precedence that keeps explicit message-level overrides authoritative
- Message-level language switching without forcing a new session
- Timezone-aware relative date parsing anchored to the user's local time
- Deterministic date-only normalization that does not depend on host-local getters or hidden `new Date()` defaults
- Channel-native locale/language hint normalization for Teams, AudioCodes, SDK, A2A, and generic webhook flows
- Backward-compatible migration away from raw `_locale` reads and the unscoped `session.data.values.language` profile-evaluation path
- Explicit migration/deprecation path for `SessionMetadata.clientInfo.locale` and `SessionMetadata.clientInfo.timezone`

---

## 2. Scope

### Goals

- Define one canonical `InteractionContext` contract with `language`, `locale`, `timezone`, `source`, and `confidence`, and place the pure-data type in `packages/shared-kernel`.
- Resolve that contract on every inbound turn across REST chat, A2A, WebSocket SDK, and normalized channel ingress.
- Persist the resolved context in a canonical session namespace while preserving compatibility aliases during migration.
- Reconcile the existing `_locale` extraction path and `session.data.values.language` behavior-profile path so execution has one canonical source of truth.
- Decide and document how `SessionMetadata.clientInfo.locale` and `SessionMetadata.clientInfo.timezone` migrate into the canonical contract instead of leaving a parallel dead shape.
- Make prompt-building, entity extraction, date normalization, and behavior-profile resolution use the resolved context instead of raw `_locale`, `session.data.values.language`, `ClientInfo`, or process-local time.
- Support message-level language changes and explicit locale/timezone overrides without forcing session recreation.
- Normalize channel-native hints (for example Teams `locale`, AudioCodes `language`) into the same execution contract and stop discarding them during adapter normalization.
- Add deterministic testing for locale-aware parsing, timezone-aware relative dates, and ingress precedence.

### Non-Goals (Out of Scope)

- Full translation/localization of all system prompts, agent auth flows, or Studio UI copy.
- Inferring timezone from locale alone, IP geolocation, or browser heuristics without an explicit product decision.
- Replacing channel-specific STT/TTS language configuration with this contract; those settings remain channel/provider-specific.
- Solving region-specific business logic such as local holidays, fiscal calendars, or country-specific compliance flows.
- Reworking all formatting utilities in the platform to consume locale immediately; the first slice is runtime execution focused.

---

## 3. User Stories

1. As an **end user**, I want to switch languages mid-conversation so the assistant responds and extracts values using the language I am using right now, not the language from the first turn.
2. As a **travel user**, I want phrases like "a week from tomorrow" or "next Monday" interpreted in my timezone so booking dates do not drift around midnight or across channels.
3. As a **channel integrator**, I want channel-native locale/language hints to be normalized once so Teams, SDK, A2A, and voice channels behave consistently.
4. As a **platform engineer**, I want one interaction-context resolver instead of ad hoc metadata reads so new channels and execution paths do not each invent their own localization behavior.

---

## 4. Functional Requirements

1. **FR-1**: The system must define a canonical `InteractionContext` contract with `language`, `locale`, `timezone`, `source`, `confidence`, and `resolvedAt`, and the pure-data type must live in `packages/shared-kernel`.
2. **FR-2**: The system must resolve `InteractionContext` on every inbound turn for REST chat, A2A, WebSocket SDK, and normalized channel/webhook ingress before execution begins.
3. **FR-3**: The resolver must apply a stable precedence order: explicit per-message context, existing session preference, contact preferences, channel-native hints, project/agent defaults, then safe fallback.
4. **FR-4**: The runtime must persist the resolved turn context in a canonical session namespace, provide compatibility aliases for existing `_locale` / `_language` / `_timezone` consumers during migration, and explicitly retire direct behavior-profile reads from `session.data.values.language` instead of creating a second long-lived canonical key.
5. **FR-5**: Explicit message-level `language`, `locale`, or `timezone` must override previously persisted session preferences for the current turn.
6. **FR-6**: The system must support message-level language switching without requiring a new session, and must distinguish current-turn context from longer-lived session preference.
7. **FR-7**: Prompt construction, entity extraction, validation, behavior-profile evaluation, and profile language routing must use the resolved interaction context instead of reading raw `_locale`, `session.data.values.language`, `SessionMetadata.clientInfo`, or generic message metadata directly.
8. **FR-8**: Relative date extraction and normalization must accept locale plus a user-local reference instant derived from the resolved timezone instead of using server-local `new Date()`, and date-only formatting helpers must be made host-timezone-safe instead of relying on misleading local-getter behavior.
9. **FR-9**: Channel adapters and protocol bridges that already expose native localization hints must map those hints into the shared interaction-context resolver instead of leaving them as channel-specific metadata or discarding them during normalization.
10. **FR-10**: The codebase must provide regression coverage for ingress precedence, explicit message-level language switching, timezone-aware relative dates, `normalizeDate()` locale propagation, host-timezone-safe date formatting, Teams locale retention, and compatibility with legacy metadata paths.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                          |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Project- or deployment-level defaults may seed the resolver, but the feature is runtime-first  |
| Agent lifecycle            | PRIMARY      | Prompts, gather extraction, and behavior profiles all consume the resolved interaction context |
| Customer experience        | PRIMARY      | Users directly experience language continuity and correct local-date interpretation            |
| Integrations / channels    | PRIMARY      | Every inbound surface needs the same normalization behavior                                    |
| Observability / tracing    | SECONDARY    | Resolved context and fallback paths should emit traceable decisions                            |
| Governance / controls      | SECONDARY    | Validation and sanitization are required to avoid leaking or misusing metadata                 |
| Enterprise / compliance    | SECONDARY    | Wrong timezone/language handling can create misleading audit trails and support incidents      |
| Admin / operator workflows | NONE         | No new admin-only UI is required for the first slice                                           |

### Related Feature Integration Matrix

| Related Feature                                                        | Relationship Type | Why It Matters                                                                                            | Key Touchpoints                                                              | Current State |
| ---------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------- |
| [Channels](../channels.md)                                             | belongs to        | Channel ingress is where most localization hints first appear                                             | `NormalizedIncomingMessage.metadata`, channel adapters, session factory      | Active        |
| [SDK](../sdk.md)                                                       | shares data with  | SDK chat already carries per-message metadata and session bootstrap attributes                            | `message.metadata`, `customAttributes`, `/api/v1/sdk/init`, `/ws/sdk`        | Active        |
| [A2A Integration](../a2a-integration.md)                               | shares data with  | A2A already forwards `messageMetadata`, but runtime does not yet consume it as interaction context        | A2A request context, `agent-executor-adapter.ts`, runtime execution options  | Active        |
| [NLU](../nlu.md)                                                       | extends           | Entity extraction, intent-side language hints, and profile routing depend on resolved language/locale     | reasoning executor, flow executor, prompt builder                            | Active        |
| [Entity Extraction & Semantic Entities](../entity-extraction.md)       | shares data with  | Date parsing and semantic extraction need user-local reference time and locale                            | `extractDatesFromText()`, extraction validation, JS extraction path          | ALPHA         |
| [Memory & Sessions](../memory-sessions.md)                             | shares data with  | Session state needs a canonical home for current-turn and preference-level interaction context            | `session.data.values.session`, session bootstrap, contact preference preload | Active        |
| [Omnichannel Session Continuity](../omnichannel-session-continuity.md) | shares data with  | Cross-channel continuity is stronger when language and timezone move with the user instead of the channel | contact preferences, session linking, channel transitions                    | ALPHA         |

---

## 6. Design Considerations (Optional)

- **Current-turn context vs session preference**: the runtime should never conflate "what applies to this message" with "what should probably apply next turn".
- **Explicit beats inferred**: explicit message-level `language`, `locale`, or `timezone` always wins over stored defaults or inferred signals.
- **Timezone is not locale**: locale may influence parsing or formatting, but timezone must remain an explicit field with IANA semantics.
- **Fail-soft behavior**: invalid or missing localization data should degrade to safe fallback behavior, not block execution for common message flows.
- **Compatibility-first migration**: existing `_locale` readers should continue to function during rollout, but new code must read the canonical session interaction namespace.
- **One canonical contract, no competing shapes**: `SessionMetadata.clientInfo.locale/timezone` may be read as a legacy input during migration, but `InteractionContext` is the only authoritative execution contract.

---

## 7. Technical Considerations (Optional)

- `packages/shared-kernel/src/types/index.ts` is the preferred home for the canonical `InteractionContext` contract because runtime, A2A, and compiler-adjacent consumers already depend on it and it stays free of compiler-specific concerns.
- `apps/runtime/src/services/identity/sdk-message-metadata.ts` currently validates generic JSON metadata, not a dedicated interaction-context contract.
- `apps/runtime/src/services/runtime-executor.ts` already has a canonical `session` namespace for agent-facing state and is the right place to persist resolved interaction context.
- `apps/runtime/src/services/execution/flow-step-executor.ts` currently reads `_locale` for JS extraction and entity prompt language, while `apps/runtime/src/services/execution/reasoning-executor.ts` still reads `session.data.values.language` for behavior-profile re-evaluation.
- `packages/compiler/src/platform/core/types.ts` already defines `ClientInfo.locale` and `ClientInfo.timezone`, but runtime execution does not use those fields today, so the design must either subsume or explicitly deprecate them instead of leaving them parallel to `InteractionContext`.
- `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts` already preloads contact preferences into `callerContext.contactPreferences`, which is a viable fallback input for the resolver.
- `apps/runtime/src/services/execution/extraction-validation.ts` currently calls `extractDatesFromText(value)` without locale, so date normalization already diverges from the flow executor for the same input string.
- `packages/compiler/src/platform/utils/date-extraction.ts` currently anchors relative parsing on `new Date()`, and its `toISODate()` helper comment claims UTC-safe extraction while using host-local getters, so timezone-aware relative dates require a contract change there.
- `apps/runtime/src/channels/adapters/msteams-adapter.ts` receives `activity.locale` on inbound messages but never forwards it into normalized channel state.
- `packages/compiler/src/platform/nlu/language.ts` includes a session language cache optimized for stable language, so message-level switching needs a more granular policy.

---

## 8. How to Consume

### Studio UI

No new primary Studio UI surface is required for the first slice. Builders and integrators interact with this feature indirectly by supplying richer per-message context through SDK, channel, or protocol clients, and by relying on correct runtime behavior.

### Surface Semantics Matrix

| Asset / Entity Type              | Source of Truth / Ownership                           | Design-Time Surface(s)                    | Editable or Read-Only? | Consumer Reference / Binding Model                                       | Runtime Materialization / Resolution                               | Notes / Unsupported State                                     |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Per-message interaction context  | Inbound message payload                               | SDK client, REST caller, A2A caller       | Editable               | Explicit `interactionContext` or canonical metadata field on the message | Highest-precedence input to the turn resolver                      | Current code accepts generic metadata, not a dedicated schema |
| Session interaction preference   | Runtime session namespace                             | None directly                             | Runtime-managed        | `session.interaction.preference`                                         | Used as fallback when the message does not specify explicit values | Current code uses ad hoc `_locale` instead                    |
| Contact preference fallback      | Contact context / caller context preference preload   | Contact management, verification/linking  | Editable elsewhere     | `callerContext.contactPreferences`                                       | Seeds initial session preference or fills missing values           | Not all channels reach this path today                        |
| Channel-native localization hint | Channel adapter payloads and provider-specific fields | Channel/provider config and request shape | Mixed                  | Teams `locale`, AudioCodes `language`, other adapter metadata            | Normalized into the same resolver input contract                   | Current code leaves these hints channel-specific              |

### Design-Time vs Runtime Behavior

This feature is mostly runtime behavior. Design-time or stored configuration may provide defaults or historical preferences, but the authoritative execution behavior is determined per turn. The runtime should:

1. collect explicit and inferred hints from the current inbound message,
2. resolve one canonical `InteractionContext`,
3. store the result under `session.interaction.current`,
4. optionally update `session.interaction.preference` based on explicit or high-confidence signals, and
5. pass the resolved values to prompts, extraction, and date parsing.

### API (Runtime)

This feature enhances existing inbound surfaces rather than adding brand-new public APIs.

| Method / Transport | Path / Surface                      | Purpose                                                                 |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------- |
| POST               | `/api/v1/chat/agent`                | Accept explicit interaction context for direct chat execution           |
| POST               | `/a2a/:connectionId`                | Normalize A2A message metadata into the same interaction-context path   |
| WebSocket          | `/ws/sdk`                           | Preserve per-message interaction context during SDK message execution   |
| POST               | `/api/v1/channels/:channelType/...` | Normalize channel-native locale/language hints for webhook ingress      |
| POST               | `/api/v1/channels/audiocodes/...`   | Normalize voice-channel language hints into canonical interaction state |

### API (Studio)

N/A for the first slice. Studio does not need a dedicated proxy route unless a future UI exposes project-level defaults or debugging surfaces.

### Admin Portal

N/A for the first slice.

### Channel / SDK / Voice / A2A / MCP Integration

- **REST chat** should accept explicit interaction context instead of forcing callers to overload generic metadata.
- **WebSocket SDK** should treat message-level interaction context as current-turn authoritative while preserving existing metadata validation limits.
- **A2A** should map `message.metadata.messageMetadata` or a future explicit field into the same resolver path.
- **Webhook/channel ingress** should convert provider-native hints into the canonical interaction-context contract before session creation.
- **Voice** should normalize channel-level language hints without assuming they are stable forever; typed follow-ups must still be able to switch the current-turn language.
- **MCP/tool execution** is not a primary ingress path for this feature, but tools that read `session` should be able to consume the canonical resolved interaction context.

---

## 9. Data Model

### Collections / Tables

No new top-level database collection is required for the first slice. The feature primarily uses:

- existing runtime session state (`session.data.values.session`)
- existing message metadata forwarding
- existing contact preference preload (`callerContext.contactPreferences`)

### Canonical Runtime Shape

`InteractionContext` should be defined in `packages/shared-kernel/src/types/index.ts` and then imported by runtime/compiler consumers, while `SessionMetadata.clientInfo.locale/timezone` becomes a compatibility input only.

```text
InteractionContext
  - language: string | null
  - locale: string | null
  - timezone: string | null
  - source: 'message' | 'session' | 'contact' | 'channel' | 'project' | 'agent' | 'default'
  - confidence: 'explicit' | 'high' | 'medium' | 'low'
  - resolvedAt: string (ISO 8601)

SessionInteractionState
  - current: InteractionContext
  - preference: {
      language?: string
      locale?: string
      timezone?: string
      source: string
      updatedAt: string
    }
```

### Compatibility Aliases

```text
session.data.values._locale
session.data.values._language
session.data.values._timezone
```

These aliases remain migration aids only. New execution code should treat `session.interaction.current` as the source of truth.

`session.data.values.language` is not promoted to a new compatibility alias. It is a legacy consumer path that should be migrated off the generic key because the unscoped name can collide with user/entity data.

### Key Relationships

- explicit inbound interaction context feeds the resolver
- contact preferences can seed session preference but do not override explicit message values
- channel-native localization hints become normalized resolver inputs
- prompt building, extraction, and date parsing all consume the same resolved context

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                           | Purpose                                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/runtime-executor.ts`                | Canonical session namespace and turn-scoped metadata application                                                  |
| `apps/runtime/src/services/execution/prompt-builder.ts`        | Main system-prompt context that needs user-local date/time and interaction fields                                 |
| `apps/runtime/src/services/execution/flow-step-executor.ts`    | Flow-path extraction and entity prompt wiring that currently reads `_locale`                                      |
| `apps/runtime/src/services/execution/reasoning-executor.ts`    | Reasoning-path entity extraction and profile re-resolution, including legacy `session.data.values.language` reads |
| `apps/runtime/src/services/execution/profile-resolver.ts`      | Behavior-profile language routing that consumes session-level language metadata                                   |
| `apps/runtime/src/services/execution/extraction-validation.ts` | Shared date normalization and extracted-value validation                                                          |
| `packages/compiler/src/platform/utils/date-extraction.ts`      | Locale-aware date extraction that must stop anchoring on process-local `new Date()`                               |
| `packages/shared-kernel/src/types/index.ts`                    | Canonical home for `InteractionContext` and migration-safe shared type exports                                    |
| `packages/compiler/src/platform/core/types.ts`                 | Legacy `ClientInfo.locale` and `ClientInfo.timezone` shape to subsume or deprecate                                |
| `packages/i18n/src/resolve-locale.ts`                          | Existing locale negotiation helper                                                                                |
| `packages/compiler/src/platform/nlu/language.ts`               | Existing language detection and session cache behavior                                                            |

### Routes / Handlers

| File                                                        | Purpose                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/runtime/src/routes/chat.ts`                           | REST chat ingress and schema validation                              |
| `apps/runtime/src/server.ts`                                | A2A execution option mapping                                         |
| `apps/runtime/src/websocket/sdk-handler.ts`                 | WebSocket SDK message handling and queued-message replay             |
| `packages/a2a/src/infrastructure/agent-executor-adapter.ts` | A2A metadata extraction                                              |
| `apps/runtime/src/channels/adapters/msteams-adapter.ts`     | Teams adapter that currently receives `activity.locale` but drops it |
| `apps/runtime/src/channels/session-resolver.ts`             | Channel metadata extraction and persistence stripping                |
| `apps/runtime/src/channels/pipeline/session-factory.ts`     | Channel pipeline session creation seam                               |

### UI Components

| File | Purpose                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| N/A  | The first slice is runtime-focused and does not require a dedicated UI component. |

### Jobs / Workers / Background Processes

| File                                 | Purpose                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `apps/runtime/src/channels/types.ts` | Normalized channel message contract used by async worker flows |

### Tests

| File                                                                                                 | Type        | Coverage Focus                                                           |
| ---------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/auth/sdk-message-metadata.test.ts`                                       | unit        | Current metadata validation baseline                                     |
| `apps/runtime/src/__tests__/channels/session-metadata-stripping.test.ts`                             | unit        | Channel metadata persistence boundaries                                  |
| `apps/runtime/src/__tests__/execution/session-metadata-dedup.test.ts`                                | unit        | Message metadata affects dedup identity                                  |
| `apps/runtime/src/__tests__/execution/contexts/orchestration/initialize-session-prepopulate.test.ts` | unit        | Contact preference preload into caller context                           |
| `packages/a2a/src/__tests__/session-metadata-extraction.test.ts`                                     | unit        | A2A metadata forwarding baseline                                         |
| `packages/compiler/src/__tests__/utils/date-extraction.test.ts`                                      | unit        | Locale-aware date parsing baseline                                       |
| `packages/i18n/src/__tests__/resolve-locale.test.ts`                                                 | unit        | Accept-Language parsing and locale fallback                              |
| `apps/runtime/src/__tests__/extract-with-js-libs.test.ts`                                            | unit        | Locale-dependent JS extraction baseline                                  |
| `apps/runtime/src/__tests__/extraction/extraction-pipeline.test.ts`                                  | integration | Existing locale-aware extraction coverage without canonical turn context |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                                   |
| -------- | ------- | ------------------------------------------------------------- |
| N/A      | N/A     | The first slice should not require new environment variables. |

### Runtime Configuration

No dedicated project runtime config key exists today for this capability. The first slice should rely on explicit inbound context, existing contact preferences, and existing agent defaults. If rollout controls are needed, they should be implemented as internal feature gating rather than a new public configuration surface.

### DSL / Agent IR / Schema

Existing related shapes:

```text
AgentIdentity.language
ClientInfo.locale
ClientInfo.timezone
messageMetadata (generic JSON today)
session.data.values.language (legacy behavior-profile input)
```

Planned execution contract:

```json
{
  "interactionContext": {
    "language": "es",
    "locale": "es-MX",
    "timezone": "America/Mexico_City"
  }
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Project isolation | Interaction context must remain attached to the resolved project/session boundary and never widen scope.        |
| Tenant isolation  | Contact preference fallback and session persistence must stay tenant-scoped; cross-tenant fallbacks return 404. |
| User isolation    | User- or contact-specific preferences must never leak across unrelated users in the same tenant or project.     |

### Security & Compliance

- Validate BCP-47 locale strings and IANA timezone strings before accepting explicit context.
- Do not infer timezone from IP address or locale alone in the first slice.
- Treat interaction context as low-sensitivity metadata, but keep user-visible error messages sanitized.
- Keep existing auth and project-scope middleware unchanged; this feature must not create a bypass around ingress validation.

### Performance & Scalability

- Resolver work should be in-memory and sub-millisecond for the common case.
- Language detection should remain bounded and optional; explicit values and stored preferences should short-circuit expensive inference.
- Prompt injection should add a small, bounded set of interaction fields rather than serializing raw metadata blobs.

### Reliability & Failure Modes

- Missing context should degrade to safe fallback behavior rather than fail the turn.
- Invalid explicit context should produce a clear boundary error for direct APIs and a recoverable error event for WebSocket flows.
- Date parsing failure should not corrupt stored session preferences.

### Observability

- Add trace/log coverage for resolver decisions, fallback source, and invalid explicit inputs.
- Keep current error-reporting surfaces sanitized so internal model IDs or tenant data do not leak in user-visible messages.

### Data Lifecycle

- Current-turn interaction context is ephemeral session state and should not create a new persisted collection.
- Session preference may be durable only as long as the session persists.
- Contact preference storage and deletion continue to follow the existing contact-context lifecycle.

---

## 13. Delivery Plan / Work Breakdown

1. Define and normalize the interaction-context contract
   1.1 Add a shared-kernel `InteractionContext` contract and a shared runtime resolver for `language`, `locale`, `timezone`, `source`, and `confidence`
   1.2 Add explicit ingress normalization for REST chat, A2A, WebSocket SDK, and channel session creation
   1.3 Preserve compatibility aliases while migrating consumers away from `_locale`
   1.4 Decide and implement the migration path for `SessionMetadata.clientInfo.locale/timezone` as legacy compatibility input rather than a competing canonical shape
2. Move execution onto the canonical context
   2.1 Update prompt-building, reasoning, flow execution, and profile re-resolution to consume canonical context
   2.2 Reconcile the `_locale` extraction path and `session.data.values.language` profile path without introducing a second generic-language alias
   2.3 Introduce current-turn versus session-preference update policy for language switching
   2.4 Add trace/log instrumentation for resolver behavior
3. Make relative dates user-local
   3.1 Extend date extraction and normalization helpers to accept a user-local reference instant
   3.2 Update extractor call sites and validation helpers to pass the resolved timezone and locale, including `normalizeDate()`
   3.3 Fix host-timezone-sensitive date-only formatting behavior such as `toISODate()` so helper behavior matches the documented contract
   3.4 Add deterministic coverage for midnight-boundary and "a week from tomorrow" cases
4. Harden channel and protocol behavior
   4.1 Normalize Teams, AudioCodes, SDK, and A2A localization hints into the shared resolver path
   4.2 Stop discarding Teams `activity.locale` during adapter normalization
   4.3 Verify dedup, queued-message replay, and contact-preference fallbacks behave correctly
   4.4 Add E2E coverage for REST, SDK, A2A, and channel ingress scenarios

---

## 14. Success Metrics

| Metric                                                               | Baseline                 | Target                                | How Measured                            |
| -------------------------------------------------------------------- | ------------------------ | ------------------------------------- | --------------------------------------- |
| Relative-date clarification prompts caused by missing "today" anchor | Frequent manual fallback | Near-zero for explicit-timezone turns | Runtime traces and support issue review |
| Turns with resolved canonical interaction context                    | 0%                       | >95% of eligible inbound turns        | Resolver trace events / metrics         |
| Message-level language-switch correctness                            | Not guaranteed           | Deterministic in test matrix          | E2E and integration pass rate           |
| Timezone-related date parsing defects                                | Known gaps               | 0 open P1 bugs after rollout          | Bug tracker + regression suite          |

---

## 15. Open Questions

1. Should the public REST and A2A contracts expose top-level `interactionContext`, or should the first slice standardize on `messageMetadata.interactionContext` for compatibility?
2. What confidence threshold should be required before an inferred language switch updates `session.interaction.preference`?
3. What removal window should apply to legacy `SessionMetadata.clientInfo.locale/timezone` compatibility reads after canonical `InteractionContext` ships?
4. Should project-level default locale/timezone be added later, or is contact/session fallback sufficient for the first release?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                        | Severity | Status |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Runtime execution reads both `_locale` and `session.data.values.language` in different execution paths instead of using one canonical turn context | High     | Open   |
| GAP-002 | Date extraction and normalization still anchor relative dates on process-local `new Date()`                                                        | High     | Open   |
| GAP-003 | `normalizeDate()` ignores locale and can parse the same text differently from the flow-extraction path                                             | High     | Open   |
| GAP-004 | Teams receives `activity.locale` on every message but discards it during adapter normalization                                                     | Medium   | Open   |
| GAP-005 | `ClientInfo.locale` and `ClientInfo.timezone` exist in core types but are not wired into runtime execution                                         | Medium   | Open   |
| GAP-006 | `toISODate()` claims UTC-safe extraction while using host-local getters                                                                            | Medium   | Open   |
| GAP-007 | Existing language cache behavior assumes stable session language and can fight message-level switching                                             | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                 | Coverage Type | Status     | Test File / Note                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------- | ------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Generic SDK metadata validation accepts locale-like payloads                                             | unit          | PASS       | `apps/runtime/src/__tests__/auth/sdk-message-metadata.test.ts`                                       |
| 2   | A2A metadata extraction preserves message metadata boundaries                                            | unit          | PASS       | `packages/a2a/src/__tests__/session-metadata-extraction.test.ts`                                     |
| 3   | Contact preference preload reaches caller context                                                        | unit          | PASS       | `apps/runtime/src/__tests__/execution/contexts/orchestration/initialize-session-prepopulate.test.ts` |
| 4   | Locale-aware date extraction baseline works for supported locales                                        | unit          | PASS       | `packages/compiler/src/__tests__/utils/date-extraction.test.ts`                                      |
| 5   | Canonical interaction-context precedence resolver                                                        | integration   | NOT TESTED | New planned runtime integration coverage                                                             |
| 6   | `_locale` extraction and `session.data.values.language` profile routing converge on one canonical source | integration   | NOT TESTED | New planned execution-state regression coverage                                                      |
| 7   | Message-level language switching in one session                                                          | e2e           | NOT TESTED | New planned REST and SDK E2E coverage                                                                |
| 8   | Timezone-aware relative date parsing and locale-aware normalization                                      | integration   | NOT TESTED | New date extraction + validation regression coverage                                                 |
| 9   | Host-timezone-safe date-only formatting                                                                  | unit          | NOT TESTED | New `toISODate()` contract coverage                                                                  |
| 10  | Channel-native locale/language hint normalization                                                        | e2e           | NOT TESTED | New Teams/AudioCodes/channel webhook coverage                                                        |

### Testing Notes

The repo already has useful building blocks for this feature:

- generic message-metadata validation
- session metadata persistence boundaries
- locale fallback utilities
- locale-aware date extraction tests
- contact preference preload

What is missing is the end-to-end contract that ties those pieces together into one canonical interaction-context path. The dedicated testing guide below covers the new coverage matrix in detail.

> Full testing details: [docs/testing/sub-features/localized-interaction-context.md](../../testing/sub-features/localized-interaction-context.md)

---

## 18. References

- Design docs: `docs/specs/localized-interaction-context.hld.md`, `docs/plans/localized-interaction-context.lld.md`
- Related feature docs: [Channels](../channels.md), [NLU](../nlu.md), [Entity Extraction](../entity-extraction.md), [Memory & Sessions](../memory-sessions.md), [SDK](../sdk.md), [A2A Integration](../a2a-integration.md)
