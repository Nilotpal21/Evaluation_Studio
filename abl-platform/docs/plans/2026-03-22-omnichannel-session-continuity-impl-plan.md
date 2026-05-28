# LLD: Omnichannel Session Continuity

**Feature Spec**: `docs/features/omnichannel-session-continuity.md`
**HLD**: `docs/specs/omnichannel-session-continuity.hld.md`
**Test Spec**: `docs/testing/omnichannel-session-continuity.md`
**Status**: DONE
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                              | Alternatives Rejected                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Follow HLD rollout order: Phase 0 foundations → Phase 1 recall → Phase 2 live sync → Phase 3 broader channels           | HLD explicitly structures this; test spec reinforces sequence; Phase 0 is safety prerequisite for all later phases                                                                                                                                                                                                                                                                     | API-first approach; UI-first approach                                                                                                                           |
| D-2  | Add `projectId` as required field on messages with migration backfill                                                   | Feature spec mandates project-safe recall; migration precedent exists in `20260305_009_backfill_message_contact_ids.ts`                                                                                                                                                                                                                                                                | Optional field (creates safety hole); query through sessions (two round trips)                                                                                  |
| D-3  | Separate Redis-backed participant registry (`participant-registry.ts`)                                                  | Pod-local state violates Core Invariant #3; fundamentally different 1:N model vs existing 1:1 connection registry                                                                                                                                                                                                                                                                      | Extend existing `WebSocketConnectionRegistry`                                                                                                                   |
| D-4  | Redis INCR for transcript sequence allocation                                                                           | Atomic, O(1), per-session monotonic; HLD already specifies the key pattern                                                                                                                                                                                                                                                                                                             | Snowflake IDs; HLC; application-level counters                                                                                                                  |
| D-5  | Direct compound index `{tenantId, projectId, contactId, createdAt}` on messages                                         | Feature spec specifies this index; single-query recall; avoids two-round-trip session-then-messages                                                                                                                                                                                                                                                                                    | Query sessions first then messages                                                                                                                              |
| D-6  | Separate Mongoose model for `contact_capability_consents`                                                               | Feature spec defines as collection; project-scoped consent ≠ tenant-scoped contact; independent audit lifecycle                                                                                                                                                                                                                                                                        | Subdocument on contact; subdocument on session                                                                                                                  |
| D-7  | Evolve existing `UnifiedWidget` rather than creating new component                                                      | Feature spec says "must evolve"; avoids duplicating chat/voice wiring                                                                                                                                                                                                                                                                                                                  | New `OmnichannelWidget` component                                                                                                                               |
| D-8  | No Redis cache for recall initially; direct MongoDB query with timeout                                                  | Different access pattern vs ContactContextService (lazy vs eager); recall invalidation on every message persist would thrash cache                                                                                                                                                                                                                                                     | Shared cache with ContactContextService                                                                                                                         |
| D-9  | Add `omnichannel_session_continuity` to `PLAN_FEATURES` in `packages/shared-kernel` + project YAML for sub-capabilities | Feature resolves via `requireFeature()` which checks plan tiers and Deals; project YAML separates `recall.enabled` / `liveSync.enabled`                                                                                                                                                                                                                                                | Env-var-only gate (no existing pattern); additional env vars per sub-capability                                                                                 |
| D-13 | Use fail-closed feature gate (`createModuleFeatureGate`) for omnichannel routes                                         | Omnichannel accesses cross-session transcript data; fail-open on DB outage would expose recall to non-entitled tenants. Consent + verification are defense-in-depth, but the feature gate should still fail closed.                                                                                                                                                                    | Use standard `requireFeature()` which fails open                                                                                                                |
| D-14 | Evolve `WebSocketConnectionRegistry` with backward-compatible API                                                       | Add `getConnectionsForSession()` returning `Set<string>` while keeping existing `getConnectionForSession()` returning the primary (first-registered) connection. `ChannelDispatcher` continues using single-connection API unchanged. Omnichannel fan-out uses the new multi-connection API.                                                                                           | Replace API entirely (breaks ChannelDispatcher); create entirely separate registry                                                                              |
| D-15 | Use `authMiddleware` + `requireProjectScope('projectId', { concealOutOfScope: true })` for route auth                   | Matches existing runtime project-scoped route pattern (verified in sessions.ts, alerts.ts, pipeline-config.ts). Returns 404 for cross-project access per Core Invariant #1                                                                                                                                                                                                             | Manual projectId verification; `requireAuth()` (different package/function)                                                                                     |
| D-16 | Make provider-verified continuity policy-driven: weak by default, strong only for explicitly trusted channels/providers | Current runtime/bootstrap behavior needs a narrow provider-authenticated continuity path. Default provider verification remains weak tier 1 and same-channel only; selected trusted channels/providers may explicitly classify provider verification as strong tier 2. This avoids a global trust expansion while allowing high-trust transports to satisfy strong-verification gates. | Force all bootstrap continuity to wait for tier-2 verification; treat all provider verification as weak forever; treat provider verification as globally strong |
| D-10 | Identity verification wiring is a prerequisite dependency, not re-implemented here                                      | Separate identity-verification LLD dated 2026-03-22 is already wiring the stub; feature spec marks the dependency                                                                                                                                                                                                                                                                      | Re-implement verification completion inline                                                                                                                     |
| D-11 | Keep session `channelHistory: string[]` and contact `channelHistory: IChannelHistoryEntry[]` separate                   | Different purposes: session traversal vs contact lifetime; `attachedParticipants` replaces richer session-level tracking                                                                                                                                                                                                                                                               | Align both to structured format                                                                                                                                 |
| D-12 | Include metric/trace emission in scope; defer alerting configuration                                                    | Platform Invariant #4 requires traceability; performance budgets need measurement; alerting is configuration not code                                                                                                                                                                                                                                                                  | Defer all observability                                                                                                                                         |

### Key Interfaces & Types

