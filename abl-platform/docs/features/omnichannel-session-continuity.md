# Feature: Omnichannel Session Continuity

**Status**: ALPHA
**Package(s)**: `apps/runtime`, `packages/web-sdk`, `apps/studio`, `packages/database`, `packages/compiler`, `packages/shared-auth`, `packages/shared-kernel`
**Last Updated**: 2026-04-23

---

## 1. Overview

Omnichannel Session Continuity is the platform feature that lets an identified customer move between channels without losing conversation continuity. It has two related parts. Part 1 provides project-scoped cross-channel recall so a later session can retrieve relevant prior discussion for the same verified contact. Part 2 extends the same foundation into a shared live session so an in-progress voice conversation can also appear in an attached text surface with the same agent, same session, and same transcript.

The feature assumes Session Scope Enforcement is the canonical boundary for session provenance. Omnichannel decisions consume a validated `ProductionExecutionScope` carrying `sessionPrincipalId`, `subject`, `actor`, `identityEvidence`, `source`, and `traceId`. Identity Verification then strengthens that envelope by registering project-safe session-resolution records instead of returning a bare `sessionId` from a tenant-only lookup.

The design intentionally separates three concepts that are currently easy to conflate. The **channel auth principal** is established by trusted channel ingress, such as a runtime-issued `sdk_session`, and is the source of truth for `tenantId`, `projectId`, `channelId`, and granted capabilities. The **session principal** is always runtime-generated and unique. The **verified end-user identity** is optional, but it must be strongly verified before it can influence recall, reusable cross-session or cross-channel resume, ownership, or live-session join authorization. Provider verification is policy-driven: weak tier 1 by default, with an optional strong tier 2 classification for explicitly trusted channels/providers. Weak provider verification remains a same-channel continuity aid only and does not widen recall or live-session authorization. Anonymous SDK users remain fully supported, but only at session scope.

This feature builds on the platform’s existing contact, session, and message foundations, while tightening project isolation and privacy boundaries. The agreed default behavior is a hybrid recall model: contact facts and preferences are preloaded at session start, transcript recall is on demand, and the SDK may request narrower behavior but cannot exceed project or channel policy. For live sync, the platform only exposes final transcript text, typed input interrupts voice playback, the same shared session continues after the call ends, and multiple attached web surfaces may participate in that same session.

### Key Capabilities

- Project-scoped cross-channel recall for the same verified contact
- Hybrid memory loading with eager facts and on-demand transcript recall
- Runtime-trusted `sdk_session` as the source of truth for tenant, project, channel, and granted capabilities
- Anonymous SDK access that remains safe by binding grants to session scope instead of reusable identity
- Project-safe verification provenance that ties continuity decisions back to `sessionPrincipalId`, verification attempt, and policy source
- Explicit verification and confirmation before a session is linked to a contact, except for policy-driven provider-verified continuity: weak tier 1 may stay same-channel only, while explicitly trusted provider verification may be treated as strong tier 2
- Strong verified identity requirement for live transcript sync and session join
- Auto-join via explicit verified join links, otherwise prompt-to-join behavior
- Final-transcript-only live sync with typed input interrupting voice TTS
- Same-session continuity after voice ends and multi-tab attachment support
- Mandatory consent, retention, redaction, audit, tenant isolation, and project isolation gates

---

## 2. How to Consume

### Studio UI

Studio should expose Omnichannel Session Continuity as a project-level capability rather than a tenant-global toggle. The builder flow is expected to include:

- an Omnichannel settings panel on the project configuration surface
- recall controls for enablement, channel allowlist, and bounded recall policy
- verification controls for approved strong-verification methods such as OTP, OAuth, email link, or signed identity envelopes
- live-sync controls for attachable channels, join-link behavior, transcript policy, and interrupt behavior
- policy visibility for consent, retention, audit, and redaction requirements

The SDK-facing portion of the feature should also be configurable per channel, but channel settings must remain narrower than project policy. For example, an SDK integration may choose to disable live transcript sync or request a stricter recall mode, but it must not widen recall scope or bypass strong-verification requirements.

### API (Runtime)

The runtime contract is intentionally split between channel authentication, identity verification, and session attachment. Existing routes provide part of the foundation; omnichannel-specific routes complete the feature.

