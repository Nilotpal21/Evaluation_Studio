# Session Scope Enforcement - Feature Spec Log

## 2026-04-15

### Task

Create the initial feature specification and matching test placeholder for `session-scope-enforcement`.

### Decision Log

- **DECIDED**: Every production session is truly project-scoped.
- **DECIDED**: The rollout is phased:
  - Phase 0: red adversarial tests and compatibility instrumentation
  - Phase 1: enforce explicit scope at HTTP, WebSocket, and queue boundaries
  - Phase 2: propagate validated scope through ALS and storage/service layers
  - Phase 3: split debug/system discriminants and remove remaining compatibility lanes
- **DECIDED**: Session identity should move from optional `userId` semantics to an explicit end-user subject contract, with actor provenance kept separate from subject.
- **DECIDED**: Legacy sessions and related artifacts must be migrated; invalid records should be quarantined or allowed to expire rather than normalized into empty scope.
- **INFERRED**: This work fits best as a focused sub-feature under `Memory & Sessions`, not as a new top-level major feature.

### Clarification Notes

The current session did not use autonomous oracle or auditor agents. Clarifications were derived from:

- explicit user decisions in-thread
- existing feature docs
- current runtime/session code and tests

### Key Repository Evidence

- `apps/runtime/src/services/session/types.ts`
- `apps/runtime/src/services/session/session-store.ts`
- `apps/runtime/src/services/session/session-service.ts`
- `apps/runtime/src/services/session/redis-session-store.ts`
- `apps/runtime/src/services/session/tiered-session-store.ts`
- `apps/runtime/src/services/session/session-state-repo.ts`
- `apps/runtime/src/services/message-persistence-queue.ts`
- `apps/runtime/src/channels/pipeline/session-factory.ts`
- `apps/runtime/src/channels/pipeline/message-pipeline.ts`
- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/websocket/twilio-media-handler.ts`
- `docs/features/memory-sessions.md`
- `docs/features/omnichannel-session-continuity.md`

### Open Questions Logged

1. Whether unresolved `customerId` should become a first-class `SessionSubject` variant or must normalize to `contactId` before it becomes authoritative.
   Resolved later on 2026-04-15: human production sessions normalize to `contactId`; raw external identifiers remain evidence or caller-context data.
2. Whether admin/observability summary lookups should retain a privileged locator contract separate from production request scope.
3. Whether pre-enforcement queue payloads need a replay or repair lane during rollout.

### Files Created / Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/features/README.md`
- `docs/testing/README.md`
- `docs/features/sub-features/README.md`
- `docs/testing/sub-features/README.md`

### Next Recommended SDLC Step

- Create `docs/testing/sub-features/session-scope-enforcement.md` alongside the feature spec. Done in this change.
- Next formal phase: `/test-spec session-scope-enforcement` or proceed directly to HLD if the test placeholder is considered sufficient for planning.

## 2026-04-15 (Follow-up Clarification)

### Task

Refresh the feature and testing specs after clarifying the authoritative identity model for human and non-human sessions.

### Additional Decisions

- **DECIDED**: Every human production session must resolve or create a `Contact` before session creation completes.
- **DECIDED**: Unauthenticated human guests are still human subjects and must use anonymous contacts rather than missing subject data.
- **DECIDED**: Customer-known but platform-new voice callers must also resolve/create contacts at the production boundary; identity strength remains evidence, not subject.
- **DECIDED**: Non-human workflow, agent, and integration sessions use an explicit `service_principal` subject/actor shape.
- **DECIDED**: Raw `customerId`, caller ID, cookie, or other external identifiers belong in `identityEvidence` or caller context, not in the authoritative subject contract.
- **DECIDED**: SDK `userContext.userId` is deprecated as an authoritative customer-identity field; verified bootstrap artifacts and trusted identity evidence are the authoritative path for human session identity.
- **DECIDED**: Reporting, metrics, and insights must distinguish canonical `subject` from `actor`, and human `contact` sessions from `service_principal` sessions.

### Open Questions Updated

1. Should `service_principal` remain one union variant with a `principalType` enum, or should `workflow`, `agent`, and `integration` become distinct subject/actor variants at the type level?
2. Should privileged admin/observability summary lookups keep a separate explicit privileged locator contract, or should all read paths become tenant-scoped plus policy-elevated?
3. Do we need a temporary replay or dead-letter repair lane for queue payloads created before enqueue-time scope enforcement turns on?

### Files Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`

## 2026-04-15 (Client + Analytics Guidance Update)

### Task

Refresh the feature and testing specs to capture explicit client-contract guidance and the reporting/metrics/insights impact before HLD begins.

### Additional Decisions

- **DECIDED**: The feature spec must contain a dedicated `Client Contract Impact` section rather than leaving client guidance implicit in runtime notes.
- **DECIDED**: Client guidance must explicitly deprecate treating SDK `userContext.userId` as authoritative customer identity.
- **DECIDED**: The design must state how reporting, metrics, and insights separate human sessions from service-principal sessions and query canonical scope dimensions during migration.

### Files Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/feature-spec.log.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