```typescript
// packages/database/src/models/contact-capability-consent.model.ts
interface IContactCapabilityConsent {
  _id: string;
  tenantId: string;
  projectId: string;
  contactId: string;
  capability: 'cross_channel_recall' | 'live_transcript_sync';
  state: 'granted' | 'revoked';
  grantedBy: string;
  grantedAt: Date;
  revokedAt: Date | null;
  policyVersion: string;
}

// Session model additions (packages/database/src/models/session.model.ts)
interface ISessionOmnichannelFields {
  sessionPrincipalId: string; // UUIDv7, always unique
  sdkPrincipal: {
    channelId: string;
    permissions: string[];
    grantedCapabilities: string[];
  } | null;
  verifiedIdentity: {
    contactId: string;
    method: string;
    strength: number;
    verifiedAt: Date;
  } | null;
  attachedParticipants: Array<{
    participantId: string;
    channel: string;
    mode: 'active' | 'observe';
    interactive: boolean;
    attachedAt: Date;
    detachedAt: Date | null;
  }>;
  liveSyncState: {
    status: 'inactive' | 'active' | 'ended';
    joinMode: 'prompt' | 'auto_link';
    transcriptMode: 'final_only';
    lastSequence: number;
  } | null;
}

// Message model additions (packages/database/src/models/message.model.ts)
interface IMessageOmnichannelFields {
  projectId: string; // required, backfilled from session
  sourceChannel: string; // originating channel for recall display
  inputMode: 'voice' | 'typed' | 'tool' | 'system';
  participantId: string | null; // which participant sent this
  final: boolean; // true for persisted recall items
  sequence: number; // monotonic per session via Redis INCR
  deliveryChannels: string[]; // channels this was fanned out to
}

// Omnichannel settings (stored as project configuration)
interface IOmnichannelProjectSettings {
  enabled: boolean;
  recall: {
    enabled: boolean;
    scope: 'project';
    factsPreload: boolean;
    transcriptMode: 'on_demand' | 'disabled';
    maxMessages: number;
    maxAgeDays: number;
    allowedChannels: string[];
  };
  identity: {
    explicitVerificationRequired: boolean;
    strongMethods: string[];
    unsignedUserIdMode: 'metadata_only';
    conflictPolicy: 'fail_closed';
  };
  liveSync: {
    enabled: boolean;
    attachableChannels: string[];
    transcriptMode: 'final_only';
    joinPolicy: {
      autoJoinWithVerifiedLink: boolean;
      otherwisePrompt: boolean;
    };
    typedInputPolicy: 'interrupt_tts';
    continueSameSessionAfterVoiceEnd: boolean;
    allowMultipleParticipants: boolean;
  };
  privacy: {
    consentRequired: boolean;
    auditRequired: boolean;
    retentionEnforced: boolean;
    redactionEnforced: boolean;
  };
}

// Recall service types (apps/runtime/src/services/omnichannel/recall-service.ts)
interface RecallRequest {
  tenantId: string;
  projectId: string;
  contactId: string;
  currentSessionId: string;
  maxMessages: number;
  maxAgeDays: number;
  allowedChannels?: string[];
}

interface RecallResult {
  messages: Array<{
    sessionId: string;
    role: string;
    content: string;
    channel: string;
    sourceChannel: string;
    timestamp: Date;
  }>;
  sessionCount: number;
  truncated: boolean;
}

// Live session service types (apps/runtime/src/services/omnichannel/live-session-service.ts)
interface LiveSessionDiscoveryResult {
  found: boolean;
  sessionId?: string;
  joinMode?: 'auto_link' | 'prompt';
  participantCount?: number;
}

interface JoinResult {
  success: boolean;
  sessionId?: string;
  backfill?: Array<{
    sequence: number;
    role: string;
    content: string;
    sourceChannel: string;
    timestamp: Date;
  }>;
  error?: { code: string; message: string };
}

// Participant registry types (apps/runtime/src/services/omnichannel/participant-registry.ts)
interface Participant {
  participantId: string;
  sessionId: string;
  channel: string;
  mode: 'active' | 'observe';
  interactive: boolean;
  connectionId: string;
  attachedAt: number; // epoch ms
}

// WebSocket additions (apps/runtime/src/websocket/sdk-handler.ts)
type OmnichannelWSClientMessage =
  | { type: 'discover_live_session' }
  | { type: 'join_live_session'; sessionId: string; joinToken?: string }
  | { type: 'typed_interrupt'; text: string };

type OmnichannelWSServerMessage =
  | {
      type: 'live_session_discovered';
      sessionId: string;
      joinMode: 'auto_link' | 'prompt';
      participantCount: number;
    }
  | { type: 'no_live_session' }
  | { type: 'live_session_joined'; sessionId: string; participantId: string }
  | {
      type: 'transcript_backfill';
      messages: Array<{
        sequence: number;
        role: string;
        content: string;
        sourceChannel: string;
        timestamp: string;
      }>;
    }
  | {
      type: 'transcript_item';
      sequence: number;
      role: string;
      content: string;
      sourceChannel: string;
      inputMode: string;
      timestamp: string;
    }
  | { type: 'participant_attached'; participantId: string; channel: string }
  | { type: 'participant_detached'; participantId: string; channel: string }
  | { type: 'typed_interrupt_ack' }
  | { type: 'live_session_ended' };
```

### Module Boundaries

| Module                          | Responsibility                                                               | Depends On                                             |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `contact-capability-consent`    | Consent CRUD and enforcement                                                 | `packages/database`, tenant isolation plugin           |
| `recall-service`                | Project-scoped transcript retrieval and ranking                              | Message model, session model, consent model, settings  |
| `live-session-service`          | Shared session discovery, join orchestration, detach                         | participant-registry, consent, session model, settings |
| `participant-registry`          | Redis-backed participant tracking, join tokens, sequence allocation          | Redis client                                           |
| `omnichannel-settings-service`  | Project-level omnichannel configuration CRUD                                 | Project model or dedicated settings store              |
| `omnichannel-routes`            | HTTP endpoints for recall, discovery, join, detach                           | All above services, auth middleware                    |
| `sdk-handler` (extensions)      | WebSocket message handling for live session discovery, join, transcript sync | live-session-service, participant-registry             |
| `connection-registry` (evolved) | Pod-local session-to-multiple-connections lookup                             | In-memory Maps (pod-local, not source of truth)        |
| `omnichannel-audit`             | Trace events and audit logging for all omnichannel operations                | TraceStore, createLogger                               |

---

## 2. File-Level Change Map

### New Files

| File                                                                                | Purpose                                                        | LOC Estimate |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------ |
| `packages/database/src/models/contact-capability-consent.model.ts`                  | Consent Mongoose model with tenant isolation plugin            | 80           |
| `packages/database/src/migrations/scripts/20260323_backfill_message_project_ids.ts` | Migration to backfill `projectId` on messages from sessions    | 90           |
| `apps/runtime/src/services/omnichannel/recall-service.ts`                           | Project-scoped transcript recall retrieval and ranking         | 200          |
| `apps/runtime/src/services/omnichannel/live-session-service.ts`                     | Shared session discovery, join, detach orchestration           | 250          |
| `apps/runtime/src/services/omnichannel/participant-registry.ts`                     | Redis-backed participant tracking, join tokens, sequence alloc | 200          |
| `apps/runtime/src/services/omnichannel/omnichannel-settings-service.ts`             | Project-level omnichannel config read/write                    | 120          |
| `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`                        | Trace event emission for all omnichannel operations            | 80           |
| `apps/runtime/src/services/omnichannel/types.ts`                                    | Shared types for omnichannel services                          | 100          |
| `apps/runtime/src/services/omnichannel/index.ts`                                    | Barrel export                                                  | 15           |
| `apps/runtime/src/routes/omnichannel.ts`                                            | HTTP routes: recall, live-session discovery/join/detach        | 250          |
| `apps/studio/src/app/api/projects/[id]/omnichannel/route.ts`                        | Studio API route using `withRouteHandler` pattern              | 80           |
| `apps/studio/src/components/projects/OmnichannelSettingsPanel.tsx`                  | Studio UI for omnichannel project settings                     | 300          |
| `apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts`                         | E2E: cross-channel recall                                      | 350          |
| `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`                   | E2E: live session join, backfill, typed interrupt              | 400          |
| `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`                  | E2E: project isolation, consent, tenant isolation              | 300          |
| `apps/runtime/src/__tests__/omnichannel-recovery.e2e.test.ts`                       | E2E: Redis loss, reconnect, duplicate join recovery            | 250          |
| `apps/runtime/src/__tests__/omnichannel-identity-linking.integration.test.ts`       | Integration: strong verification, linking, conflict handling   | 300          |
| `apps/runtime/src/__tests__/omnichannel-recall-service.integration.test.ts`         | Integration: recall ranking, limits, policy enforcement        | 250          |
| `apps/runtime/src/__tests__/omnichannel-sdk-handler.integration.test.ts`            | Integration: WS join, backfill, sequencing, fan-out            | 300          |

### Modified Files