| Method | Path                                                                  | Purpose                                                                                                                                                                                                             | Wired                                                                           |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/api/v1/sdk/init`                                                    | Existing foundation. Exchanges a public SDK key for a runtime-trusted `sdk_session` token that anchors tenant, project, channel, and granted capabilities                                                           | YES — registered in server.ts                                                   |
| POST   | `/api/identity/verify/initiate`                                       | Implemented (ALPHA). Initiates OTP, HMAC, email-link, OAuth, provider, or webhook verification for a session                                                                                                        | YES — registered in server.ts                                                   |
| POST   | `/api/identity/verify/complete`                                       | Implemented (ALPHA). Completes verification by delegating to the correct verifier via attempt method lookup and should update the project-safe session-resolution record                                            | YES — registered in server.ts                                                   |
| GET    | `/api/identity/verify/:attemptId`                                     | Implemented (ALPHA). Reads verification status from the Redis-backed token store for the same project/session scope                                                                                                 | YES — registered in server.ts                                                   |
| POST   | `/api/contacts/:id/link-session`                                      | Existing foundation. Explicitly links a verified session to a known contact                                                                                                                                         | YES — registered in server.ts                                                   |
| GET    | `/api/contacts/:id/history`                                           | Existing foundation to evolve into project-safe history access and recall candidate inspection                                                                                                                      | YES — registered in server.ts                                                   |
| POST   | `/api/contacts/manage/merge`                                          | Existing foundation. Merges duplicate contacts so future recall can span unified history                                                                                                                            | YES — registered in server.ts                                                   |
| GET    | `/api/projects/:projectId/omnichannel/live-session`                   | Implemented (ALPHA). Discovers active live session for verified contact                                                                                                                                             | NO — router not mounted in server.ts (GAP-020). Only E2E test harnesses wire it |
| POST   | `/api/projects/:projectId/omnichannel/live-session/:sessionId/join`   | Implemented (ALPHA). Attaches verified text participant to active shared session                                                                                                                                    | NO — router not mounted in server.ts (GAP-020)                                  |
| POST   | `/api/projects/:projectId/omnichannel/live-session/:sessionId/detach` | Implemented (ALPHA). Detaches a participant from a live session                                                                                                                                                     | NO — router not mounted in server.ts (GAP-020)                                  |
| POST   | `/api/projects/:projectId/omnichannel/recall`                         | Implemented (ALPHA). Bounded transcript recall with consent, identity, and project-scope checks                                                                                                                     | NO — router not mounted in server.ts (GAP-020). Zero HTTP callers in production |
| POST   | `/api/projects/:projectId/omnichannel/join-links`                     | Implemented (ALPHA). Issues one-time join link token for verified identities                                                                                                                                        | NO — router not mounted in server.ts (GAP-020)                                  |
| GET    | `/api/projects/:projectId/omnichannel/audit`                          | Implemented (ALPHA). Queries recent omnichannel audit events from in-memory ring buffer                                                                                                                             | NO — router not mounted in server.ts (GAP-020)                                  |
| WS     | `/ws/sdk`                                                             | Implemented (ALPHA). Auth uses `Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>` and the socket supports discover_live_session, join_live_session, typed_interrupt, transcript fan-out, and participant events | YES — WS handlers registered in sdk-handler.ts                                  |

> **Wiring status convention**: "YES" means the endpoint is reachable from production server startup. "NO" means the code exists but is not mounted/called in the production entry point (`server.ts`). E2E tests mount these routes in their own test harnesses, so tests pass even when production wiring is missing.

### API (Studio)

Studio is expected to own the control-plane configuration for this feature.

| Method | Path                                              | Purpose                                                                                           | Wired                                                                                                 |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/omnichannel`            | Implemented (ALPHA). Read project-level omnichannel settings via runtime proxy                    | PARTIAL — Studio BFF route exists, proxies to runtime; runtime route exists but not mounted (GAP-020) |
| PATCH  | `/api/projects/:projectId/omnichannel`            | Implemented (ALPHA). Update recall, verification, consent, and live-sync policy via runtime proxy | PARTIAL — Studio BFF route exists, proxies to runtime; runtime route exists but not mounted (GAP-020) |
| GET    | `/api/projects/:projectId/omnichannel/audit`      | Implemented (ALPHA). View project-scoped audit activity via runtime proxy                         | PARTIAL — Studio BFF route exists but no UI component renders audit data (GAP-023)                    |
| POST   | `/api/projects/:projectId/omnichannel/join-links` | PLANNED. Studio proxy not yet created (runtime endpoint exists)                                   | NO — neither Studio BFF route nor UI exists                                                           |

### Admin Portal

No dedicated admin-only Omnichannel UI is required for the first rollout. Governance should rely on:

- project-scoped settings in Studio
- tenant feature gating
- audit visibility for recall access and live-session joins
- existing contact-merge and GDPR deletion workflows

### Channel Integration

The architecture should treat all channels as attachable participants, even if the rollout sequence begins with voice plus web and mobile chat.

| Channel                   | Part 1 Recall | Part 2 Live Attach   | Notes                                                                                                   |
| ------------------------- | ------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| Web chat                  | Full          | Full                 | Primary text surface for transcript viewing and typed interruption                                      |
| Mobile chat / in-app chat | Full          | Full                 | Same participant model as web chat                                                                      |
| Voice call                | Full          | Full                 | Originating live session for transcript sync and voice playback                                         |
| SMS                       | Full          | Planned              | Can participate in project-scoped recall immediately; live attach depends on async delivery constraints |
| WhatsApp                  | Full          | Planned              | Strong identity can come from verified channel identity; live attach depends on transport capabilities  |
| Slack / MS Teams          | Full          | Planned              | Treated as verified channel identities when tenant trust is configured                                  |
| A2A / server-to-server    | Scoped        | Not a primary target | Can leverage recall via verified identity but is not a first-wave live transcript surface               |

---

## 3. Data Model

### Collections / Tables