## 2026-04-15 (Future-Ready Architecture Decisions Confirmed)

### Task

Promote the remaining HLD-input recommendations into explicit design decisions once product direction was confirmed.

### Additional Decisions

- **DECIDED**: Admin/observability reads use a separate privileged locator contract instead of overloading production request-scoped locators.
- **DECIDED**: GDPR/retention keeps a bounded high-risk legacy compatibility scan during migration rather than relying only on canonical subject mapping from day one.
- **DECIDED**: Studio session detail is the operator-facing source of truth, backed by a dedicated runtime diagnostics/read-model payload reusable by other Studio surfaces.
- **DECIDED**: `environment` is resolved once at the runtime boundary and carried explicitly in production scope.
- **DECIDED**: Service principals use shared/project-safe auth profiles by default; any future principal-bound service credentials should be added as a first-class contract rather than reusing human personal/per-user auth semantics.
- **DECIDED**: Legacy human `user` memory semantics retire through compatibility-read migration, not long-lived dual-write; new human-memory writes move to contact-backed ownership as soon as the new contract exists.

### Files Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/feature-spec.log.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

## 2026-04-15 (Pre-HLD Review Incorporation)

### Task

Incorporate reviewer feedback before HLD handoff by tightening terminology, scope split criteria, resolved design decisions, threat-model framing, and rollout/rollback planning.

### Additional Decisions

- **DECIDED**: `ExecutionScope` is the umbrella discriminated union; `ProductionExecutionScope`, `DebugExecutionScope`, and `SystemExecutionScope` are concrete variants; `SessionScope` is the minimal operational subset used for existing-session operations.
- **DECIDED**: `service_principal` stays a single union variant with a `principalType` enum rather than separate workflow/agent/integration union arms.
- **DECIDED**: A bounded dead-letter or repair lane is allowed for pre-enforcement queue payloads, but it must be time-boxed, telemetry-backed, and retired after rollout stabilization.
- **DECIDED**: The delivery plan must include explicit split criteria so FR-13 to FR-18 and FR-19 to FR-21 can become sibling sub-features if they block core boundary enforcement.
- **DECIDED**: The feature spec should carry an explicit threat-model summary and fail-closed response contract before HLD begins.
- **DECIDED**: Migration volume estimation is a required HLD input and should come out of the initial inventory work, not be deferred indefinitely.

### Files Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/feature-spec.log.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

## 2026-04-15 (Auth Profile + Model Resolution + Memory Impact Review)

### Task

Review the remaining impacts on auth profiles, model resolution, and memory, then expand the feature/test specs and clarify the exact `userId` ambiguity being fixed.

### Decisions Captured

- **DECIDED**: Auth-profile storage is already structurally close to target; the change is that credential ownership must come from canonical actor/auth-scope semantics, not from overloaded session `userId` or human subject identity.
- **DECIDED**: Model resolution should preserve the existing contract. Full resolution remains actor-scoped and credential-aware; reasoning-settings resolution stays settings-only and must not pick up `contactId` or other subject-only dimensions by accident.
- **DECIDED**: Memory needs the strongest semantic cleanup. Human cross-session continuity should converge on contact-backed context, while platform-user/debug/service-principal memory remains explicit actor-owned state.
- **DECIDED**: The `userId` issue is an infrastructure ambiguity problem: different code paths currently reuse one generic slot for platform users, session principals, service principals, and customer/contact surrogates. Even if a single product flow only uses one of those at a time, shared helpers cannot safely infer ownership semantics from that field.

### Additional Repository Evidence Reviewed

