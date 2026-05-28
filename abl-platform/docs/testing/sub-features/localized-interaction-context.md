# Test Specification: Localized Interaction Context

**Feature Spec**: [docs/features/sub-features/localized-interaction-context.md](../../features/sub-features/localized-interaction-context.md)
**HLD**: [docs/specs/localized-interaction-context.hld.md](../../specs/localized-interaction-context.hld.md)
**LLD**: [docs/plans/localized-interaction-context.lld.md](../../plans/localized-interaction-context.lld.md)
**Status**: PLANNED
**Last Updated**: 2026-04-16

---

## 1. Coverage Matrix

| FR    | Description                                                             | Unit    | Integration | E2E | Manual | Status  |
| ----- | ----------------------------------------------------------------------- | ------- | ----------- | --- | ------ | ------- |
| FR-1  | Canonical `InteractionContext` contract                                 | NO      | NO          | NO  | NO     | PLANNED |
| FR-2  | Ingress normalization across REST, A2A, SDK, and channels               | NO      | NO          | NO  | NO     | PLANNED |
| FR-3  | Resolver precedence order                                               | NO      | NO          | NO  | NO     | PLANNED |
| FR-4  | Canonical session persistence with compatibility aliases                | NO      | NO          | NO  | NO     | PLANNED |
| FR-5  | Explicit message-level override                                         | NO      | NO          | NO  | NO     | PLANNED |
| FR-6  | Message-level language switching                                        | NO      | NO          | NO  | NO     | PLANNED |
| FR-7  | Execution consumers read canonical interaction context                  | NO      | NO          | NO  | NO     | PLANNED |
| FR-8  | Timezone-aware relative date parsing                                    | PARTIAL | NO          | NO  | NO     | PARTIAL |
| FR-9  | Channel-native hint normalization                                       | PARTIAL | NO          | NO  | NO     | PARTIAL |
| FR-10 | Regression coverage for precedence, switching, dates, and compatibility | PARTIAL | NO          | NO  | NO     | PARTIAL |

### Current Baseline

The repository already contains partial baseline coverage that this feature should reuse instead of replacing:

- `apps/runtime/src/__tests__/auth/sdk-message-metadata.test.ts` validates generic JSON message metadata payloads.
- `packages/a2a/src/__tests__/session-metadata-extraction.test.ts` verifies that A2A preserves `messageMetadata`.
- `apps/runtime/src/__tests__/execution/contexts/orchestration/initialize-session-prepopulate.test.ts` verifies contact preference preload (`language`, `timezone`) into caller context.
- `packages/compiler/src/__tests__/utils/date-extraction.test.ts` and `apps/runtime/src/__tests__/extraction/extraction-pipeline.test.ts` cover locale-aware date parsing baselines.
- `apps/runtime/src/__tests__/execution/session-metadata-dedup.test.ts` verifies that message metadata affects dedup identity.

These tests are valuable, but they do not prove end-to-end behavior for canonical per-turn interaction context. They also do not cover the existing split where flow extraction reads `_locale`, behavior-profile routing reads `session.data.values.language`, `normalizeDate()` omits locale, and Teams drops `activity.locale`.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through HTTP or WebSocket entry points with real runtime servers, middleware, and session creation. No mocks of codebase components. Channel scenarios must still go through their public webhook or socket surfaces.

### E2E-1: REST chat explicit interaction context controls prompt and date resolution

- **Preconditions**: Runtime server running with MongoDB and Redis. Project has an agent that gathers a departure date and echoes the normalized date in the response or trace.
- **Steps**:
  1. POST `/api/v1/chat/agent` with message `"Departure is a week from tomorrow"` and explicit `interactionContext` `{ locale: "en-US", timezone: "Asia/Kolkata", language: "en" }`.
  2. Assert execution succeeds and the normalized departure date resolves from the user-local timezone, not the server-local timezone.
  3. Repeat the same request with a different explicit timezone and assert the normalized anchor shifts accordingly if the request crosses a day boundary.
- **Expected Result**: The runtime uses the explicit interaction context for date anchoring and does not ask the user for "today's date".
- **Auth Context**: Tenant T1, Project P1, User U1 with execute permission.
- **Isolation Check**: Cross-tenant execution against the same project id returns 404.

### E2E-2: WebSocket SDK supports message-level language switching in one session