```
Collection: contacts (existing collection, extended usage)
Key fields:
  - _id: string
  - tenantId: string (required, indexed)
  - encryptedIdentities: Array<{ type, normalizedHash, encryptedValue, verifiedAt?, sourceChannel? }>
  - mergedInto: string | null
  - contactContext: { preferences, dataValues, lastDisposition } | null
  - channelHistory: Array<{ channel, sessionCount, lastSeenAt }>
Indexes:
  - existing tenant + identity indexes remain
Notes:
  - Contact linkage is only allowed after explicit verification and confirmation, except for policy-driven provider verification: weak tier 1 may preserve same-channel continuity, and explicitly trusted provider verification may count as strong tier 2
  - Project-scoped recall uses the contact as the identity anchor but still filters by project
```

```
Collection: sessions (existing collection, planned additions)
Key fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - contactId: string | null
  - channel: string
  - channelArtifact: Record<string, unknown> | null
  - identityTier: number
  - verificationMethod: string
  - sessionPrincipalId: string (planned, required)
  - sdkPrincipal: { channelId, permissions, grantedCapabilities } | null (implemented)
  - verifiedIdentity: { contactId, method, strength, verifiedAt, verificationAttemptId, policySource, grantScope } | null (implemented)
  - identityEvidenceSummary: { identityTier, verificationMethod, verificationAttemptId?, verifiedAt?, policySource, grantScope } | null (planned)
  - attachedParticipants: Array<{ participantId, channel, mode, interactive, attachedAt, detachedAt? }> (implemented)
  - liveSyncState: { status, joinMode, transcriptMode, lastSequence } | null (implemented)
Indexes:
  - { tenantId: 1, projectId: 1, contactId: 1, updatedAt: -1 }
  - { tenantId: 1, projectId: 1, "liveSyncState.status": 1, contactId: 1 } (implemented)
Notes:
  - Session principal is always runtime-generated
  - Anonymous SDK users remain fully valid sessions even without verifiedIdentity
```

```
Collection: messages (existing collection, planned additions)
Key fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (planned, required, indexed)
  - sessionId: string (required, indexed)
  - contactId: string | null
  - role: 'user' | 'assistant' | 'tool' | 'system'
  - channel: string
  - sourceChannel: string (implemented)
  - inputMode: 'voice' | 'typed' | 'tool' | 'system' (implemented)
  - participantId: string | null (implemented)
  - final: boolean (planned, default true for persisted transcript recall)
  - sequence: number (implemented)
  - deliveryChannels: string[] (implemented)
  - content: normalized message payload
Indexes:
  - { tenantId: 1, projectId: 1, contactId: 1, createdAt: -1 } (implemented)
  - { tenantId: 1, sessionId: 1, sequence: 1 } (implemented)
Notes:
  - Project scoping on messages is required to keep recall safe
  - Recall only consumes final transcript items and bounded windows
```

```
Collection: contact_capability_consents (implemented)
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - contactId: string (required, indexed)
  - capability: 'cross_channel_recall' | 'live_transcript_sync'
  - state: 'granted' | 'revoked'
  - grantedBy: string
  - grantedAt: Date
  - revokedAt: Date | null
  - policyVersion: string
Indexes:
  - { tenantId: 1, projectId: 1, contactId: 1, capability: 1 } (unique)
```

<!-- prettier-ignore-start -->
```
Collection: omnichannel_project_settings (implemented — separate model, not embedded in ProjectSettings)
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed, unique with tenantId)
  - recall: { enabled, maxMessages, maxAgeDays, allowedChannels, mode }
  - identity: { requireVerification, identityTier, verificationMethods }
  - consent: { requireExplicit, capabilities, policyVersion }
  - liveSync: { enabled, maxParticipants, joinMode, transcriptMode }
  - retention: { maxRetentionDays (default 90), enableAutoPurge (default false) }
Indexes:
  - { tenantId: 1, projectId: 1 } (unique)
Notes:
  - Deviation from LLD: created as separate Mongoose model (not embedded in ProjectSettings) for cleaner domain separation
  - Defaults are applied at read time when no document exists
```

```
Redis / ephemeral state (implemented)
Keys:
  - omnichannel:live:{tenantId}:{projectId}:{contactId} -> active shared session lookup
  - omnichannel:join:{token} -> one-time verified join link
  - omnichannel:participants:{sessionId} -> attached participants set
  - omnichannel:seq:{sessionId} -> transcript sequence allocator
Notes:
  - Redis is authoritative for live participant attachment, not pod-local memory
```
<!-- prettier-ignore-end -->

### Key Relationships

- `sdk_session` establishes the channel auth principal and is the authoritative source for `tenantId`, `projectId`, `channelId`, and granted capabilities
- `sessionPrincipalId` is always unique to a runtime session and remains valid even when the user is anonymous
- `verifiedIdentity` is optional and must be strongly verified before it can authorize recall, reusable cross-session resume, or live attach; provider verification is weak tier 1 by default, and only explicitly trusted provider verification may count as strong tier 2
- identity verification should register a project-safe session-resolution record that carries `sessionLocator`, `sessionPrincipalId`, `verificationAttemptId`, `verifiedAt`, `policySource`, `grantScope`, and `traceId`
- `contactId + projectId` is the boundary for transcript recall
- `messages` are the recall substrate, while `contactContext` remains the eager fact and preference preload substrate
- multiple attached participants can share one session principal during live sync