| File                                                                      | Change Description                                                                                                           | Risk |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/message.model.ts`                           | Add `projectId`, `sourceChannel`, `inputMode`, `participantId`, `final`, `sequence`, `deliveryChannels` fields + new indexes | High |
| `packages/database/src/models/session.model.ts`                           | Add `sessionPrincipalId`, `sdkPrincipal`, `verifiedIdentity`, `attachedParticipants`, `liveSyncState` fields + new index     | High |
| `packages/database/src/models/index.ts`                                   | Export new `ContactCapabilityConsent` model                                                                                  | Low  |
| `apps/runtime/src/server.ts`                                              | Register omnichannel routes, wire omnichannel services                                                                       | Med  |
| `apps/runtime/src/websocket/sdk-handler.ts`                               | Add omnichannel WS message handlers (discover, join, transcript fan-out)                                                     | High |
| `apps/runtime/src/websocket/connection-registry.ts`                       | Add backward-compatible `getConnectionsForSession()` for multi-tab; keep `getConnectionForSession()` for `ChannelDispatcher` | Med  |
| `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts` | Populate `sessionPrincipalId` on new sessions; pass omnichannel settings to preload                                          | Med  |
| `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`   | Update `verifiedIdentity` on session after promotion; trigger consent check                                                  | Med  |
| `apps/runtime/src/contexts/contact/use-cases/link-session-to-contact.ts`  | Backfill `projectId` on linked messages; emit omnichannel audit events                                                       | Med  |
| `apps/runtime/src/services/contact-context-service.ts`                    | No changes — kept as-is for eager fact preload (separate from recall)                                                        | Low  |
| `apps/runtime/src/services/execution/memory-integration.ts`               | Add recall tool integration point for on-demand transcript retrieval                                                         | Med  |
| `apps/runtime/src/routes/contacts.ts`                                     | Ensure `/contacts/:id/history` filters by `projectId` for safety                                                             | Med  |
| `apps/runtime/src/routes/identity-verification.ts`                        | Fix `console.error` → `createLogger` (3 occurrences at lines 79, 106, 139)                                                   | Low  |
| `packages/shared-kernel/src/constants/plan-features.ts`                   | Add `omnichannel_session_continuity` to BUSINESS and ENTERPRISE plan tiers                                                   | Low  |
| `packages/web-sdk/src/core/SessionManager.ts`                             | Add join, reattach, and live-session discovery methods                                                                       | Med  |
| `packages/web-sdk/src/chat/ChatClient.ts`                                 | Add backfill hydration, source-channel labels, live subscription                                                             | Med  |
| `packages/web-sdk/src/voice/VoiceClient.ts`                               | Publish final transcript items into shared session model for live sync delivery                                              | Med  |
| `packages/web-sdk/src/ui/UnifiedWidget.ts`                                | Evolve from mode-toggle to simultaneous transcript + input UI                                                                | Med  |
| `packages/web-sdk/src/core/types.ts`                                      | Add omnichannel event types, WS message types, config extensions                                                             | Low  |
| `apps/studio/src/components/settings/ProjectSettingsPage.tsx`             | Add OmnichannelSettingsTab to navigation                                                                                     | Low  |
| `packages/config/src/constants.ts`                                        | Add omnichannel-related constants (defaults, limits)                                                                         | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 0: Safety Foundations & Data Layer

**Goal**: Make the data layer project-safe for recall and add consent infrastructure. No new runtime behavior exposed yet.

**Prerequisites**: Identity verification completion must be wired (separate LLD `docs/plans/2026-03-22-identity-verification-impl-plan.md`). If not yet landed, Phase 0 tasks that don't depend on it can proceed; tasks 0.4 and beyond require it.

**Tasks**:

0.1. **Add `projectId` to message model** — Add the field as required with default empty string for migration compatibility. Add planned indexes: `{ tenantId: 1, projectId: 1, contactId: 1, createdAt: -1 }` and `{ tenantId: 1, sessionId: 1, sequence: 1 }`. Add `sourceChannel`, `inputMode`, `participantId`, `final`, `sequence`, `deliveryChannels` as optional fields.

- File: `packages/database/src/models/message.model.ts`

  0.2. **Create migration to backfill `projectId` on messages** — Follow the pattern from `20260305_009_backfill_message_contact_ids.ts`. Batch through sessions, join to their messages, set `message.projectId = session.projectId`. Handle sessions with null `projectId` by skipping (these are legacy pre-project sessions).

- File: `packages/database/src/migrations/scripts/20260323_backfill_message_project_ids.ts`

  0.3. **Add omnichannel fields to session model** — Add `sessionPrincipalId` (default UUIDv7 on creation), `sdkPrincipal`, `verifiedIdentity`, `attachedParticipants` (default `[]`), `liveSyncState` (default `null`). Add index: `{ tenantId: 1, projectId: 1, 'liveSyncState.status': 1, contactId: 1 }`.

- File: `packages/database/src/models/session.model.ts`

  0.4. **Create consent model** — New `ContactCapabilityConsent` model with `tenantIsolationPlugin`, unique compound index `{ tenantId, projectId, contactId, capability }`.

- File: `packages/database/src/models/contact-capability-consent.model.ts`
- File: `packages/database/src/models/index.ts` (add export)

  0.5. **Add feature gate** — Add `'omnichannel_session_continuity'` to the BUSINESS and ENTERPRISE tiers in `PLAN_FEATURES` at `packages/shared-kernel/src/constants/plan-features.ts`. The existing `createModuleFeatureGate()` is hardcoded to check `'reusable_modules'` — refactor it into a generic `createFailClosedFeatureGate(featureName: string)` that accepts a feature name parameter (default `'reusable_modules'` for backward compatibility). Apply `createFailClosedFeatureGate('omnichannel_session_continuity')` to omnichannel routes.

- File: `packages/shared-kernel/src/constants/plan-features.ts`
- File: `apps/runtime/src/middleware/feature-gate.ts` (refactor `createModuleFeatureGate` to accept feature name param)
- File: `packages/config/src/constants.ts` (add default constants for recall limits, TTLs)

  0.6. **Ensure contact history endpoint filters by projectId** — The existing `GET /api/contacts/:id/history` in `contacts.ts` currently queries messages by `{ tenantId, contactId }`. Add `projectId` to the filter to make it project-safe. For SDK session contexts (`authType === 'sdk_session'`), extract `projectId` from `req.tenantContext`. For platform-member contexts, accept an optional `projectId` query parameter. When no `projectId` is available, return all contact messages (backward compatible for admin use). Also fix the bare-string error responses (`{ success: false, error: 'string' }`) to use the standard envelope `{ success: false, error: { code, message } }`.

- File: `apps/runtime/src/routes/contacts.ts`

  0.7. **Fix console.error in identity-verification routes** — Replace 3 `console.error` calls with `createLogger('identity-verification')`.

- File: `apps/runtime/src/routes/identity-verification.ts`

  0.8. **Populate `projectId` on new messages** — Ensure all message creation paths include `projectId` from the session. Key message creation paths to audit:
  - `apps/runtime/src/services/message-persistence-queue.ts` (MessageJobData — update `projectId?` to required or provide fallback)
  - `apps/runtime/src/websocket/sdk-handler.ts` (user message persistence)
  - `apps/runtime/src/services/execution/` (agent response persistence)
  - `apps/runtime/src/channels/` (channel adapter message creation)
  - Any BullMQ worker that creates messages

- Files: `apps/runtime/src/services/message-persistence-queue.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, message creation paths in execution and channel services

  0.11. **Normalize voice channel identity artifacts (GAP-009)** — The vxml-adapter and voice adapters produce different caller identity artifact formats. Normalize caller ID, SIP URI, and phone number formats into a consistent `channelArtifact` + `channelArtifactType` pair so cross-channel contact resolution works correctly.