- `packages/database/src/models/auth-profile.model.ts`
- `apps/runtime/src/services/auth-profile-resolver.ts`
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`
- `apps/runtime/src/services/auth-profile/auth-preflight.ts`
- `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`
- `apps/runtime/src/services/llm/model-resolution-versioning.ts`
- `apps/runtime/src/services/llm/model-resolution.ts`
- `apps/runtime/src/services/session/types.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/channels/session-resolver.ts`
- `apps/runtime/src/websocket/twilio-media-handler.ts`
- `apps/runtime/src/services/execution/memory-executor.ts`
- `apps/runtime/src/services/execution/memory-integration.ts`
- `apps/runtime/src/services/execution/tool-memory-bridge.ts`
- `apps/runtime/src/services/stores/mongodb-fact-store.ts`
- `apps/runtime/src/services/contact-context-service.ts`
- `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`
- `apps/runtime/src/__tests__/auth/auth-profile-propagation.test.ts`
- `apps/runtime/src/__tests__/auth/auth-profile-tool-executor-integration.test.ts`
- `apps/runtime/src/__tests__/model-resolution-versioning.test.ts`
- `apps/runtime/src/__tests__/memory-integration.test.ts`
- `apps/runtime/src/__tests__/mongodb-fact-store-scope.test.ts`
- `apps/runtime/src/__tests__/memory-scope-integration.test.ts`

### Files Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/feature-spec.log.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

## 2026-04-15 (Encryption + DEK Impact Review)

### Task

Review how the new session-scope contract interacts with encryption, BYOK/KMS, and DEK scoping, then expand the feature and testing specs to capture the required rollout behavior.

### Additional Decisions

- **DECIDED**: The feature will reuse the existing tenant+project+environment DEK substrate rather than invent a second crypto hierarchy for sessions.
- **DECIDED**: Project-scoped production session artifacts should use project/environment-scoped DEKs wherever the artifact itself is project-scoped.
- **DECIDED**: Contact encrypted identities, blind indexes, and `encryptionSalt` remain tenant-scoped by design because `Contact` is the canonical tenant-wide human-subject registry.
- **DECIDED**: Migration must classify legacy encrypted artifacts by DEK scope and support re-encryption, compatibility telemetry, or quarantine for tenant-scoped ciphertext backing project-scoped production session data.
- **DECIDED**: KMS audit telemetry is part of rollout safety; project-scoped session crypto should emit auditable `projectId`, `environment`, and `dekId` signals where platform-managed DEKs are involved.

### Additional Repository Evidence Reviewed

- `packages/shared-encryption/src/index.ts`
- `packages/shared-encryption/src/tenant-encryption-facade.ts`
- `packages/shared-encryption/src/encryption-manifest.ts`
- `packages/database/src/mongo/plugins/encryption.plugin.ts`
- `packages/database/src/kms/kms-resolver.ts`
- `packages/database/src/kms/dek-manager.ts`
- `packages/database/src/kms/kms-provider-pool.ts`
- `packages/database/src/models/tenant-kms-config.model.ts`
- `packages/database/src/models/materialized-kms-config.model.ts`
- `packages/database/src/models/dek-registry.model.ts`
- `packages/database/src/models/session-state.model.ts`
- `packages/database/src/models/message.model.ts`
- `packages/database/src/models/contact.model.ts`
- `packages/database/src/clickhouse-encryption-interceptor.ts`
- `apps/runtime/src/services/session/session-service.ts`
- `apps/runtime/src/services/message-persistence-queue.ts`
- `apps/runtime/src/services/agent-transfer/index.ts`
- `packages/agent-transfer/src/security/session-field-encryption.ts`
- `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts`
- `apps/runtime/src/services/kms/kms-audit-logger.ts`
- `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts`
- `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`
- `apps/docs-internal/content/getting-started/platform-overview.mdx`

### Files Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/feature-spec.log.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

## 2026-04-15 (Cross-Cutting + Studio Impact Review)

### Task

Review the remaining cross-cutting impact areas in detail and expand the feature/test specs to cover them explicitly, with a dedicated Studio impact review.

### Additional Decisions

- **DECIDED**: The feature spec must explicitly cover retention/GDPR, session ownership/authz, contact lifecycle, transfer/handoff, audit/event/export surfaces, and Studio read models as first-class impact areas.
- **DECIDED**: Studio impact is mostly additive and read-model/proxy oriented, not a first-wave full UX redesign.
- **DECIDED**: Studio debug chat and preview callerData flows must remain explicit debug-only contracts and must not become authoritative production identity.
- **DECIDED**: Retention/GDPR compatibility paths must be explicit, measurable, and retirement-bound rather than hidden inside heuristic field scans.
- **DECIDED**: Session ownership/list filters must tighten alongside session creation so runtime and Studio reads do not preserve legacy `customerId` / `anonymousId` semantics after write paths are hardened.
- **DECIDED**: Provider-side synthetic transfer user IDs are transport aliases only; canonical human subject identity remains `contactId`.

### Additional Repository Evidence Reviewed

- `apps/studio/src/services/retention/mongo-gdpr-store.ts`
- `apps/studio/src/services/retention/retention-service.ts`
- `packages/shared-auth/src/middleware/session-ownership.ts`
- `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`
- `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`
- `packages/agent-transfer/src/session/types.ts`
- `packages/agent-transfer/src/adapters/kore/index.ts`
- `packages/eventstore/src/schema/platform-event.ts`
- `packages/eventstore/src/interfaces/event-gdpr.ts`
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts`
- `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`
- `apps/studio/src/app/api/runtime/sessions/route.ts`
- `apps/studio/src/app/api/runtime/sessions/[id]/route.ts`
- `apps/studio/src/app/api/runtime/sessions/[id]/traces/route.ts`
- `apps/studio/src/app/api/runtime/insights/route.ts`
- `apps/studio/src/components/session/SessionsListPage.tsx`
- `apps/studio/src/components/session/SessionDetailPage.tsx`
- `apps/studio/src/components/traces/TracesPage.tsx`
- `apps/studio/src/components/chat/StudioChatPanel.tsx`
- `apps/studio/src/components/chat/SessionSidebar.tsx`
- `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- `apps/studio/src/hooks/useSessionDetail.ts`
- `apps/studio/src/hooks/useInsightsDashboard.ts`
- `apps/studio/src/hooks/useAtAGlance.ts`
- `apps/studio/src/contexts/WebSocketContext.tsx`
- `apps/studio/src/hooks/useProjectAgentSessionLauncher.ts`
- `apps/studio/src/store/caller-data-store.ts`
- `apps/studio/src/app/preview/page.tsx`

### Files Updated

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/feature-spec.log.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`