---

## 4. Key Implementation Files

### Domain / Core Logic

| File                                                                                                 | Purpose                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/database/src/models/contact.model.ts`                                                      | Existing contact identity, merge, and contact-context foundation                                |
| `packages/database/src/models/session.model.ts`                                                      | Existing session metadata foundation for contact linkage and channel artifacts                  |
| `packages/database/src/models/message.model.ts`                                                      | Existing message persistence foundation; planned project-scoped recall fields belong here       |
| `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`                            | Existing session bootstrap and eager contact-context preload                                    |
| `apps/runtime/src/contexts/orchestration/use-cases/switch-channel.ts`                                | Existing channel-switch orchestration that should evolve into project-safe continuity logic     |
| `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`                              | Existing promotion and link flow for mid-session identity upgrade                               |
| `apps/runtime/src/contexts/contact/use-cases/link-session-to-contact.ts`                             | Existing explicit session-contact linking flow that must update both session and contact state  |
| `apps/runtime/src/services/contact-context-service.ts`                                               | Existing fact and preference loading foundation                                                 |
| `apps/runtime/src/services/execution/memory-integration.ts`                                          | Existing memory preload wiring that should remain separate from transcript recall               |
| `apps/runtime/src/services/omnichannel/recall-service.ts`                                            | Bounded transcript recall with consent, merged contacts, GDPR filter, PII redaction, 64KB limit |
| `apps/runtime/src/services/omnichannel/live-session-service.ts`                                      | Shared-session discover, join, detach, activate/end with consent and identity checks            |
| `apps/runtime/src/services/omnichannel/participant-registry.ts`                                      | Redis-backed participant set, join tokens (atomic Lua), sequence allocator, TTL management      |
| `apps/runtime/src/services/omnichannel/transcript-fanout.ts`                                         | Real-time transcript and participant event fan-out to all session connections                   |
| `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`                                         | Audit event emission (11 types) with in-memory ring buffer for query endpoint                   |
| `apps/runtime/src/services/omnichannel/omnichannel-settings-service.ts`                              | OmnichannelProjectSettings CRUD with dot-notation nested updates                                |
| `apps/runtime/src/services/omnichannel/types.ts`                                                     | Shared types for all omnichannel services                                                       |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/configurable-oauth-provider-adapter.ts` | Generic OAuth 2.0 provider adapter with PKCE for configurable OAuth identity verification       |
| `apps/runtime/src/contexts/identity/domain/identity-tier.ts`                                         | VERIFICATION_TIER_MAP mapping VerificationMethod → IdentityTier (0/1/2)                         |
| `packages/database/src/cascade/cascade-delete.ts`                                                    | GDPR cascade delete — includes ContactCapabilityConsent and OmnichannelProjectSettings cleanup  |

### Routes / Handlers

| File                                                        | Purpose                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/sdk-init.ts`                       | Existing SDK channel-auth entry point for `sdk_session` issuance                                  |
| `apps/runtime/src/routes/identity-verification.ts`          | Existing verification start/status route set with planned completion wiring                       |
| `apps/runtime/src/routes/contacts.ts`                       | Existing contact link and history foundation; requires project-safe history behavior              |
| `apps/runtime/src/routes/contact-merge.ts`                  | Existing merge and GDPR foundations for contact unification and erasure                           |
| `apps/runtime/src/websocket/sdk-handler.ts`                 | Existing SDK WebSocket handler that must gain join, backfill, and multi-participant support       |
| `apps/runtime/src/websocket/sdk-handler-contact-linking.ts` | Existing SDK contact-linking flow that must support stronger verification semantics               |
| `apps/runtime/src/websocket/connection-registry.ts`         | Extended with multi-connection support (sessionToConnections Map), stale sweep, per-session limit |
| `apps/runtime/src/channels/session-resolver.ts`             | Existing channel resolution logic that must normalize identity artifacts across channels          |
| `apps/runtime/src/channels/adapters/vxml-adapter.ts`        | Existing voice adapter touchpoint for normalized caller identity artifacts                        |
| `apps/runtime/src/routes/omnichannel.ts`                    | Runtime routes: recall, settings, audit, live-session discover/join/detach, join-links            |
| `apps/runtime/src/server.ts`                                | Production entry point — omnichannel router must be mounted here to be reachable (GAP-020)        |

### UI Components (Studio)

| File                                                                 | Purpose                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/web-sdk/src/core/SessionManager.ts`                        | Existing SDK session bootstrap that must align to token-based join and resume flows                          |
| `packages/web-sdk/src/chat/ChatClient.ts`                            | Existing chat client that must add backfill, source-channel labeling, and shared-session participation       |
| `packages/web-sdk/src/voice/VoiceClient.ts`                          | Existing voice client that already emits transcript events and must participate in shared delivery semantics |
| `packages/web-sdk/src/ui/UnifiedWidget.ts`                           | Existing widget that must evolve from mode toggle into simultaneous transcript-plus-input UI                 |
| `packages/web-sdk/src/core/types.ts`                                 | Existing client contract types that need source-channel and participant metadata                             |
| `apps/studio/src/app/api/projects/[id]/omnichannel/route.ts`         | Studio API proxy for GET/PATCH omnichannel settings                                                          |
| `apps/studio/src/app/api/projects/[id]/omnichannel/audit/route.ts`   | Studio API proxy for audit event queries                                                                     |
| `apps/studio/src/components/projects/OmnichannelSettingsPanel.tsx`   | Studio settings panel with 4 sections: recall, identity, consent, liveSync                                   |
| `apps/studio/src/config/navigation.ts`                               | Navigation wiring for omnichannel settings page                                                              |
| `packages/database/src/models/omnichannel-project-settings.model.ts` | OmnichannelProjectSettings Mongoose model with nested subdocuments and tenant isolation                      |
| `packages/database/src/models/contact-capability-consent.model.ts`   | ContactCapabilityConsent model for per-contact, per-capability consent tracking                              |