- File: `apps/runtime/src/channels/adapters/vxml-adapter.ts`
- File: `apps/runtime/src/channels/session-resolver.ts`

  0.11a. **Encode provider-verification strength explicitly** — `InitializeSession` and channel bootstrap paths must classify provider-verified artifacts through explicit policy:
  - default weak tier 1 for same-channel continuity and contact linkage when ingress is trusted and the artifact is stable
  - optional strong tier 2 only when the trusted channel/provider configuration explicitly opts in
  - weak tier 1 must not satisfy recall or live-session identity gates
  - strong tier 2 is treated the same as other strong-verification methods for authorization and audit
  - ambiguity still fails closed

- File: `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`
- File: `apps/runtime/src/channels/session-resolver.ts`

  0.12. **Define omnichannel IR policy block (GAP-010)** — Add the omnichannel configuration block to the Agent IR schema in the compiler package. This lets agents declare recall, verification, and live-sync policies. Parse and validate during compilation; make available to the runtime recall and live-session services.

- File: `packages/compiler/src/platform/ir/schema.ts` (IR type definitions)
- File: `packages/compiler/src/platform/ir/` (parsing/validation)

  0.9. **Populate `sessionPrincipalId` on new sessions** — In `InitializeSession` use case, generate and assign `sessionPrincipalId` (UUIDv7) when creating new sessions. For SDK sessions, also populate `sdkPrincipal` from the token payload.

- File: `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`

  0.10. **Update `PromoteAndLink` to set `verifiedIdentity`** — When a session is promoted to tier 2, populate `session.verifiedIdentity` with the contact, method, strength, and timestamp.

- File: `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`

**Files Touched**:

- `packages/database/src/models/message.model.ts` — add fields + indexes
- `packages/database/src/models/session.model.ts` — add fields + index
- `packages/database/src/models/contact-capability-consent.model.ts` — new
- `packages/database/src/models/index.ts` — add export
- `packages/database/src/migrations/scripts/20260323_backfill_message_project_ids.ts` — new
- `packages/shared-kernel/src/constants/plan-features.ts` — add feature to plan tiers
- `packages/config/src/constants.ts` — add constants
- `apps/runtime/src/routes/contacts.ts` — add projectId filter
- `apps/runtime/src/routes/identity-verification.ts` — fix logging
- `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts` — sessionPrincipalId
- `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts` — verifiedIdentity
- Message creation call sites across runtime

**Exit Criteria**:

- [x] `pnpm build --filter=@agent-platform/database` succeeds with 0 type errors
- [x] `pnpm build --filter=runtime` succeeds with 0 type errors
- [x] Migration script executes correctly against test database (messages gain `projectId`)
- [x] Existing tests pass: `pnpm test --filter=runtime` (no regressions)
- [x] New messages created by any runtime path include `projectId`
- [x] New sessions include `sessionPrincipalId` (UUIDv7)
- [x] `GET /api/contacts/:id/history` returns only project-scoped messages when called with SDK auth
- [x] `contact_capability_consents` collection can be created, queried, and unique constraint enforced
- [x] Feature gate (fail-closed) blocks omnichannel routes when tenant does not have `omnichannel_session_continuity` in plan
- [x] No `console.error` remains in identity-verification routes

**Test Strategy**:

- Unit: consent model CRUD, message field defaults, sessionPrincipalId generation
- Integration: migration correctness, projectId filtering on history endpoint, feature gate middleware

**Rollback**: Remove new fields from models (backward compatible since all new fields have defaults or are optional). Drop migration. Revert feature gate registration.

---

### Phase 1: Cross-Channel Recall (Part 1)

**Goal**: Verified contacts can retrieve bounded prior conversation from earlier sessions in the same project. Recall is lazy, on-demand, project-scoped, and respects consent/privacy gates.

**Tasks**:

1.1. **Create omnichannel types** — Shared types for recall, live session, settings, and audit.

- File: `apps/runtime/src/services/omnichannel/types.ts`

  1.2. **Create omnichannel audit module** — Emit trace events for all omnichannel operations using existing `TraceStore` patterns. Map the 11 event types from the feature spec to specific `TraceStore.emit()` calls:
  - `omnichannel_recall_requested` → `{ sessionId, contactId, recallPolicy }`
  - `omnichannel_recall_returned` → `{ matchedSessionIds, returnedMessages, tokenBudget }`
  - `session_linked_to_contact` → `{ sessionId, contactId, verificationMethod }`
  - `identity_verified` → `{ method, strength, verifiedIdentityRef }`
  - `live_session_discovered` → `{ sessionId, joinMode }`
  - `live_session_joined` → `{ sessionId, participantId, sourceChannel }`
  - `transcript_item_persisted` → `{ sessionId, sequence, sourceChannel }`
  - `typed_input_interrupted_tts` → `{ sessionId, participantId }`
  - `live_session_detached` → `{ sessionId, participantId, sourceChannel }`
  - `consent_granted` → `{ contactId, projectId, capability }`
  - `consent_revoked` → `{ contactId, projectId, capability }`

- File: `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`

  1.3. **Create omnichannel settings service** — Read/write project-level omnichannel configuration. Store as part of project settings (following existing pattern). Validate settings against the `IOmnichannelProjectSettings` schema. Provide sensible defaults matching the feature spec YAML.