- **Preconditions**: Runtime server running. SDK channel established for a project. Session starts in English.
- **Steps**:
  1. Connect to `/ws/sdk` with valid auth/bootstrap.
  2. Send a first message in English.
  3. Send a second message in Spanish with explicit message-level interaction context or equivalent canonical metadata.
  4. Assert the second turn uses the new language for extraction/prompt behavior without creating a new session.
- **Expected Result**: The second turn is processed using Spanish as the current-turn language while preserving the existing session id.
- **Auth Context**: Tenant T1, Project P1, User U1.
- **Isolation Check**: A second tenant cannot attach to or influence the SDK session.

### E2E-3: A2A propagates explicit locale/timezone into downstream execution

- **Preconditions**: Local A2A runtime endpoint and a connected agent route.
- **Steps**:
  1. POST `/a2a/:connectionId` with a message that includes explicit localization context in the supported inbound contract.
  2. Send a relative-date utterance in the message body.
  3. Assert the downstream runtime session stores the resolved interaction context and uses it during execution.
- **Expected Result**: A2A no longer strips localization context into inert metadata; execution consumes it.
- **Auth Context**: Valid A2A connection scoped to Tenant T1 / Project P1.
- **Isolation Check**: Cross-tenant A2A access still returns 404 or connection-not-found semantics without leaking data.

### E2E-4: Teams locale hint is normalized during channel ingress

- **Preconditions**: Runtime server with a configured Teams connection and public webhook ingress.
- **Steps**:
  1. POST a Teams activity payload containing `locale: "fr-FR"` to the public webhook route.
  2. Allow the inbound job/session pipeline to create or resume a runtime session.
  3. Assert the resolved interaction context for the resulting turn contains the normalized locale and language fallback.
- **Expected Result**: Channel-native locale hints flow into the same canonical interaction-context path used by REST and SDK.
- **Regression Guard**: The adapter must not drop `activity.locale` before the session resolver sees it.
- **Auth Context**: Provider-authenticated ingress for Tenant T1 / Project P1.
- **Isolation Check**: Posting the same payload to another tenant's connection identifier returns 404.

### E2E-5: AudioCodes language hint survives voice ingress and typed follow-up override

- **Preconditions**: AudioCodes webhook route configured for a project.
- **Steps**:
  1. Create or start a voice session through the AudioCodes public webhook using a channel config with `language`.
  2. Verify the created session carries the expected interaction context from voice ingress.
  3. Send a typed follow-up through an attached text surface or equivalent follow-up entry path with an explicit different message-level language.
  4. Assert the typed follow-up wins for that turn without corrupting session identity.
- **Expected Result**: Voice defaults can seed context, but an explicit later message can switch the current-turn language.
- **Auth Context**: Provider-authenticated ingress plus an attached text participant scoped to the same project.
- **Isolation Check**: Another project cannot reuse the live session or override the context.

### E2E-6: Contact preference fallback applies only when the message is silent

- **Preconditions**: Runtime server running. Contact linked to a session with stored preferences `{ language: "fr", timezone: "Europe/Paris" }`.
- **Steps**:
  1. Start a new session for the verified contact without explicit interaction context and send a relative-date utterance.
  2. Assert the session uses contact preference fallback.
  3. Send a follow-up message with explicit `language: "en"` and `timezone: "America/New_York"`.
  4. Assert the explicit values override the contact fallback for that turn.
- **Expected Result**: Contact preferences seed behavior but never outrank explicit message input.
- **Auth Context**: Tenant T1, Project P1, verified contact session.
- **Isolation Check**: A different contact in the same tenant cannot inherit or observe the first contact's stored preferences.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Resolver precedence merges message, session, contact, channel, and default inputs correctly

- **Boundary**: Interaction-context resolver only
- **Setup**: Build runtime session state with existing preference plus contact fallback and channel hint fixtures.
- **Steps**: Evaluate combinations where each precedence layer is present or missing.
- **Expected Result**: The resolver always chooses the highest-priority available value and records correct `source` / `confidence`.
- **Failure Mode**: Invalid explicit inputs are rejected or downgraded without corrupting lower-priority data.

### INT-2: Runtime executor persists canonical context and compatibility aliases together