### Tests

| File                                                                                       | Type               | Count    |
| ------------------------------------------------------------------------------------------ | ------------------ | -------- |
| `apps/runtime/src/__tests__/contexts/orchestration/initialize-session-prepopulate.test.ts` | integration        | existing |
| `apps/runtime/src/__tests__/contexts/orchestration/switch-channel.test.ts`                 | integration        | existing |
| `apps/runtime/src/__tests__/contexts/orchestration/promote-and-link.test.ts`               | integration        | existing |
| `apps/runtime/src/__tests__/session-resolver.test.ts`                                      | unit / integration | existing |
| `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`                                        | integration        | existing |
| `apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts`                                | e2e                | 11 tests |
| `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`                          | e2e                | 12 tests |
| `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`                         | e2e                | 5 tests  |
| `apps/runtime/src/__tests__/omnichannel-recall-service.integration.test.ts`                | integration        | 9 tests  |
| `apps/runtime/src/__tests__/omnichannel-identity-linking.integration.test.ts`              | integration        | 6 tests  |
| `packages/web-sdk/src/__tests__/session-manager-omnichannel.test.ts`                       | unit               | 13 tests |
| `packages/web-sdk/src/__tests__/chat-backfill.test.ts`                                     | unit               | 13 tests |
| `packages/web-sdk/src/__tests__/unified-widget-live-sync.test.ts`                          | unit               | 18 tests |
| `apps/runtime/src/__tests__/omnichannel-identity-verification.e2e.test.ts`                 | e2e                | 12 tests |
| `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`                         | e2e                | 6 tests  |
| `apps/studio/src/__tests__/omnichannel-settings-panel.test.tsx`                            | unit               | 10 tests |

---

## 5. Configuration

### Environment Variables

The feature should prefer existing feature-gate infrastructure over a large bespoke env-var surface, but a few rollout and budget controls are expected.

| Variable                                            | Default  | Description                                                                             |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `OMNICHANNEL_SESSION_CONTINUITY_ENABLED`            | `false`  | Global runtime feature gate for development and phased rollout                          |
| `OMNICHANNEL_RECALL_DEFAULT_MODE`                   | `hybrid` | Default runtime recall mode when project settings are absent                            |
| `OMNICHANNEL_RECALL_MAX_MESSAGES`                   | `20`     | Hard upper bound for transcript recall injection                                        |
| `OMNICHANNEL_SESSION_START_BUDGET_MS`               | `1000`   | Session-start latency target budget for eager work                                      |
| `OMNICHANNEL_JOIN_LINK_TTL_SECONDS`                 | `600`    | One-time join-link expiration for explicit live-session auto-join                       |
| `OMNICHANNEL_REQUIRE_STRONG_IDENTITY_FOR_LIVE_SYNC` | `true`   | Enforces strong verification before live-session discovery and join                     |
| `IDENTITY_OAUTH_AUTHORIZATION_ENDPOINT`             | —        | OAuth 2.0 authorization endpoint URL (enables OAuth verifier when all 6 OAuth vars set) |
| `IDENTITY_OAUTH_TOKEN_ENDPOINT`                     | —        | OAuth 2.0 token endpoint URL                                                            |
| `IDENTITY_OAUTH_USERINFO_ENDPOINT`                  | —        | OAuth 2.0 / OIDC userinfo endpoint URL                                                  |
| `IDENTITY_OAUTH_CLIENT_ID`                          | —        | OAuth client ID registered with the provider                                            |
| `IDENTITY_OAUTH_CLIENT_SECRET`                      | —        | OAuth client secret                                                                     |
| `IDENTITY_OAUTH_REDIRECT_URI`                       | —        | OAuth redirect URI registered with the provider                                         |

### Runtime Configuration

Project-level configuration should be the primary control surface:

```yaml
omnichannel:
  enabled: true
  recall:
    enabled: true
    scope: project
    factsPreload: true
    transcriptMode: on_demand
    maxMessages: 20
    maxAgeDays: 30
    allowedChannels: [web, mobile, voice, sms, whatsapp, slack, teams]
  identity:
    explicitVerificationRequired: true
    strongMethods: [otp, oauth, email_link, hmac, provider]
    unsignedUserIdMode: metadata_only
    conflictPolicy: fail_closed
  liveSync:
    enabled: true
    attachableChannels: [web, mobile, sms, whatsapp, slack, teams]
    transcriptMode: final_only
    joinPolicy:
      autoJoinWithVerifiedLink: true
      otherwisePrompt: true
    typedInputPolicy: interrupt_tts
    continueSameSessionAfterVoiceEnd: true
    allowMultipleParticipants: true
  privacy:
    consentRequired: true
    auditRequired: true
    retentionEnforced: true
    redactionEnforced: true
```

The SDK may request narrower behavior inside the granted capability envelope. It must never widen recall scope, skip required consent, or bypass strong-verification policy.

### DSL / Agent IR

The current IR has memory primitives but not a dedicated omnichannel contract. A project-scoped omnichannel block is expected:

```yaml
omnichannel:
  enabled: true
  recall:
    mode: hybrid
    max_messages: 20
    on_demand_tool: true
  verification:
    require_explicit_confirmation: true
    strong_methods: [otp, oauth, hmac]
  live_sync:
    enabled: true
    transcript_mode: final_only
    typed_input_behavior: interrupt_tts
    continue_same_session: true
```

---

## 6. Runtime Integration

The runtime integration is based on principal separation and fail-closed authorization.

### Lifecycle

1. Channel ingress authenticates first. For SDK traffic, `POST /api/v1/sdk/init` produces a runtime-trusted `sdk_session` that carries `tenantId`, `projectId`, `channelId`, and granted capabilities.
2. The runtime creates a unique session principal for the conversation. This remains valid even when no verified end-user identity exists.
3. Any caller-provided `userContext.userId` is treated as personalization metadata unless it arrives inside a trusted signed identity mechanism.
4. Identity verification runs through explicit flows such as OTP, OAuth, email link, or provider-verifier integration.
5. Successful verification registers a project-safe session-resolution record with `sessionLocator`, `sessionPrincipalId`, `verificationAttemptId`, `verifiedAt`, `policySource`, `grantScope`, and `traceId`.
6. Only after explicit verification and user confirmation may the session link to a contact and backfill pre-link messages.
7. At session start, the runtime eagerly preloads bounded `contactContext` facts and preferences so startup remains under the one-second budget.
8. Transcript recall remains lazy. When the agent or user asks about prior conversation, the runtime retrieves bounded final transcript snippets from prior project-scoped sessions for the same verified contact.
9. If a verified user opens another surface during an active live session, the runtime discovers the active session and either auto-joins from an explicit verified link or prompts the user to join.
10. All attached participants receive final transcript events from the same shared session. Typed input enters the shared session and interrupts active voice playback.
11. If the voice call ends, the session remains active and continues as the same text-capable session.

### Dependencies

| Service / Module                       | Purpose                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `sdk_session` auth middleware          | Channel-scoped trust anchor for tenant, project, channel, and capability scope     |
| Identity verifier implementations      | Strong end-user verification before linking or live attach                         |
| Contact repository and merge flows     | Contact resolution, linking, merge, and GDPR deletion                              |
| Session service and conversation store | Session creation, continuation, and backfill updates                               |
| Message store and recall service       | Project-safe transcript retrieval and ranking                                      |
| Redis-backed participant registry      | Shared-session presence, join links, sequence allocation, and fan-out coordination |
| Trace store and audit log              | Operational visibility and compliance evidence                                     |
| Web SDK clients                        | Join, backfill, channel badges, transcript rendering, and typed interruption UX    |

### Event Flow

| Event Type                        | When Emitted                                         | Key Data                                         |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `sdk_session_issued`              | Channel auth completes                               | tenantId, projectId, channelId, capabilities     |
| `session_principal_created`       | New session starts                                   | sessionId, sessionPrincipalId, channel           |
| `identity_verification_initiated` | Verification flow starts                             | method, identityType, sessionId                  |
| `identity_verified`               | Strong verification completes                        | method, strength, verifiedIdentityRef            |
| `session_linked_to_contact`       | Session is explicitly linked                         | sessionId, contactId, verificationMethod         |
| `omnichannel_recall_requested`    | Agent or user requests prior-discussion recall       | sessionId, contactId, recallPolicy               |
| `omnichannel_recall_returned`     | Recall snippets are ranked and returned              | matchedSessionIds, returnedMessages, tokenBudget |
| `live_session_discovered`         | Verified secondary surface checks for active session | sessionId, joinMode                              |
| `live_session_joined`             | Additional participant attaches                      | sessionId, participantId, sourceChannel          |
| `transcript_item_persisted`       | Final transcript message is committed                | sessionId, sequence, sourceChannel               |
| `typed_input_interrupted_tts`     | Typed turn interrupts voice playback                 | sessionId, participantId                         |
| `live_session_detached`           | Participant disconnects                              | sessionId, participantId, sourceChannel          |

---

## 7. Admin Integration

Admin integration is primarily governance and compliance, not a separate runtime path.