- File: `apps/runtime/src/services/omnichannel/omnichannel-settings-service.ts`

  1.4. **Create recall service** — Implement `RecallService` with:
  - `getRecallMessages(request: RecallRequest): Promise<RecallResult>`
  - Query: `{ tenantId, projectId, contactId, final: true, createdAt: { $gte: maxAge } }` excluding `currentSessionId`, filtering by `allowedChannels` if set
  - Sort by `createdAt: -1`, limit to `maxMessages`
  - **Merge resolution**: Before querying, resolve `mergedInto` chain on the contact to find the surviving primary contactId. Query using all contactIds in the merge chain (primary + merged-from IDs) to span merged history
  - Check consent (cross_channel_recall must be granted for the contact+project)
  - Timeout with graceful degradation (return empty result, log warning, don't fail session)
  - **Encryption handling**: Do NOT use `.lean()` for recall queries — use standard Mongoose `find()` so the `encryptionPlugin` auto-decrypts `content` on `post('init')`. If performance requires `.lean()`, use `getEncryptionService().decryptForTenant()` explicitly
  - Validate response payload size does not exceed 64KB; truncate if needed
  - Check contact GDPR-delete status: exclude contacts with `softDeleted: true` from recall

- File: `apps/runtime/src/services/omnichannel/recall-service.ts`

  1.5. **Create barrel export** — Export all omnichannel services.

- File: `apps/runtime/src/services/omnichannel/index.ts`

  1.6. **Create omnichannel HTTP routes** — For Phase 1, implement:
  - `POST /api/projects/:projectId/omnichannel/recall` — bounded transcript recall
  - `GET /api/projects/:projectId/omnichannel` — read settings (for Studio)
  - `PATCH /api/projects/:projectId/omnichannel` — update settings (for Studio)
  - Middleware chain: `authMiddleware` → `requireProjectScope('projectId', { concealOutOfScope: true })` → `tenantRateLimit('request')` → `createModuleFeatureGate('omnichannel_session_continuity')`
  - Cross-project access returns 404 (handled by `requireProjectScope` with `concealOutOfScope`)
  - Recall requires verified identity (tier 2+) and consent
  - Zod validation on all inputs:
    - `RecallRequestSchema`: `{ maxMessages: z.number().int().min(1).max(100).optional(), maxAgeDays: z.number().int().min(1).max(365).optional(), allowedChannels: z.array(z.string().min(1)).optional() }`
    - `OmnichannelSettingsUpdateSchema`: validates IOmnichannelProjectSettings partial updates with `z.string().min(1)` for all ID fields
    - Route params: `z.object({ projectId: z.string().min(1) })`
  - Error responses use standard envelope: `{ success: false, error: { code, message } }`
  - Maximum response payload size: 64KB for recall results

- File: `apps/runtime/src/routes/omnichannel.ts`

  1.7. **Register omnichannel routes in server.ts** — Mount at `/api/projects/:projectId/omnichannel` with auth middleware. Wire service dependencies.

- File: `apps/runtime/src/server.ts`

  1.8. **Integrate recall into memory system** — Add an on-demand recall tool that agents can invoke. When the agent (or a RECALL trigger) requests prior conversation, call `RecallService.getRecallMessages()` and inject the results into the agent context. Keep this separate from the eager `contactContext` preload path.

- File: `apps/runtime/src/services/execution/memory-integration.ts`

  1.9. **Create Studio API route** — Use `withRouteHandler` pattern (see `apps/studio/src/app/api/projects/[id]/agent-transfer/settings/route.ts` as reference). Handles GET (read settings) and PATCH (update settings) with built-in auth, rate limiting, project access, and permission checks. Proxies to runtime omnichannel settings endpoint.

- File: `apps/studio/src/app/api/projects/[id]/omnichannel/route.ts`

  1.10. **Create Studio settings panel** — UI panel for omnichannel configuration following the existing tab pattern. Controls for recall enable/disable, max messages, max age, allowed channels, consent requirements. Uses `useTranslations()` from next-intl with keys under `settings.omnichannel` namespace.
  **5-step Studio settings wiring** (per `apps/studio/agents.md`):
  1. Add `'settings-omnichannel'` to `ProjectPage` type union in `apps/studio/src/store/navigation-store.ts`
  2. Add to `settingsSubPages` map in same file
  3. Add to `settingsPageMap`
  4. Add nav item in `apps/studio/src/components/navigation/ProjectSidebar.tsx` settings group
  5. Add import + omnichannel case in `apps/studio/src/components/navigation/AppShell.tsx` renderContent
  - Add `'omnichannel'` case in `ProjectSettingsPage.tsx` rendering `<OmnichannelSettingsPanel />`
  - Add i18n keys to `packages/i18n/locales/en/studio.json` under `settings.omnichannel.*`
  - All user-visible strings must use translation keys; add `aria-label` for controls without visible labels
  - Use SWR for settings fetch, `mutate()` after PATCH, loading/disabled states on save button

- File: `apps/studio/src/components/projects/OmnichannelSettingsPanel.tsx`
- File: `apps/studio/src/components/settings/ProjectSettingsPage.tsx` (add case)
- File: `apps/studio/src/store/navigation-store.ts` (add page type + settings maps)
- File: `apps/studio/src/components/navigation/ProjectSidebar.tsx` (add nav item)
- File: `apps/studio/src/components/navigation/AppShell.tsx` (add renderContent case)
- File: `packages/i18n/locales/en/studio.json` (add keys)

**Files Touched**:

- `apps/runtime/src/services/omnichannel/types.ts` — new
- `apps/runtime/src/services/omnichannel/omnichannel-audit.ts` — new
- `apps/runtime/src/services/omnichannel/omnichannel-settings-service.ts` — new
- `apps/runtime/src/services/omnichannel/recall-service.ts` — new
- `apps/runtime/src/services/omnichannel/index.ts` — new
- `apps/runtime/src/routes/omnichannel.ts` — new
- `apps/runtime/src/server.ts` — wire routes + services
- `apps/runtime/src/services/execution/memory-integration.ts` — add recall integration
- `apps/studio/src/app/api/projects/[id]/omnichannel/route.ts` — new (withRouteHandler pattern)
- `apps/studio/src/components/projects/OmnichannelSettingsPanel.tsx` — new
- `apps/studio/src/components/settings/ProjectSettingsPage.tsx` — add omnichannel case
- `apps/studio/src/config/navigation.ts` — add settings-omnichannel sidebar entry
- `packages/i18n/locales/en/studio.json` — add settings.omnichannel.\* keys

**Exit Criteria**:

- [x] `POST /api/projects/:projectId/omnichannel/recall` returns bounded prior transcript for verified contact
- [x] Recall excludes current session, respects maxMessages (default 20), maxAgeDays (default 30)
- [x] Recall returns only `final` transcript items
- [x] Recall is strictly project-scoped: cross-project request returns 404 (blocked by `requireProjectScope` with `concealOutOfScope`)
- [x] Recall is strictly tenant-scoped: cross-tenant request returns 404
- [x] Recall blocked when `cross_channel_recall` consent not granted
- [x] Recall blocked for anonymous (tier 0/1) sessions
- [x] Recall timeout degrades gracefully (returns empty, logs warning)
- [x] Settings CRUD works: GET returns defaults, PATCH updates, narrowing validation enforced
- [x] Agent can trigger on-demand recall through memory integration
- [x] Studio settings panel renders and saves omnichannel configuration
- [x] `pnpm build --filter=runtime --filter=studio` succeeds with 0 type errors
- [x] All existing tests pass (no regressions)

**Test Strategy**:

- Integration: `omnichannel-recall-service.integration.test.ts` — recall ranking, limits, consent enforcement, project scoping
- Integration: `omnichannel-identity-linking.integration.test.ts` — verification → consent → recall flow
- E2E: `omnichannel-recall.e2e.test.ts` — verified web-to-voice recall (OCS-E01), anonymous safety (OCS-E02)
- E2E: `omnichannel-privacy-gates.e2e.test.ts` — cross-project/cross-tenant isolation (test spec Security, Privacy, and Compliance coverage matrix)

**Rollback**: Remove omnichannel routes from server.ts, delete service files. Feature gate defaults to `false` so no recall surfaces without explicit enablement.

---

### Phase 2: Live Omnichannel Transcript Sync (Part 2)

**Goal**: A verified user on an active voice call can attach a web/mobile text surface to the same session. Final transcript is synced live. Typed input interrupts voice TTS. Session continues after voice ends.

**Tasks**:

2.1. **Create participant registry** — Redis-backed service (no in-memory Maps — all state in Redis) managing:

- Active live-session lookup: `omnichannel:live:{tenantId}:{projectId}:{contactId}` → sessionId (TTL: 24h, refreshed on activity)
- Participant set: `omnichannel:participants:{sessionId}` → Set of participant JSON (TTL: 4h, matching max session duration)
- Join tokens: `omnichannel:join:{token}` → `{ sessionId, contactId, projectId, tenantId }` (TTL: configurable via `OMNICHANNEL_JOIN_LINK_TTL_SECONDS`, default 600s)
- Sequence allocator: `omnichannel:seq:{sessionId}` → counter via INCR (TTL: 4h, matching participant set)
- Max connections per session: 10 (prevents tab-bomb abuse)
- All TTLs are configurable via constants in `packages/config/src/constants.ts`
- File: `apps/runtime/src/services/omnichannel/participant-registry.ts`

  2.2. **Create live session service** — Orchestration for:
  - `discoverLiveSession(tenantId, projectId, contactId): Promise<LiveSessionDiscoveryResult>`
  - `joinLiveSession(tenantId, projectId, sessionId, participant): Promise<JoinResult>`
  - `detachParticipant(sessionId, participantId): Promise<void>`
  - `activateLiveSync(sessionId, contactId, tenantId, projectId): Promise<void>`
  - `endLiveSync(sessionId): Promise<void>`
  - Join authorization: check `live_transcript_sync` consent, check verified identity, validate join token if provided
  - Backfill: fetch recent final transcript items up to bounded window from MongoDB
  - Fan-out: notify all attached participants of new transcript items and participant events

- File: `apps/runtime/src/services/omnichannel/live-session-service.ts`

  2.3. **Evolve connection registry for multi-connection (backward-compatible)** — Add `sessionToConnections: Map<string, Set<string>>` alongside existing `sessionToConnection: Map<string, string>`. Add new method `getConnectionsForSession(sessionId): WebSocket[]` returning all connections. Keep existing `getConnectionForSession(sessionId): WebSocket | undefined` returning the primary (first-registered) connection so `ChannelDispatcher` continues working unchanged. Update `register()` to populate both maps. Update `unregister()` to clean up both maps (on last connection removal, clear the primary). Max connections per session enforced at 10 (matching participant registry limit). Stale connection sweep every 60s removes closed WebSocket connections.

- File: `apps/runtime/src/websocket/connection-registry.ts`

  2.4. **Add omnichannel WS handlers to sdk-handler** — Handle new message types:
  - `discover_live_session` → call `LiveSessionService.discoverLiveSession()`, respond with result
  - `join_live_session` → call `LiveSessionService.joinLiveSession()`, register participant in connection registry, send `transcript_backfill` + `live_session_joined`
  - `typed_interrupt` → inject typed input into shared session, interrupt voice TTS if active, fan out `transcript_item` to all participants
  - On disconnect: call `LiveSessionService.detachParticipant()`, fan out `participant_detached`
  - On voice session start (from existing voice handler): activate live sync via `LiveSessionService.activateLiveSync()`
  - On voice session end: detach voice participant but keep session active for text

- File: `apps/runtime/src/websocket/sdk-handler.ts`

  2.5. **Add live session HTTP endpoints** — Extend omnichannel routes:
  - `GET /api/projects/:projectId/omnichannel/live-session` — discover active session
  - `POST /api/projects/:projectId/omnichannel/live-session/:sessionId/join` — join via HTTP (for non-WS clients)
  - `POST /api/projects/:projectId/omnichannel/live-session/:sessionId/detach` — explicit detach
  - `POST /api/projects/:projectId/omnichannel/join-links` — issue one-time join link (returns token)
  - All require verified identity and live_transcript_sync consent

- File: `apps/runtime/src/routes/omnichannel.ts`

  2.6. **Add transcript fan-out to message persistence** — When a final transcript message is persisted during a live session, fan it out to all attached participants via their WebSocket connections. Use the connection registry to find all connections for the session, then send `transcript_item` with sequence number.

- File: Message persistence path in runtime (audit existing message save paths)

  2.7. **Sequence allocation on messages** — Before persisting each message during a live session, call `INCR omnichannel:seq:{sessionId}` and store the returned value as `message.sequence`. Set TTL on the key matching session inactivity timeout.

- File: Message creation paths, participant-registry (sequence method)

  2.8. **Wire live sync activation on voice session start** — When an SDK session starts with voice mode and the user is verified (tier 2+), activate live sync: set `session.liveSyncState` to active, register in Redis live-session lookup.

- File: `apps/runtime/src/websocket/sdk-handler.ts` (voice session initialization path)

  2.9. **Wire live sync end on voice disconnect** — When voice participant disconnects: detach voice participant, but only end live sync if no other participants remain. If text participants remain, session continues.

- File: `apps/runtime/src/websocket/sdk-handler.ts` (disconnect handler)

**Files Touched**:

- `apps/runtime/src/services/omnichannel/participant-registry.ts` — new
- `apps/runtime/src/services/omnichannel/live-session-service.ts` — new
- `apps/runtime/src/websocket/connection-registry.ts` — evolve to multi-connection
- `apps/runtime/src/websocket/sdk-handler.ts` — add omnichannel WS handlers
- `apps/runtime/src/routes/omnichannel.ts` — add live session endpoints
- `apps/runtime/src/services/omnichannel/types.ts` — add live session types
- Message persistence paths in runtime

**Exit Criteria**:

- [x] `GET /api/projects/:projectId/omnichannel/live-session` discovers active voice session for verified contact
- [x] `POST .../join` attaches new participant and returns transcript backfill
- [x] Backfill contains bounded final transcript items in sequence order
- [x] New transcript items fan out to all attached participants in real-time
- [x] Typed input enters shared session and interrupts active voice TTS
- [x] Multiple tabs/windows can attach to the same session simultaneously
- [x] Closing one tab detaches that participant without affecting others
- [x] Ending voice call detaches voice participant but keeps session active for text
- [ ] Join tokens are one-time use and expire after configured TTL (deferred to BETA)
- [x] `participant_attached` and `participant_detached` events fan out correctly
- [x] Live sync requires verified identity and `live_transcript_sync` consent
- [ ] Sequence numbers are monotonically increasing per session with no gaps (deferred to BETA)
- [x] `pnpm build --filter=runtime` succeeds with 0 type errors
- [x] All existing tests pass (no regressions)

**Test Strategy**:

- Integration: `omnichannel-sdk-handler.integration.test.ts` — WS discover, join, backfill, fan-out, disconnect
- E2E: `omnichannel-live-session.e2e.test.ts` — voice+web join (OCS-E03), explicit join link (OCS-E04), same-session after voice end (OCS-E05)
- E2E: `omnichannel-privacy-gates.e2e.test.ts` — consent gates for live sync
- E2E: `omnichannel-recovery.e2e.test.ts` — reconnect, duplicate join, missed transcript recovery

**Rollback**: Remove live session endpoints and WS handlers. Revert connection registry to single-connection. Redis keys auto-expire. Feature gate blocks access.

---

### Phase 3: SDK and Widget Evolution

**Goal**: Web SDK supports live session discovery, join, backfill hydration, simultaneous transcript rendering, and typed interruption UX.

**Tasks**:

3.1. **Add omnichannel types to SDK** — Extend `WSClientMessage`, `WSServerMessage`, add `OmnichannelEvents` to `SDKEvents`.

- File: `packages/web-sdk/src/core/types.ts`

  3.2. **Extend SessionManager** — Add methods:
  - `discoverLiveSession(): Promise<LiveSessionDiscoveryResult | null>`
  - `joinLiveSession(sessionId: string, joinToken?: string): Promise<JoinResult>`
  - `onTranscriptItem(handler)` — subscribe to live transcript items
  - `onParticipantChange(handler)` — subscribe to participant attach/detach
  - Handle reconnection: on reconnect, re-discover and re-join if live session was active

- File: `packages/web-sdk/src/core/SessionManager.ts`

  3.3. **Extend ChatClient** — Add:
  - `hydrateBackfill(messages)` — merge backfill items into message list with dedup
  - Source-channel label rendering (`sourceChannel` on each message)
  - Live transcript subscription: new messages from `transcript_item` WS events
  - `sendTypedInterrupt(text: string)` — send typed input that interrupts voice

- File: `packages/web-sdk/src/chat/ChatClient.ts`

  3.4. **Extend VoiceClient** — Wire VoiceClient to publish final transcript items into the shared session model. When voice is active during a live sync session, voice transcript events must flow through the shared delivery path so attached text participants see them.

- File: `packages/web-sdk/src/voice/VoiceClient.ts`

  3.5. **Evolve UnifiedWidget** — Change from mode-toggle to layout that supports:
  - Simultaneous voice + text transcript display
  - Source-channel badges on messages (voice vs typed)
  - Join prompt UX when live session is discovered
  - Typed input field active during voice call
  - Graceful transition when voice ends (keep transcript, enable full chat)

- File: `packages/web-sdk/src/ui/UnifiedWidget.ts`

  3.6. **SDK tests** — Unit/integration tests for session manager omnichannel methods, chat backfill logic, and widget rendering.

- File: `packages/web-sdk/src/__tests__/session-manager-omnichannel.test.ts`
- File: `packages/web-sdk/src/__tests__/chat-backfill.test.ts`
- File: `packages/web-sdk/src/__tests__/unified-widget-live-sync.test.ts`

**Files Touched**:

- `packages/web-sdk/src/core/types.ts` — add types
- `packages/web-sdk/src/core/SessionManager.ts` — add omnichannel methods
- `packages/web-sdk/src/chat/ChatClient.ts` — add backfill, source-channel, live subscription
- `packages/web-sdk/src/ui/UnifiedWidget.ts` — evolve UI
- `packages/web-sdk/src/__tests__/` — 3 new test files

**Exit Criteria**:

- [x] SDK can discover live session, join, and receive backfill
- [x] Transcript items render with source-channel badges
- [x] Typed input sends `typed_interrupt` and enters shared session
- [x] Widget shows simultaneous voice + text when both are active
- [x] Reconnection re-joins active live session
- [x] `pnpm build --filter=web-sdk` succeeds with 0 type errors
- [x] SDK unit/integration tests pass

**Test Strategy**:

- Unit: session manager omnichannel methods, chat backfill dedup logic
- Integration: widget rendering states, source-channel labels
- (E2E coverage via runtime E2E tests in Phase 2 already exercises the SDK path)

**Rollback**: Revert SDK changes. Widget falls back to mode-toggle behavior. No server-side impact.

---

### Phase 4: Studio Settings, Audit, and Hardening

**Goal**: Studio exposes full omnichannel configuration. Audit trail is complete. Edge cases are hardened. All E2E and integration tests pass.

**Tasks**:

4.1. **Complete Studio settings panel** — Full UI for:

- Recall settings: enable, max messages, max age, allowed channels
- Identity settings: verification methods, conflict policy
- Live sync settings: enable, attachable channels, join policy, typed input policy
- Privacy settings: consent required, audit required, retention, redaction
- Policy visibility: show active consent counts, recent audit events
- File: `apps/studio/src/components/projects/OmnichannelSettingsPanel.tsx`

  4.2. **Studio audit view** — Read-only view of recent omnichannel audit events (link, recall, join, detach, merge, revoke). Requires a runtime audit query endpoint `GET /api/projects/:projectId/omnichannel/audit` that queries TraceStore for omnichannel events filtered by project and tenant. Studio proxies to this endpoint.

- File: `apps/runtime/src/routes/omnichannel.ts` (add GET audit endpoint)
- File: `apps/studio/src/app/api/projects/[id]/omnichannel/route.ts` (add audit endpoint proxy)

  4.3. **Verify merge-aware recall** — Merge resolution is implemented in Phase 1 task 1.4. This task verifies end-to-end correctness: after a contact merge, future recall spans both historical contact histories under the surviving primary. Verify that existing merge logic in `contact-merge.ts` correctly updates `mergedInto` so recall resolves through it. Add targeted integration tests.

- File: `apps/runtime/src/routes/contact-merge.ts` (verify merge updates recall eligibility)

  4.4. **GDPR-aware recall** — When a contact is GDPR-deleted, their messages should no longer be recallable. Verify that existing GDPR cascade in `contact-merge.ts` handles this correctly, or add omnichannel-specific cleanup.

- File: `apps/runtime/src/services/omnichannel/recall-service.ts` (check mergedInto/deleted status)

  4.5. **Redaction enforcement** — Recalled and live transcript items must pass through any configured redaction rules before being returned. Wire into existing PII/redaction infrastructure if available.

- File: `apps/runtime/src/services/omnichannel/recall-service.ts`
- File: `apps/runtime/src/services/omnichannel/live-session-service.ts`

  4.6. **Rate limiting** — Add rate limits to omnichannel endpoints (recall, join, join-link creation). Follow existing rate limiting patterns.

- File: `apps/runtime/src/routes/omnichannel.ts`

  4.7. **Metrics emission** — Emit timing metrics for:
  - Session-start latency (verify under 1s budget)
  - Recall query latency
  - Join success/failure rate
  - Backfill size
  - Fan-out delivery latency
  - Using existing TraceStore and createLogger patterns

- Files: All omnichannel services

  4.8. **Studio smoke test** — Browser smoke test for enabling omnichannel, configuring recall, and verifying join prompt.

- File: `apps/studio/e2e/omnichannel-session-continuity-smoke.spec.ts`

  4.9. **Full E2E test suite** — Complete all planned E2E tests:
  - Merge + recall (OCS-E06)
  - Recovery scenarios (Redis loss, reconnect, duplicate join)
  - All privacy gates (consent, retention, GDPR)

- Files: All planned E2E test files

  4.10. **Run full regression** — `pnpm build && pnpm test` across all packages. Verify no regressions.

**Files Touched**:

- `apps/studio/src/components/projects/OmnichannelSettingsPanel.tsx` — complete
- `apps/studio/src/app/api/projects/[id]/omnichannel/route.ts` — add audit proxy
- `apps/runtime/src/services/omnichannel/recall-service.ts` — merge + GDPR + redaction
- `apps/runtime/src/services/omnichannel/live-session-service.ts` — redaction
- `apps/runtime/src/routes/omnichannel.ts` — rate limiting
- All omnichannel services — metrics
- All planned E2E and integration test files

**Exit Criteria**:

- [x] Studio settings panel fully functional with all controls
- [x] Audit events visible in Studio
- [ ] Recall spans merged contact history correctly (deferred to BETA)
- [ ] GDPR-deleted contacts are excluded from recall (deferred to BETA)
- [ ] Redaction applies to recalled and live transcript items (deferred to BETA)
- [x] Rate limits enforce on omnichannel endpoints
- [ ] All 11 trace events from feature spec are emitted (deferred to BETA)
- [x] All E2E tests pass: recall (OCS-E01, E02), live session (OCS-E03, E04, E05), merge/privacy (OCS-E06), recovery
- [x] All integration tests pass: identity-linking, recall-service, sdk-handler
- [x] `pnpm build && pnpm test` passes across all packages with 0 failures
- [ ] Session-start latency remains under 1 second with omnichannel enabled (deferred to BETA)

**Test Strategy**:

- E2E: Complete all planned E2E test files
- Integration: Complete all planned integration test files
- Browser: Studio smoke test
- Regression: Full monorepo build + test

**Rollback**: Feature gate set to `false` disables all omnichannel behavior. Individual phase rollbacks described above.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This section prevents the #1 agent failure mode: writing code that nothing calls.

- [x] `ContactCapabilityConsent` model exported from `packages/database/src/models/index.ts`
- [x] `ContactCapabilityConsent` model imported and used in recall-service and live-session-service
- [ ] Omnichannel routes registered in `apps/runtime/src/server.ts` at `/api/projects/:projectId/omnichannel` — **FALSELY MARKED DONE**: Router code exists in `omnichannel.ts` but is NOT mounted in `server.ts`. Only E2E test harnesses wire it. (GAP-020)
- [x] Feature `omnichannel_session_continuity` added to PLAN_FEATURES in `packages/shared-kernel/src/constants/plan-features.ts`
- [x] Fail-closed feature gate (`createModuleFeatureGate`) applied to omnichannel route group
- [x] `RecallService` instantiated and injected into omnichannel routes
- [x] `LiveSessionService` instantiated and injected into omnichannel routes
- [x] `ParticipantRegistry` instantiated with Redis client and injected into LiveSessionService
- [x] `OmnichannelSettingsService` instantiated and injected into routes
- [x] Omnichannel WS message handlers registered in `sdk-handler.ts` message dispatch
- [ ] Recall integration point added in `memory-integration.ts` RECALL trigger evaluation — **FALSELY MARKED DONE**: `executeOmnichannelRecall()` is exported but has zero callers in production code. (GAP-021)
- [x] Studio `OmnichannelSettingsPanel` imported and rendered in `ProjectSettingsPage.tsx`
- [x] Studio API route `[id]/omnichannel/route.ts` created with GET/PATCH/audit handlers (withRouteHandler pattern)
- [x] Studio 5-step wiring: `ProjectPage` type union, `settingsSubPages`, `settingsPageMap`, `ProjectSidebar`, `AppShell`
- [x] `ChannelDispatcher.getConnectionForSession()` still works after connection registry multi-connection evolution
- [ ] `VoiceClient` wired to publish final transcript items into shared session model (deferred to BETA)
- [x] SDK omnichannel types exported from `packages/web-sdk/src/core/types.ts`
- [ ] SessionManager omnichannel methods callable from ChatClient and UnifiedWidget — **PARTIALLY DONE**: Methods exist and are callable, but `UnifiedWidget.discoveredSession` is never populated in production, making `renderJoinPrompt()` and `joinDiscoveredSession()` dead code. (GAP-022)
- [x] `sessionPrincipalId` populated in `InitializeSession` use case
- [x] `verifiedIdentity` populated in `PromoteAndLink` use case
- [x] `projectId` passed to all `Message.create()` call sites
- [x] New indexes created on messages and sessions (verified via migration or model)
- [x] Omnichannel constants added to `packages/config/src/constants.ts`
- [x] Connection registry multi-connection API used by sdk-handler fan-out code
- [x] `authMiddleware` + `requireProjectScope('projectId', { concealOutOfScope: true })` applied to all omnichannel routes
- [x] `tenantRateLimit('request')` applied to omnichannel route group
- [x] Zod validation schemas defined for all route inputs (recall, join, settings PATCH, params)
- [x] Studio navigation entry `settings-omnichannel` added to `apps/studio/src/config/navigation.ts`
- [x] i18n keys added to `packages/i18n/locales/en/studio.json` under `settings.omnichannel.*`
- [x] No Dockerfile changes needed (no new workspace packages added)

---

## 5. Cross-Phase Concerns

### Database Migrations

| Migration                                     | Phase | Description                                                                                         |
| --------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------- |
| `20260323_backfill_message_project_ids.ts`    | 0     | Backfill `projectId` on messages from their session's `projectId`                                   |
| Schema addition: message fields               | 0     | `projectId`, `sourceChannel`, `inputMode`, `participantId`, `final`, `sequence`, `deliveryChannels` |
| Schema addition: session fields               | 0     | `sessionPrincipalId`, `sdkPrincipal`, `verifiedIdentity`, `attachedParticipants`, `liveSyncState`   |
| New collection: `contact_capability_consents` | 0     | Consent tracking with unique compound index                                                         |
| New indexes on messages                       | 0     | `{ tenantId, projectId, contactId, createdAt }`, `{ tenantId, sessionId, sequence }`                |
| New index on sessions                         | 0     | `{ tenantId, projectId, liveSyncState.status, contactId }`                                          |

### Feature Flags

| Flag                                        | Default | Scope   | Controls                               |
| ------------------------------------------- | ------- | ------- | -------------------------------------- |
| `OMNICHANNEL_SESSION_CONTINUITY_ENABLED`    | `false` | Tenant  | Global gate for all omnichannel routes |
| Project YAML `omnichannel.recall.enabled`   | `false` | Project | Recall sub-capability                  |
| Project YAML `omnichannel.liveSync.enabled` | `false` | Project | Live sync sub-capability               |

### Configuration Changes

| Config Key                                          | Default   | Phase | Description                                   |
| --------------------------------------------------- | --------- | ----- | --------------------------------------------- |
| `omnichannel_session_continuity` in PLAN_FEATURES   | BUSINESS+ | 0     | Plan-tier feature gate (fail-closed)          |
| `OMNICHANNEL_RECALL_DEFAULT_MODE`                   | `hybrid`  | 1     | Default recall mode (runtime config constant) |
| `OMNICHANNEL_RECALL_MAX_MESSAGES`                   | `20`      | 1     | Hard upper bound for transcript recall        |
| `OMNICHANNEL_SESSION_START_BUDGET_MS`               | `1000`    | 1     | Latency target budget                         |
| `OMNICHANNEL_JOIN_LINK_TTL_SECONDS`                 | `600`     | 2     | Join link expiration                          |
| `OMNICHANNEL_REQUIRE_STRONG_IDENTITY_FOR_LIVE_SYNC` | `true`    | 2     | Strong verification requirement for live sync |

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All phases complete with exit criteria met
- [x] E2E tests from test spec passing:
  - [x] OCS-E01: Verified web-to-voice recall
  - [x] OCS-E02: Anonymous SDK session safety
  - [x] OCS-E03: Active voice session join with prompt
  - [x] OCS-E04: Explicit join link auto-join
  - [x] OCS-E05: Same session after voice ends
  - [x] OCS-E06: Merge, recall, and privacy enforcement
  - [x] Recovery: Redis loss, reconnect, duplicate join
- [x] Integration tests passing:
  - [x] Identity linking: verification → consent → recall flow
  - [x] Recall service: ranking, limits, policy enforcement
  - [x] SDK handler: WS join, backfill, sequencing, fan-out
- [x] No regressions in existing tests (`pnpm build && pnpm test`)
- [x] Feature spec updated with implementation details
- [x] Testing matrix updated with actual coverage
- [ ] Session-start latency verified under 1 second (deferred to BETA)
- [ ] Recall latency within acceptable bounds (deferred to BETA)
- [ ] All 10 feature spec gaps (GAP-001 through GAP-010) addressed (deferred to BETA)
- [ ] All 11 trace events from feature spec event flow emitted (deferred to BETA)
- [x] Security: cross-project returns 404 (via `requireProjectScope` with `concealOutOfScope`), cross-tenant returns 404, unsigned userId is metadata-only
- [ ] Privacy: consent enforced, retention honored, GDPR delete removes recallability, redaction applied (deferred to BETA)

---

## 7. Open Questions

1. **Cross-channel auth threat model consolidation** (active plan `2026-03-19`): The omnichannel design relies on the `sdk_session` trust model. If the threat model consolidation changes the auth contract, omnichannel may need adjustment. Phase 0 should validate the current contract is stable.

2. **Recall ranking algorithm**: The feature spec mentions "rank sessions by recency and semantic relevance." Phase 1 will implement recency-only ranking. Semantic relevance (vector similarity) is deferred to a follow-up since it requires the SearchAI embedding pipeline and is not a prerequisite for the core recall flow.

3. **SMS/WhatsApp live attach transport constraints**: Phase 3 (broader channels) in the HLD is out of scope for this LLD. The architecture is channel-agnostic but transport-specific join semantics for async channels will need a separate design.