- **Boundary**: Ingress execution options -> runtime session namespace
- **Setup**: Execute a turn with explicit context and inspect the runtime session after metadata application.
- **Steps**: Verify `session.interaction.current`, `session.interaction.preference`, and compatibility aliases are synchronized.
- **Expected Result**: New consumers can read canonical state while legacy `_locale` readers continue to function during migration, and no new long-lived `session.data.values.language` alias is introduced.
- **Failure Mode**: Alias sync drift is detected by assertions.

### INT-3: Prompt builder, reasoning executor, flow executor, and profile resolver consume the same canonical context

- **Boundary**: Session namespace -> prompt/execution consumers
- **Setup**: Create one session with a resolved interaction context and exercise both reasoning and flow execution paths.
- **Steps**: Build the system prompt, run entity extraction, and re-evaluate behavior profiles.
- **Expected Result**: All consumers observe the same `language`, `locale`, and `timezone` values, and profile routing no longer depends on `session.data.values.language`.
- **Failure Mode**: Any direct `_locale` or `session.data.values.language` fallback produces a failing assertion.

### INT-4: Date extraction and normalization accept an explicit reference instant

- **Boundary**: Runtime extraction validation -> compiler date extraction helper
- **Setup**: Pass explicit locale and reference instants near UTC day boundaries.
- **Steps**: Normalize `today`, `tomorrow`, `a week from tomorrow`, and `next Monday` through both flow extraction and `normalizeDate()`.
- **Expected Result**: Results are deterministic for the provided timezone, both call paths pass locale consistently, and helper output does not depend on the CI/server timezone.
- **Failure Mode**: Hidden `new Date()` usage, host-local getters, or `normalizeDate()` locale omission causes flakiness or mismatched dates.

### INT-5: Channel and protocol adapters map localization hints into canonical resolver inputs

- **Boundary**: Teams / AudioCodes / A2A / SDK ingress helpers -> interaction-context resolver
- **Setup**: Use normalized inbound payload fixtures from each supported surface.
- **Steps**: Extract metadata, strip persistence-only fields, and verify canonical interaction-context inputs are preserved.
- **Expected Result**: Each surface produces equivalent canonical inputs for equivalent localization data, and Teams locale is retained instead of being dropped.
- **Failure Mode**: One ingress path drops locale/timezone/language or leaves it trapped in channel-specific metadata.

### INT-6: Legacy `ClientInfo` localization fields map to compatibility input without becoming authoritative

- **Boundary**: Legacy session metadata / ingress compatibility -> interaction-context resolver
- **Setup**: Provide a request or session bootstrap fixture that includes `SessionMetadata.clientInfo.locale/timezone` plus canonical turn input.
- **Steps**: Resolve interaction context once with only legacy `ClientInfo` values and once with both legacy and explicit per-message input.
- **Expected Result**: Legacy `ClientInfo` values can seed missing data during migration but never outrank explicit message-level context, and execution still reads canonical session state.
- **Failure Mode**: `ClientInfo` becomes a second authoritative contract or overrides explicit turn input.

### INT-7: Dedup and queued-message replay respect interaction-context identity

- **Boundary**: Execution dedup + auth-gate queue replay
- **Setup**: Use existing dedup and SDK auth-gate replay test harnesses with explicit interaction-context changes.
- **Steps**: Replay same text with different message-level interaction context.
- **Expected Result**: Different interaction context does not collapse into the same execution hash, and replay preserves the original context.
- **Failure Mode**: Dedup or queue replay loses the turn-specific context.

---

## 4. Unit Test Scenarios

### UT-1: Metadata contract validation

- **Module**: `sdk-message-metadata` / inbound contract validator
- **Input**: Valid and invalid interaction-context payloads
- **Expected Output**: Valid JSON-like interaction context is accepted; malformed locale/timezone values are rejected

### UT-2: Locale negotiation helper reuse

- **Module**: locale resolution helper
- **Input**: Accept-Language headers and explicit locale lists
- **Expected Output**: Exact and prefix matches behave deterministically

### UT-3: Language-switch policy helper

- **Module**: interaction-context preference update policy
- **Input**: current-turn explicit override, inferred switch, low-confidence signal
- **Expected Output**: Explicit overrides update current turn immediately; low-confidence inference does not thrash session preference

### UT-4: Timezone-aware relative date helper

- **Module**: date extraction / normalization helper
- **Input**: reference instants plus relative phrases
- **Expected Output**: `today`, `tomorrow`, `a week from tomorrow`, and weekday phrases normalize deterministically, and date-only formatting is host-timezone-safe

### UT-5: Compatibility alias synchronization