- Tenant feature gates should control whether a project can enable cross-channel recall or live transcript sync
- Audit tooling should expose session-link, recall-access, join, detach, merge, revoke-consent, and GDPR-delete events
- Existing contact-management workflows should remain the path for manual merge and erasure
- No admin override should bypass project isolation or strong-verification requirements

---

## 8. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                             | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Transcript recall is not implemented yet; current memory behavior is fact-oriented rather than transcript-oriented                                                                                      | High     | Mitigated |
| GAP-002 | Message recall is not safely project-scoped because persisted message history lacks a dedicated `projectId` field                                                                                       | High     | Mitigated |
| GAP-003 | Identity verification completion is mounted with stub dependencies and not fully wired to contact linking                                                                                               | High     | Mitigated |
| GAP-004 | Session-to-contact linking is split across multiple paths and does not consistently update both session state and contact history                                                                       | High     | Open      |
| GAP-005 | SDK contact linking is asynchronous enough that early persisted messages can race ahead of finalized contact linkage                                                                                    | High     | Open      |
| GAP-006 | SDK live-session contract does not expose join, backfill, or multi-participant semantics today                                                                                                          | High     | Mitigated |
| GAP-007 | WebSocket connection registry is currently one session to one connection, which blocks multi-subscriber transcript fan-out                                                                              | High     | Mitigated |
| GAP-008 | `UnifiedWidget` currently toggles between chat and voice instead of rendering a simultaneous shared transcript surface                                                                                  | Medium   | Mitigated |
| GAP-009 | Voice channel identity normalization differs across adapters, which can break cross-channel resolution                                                                                                  | Medium   | Mitigated |
| GAP-010 | The current feature set does not yet define or persist an omnichannel-specific policy block in the IR                                                                                                   | Medium   | Mitigated |
| GAP-011 | Audit events are stored in an in-memory ring buffer (lost on restart); persistent audit storage not yet implemented                                                                                     | Medium   | Open      |
| GAP-012 | SDK WS handlers for discover/join accept contactId from message payload as fallback (should be auth-only long term)                                                                                     | Low      | Open      |
| GAP-013 | E2E recovery tests (Redis loss, reconnect, duplicate joins) not yet implemented                                                                                                                         | Medium   | Open      |
| GAP-014 | 5 of 6 identity verifiers not wired in server.ts (only OTP was active; email_link, hmac, provider, webhook, oauth were stubs)                                                                           | High     | Mitigated |
| GAP-015 | No retention enforcement — recall maxAgeDays was unbounded by compliance retention window                                                                                                               | Medium   | Mitigated |
| GAP-016 | GDPR cascade missing omnichannel model cleanup (ContactCapabilityConsent, OmnichannelProjectSettings not in deleteTenant/deleteProject)                                                                 | High     | Mitigated |
| GAP-017 | SDK token signing secret mismatch in 3 E2E test files (local constants vs shared harness secret)                                                                                                        | Medium   | Mitigated |
| GAP-018 | No test coverage for Studio OmnichannelSettingsPanel component                                                                                                                                          | Medium   | Mitigated |
| GAP-019 | No E2E test coverage for identity verification round-trip (initiate → complete → status)                                                                                                                | High     | Mitigated |
| GAP-020 | Omnichannel HTTP router not mounted in `apps/runtime/src/server.ts` — all `/api/projects/:projectId/omnichannel/*` endpoints are unreachable in production. Only E2E test harnesses wire the router.    | Critical | Open      |
| GAP-021 | `executeOmnichannelRecall()` in `memory-integration.ts` is exported but never called from any production code path — the agent IR recall trigger is dead code                                           | High     | Open      |
| GAP-022 | SDK `UnifiedWidget.discoveredSession` property is never populated in production — `renderJoinPrompt()` and `joinDiscoveredSession()` are dead code                                                      | High     | Open      |
| GAP-023 | Studio audit BFF route (`/api/projects/[id]/omnichannel/audit/route.ts`) exists but no UI component renders audit event data                                                                            | Medium   | Open      |
| GAP-024 | Omnichannel project settings initialization is lazy (in-memory defaults until first PATCH) — no production path triggers the first PATCH since Studio BFF proxies to unmounted runtime routes (GAP-020) | High     | Open      |

---

## 9. Non-Functional Characteristics

### Performance

- Session start should remain below one second by limiting eager work to contact facts and preferences
- Transcript recall must be bounded to at most 20 recalled messages by default
- Live transcript fan-out should avoid duplicate message persistence and sequence gaps across attached participants
- Join and backfill should degrade gracefully if live participant state is unavailable

### Security

- Channel authentication is mandatory and evaluated before any end-user identity logic
- Unsigned `userContext.userId` values are metadata only and must never drive ownership, resume, or cross-session authorization
- Strong verified identity is required for live transcript sync and any reusable cross-session authorization decision; weak provider-verified continuity is limited to same-channel bootstrap/resume and does not bypass those gates, while explicitly trusted provider verification may satisfy those strong-verification gates as tier 2
- Every recall, resume, and live-join decision must consume the current `ProductionExecutionScope` plus the project-safe session-resolution record; tenant-only artifact matches or reconstructed session guesses are not sufficient
- Consent, audit, redaction, retention, tenant isolation, and project isolation are mandatory for both recall and live sync
- Cross-scope access should fail closed and avoid leaking resource existence

### Scalability

- Live participant state must live in Redis or another shared distributed store, not pod-local memory
- Transcript persistence and sequence allocation should support multiple attached surfaces without central pod affinity
- Recall should rank candidate sessions and fetch only bounded windows rather than injecting whole-session histories
- The architecture should accommodate future attachable channels without reworking the session core

### Observability

- Trace events should capture verification, link, recall, join, detach, and typed-interrupt moments
- Audit logs should capture all authorization-changing and privacy-sensitive operations
- Metrics should track session-start latency, recall latency, join success rate, backfill size, and fan-out lag
- Alerting should focus on privacy-gate failures, project-scope violations, and fan-out delivery failure rates

---

## 10. Testing

### E2E Test Scenarios

| #   | Scenario                                                                                       | Status  | Test File                                                                  |
| --- | ---------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------- |
| 1   | Verified web chat session is recalled correctly from a later voice session in the same project | PASS    | `apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts`                |
| 2   | Anonymous SDK session remains session-scoped and cannot drive cross-session recall             | PASS    | `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`         |
| 3   | Active voice session is discovered and joined by web chat with transcript backfill             | PASS    | `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`          |
| 4   | Typed input during a live voice session interrupts TTS and is delivered on the shared session  | PARTIAL | `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`          |
| 5   | Cross-project and cross-tenant access is denied without leaking transcript existence           | PASS    | `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`         |
| 6   | Identity verification round-trip: OTP initiate → complete → status, HMAC single-step           | PASS    | `apps/runtime/src/__tests__/omnichannel-identity-verification.e2e.test.ts` |
| 7   | Identity verification auth enforcement: missing/invalid tokens blocked, correct error codes    | PASS    | `apps/runtime/src/__tests__/omnichannel-identity-verification.e2e.test.ts` |
| 8   | WebSocket to HTTP async cross-channel recall with structured content                           | PASS    | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`         |
| 9   | HTTP async to WebSocket reverse-direction cross-channel recall                                 | PASS    | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`         |
| 10  | Voice to WhatsApp cross-channel recall with OTP verification                                   | PASS    | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`         |
| 11  | Multi-channel recall spanning voice, web, and WhatsApp                                         | PASS    | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`         |
| 12  | Cross-channel recall blocked without strong verification (tier 0/1)                            | PASS    | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`         |
| 13  | Cross-channel recall with defaultAllowedChannels filter                                        | PASS    | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`         |

### Integration Test Scenarios

| #   | Scenario                                                                      | Status                 | Test File                                                                                  |
| --- | ----------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Session bootstrap preloads contact facts while leaving transcript recall lazy | PASS (foundation only) | `apps/runtime/src/__tests__/contexts/orchestration/initialize-session-prepopulate.test.ts` |
| 2   | Channel-switch orchestration preserves continuity metadata                    | PASS (foundation only) | `apps/runtime/src/__tests__/contexts/orchestration/switch-channel.test.ts`                 |
| 3   | Mid-session promote-and-link flow updates continuity state                    | PASS (foundation only) | `apps/runtime/src/__tests__/contexts/orchestration/promote-and-link.test.ts`               |
| 4   | Recall service with consent, merged contacts, GDPR, limits                    | PASS                   | `apps/runtime/src/__tests__/omnichannel-recall-service.integration.test.ts` (9 tests)      |
| 5   | Identity linking with consent lifecycle                                       | PASS                   | `apps/runtime/src/__tests__/omnichannel-identity-linking.integration.test.ts` (6 tests)    |
| 6   | Web SDK chat and voice clients render shared transcript state                 | PASS (unit)            | `packages/web-sdk/src/__tests__/unified-widget-live-sync.test.ts` (18 tests)               |
| 7   | Studio OmnichannelSettingsPanel renders, loads, saves, validates settings     | PASS (unit)            | `apps/studio/src/__tests__/omnichannel-settings-panel.test.tsx` (10 tests)                 |

### Unit Test Coverage

| Package             | Tests                                                                                                       | Passing                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| `apps/runtime`      | identity verification, orchestration, session resolver, omnichannel recall/live-session/audit/cross-channel | 46 E2E + 15 integration |
| `packages/web-sdk`  | session manager, chat backfill, unified widget live sync                                                    | 44 unit                 |
| `apps/studio`       | OmnichannelSettingsPanel render, load, save, validation                                                     | 10 unit                 |
| `packages/database` | message and consent schema validated via build + integration tests                                          | via build               |

> Full testing details: [docs/testing/omnichannel-session-continuity.md](../testing/omnichannel-session-continuity.md)

---

## References

- Design docs: `docs/specs/omnichannel-session-continuity.hld.md`
- Related features: [channels.md](channels.md), [sdk.md](sdk.md), [voice-capabilities.md](voice-capabilities.md), [memory-sessions.md](memory-sessions.md), [multi-agent-session-management.md](multi-agent-session-management.md)