- **Module**: runtime session interaction-context persistence
- **Input**: canonical interaction context
- **Expected Output**: legacy aliases are written consistently during migration without reintroducing `session.data.values.language` as a generic alias

### UT-6: `normalizeDate()` forwards locale-aware options

- **Module**: `extraction-validation`
- **Input**: localized date strings plus explicit locale/reference options
- **Expected Output**: `normalizeDate()` passes locale-aware options to the shared date helper instead of silently defaulting to English

### UT-7: Teams adapter preserves locale before normalization

- **Module**: `msteams-adapter`
- **Input**: Bot Framework activity with `locale`
- **Expected Output**: The normalized inbound message retains locale for the session resolver

---

## 5. Security & Isolation Tests

- **Cross-tenant access returns 404**: REST, SDK, A2A, and webhook tests must verify that localization context never creates a cross-tenant lookup or leak.
- **Cross-project access returns 404**: project-scoped session or contact preference fallback must not be visible in another project.
- **Cross-user/contact leakage is blocked**: contact preference fallback tests must prove one user's stored locale/timezone does not seed another user's session.
- **Boundary validation rejects malformed input**: invalid locale/timezone values must fail at the ingress boundary instead of propagating into execution internals.
- **Sanitized user-visible errors**: invalid explicit interaction context must return safe error envelopes without internal remediation detail.

---

## 6. Performance & Load Tests (if applicable)

- Measure resolver overhead under high-volume chat traffic and confirm the common case stays in-memory with negligible latency.
- Stress test rapid message-level language switching in the same session to ensure no unbounded cache growth or profile churn.
- Run date-normalization load tests with repeated relative-date utterances near timezone boundaries to confirm deterministic behavior.

---

## 7. Test Infrastructure

- **Required services**: Runtime, MongoDB, Redis, public webhook ingress harnesses, A2A connection harness, SDK WebSocket harness
- **Data seeding**: Project with execute permission, optional verified contact with stored `language` / `timezone` preferences, Teams and AudioCodes channel fixtures
- **Environment variables**: No new env vars required for the first slice; tests reuse standard runtime test configuration
- **CI configuration**: Ensure timezone-sensitive tests use explicit reference instants and do not rely on runner locale/timezone defaults

---

## 8. Test File Mapping

| Test File                                                                            | Type        | Covers                 |
| ------------------------------------------------------------------------------------ | ----------- | ---------------------- |
| `apps/runtime/src/__tests__/execution/interaction-context-resolver.test.ts`          | integration | FR-1, FR-3, FR-5, FR-6 |
| `apps/runtime/src/__tests__/execution/interaction-context-session-state.test.ts`     | integration | FR-4, FR-7             |
| `apps/runtime/src/__tests__/execution/interaction-context-profile-routing.test.ts`   | integration | FR-4, FR-7             |
| `apps/runtime/src/__tests__/extraction/date-extraction-timezone.test.ts`             | integration | FR-8, FR-10            |
| `packages/compiler/src/__tests__/utils/date-extraction-timezone.test.ts`             | unit        | FR-8, FR-10            |
| `apps/runtime/src/__tests__/e2e/localized-interaction-context-chat.e2e.test.ts`      | e2e         | FR-2, FR-5, FR-8       |
| `apps/runtime/src/__tests__/channels/ws-sdk-interaction-context.e2e.test.ts`         | e2e         | FR-2, FR-6, FR-10      |
| `packages/a2a/src/__tests__/interaction-context-a2a.integration.test.ts`             | integration | FR-2, FR-9             |
| `apps/runtime/src/__tests__/channels/teams-interaction-context.e2e.test.ts`          | e2e         | FR-2, FR-9             |
| `apps/runtime/src/__tests__/channels/msteams-adapter.test.ts`                        | unit        | FR-9, FR-10            |
| `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts`     | e2e         | FR-2, FR-6, FR-9       |
| `apps/runtime/src/__tests__/execution/interaction-context-dedup.integration.test.ts` | integration | FR-4, FR-10            |

---

## 9. Open Testing Questions

1. Should A2A localization context remain nested under `messageMetadata` for the first release, or should tests target a new top-level field immediately?
2. How long should legacy `ClientInfo.locale/timezone` compatibility coverage remain mandatory once the canonical contract is live?
3. What is the minimum confidence threshold for automatic session-preference updates in language-switch tests?
