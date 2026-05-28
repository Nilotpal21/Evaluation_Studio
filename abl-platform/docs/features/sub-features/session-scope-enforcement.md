# Feature: Session Scope Enforcement

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Memory & Sessions](../memory-sessions.md)
**Status**: ALPHA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `integrations`, `observability`, `analytics`, `governance`, `compliance`, `security`, `studio`, `enterprise`
**Package(s)**: `apps/runtime`, `packages/database`, `packages/shared-auth`, `packages/shared-encryption`, `packages/eventstore`, `packages/agent-transfer`, `apps/search-ai`, `packages/web-sdk`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/session-scope-enforcement.md](../../testing/sub-features/session-scope-enforcement.md)
**Last Updated**: 2026-04-23

---

## 1. Introduction / Overview

### Problem Statement

The runtime currently mixes three different models for session identity and access control:

- explicit parameters at some boundaries
- ambient AsyncLocalStorage (ALS) in some deep data paths
- optional or missing scope normalized into empty strings or late repair logic in hot-store, cold-store, and queue flows

That split shows up in the current core contracts:

- `SessionData` still treats `tenantId`, `projectId`, `userId`, and `callerContext` as optional runtime identity fields.
- `SessionStore` and `SessionService` still load, save, delete, touch, and lock by bare `sessionId`.
- `TieredSessionStore` still cold-restores through unscoped `SessionStateRepo` helpers when the hot path misses.
- `RedisSessionStore` still resolves missing tenant lookup to `''`, which turns scope loss into an empty-tenant namespace instead of a hard failure.
- `persistMessage()` and `persistTurnMetrics()` still accept partial scope at enqueue time and rely on later repair or synthetic worker provenance.

This makes `sessionId` behave like the real capability token, even though the platform invariants require tenant, project, and user isolation. It also makes migrations and future fixes harder because local patches have to guess whether missing scope means "debug", "system job", or "bug".

### Goal Statement

Introduce an explicit, typed `ExecutionScope` / `SessionScope` contract that becomes the only allowed production boundary for session creation, session persistence, session restore, and message persistence. Production scope must be fail-closed, project-scoped, auditable, analytics-safe, encryption-consistent, and migration-friendly: every production session must carry validated tenant, project, session principal, actor, subject, identity evidence, channel, source, and trace context before any runtime or persistence operation proceeds.

### Summary

This sub-feature hardens the Memory & Sessions foundation by changing scope from an optional convention into a typed invariant.

The rollout is intentionally phased:

- Phase 0 writes adversarial regression tests first so existing scope leaks are captured as red tests before implementation begins.
- Phase 1 makes `ExecutionScope` mandatory at the three critical production boundaries: HTTP session creation, WebSocket/session bootstrap, and queue enqueue.
- Phase 2 propagates the validated scope through ALS and refactors hot-store, cold-store, and reusable service boundaries so deep layers consume mirrored scope instead of inventing or repairing it.
- Phase 3 separates production, debug, and system flows into discriminated types so "missing scope" no longer encodes multiple meanings.

The agreed product decision for this feature is that every production session is truly project-scoped. Legacy sessions and queued artifacts must be migrated or quarantined rather than normalized into empty tenant/project namespaces. The existing BYOK/KMS design already supports per-project/per-environment DEKs, so this feature should reuse that substrate for session-adjacent encrypted data instead of inventing a second crypto hierarchy.

### Terminology

| Term                                    | Meaning                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionScope`                        | Top-level discriminated union for runtime boundary context. It has concrete variants for `production`, `debug`, and `system`.                                                |
| `Production/Debug/SystemExecutionScope` | Concrete `ExecutionScope` variants. `ProductionExecutionScope` is the strict fail-closed contract; debug/system stay separate by type, not omission.                         |
| `SessionScope`                          | Minimal scoped locator/operational subset derived from `ExecutionScope` for existing-session operations such as load/save/touch/delete/lock.                                 |
| `Session Principal`                     | Runtime-generated continuity identity for exactly one session. It always exists, even before human identity is verified, and stays distinct from both `subject` and `actor`. |

---

## 2. Scope

### Goals

- Make validated `ExecutionScope` mandatory at production session-creation and queue-enqueue boundaries.
- Require `projectId` for every production runtime session across HTTP, WebSocket, SDK, and voice entry paths.
- Replace optional runtime `userId` semantics with an explicit `sessionPrincipalId`, `subject`, `actor`, and `identityEvidence` contract.
- Deprecate client guidance that treats SDK `userContext.userId` as authoritative customer identity; verified bootstrap and trusted identity evidence must become the authoritative path.
- Clarify actor-owned auth and memory semantics so platform-user, session-principal, service-principal, and human-contact state are not conflated through one overloaded `userId` slot.
- Remove unscoped hot-store and cold-store operations from normal production request flows.
- Migrate existing session, cold-store, and queue artifacts to the new contract without silently widening access.
- Make reporting, metrics, and insights surfaces query canonical subject/actor semantics instead of legacy `customerId` / `anonymousId` heuristics.
- Realign retention/GDPR, session ownership, transfer/handoff, audit/export, and Studio read models around the same canonical scope summary instead of legacy identity heuristics.
- Align session-adjacent encryption and DEK scope with the production session contract: project-scoped session artifacts should use project/environment-scoped DEKs, while tenant-wide contact identity crypto stays tenant-scoped by design.
- Add adversarial regression coverage for the exact failure modes identified in the audit before enforcement is enabled.

### Non-Goals (Out of Scope)

- Replacing the overall Redis hot-store plus MongoDB cold-store architecture described in [Memory & Sessions](../memory-sessions.md).
- Redesigning omnichannel recall, contact linking, or verification policy beyond the subject-of-record contract needed for session scope.
- Removing compatibility routes or debug tooling in the first rollout wave; backward-compatible adapters may exist during migration.
- Replacing ALS entirely. ALS remains as a propagation mechanism after scope validation, not as the source of truth.
- Treating every lower-priority route-local ownership gap in the repository as part of Phase 1. The first implementation focus is the production runtime session path.
- Rebuilding Studio session, traces, or insights UX from scratch in Phase 1. Most Studio changes should be additive read-model and proxy updates rather than disruptive UI redesigns.
- Redesigning the overall BYOK/KMS product model. This feature should consume the existing tenant+project+environment DEK hierarchy rather than invent a new one.
- Making every encrypted record in the platform project-scoped. Tenant-scoped registries such as `Contact` identity encryption and blind indexes remain explicit exceptions.

---

## 3. User Stories

1. As a **platform engineer**, I want production session creation to require a validated typed scope so that cross-tenant or cross-project access becomes impossible to encode accidentally.
2. As a **runtime operator**, I want Redis misses, cold restores, and queue writes to fail closed when scope is missing so that session continuity bugs do not widen into isolation bugs.
3. As a **security reviewer**, I want actor provenance and end-user subject identity to be durable and explicit so that audit trails are complete and authorization logic is reviewable.
4. As a **channel integrator**, I want HTTP, SDK, WebSocket, and voice entry paths to use one production scope contract so that new channels do not reintroduce scope holes through special cases.
5. As a **migration owner**, I want a staged rollout with red-first tests, migration telemetry, and compatibility counters so that we can tighten the contract without losing recoverability for existing sessions.
6. As a **Studio operator / compliance admin**, I want session, trace, retention, export, and transfer views to reflect the same canonical scope semantics as runtime so that investigations, ownership checks, and erasure flows stay trustworthy during migration.

---

## 4. Functional Requirements

1. **FR-1**: The system must require a validated production `ExecutionScope` at every production session-creation boundary, including HTTP routes, WebSocket/bootstrap entry paths, SDK/voice session bootstrap, and any shared session-factory path used by those flows.
2. **FR-2**: The system must reject production session creation when `projectId` is absent. Production session scope may not be tenant-only.
3. **FR-3**: The system must model scope with explicit `sessionPrincipalId`, `subject`, `actor`, and `identityEvidence` contracts rather than an optional `userId` string. `sessionPrincipalId` must be runtime-generated, mandatory for every production session (including anonymous and pre-verification sessions), and remain distinct from both the human `contact` subject and actor/auth provenance. All human production sessions, including unauthenticated guests and customer-known voice callers, must use `subject.kind = 'contact'` after resolve-or-create contact completes. Only non-human agent/workflow/integration sessions may use `subject.kind = 'service_principal'`. Subject handling must remain distinct from actor/auth provenance, session continuity identity, and evidence strength.
4. **FR-4**: The system must require a scoped locator or validated scope object for production session load, version read, save, delete, touch, conversation operations, and execution locking. Bare `sessionId` operations must not remain on the production path.
5. **FR-5**: The Redis session store must not normalize missing tenant context to `''`. Reverse-lookup expiry or absent tenant mapping must fail closed rather than reading or writing the empty-tenant namespace.
6. **FR-6**: MongoDB cold-store restore, version read, delete, and touch operations used by production flows must require scope and must not rely on unscoped internal helpers.
7. **FR-7**: Message and metrics enqueue contracts must require full production scope and audit provenance at enqueue time. Steady-state workers must not repair missing tenant/project fields or synthesize actor identity as the durable source of truth.
8. **FR-8**: ALS may only mirror scope that was already validated at the boundary. Deep layers may consume mirrored ALS for convenience, but they must not treat ALS or missing values as authoritative input.
9. **FR-9**: Production, debug, and system flows must use discriminated scope types by the end of the rollout so that missing scope never means both "debug" and "bug".
10. **FR-10**: The rollout must migrate existing runtime sessions, cold-store session snapshots, and relevant persisted message artifacts to the new scope contract, backfilling where derivable and quarantining or expiring invalid records where it is not.
11. **FR-11**: The system must add adversarial regression tests for reverse-lookup expiry, cross-tenant cold restore, missing-scope queue payloads, debug resume with incomplete scope, and cross-project/cross-user service access before enforcement is enabled.
12. **FR-12**: The system must emit structured logs, counters, and analytics-friendly dimensions for scope validation failures, compatibility-path usage, migration outcomes, and canonical subject/actor classification so operators can measure rollout safety in tracing, reporting, metrics, and insights surfaces before full enforcement.
13. **FR-13**: Retention, GDPR, archive, and erasure flows must resolve subjects using canonical `subject` / `actor` semantics and migration-aware lookup rules. Legacy field scans may remain only as explicit compatibility paths with telemetry and retirement criteria.
14. **FR-14**: Session ownership, SDK session listing, resume/delete/read authorization, and related reusable service boundaries must migrate from `customerId` / `channelArtifact` / `anonymousId` priority logic to canonical subject/actor semantics plus explicit policy checks.
15. **FR-15**: Verification promotion, contact linking, merge/back-link, and contact deletion flows must preserve the canonical human subject model. Stronger evidence may enrich or merge contacts, but it must not invent alternate subject semantics for the same human.
16. **FR-16**: Agent transfer and handoff systems must use canonical `contactId` as the human subject-of-record and must treat provider-side synthetic user IDs, aliases, or transport-specific handles as non-authoritative metadata.
17. **FR-17**: Audit, event, export, archive, and compliance-summary surfaces must persist or derive a privacy-preserving canonical scope summary that distinguishes `subject` from `actor`, supports GDPR anonymization, and keeps live/historical trace replay consistent.
18. **FR-18**: Studio runtime proxies, session/traces explorers, debug chat, preview/embed tools, transfer views, and retention tooling must remain compatible with stricter runtime scope enforcement; Studio read models should expose additive canonical scope summaries, migration state, and compatibility flags instead of relying on legacy identity fields.
19. **FR-19**: Project-scoped production session artifacts that use platform-managed DEKs must resolve encryption scope at `tenantId + projectId + environment` rather than tenant-wide sentinels. This applies to Redis hot-session blobs, encrypted queue payloads, agent-transfer session metadata/provider data for project-scoped sessions, and ClickHouse/eventstore session-adjacent encrypted rows unless a documented exception exists.
20. **FR-20**: Tenant-scoped human-subject registries such as `Contact` encrypted identities, blind indexes, and contact erasure crypto-shredding must remain tenant-scoped by design. Project scope enforcement must not fragment canonical human identity across projects.
21. **FR-21**: Migration and rollout telemetry must classify legacy encrypted artifacts by DEK scope, support re-encryption or quarantine for tenant-scoped ciphertext backing project-scoped production session data, and record KMS audit metadata (`projectId`, `environment`, `dekId`, compatibility path) sufficient for compliance and rollout safety.
22. **FR-22**: Auth-profile resolution, preflight, and tool-auth middleware must derive credential-owner context from canonical actor/auth-scope inputs, not from optional session `userId`, human `subject`, or late-reconstructed caller context. Personal/per-user/session credentials must remain actor-owned, and service-principal access to those modes must require explicit policy.
23. **FR-23**: Model resolution must preserve the existing contract: full `resolve()` remains actor-scoped and credential-aware, while reasoning-settings resolution remains settings-only and must not key on human `subject` / `contactId` unless the underlying policy truly depends on it.
24. **FR-24**: Runtime memory must separate session working state, project-scoped persistent memory, canonical contact-backed human memory, and actor-owned memory. Human cross-session memory must not depend on overloaded session `userId`, and debug/platform-user/service-principal memory must not be mistaken for customer/contact memory.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                         |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Every production session becomes explicitly project-scoped by contract.                       |
| Agent lifecycle            | PRIMARY      | Session creation, persistence, resume, lock, and fork behavior depend on the new contract.    |
| Customer experience        | SECONDARY    | End-user behavior should stay consistent, but safer scope handling reduces isolation risk.    |
| Integrations / channels    | PRIMARY      | HTTP, SDK, WebSocket, and voice entry paths all need the same boundary enforcement.           |
| Observability / tracing    | PRIMARY      | Actor/subject/source/trace become durable audit fields and queryable rollout dimensions.      |
| Reporting / metrics        | PRIMARY      | Human vs non-human traffic, identity strength, and migration state need canonical dimensions. |
| Governance / controls      | PRIMARY      | This feature closes isolation gaps by design rather than by route-local convention.           |
| Enterprise / compliance    | PRIMARY      | Fail-closed scope and durable provenance strengthen auditability and blast-radius control.    |
| Admin / operator workflows | SECONDARY    | Operators need migration and compatibility visibility during rollout.                         |

### Related Feature Integration Matrix

| Related Feature                                                                         | Relationship Type | Why It Matters                                                                                                                                                         | Key Touchpoints                                                                | Current State         |
| --------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| [Memory & Sessions](../memory-sessions.md)                                              | extends           | This feature hardens the session identity, storage, and restore contracts described by the parent feature.                                                             | `SessionData`, `SessionStore`, `SessionService`, Redis/Mongo hot-cold storage  | Active but permissive |
| [Omnichannel Session Continuity](../omnichannel-session-continuity.md)                  | shares data with  | Omnichannel already separates channel auth principal, session principal, and verified end-user identity. The same structural split should inform session scope design. | session principal, verified identity, project-scoped recall, channel principal | ALPHA                 |
| [SDK](../sdk.md)                                                                        | depends on        | SDK sessions already distinguish session-scope grants from reusable identity, but runtime boundaries still accept optional identity inputs.                            | `sdk_session`, WebSocket bootstrap, session-scope auth artifacts               | Active integration    |
| [Identity Verification](../identity-verification.md)                                    | shares data with  | Verified identity should strengthen evidence and contact linkage without changing the core human-subject contract away from `contactId`.                               | verified contact linking, identity tiers, verification method metadata         | ALPHA                 |
| [Session Timeout & Disposition Unification](session-timeout-disposition-unification.md) | shares data with  | Timeout/disconnect policy depends on the same session creation and persistence boundaries becoming trustworthy.                                                        | session lifecycle services, cleanup paths, session close routes                | PLANNED               |

---

## 6. Design Considerations

- The runtime should treat scope construction the same way model resolution now treats cache identity: explicit scope inputs are separate from versioned state and are visible in one place.
- Actor provenance and subject identity should not collapse into one field. Who initiated the session and who the session is about are related but different questions.
- Session principal is the private continuity lane for one conversation. It should exist before strong verification and must not be inferred later from `contactId`, `userId`, or transient caller context.
- Human and non-human sessions should branch through explicit subject kinds, not through missing fields or overloaded `userId` semantics.
- Unauthenticated guests are still human subjects. They should resolve to anonymous contacts, not to absent subject data.
- The `userId` problem is mostly an infrastructure ambiguity problem, not a product-flow ambiguity problem. A given session may only represent one principal at a time, but shared helpers currently reuse one generic `userId` slot for platform users, session principals, service principals, and customer/contact surrogates, which makes auth, memory, and reporting semantics drift across code paths.
- Client-provided identity hints must not be mistaken for authoritative identity. In particular, SDK `userContext.userId` is personalization or hinting input, not the canonical customer identity for a production session.
- Project scoping should be visible in the type system, not just in route prefixes.
- Auth profiles should follow the acting principal, not the human subject of the conversation, unless an explicit delegated-consent rule says otherwise.
- Model resolution already has the right separation of scope and versioned inputs; this feature should feed it canonical actor scope without expanding cache identity to human-subject semantics by accident.
- Memory should distinguish contact-backed human continuity from actor-owned or debug-owned state so customer context does not leak into platform-operator or service-principal paths.
- `service_principal` remains one union variant with a `principalType` enum rather than three separate union arms. That keeps type growth bounded while still preserving semantic clarity for workflow/agent/integration cases.
- Pre-enforcement queue payloads may use a bounded dead-letter or repair lane during migration, but that lane must be time-boxed, telemetry-backed, and removed after rollout stabilization.
- Reporting, metrics, and insights must distinguish `subject` from `actor`, and human `contact` traffic from `service_principal` traffic, so customer outcomes and automation usage do not collapse together.
- Retention, GDPR, and archive flows should not keep relying on heuristic field scans forever. Canonical subject lookup plus a bounded migration-compatibility lane is safer and more reviewable.
- Ownership and read-filter logic have to evolve alongside write-path enforcement. If session creation becomes canonical but session listing still keys on `customerId` or `anonymousId`, the model remains inconsistent.
- Provider-specific transport aliases such as synthetic contact/user IDs are integration details, not the authoritative subject contract.
- Audit and event schemas need enough canonical scope summary to support privacy-safe operator views, anonymization, and trace replay without exposing raw identity values.
- Migration visibility matters as much as type safety. Operators need compatibility counters before enforcement, not just after failures appear.
- This feature does not require a new first-wave Studio UX, but Studio diagnostics, session inspection, trace replay, transfer operations, and retention tooling should eventually show effective scope, compatibility-path usage, and migration state.
- The existing BYOK/KMS model is already per `tenant + project + environment`; session-scope enforcement should standardize callers onto that substrate instead of creating a parallel crypto concept.
- Authorization scope and encryption scope should agree for production session data. If a session artifact is project-scoped in authz but encrypted under a tenant-wide DEK, crypto blast radius and rotation semantics are weaker than the runtime contract implies.
- Contact identity encryption is the main intentional exception: contacts are tenant-wide human-subject anchors, so encrypted identities, blind indexes, and erasure salts must stay tenant-scoped even when sessions and messages are project-scoped.
- Migration must separate schema backfill from re-encryption. Some legacy rows may be structurally backfillable but still require DEK-scope classification, re-encryption, or quarantine before compatibility paths can be removed.

### Threat Model Summary

- **Protected assets**: production session state, scoped queue payloads, contact identity, actor-owned credentials, audit traces, and project-scoped encrypted artifacts.
- **Primary attackers / failure sources**: cross-tenant or cross-project callers, stale or partial queue payloads, debug/system code paths accidentally entering production flows, provider aliases being mistaken for canonical identity, and crypto callers silently downgrading to tenant-wide scope.
- **Primary abuse paths**: bare-`sessionId` restore, reverse-lookup expiry fallback, partial-scope enqueue with late repair, overloaded `userId` ownership semantics, and tenant-scoped crypto on project-scoped session data.
- **Primary mitigations**: fail-closed boundary validation, discriminated `ExecutionScope` variants, canonical `subject`/`actor` semantics, time-boxed compatibility lanes, project-scoped DEK enforcement for production artifacts, and explicit rollout telemetry.

---

## 7. Technical Considerations

- The central production session-creation surfaces already exist in `apps/runtime/src/channels/pipeline/session-factory.ts`, `apps/runtime/src/services/session/session-bootstrap.ts`, `apps/runtime/src/routes/chat.ts`, `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, and `apps/runtime/src/websocket/twilio-media-handler.ts`.
- The core runtime session contract is still optional today in `apps/runtime/src/services/session/types.ts`, `apps/runtime/src/services/session/session-store.ts`, and `apps/runtime/src/services/session/session-service.ts`.
- The hot/cold storage gap is currently concentrated in `apps/runtime/src/services/session/redis-session-store.ts`, `apps/runtime/src/services/session/tiered-session-store.ts`, and `apps/runtime/src/services/session/session-state-repo.ts`.
- Queue-enqueue and late-repair behavior currently lives in `apps/runtime/src/services/message-persistence-queue.ts` and `apps/runtime/src/channels/pipeline/message-pipeline.ts`.
- Human subject creation and enrichment already have strong building blocks in `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts`, `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`, `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`, and `apps/runtime/src/websocket/sdk-handler-contact-linking.ts`.
- Auth-profile storage and resolution are already structurally close to the target in `packages/database/src/models/auth-profile.model.ts`, `apps/runtime/src/services/auth-profile-resolver.ts`, `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`, `apps/runtime/src/services/auth-profile/auth-preflight.ts`, and `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`; the main change is feeding those paths canonical actor/auth-scope inputs.
- Model resolution already documents the intended separation of actor-scoped full resolution and settings-only reasoning resolution in `apps/runtime/src/services/llm/model-resolution-versioning.ts` and `apps/runtime/src/services/llm/model-resolution.ts`; session-scope enforcement should preserve that contract rather than widening model-resolution identity to human subject semantics.
- Runtime memory currently carries the clearest `userId` collision. `apps/runtime/src/services/runtime-executor.ts`, `apps/runtime/src/channels/session-resolver.ts`, and `apps/runtime/src/websocket/twilio-media-handler.ts` all map customer/anonymous/channel identity into `userId`, while `apps/runtime/src/services/execution/memory-executor.ts`, `apps/runtime/src/services/execution/memory-integration.ts`, `apps/runtime/src/services/execution/tool-memory-bridge.ts`, and `apps/runtime/src/services/stores/mongodb-fact-store.ts` treat `userId` as the owner key for persistent memory.
- Contact-backed cross-session context already exists in `apps/runtime/src/services/contact-context-service.ts` and `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`, which makes it the right foundation for human memory that survives across sessions and channels.
- Session-scoped auth-profile flows already use `userId` as a session principal in `apps/runtime/src/services/auth-profile/auth-preflight.ts` and related propagation helpers/tests; the rollout needs an explicit actor/session-principal field so that session auth is not confused with platform-user or contact identity.
- `MongoConversationStore` already fails closed through ALS for several read/update paths, which makes it a useful model for Phase 2 once explicit scope is built first.
- The DEK substrate already understands `tenant + project + environment` in `packages/database/src/kms/kms-resolver.ts`, `packages/database/src/models/tenant-kms-config.model.ts`, `packages/database/src/models/materialized-kms-config.model.ts`, `packages/database/src/models/dek-registry.model.ts`, and `packages/shared-encryption/src/tenant-encryption-facade.ts`.
- Cold session state and persisted messages already use project-scoped DEK encryption in `packages/database/src/models/session-state.model.ts` and `packages/database/src/models/message.model.ts`, which makes them the correct template for the rest of the session path.
- The main crypto mismatches today are in `apps/runtime/src/services/session/session-service.ts`, `apps/runtime/src/services/message-persistence-queue.ts`, `apps/runtime/src/services/agent-transfer/index.ts`, `packages/agent-transfer/src/security/session-field-encryption.ts`, and `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts`, all of which currently lean on tenant-scoped convenience wrappers for session-adjacent payloads.
- Contact identity crypto is intentionally tenant-scoped today in `packages/database/src/models/contact.model.ts`, `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts`, and `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`; that should remain a documented exception, not a hidden inconsistency.
- KMS audit already has the right shape for this rollout in `apps/runtime/src/services/kms/kms-audit-logger.ts`, which records `projectId`, `environment`, and `dekId`, but current session-adjacent callers do not use that metadata consistently enough.
- Reporting and trace materialization paths currently need explicit attention in `apps/runtime/src/services/trace/emit-to-eventstore.ts`, `apps/runtime/src/services/trace/clickhouse-session-trace-events.ts`, `apps/runtime/src/routes/admin-sessions.ts`, and `apps/runtime/src/routes/platform-admin-traces.ts`.
- GDPR and retention subject discovery currently still scan legacy identity fields in `apps/studio/src/services/retention/mongo-gdpr-store.ts` and `apps/studio/src/services/retention/retention-service.ts`, so that compatibility lane needs an explicit redesign and retirement plan.
- Shared ownership and session-list filters still rely on tiered `customerId` / `channelArtifact` / `anonymousId` logic in `packages/shared-auth/src/middleware/session-ownership.ts`.
- Agent-transfer session storage already keys human sessions by `tenantId + contactId + channel` in `packages/agent-transfer/src/session/types.ts`, but adapters such as `packages/agent-transfer/src/adapters/kore/index.ts` still synthesize provider-side user IDs that must remain transport-only aliases.
- Audit/event schemas and anonymization helpers still center on `actor_id` / `actor_type` in `packages/eventstore/src/schema/platform-event.ts`, `packages/eventstore/src/interfaces/event-gdpr.ts`, and `apps/runtime/src/services/stores/clickhouse-audit-store.ts`.
- Studio read models and proxies are intentionally identity-light today in `apps/studio/src/app/api/runtime/sessions/route.ts`, `apps/studio/src/app/api/runtime/sessions/[id]/route.ts`, `apps/studio/src/app/api/runtime/sessions/[id]/traces/route.ts`, `apps/studio/src/components/session/SessionsListPage.tsx`, `apps/studio/src/components/session/SessionDetailPage.tsx`, and `apps/studio/src/hooks/useSessionDetail.ts`; this makes Studio mostly an additive read-model update rather than a complete redesign.
- Studio debug and preview launch paths explicitly send free-form `callerData` today in `apps/studio/src/store/caller-data-store.ts`, `apps/studio/src/contexts/WebSocketContext.tsx`, `apps/studio/src/hooks/useProjectAgentSessionLauncher.ts`, and `apps/studio/src/app/preview/page.tsx`, so those surfaces need a clear debug-only contract.
- Studio aggregate dashboard hooks in `apps/studio/src/hooks/useAtAGlance.ts` and `apps/studio/src/hooks/useInsightsDashboard.ts` are mostly project/session aggregate consumers, so they should gain additive canonical dimensions rather than require a wholesale UI redesign.
- The rollout should be staged:
  - Phase 0: red adversarial tests and compatibility instrumentation
  - Phase 1: boundary enforcement at production session create and queue enqueue
  - Phase 2: scoped store/service propagation plus ALS mirroring
  - Phase 3: discriminated debug/system contracts and removal of remaining compatibility lanes
- A temporary rollout mode is likely required so production can move from `audit` to `warn` to `enforce` without one unsafe cutover.
- Migration should classify persisted records into:
  - backfillable records whose `tenantId`, `projectId`, and subject can be derived safely
  - quarantined or expiring records that cannot be classified without widening access
  - explicit debug/system records that move onto separate discriminated contracts

---

## 8. How to Consume

### Studio UI

No brand-new first-wave Studio configuration surface is required, but Studio is not impact-free. Most Studio work is additive: existing pages remain, but they need runtime-backed canonical scope summaries and clearer debug-vs-production boundaries.

The operator-facing source of truth should be the session-detail surface, backed by a dedicated canonical diagnostics/read-model payload from runtime so other Studio surfaces can reuse the same semantics without inventing parallel identity models.

| Studio Surface                    | Current State                                                                                                                                  | Impact Review                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session list / session detail     | Session list and detail read models are identity-light and focus on timing, tokens, messages, and traces.                                      | Low-to-medium UI impact. Additive `scopeSummary`, `migrationStatus`, and `compatibilityPathUsed` fields should be exposed so operators can inspect canonical scope safely. |
| Historical traces / observatory   | Historical session detail replays trace events into Studio, but the current read path does not preserve canonical subject/actor semantics.     | Medium impact. Live and replayed traces need the same canonical scope summary so investigations do not disagree about who a session was about.                             |
| Runtime session proxies           | Studio proxies already require `projectId` for session list/detail/trace routes and mostly inherit runtime behavior.                           | Low code-shape impact. These proxies should primarily pass through stricter runtime failures and canonical scope summaries without inventing identity locally.             |
| Debug chat / preview / callerData | Studio debug chat and preview tools explicitly send free-form `callerData` with `load_agent` or SDK share exchange flows.                      | High semantic impact, low UX impact. These flows should move onto explicit debug contracts so callerData never becomes authoritative production identity.                  |
| Transfer monitoring               | Studio transfer views already display `contactId` and poll project-scoped transfer-session APIs.                                               | Medium impact. Keep canonical `contactId` visible for human sessions, but label provider aliases or synthetic user IDs as provider metadata only.                          |
| Insights dashboards               | Most dashboards consume project-scoped aggregate metrics and do not currently show identity-level data.                                        | Low product impact. They mainly need additive canonical dimensions where segmentation or rollout monitoring depends on subject/actor semantics.                            |
| Retention / GDPR tooling          | Studio retention services still discover subjects by scanning legacy session/message fields and attachments.                                   | High impact. These flows need explicit canonical-subject resolution plus migration-aware compatibility behavior.                                                           |
| Archives / exports                | Studio archive routes and export-adjacent tools reason mostly at tenant/project scope and do not yet expose canonical session-scope semantics. | Medium impact. Archive/export manifests and operator summaries should stay privacy-safe while reflecting canonical subject/actor semantics and migration status.           |

### API (Runtime)

No brand-new public API route is required in Phase 1. This feature hardens the behavior of existing production session entry points.

| Method   | Path                                                  | Purpose                                                                                                               |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| POST     | `/api/projects/:projectId/sessions`                   | Existing test-session creation path must construct a validated production scope before runtime session creation.      |
| POST     | `/api/v1/chat/:agentName` and related HTTP chat paths | Existing HTTP chat/session bootstrap paths must reject missing production scope.                                      |
| POST     | `/api/v1/livekit/token`                               | LiveKit token issuance must preflight canonical production scope before returning a room token or starting a worker.  |
| WS       | `/ws`                                                 | Existing WebSocket bootstrap and resume paths must use validated scope or explicit debug/system discriminants.        |
| WS       | `/ws/sdk`                                             | Existing SDK session bootstrap must require project-scoped production scope and durable actor/subject provenance.     |
| WS       | Twilio media bootstrap                                | Voice bootstrap must fail closed on invalid production scope rather than silently degrading to echo-only fallback.    |
| Internal | `persistMessage()` / `persistTurnMetrics()`           | Existing queue enqueue boundary must accept full scope and audit envelope rather than optional tenant/project fields. |

### Fail-Closed Response Contract

- Missing authentication continues to return `401` with the repo-standard error envelope.
- Authenticated production-create requests that cannot build a valid production scope should return `400` with a stable validation error envelope, for example `{ success: false, error: { code: 'INVALID_SESSION_SCOPE', message: 'Invalid production session scope.' } }`.
- Cross-tenant, cross-project, or wrong-owner access to an existing session/resource should continue to return non-leaky `404` behavior rather than `403`.
- Passing a debug/system discriminant through a production-only boundary should return `400` with a stable contract error such as `UNSUPPORTED_SCOPE_KIND`, not silently coerce into production semantics.
- Follow-up `sessionMetadata` writes that exceed the request or post-merge size contract should fail with `413` and a stable `{ success: false, error: { code: 'PAYLOAD_TOO_LARGE', ... } }` envelope; the server must not silently drop `_metadata` updates while still returning success.

### API (Studio)

Studio runtime proxies should remain behaviorally compatible, but they inherit stricter runtime guarantees because the underlying runtime session boundaries fail closed.

| Method   | Path                         | Purpose                                                                                         |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| GET/POST | `/api/runtime/sessions/*`    | Existing proxies continue to work over stricter runtime session invariants.                     |
| GET/POST | `/api/projects/:projectId/*` | Project-scoped Studio proxies remain compatible while runtime rejects missing scope internally. |

### Admin Portal

Admin and observability flows should use an explicit privileged locator contract for summary or diagnostics-only access. This should remain separate from production request-scoped session APIs so production read paths stay simple and fail-closed while privileged reads carry their own audit, redaction, and purpose semantics.

### Channel / SDK / Voice / A2A / MCP Integration

- HTTP, SDK, WebSocket, and voice entry points all move onto one production scope contract.
- Anonymous human guests remain supported, but they must resolve to anonymous `Contact` records before production session creation.
- Customer-known but platform-new voice callers remain supported by creating or resolving a `Contact` from boundary identity evidence before the production session is persisted.
- The currently converted voice/runtime boundaries are HTTP chat bootstrap, LiveKit token issuance, and Twilio media bootstrap. Other voice/channel entry points still need parity with the same preflight and fail-closed semantics.
- Non-human agent/workflow/integration sessions remain supported through an explicit `service_principal` subject kind instead of missing human identity fields.
- Debug and system flows stay supported, but they stop reusing the production shape by omission.
- SearchAI or other system jobs that intentionally operate outside production request scope should eventually use explicit system discriminants instead of optional tenant/project fields.

### Client Contract Impact

- **Web SDK**: Existing `/api/v1/sdk/init` and `/ws/sdk` wire contracts should remain mostly compatible in early rollout phases, but the identity semantics tighten. SDK `userContext.userId` is deprecated as an authoritative customer-identity field and should be treated as personalization or client context only.
- **Verified bootstrap and trusted evidence**: Verified bootstrap artifacts, trusted channel assertions, and boundary-built `identityEvidence` become the authoritative path for human session identity. The resulting canonical production subject is the resolved `contactId`, not a raw client-provided user string.
- **HTTP / API**: Project-scoped request shapes should stay largely compatible, but create/resume flows fail earlier when the server cannot build valid production scope. Pure non-human API executions should identify themselves as `service_principal`, not overload a human `userId`.
- **Voice / channel adapters**: External webhook/provider payloads may remain stable, but adapter implementations must resolve or create `Contact` before persisting a production session. Caller ID, phone, external customer identifiers, and similar raw channel values belong in `identityEvidence`, not in the authoritative subject contract.
- **Studio debug chat**: Studio UX can remain similar, but debug sessions move onto `DebugExecutionScope` rather than reusing the production contract through missing fields.
- **Internal queues / integrations**: Internal producers become stricter than browser/mobile clients. They must send full scope plus actor/subject provenance, not partial `sessionId`-only envelopes with optional context.

**Deprecated client guidance**: do not treat SDK `userContext.userId` as the authoritative customer identity anymore. Use verified bootstrap artifacts, trusted channel evidence, and the resulting canonical `contactId` subject path for human identity.

### Auth Profile Impact

- Auth profiles themselves are already close to the target state: they are tenant/project/environment aware, differentiate `shared` vs `personal`, and already encode connection mode and usage mode. This feature should not redesign auth-profile storage.
- The main change is the ownership input to resolution. Tool auth, preflight, and consent evaluation should use the canonical `actor` plus explicit auth scope from `ExecutionScope`, not optional session `userId` or the human `subject`.
- Human `contact` subjects are usually not the credential owner for tool auth. A customer the session is about and a platform user or service principal acting in the session are different principals and should stay different in auth-profile resolution.
- Session-scoped auth should remain possible, but it needs an explicit session-principal concept instead of overloading raw `userId`.
- Service-principal sessions should use shared/project-safe credentials by default. If the platform later needs principal-bound or session-bound service credentials, that should be added as a first-class policy contract rather than reusing human `personal` / `per_user` semantics.

### Model Resolution Impact

- Model resolution is already the template to copy. Full `ModelResolutionService.resolve()` is actor-scoped and credential-aware, while `resolveReasoningSettings()` is intentionally settings-only.
- This feature should change the source of identity, not the contract itself: the `userId` or principal passed to full resolution should come from validated actor scope rather than optional session fields or reconstructed caller context.
- Canonical human subject identity should not automatically become part of model-resolution cache identity. `contactId` only belongs in resolution scope if a real credential or budget policy depends on it.
- Reasoning-settings caches must remain free of actor/user/contact identity unless the reasoning-resolution pipeline itself begins consulting those fields.

### Memory Impact

- Session working state (`dataValues`, thread state, gather progress) remains per-session and still belongs on the scoped session itself.
- Project persistent memory is already structurally aligned because it is explicitly tenant/project scoped in the fact-store layer.
- The biggest semantic change is human cross-session memory. Anything that represents long-lived human context across sessions and channels should move toward canonical contact-backed storage and retrieval, not overloaded session `userId`.
- Actor-owned memory remains valid for platform-user, debug, or service-principal cases, but it must be explicit. A platform operator’s debug memory and a human customer’s remembered preferences are different ownership domains even if the current runtime sometimes funnels both through `userId`.
- During migration, existing `user` memory lanes should be treated as a compatibility-read path, not a long-lived dual-write model. New human-memory writes should move to contact-backed ownership as soon as the new contract is available, with bounded compatibility reads for legacy agent behavior.
- The target model should distinguish session memory, project memory, contact-backed human memory, and actor-owned memory as separate ownership domains.

### Reporting, Metrics, and Insights Impact

- Session volume, latency, token, and cost metrics remain project-scoped and stable, but human identity rollups must move from `customerId` / `anonymousId` heuristics to canonical `subject.kind` plus `contactId`.
- Reporting pipelines must preserve a queryable distinction between `subject` and `actor`. If a workflow acts on behalf of a human, customer outcome metrics stay attached to the human `contact` subject while automation-utilization metrics attach to the `service_principal` actor.
- Trace, metrics, and admin/reporting materializations should emit or derive additive dimensions such as `scopeKind`, `subjectKind`, `actorKind`, `authType`, `source`, `compatibilityPathUsed`, and `migrationStatus`.
- Insights surfaces that reason about identity quality, omnichannel continuity, or conversion should treat verification as stronger `identityEvidence` for the same human subject rather than as a new user or new session owner.
- Migration-period dashboards should separate canonical rows from legacy compatibility rows so operators can see when reports are still backed by fallback identity fields.
- Existing billing and generic performance dashboards do not need a product redesign; the main change is stronger identity semantics and better query dimensions behind those surfaces.

### Encryption & DEK Impact

- The platform already has the right foundational crypto model for this work: KMS resolution and DEK materialization are keyed by `tenantId + projectId + environment`, not just tenant, through `TenantKMSConfig`, `MaterializedKMSConfig`, `DEKEntry`, and `TenantEncryptionFacade`.
- MongoDB durable session artifacts are already aligned with that model. `session_states.stateData` / `irData` / `compilationData` and `messages.content` are encrypted with project-scoped plugin settings today, so the feature should copy that pattern rather than invent a new one.
- The main gaps are session-adjacent runtime shortcuts:
  - Redis session hot-store encryption is currently wired through tenant sentinels in `SessionService`.
  - BullMQ message-persistence queue encryption currently groups by tenant and encrypts with tenant-default wrappers rather than explicit project scope.
  - Agent-transfer session metadata/provider data are still encrypted with a tenant-scoped session encryptor.
  - ClickHouse/session-event encryption currently uses tenant-scoped wrappers even for rows that already carry `project_id`.
- Contacts are the intentional exception. Contact encrypted identities, blind indexes, and `encryptionSalt` remain tenant-scoped because `Contact` is the canonical tenant-wide human-subject registry that supports cross-project continuity, merge, and erasure.
- Migration must classify session-adjacent ciphertext by current DEK scope. If a project-scoped production artifact is still encrypted under tenant sentinels such as `_tenant` / `_shared`, the rollout needs an explicit re-encryption or quarantine path rather than silently declaring it compliant.
- KMS/DEK auditability should be part of rollout safety. Project-scoped session crypto should produce auditable `projectId` / `environment` / `dekId` signals so key rotation, re-encryption, and compliance reviews can verify the same scoping guarantees as the runtime contract.

### Session Ownership & Authz Impact

- SDK session ownership and session listing are currently defined by a tiered fallback over `customerId`, `channelArtifact`, session principal, and `anonymousId`. That contract has to change alongside session creation so reads, deletes, and resumes use the same canonical semantics as writes.
- Route-local protections should remain, but reusable ownership helpers and list filters need a canonical subject/actor model so Studio proxies and runtime APIs do not drift.
- During migration, compatibility ownership paths should remain observable and deliberately temporary, not hidden inside default matching logic.

### Retention, GDPR, and Archive Impact

- Right-to-erasure and retention flows are more impacted than most UI surfaces because they still discover a subject via legacy fields on sessions, messages, traces, and attachments.
- The canonical end state should treat `contactId` or `service_principal` as the subject-of-record, with explicit migration-aware compatibility rules for historical rows and a privacy-safe anonymization story for event/audit storage.
- During migration, a bounded compatibility scan across known high-risk legacy fields and metadata should remain as a backstop so historical PII is not missed. This scan should be schema-bounded, telemetry-backed, and retired once canonical subject coverage is sufficient.
- Archive and export manifests do not need a brand-new product workflow, but they should record enough canonical scope/migration metadata that compliance operators can reason about what was archived or scrubbed.

### Contact Lifecycle & Merge Impact

- Current verification promotion and contact-linking flows already separate evidence strength from contact linkage, which is a good foundation.
- Once human sessions require canonical `contactId` at creation time, these flows shift from "establish subject late" to "strengthen evidence, merge contacts, back-link historical artifacts, and preserve the same human subject semantics over time."
- Contact deletion, merge, and back-link jobs become part of the contract because canonical `contactId` is no longer just an optional enrichment field.

### Transfer / Handoff Impact

- Agent transfer storage is already closer to the target model because transfer sessions are keyed by contact.
- The remaining risk is adapter behavior: provider-side synthetic user IDs, aliases, and external handles must stay transport metadata rather than leaking into canonical subject semantics or Studio/operator views.
- Human handoff and return-from-handoff flows should preserve the same `contact` subject across runtime, transfer state, reporting, and Studio transfer tooling.

### Audit, Export, and Compliance Summary Impact

- Event, audit, and summary surfaces need more than `actor_id` and `actor_type` once the platform distinguishes `subject` from `actor`.
- The design should favor privacy-preserving canonical scope summaries: queryable enough for operators, reporting, and replay, but safe enough for admin and cross-tenant diagnostics surfaces.
- Export, archive, and GDPR utilities should use the same canonical summary and migration flags as trace and session views so operators do not have to reconcile multiple identity models by hand.

---

## 9. Data Model

### Collections / Tables

```text
Runtime hot store: Redis session keys (existing, contract tightened)
Keys:
  - sess:{tenantId}:{sessionId}
  - sess:{tenantId}:{sessionId}:conv
  - sess-tid:{sessionId}
  - registry:{tenantId}:{sessionId}
  - lock:exec:{tenantId}:{sessionId}
  - resolve:{tenantId}:{channelId}:{artifactHash}
Planned contract changes:
  - missing tenant lookup must fail closed
  - empty-tenant namespaces are disallowed for production sessions
  - scope metadata must be sufficient to validate project and actor/subject provenance
```

```text
Collection: session_states (existing cold store, contract tightened)
Fields:
  - _id: string
  - tenantId: string (required)
  - projectId: string (required for production sessions)
  - stateData: Buffer / encrypted payload
  - threads: Array<...>
  - resolutionKeys: Array<...>
  - createdAt / lastActivityAt / expiresAt
Planned contract changes:
  - production reads/writes require scoped access
  - migration adds or validates explicit scope metadata and subject-of-record
  - project-scoped DEK encryption already exists here and becomes the standard for session-adjacent payloads
Indexes:
  - existing tenant-scoped indexes remain; production paths should no longer use unscoped lookups
```

```text
Collection: sessions (existing durable conversation rows)
Current relevant fields:
  - _id
  - tenantId
  - projectId
  - initiatedById
  - customerId
  - anonymousId
  - contactId
  - channelId / channelArtifact / identityTier / verificationMethod
Planned contract changes:
  - explicit actor provenance
  - explicit `subject` union with `contact` for human sessions and `service_principal` for non-human sessions
  - explicit `identityEvidence` envelope capturing identity strength separately from subject
  - migration classification for legacy rows missing project or canonical subject data
Indexes:
  - existing tenant/project/session indexes stay the base for migration and validation
```

```text
Collection: messages (existing persisted messages)
Current relevant fields:
  - sessionId
  - tenantId
  - projectId
  - traceId
  - contactId
  - channel
Planned contract changes:
  - enqueue-time scope becomes mandatory
  - migration validates that production messages remain project-scoped and tenant-scoped
  - durable message content already uses project-scoped DEK encryption; queue and analytics copies should align with that scope
Indexes:
  - existing tenant/project/session indexes remain required for isolation
```

```text
Collection: contacts (existing tenant-wide human subject registry)
Current relevant fields:
  - tenantId
  - identities[].encryptedValue
  - identities[].blindIndex
  - sourceIdentities[].encryptedEmail / blindIndex
  - encryptionSalt
Planned contract changes:
  - remains tenant-scoped by design because `Contact` is the canonical human-subject anchor across projects
  - project-scoped session enforcement must not split contact identity encryption or blind indexes by project
  - erasure and merge flows must preserve tenant-scoped crypto-shredding and blind-index semantics
Indexes:
  - existing tenant + blind-index indexes remain the basis for human identity continuity and GDPR cleanup
```

```text
Collection: auth_profiles (existing credential registry)
Current relevant fields:
  - tenantId
  - projectId
  - environment
  - visibility
  - connectionMode
  - usageMode
  - createdBy
Planned contract changes:
  - auth-profile storage stays mostly unchanged
  - resolution/preflight should use canonical actor and auth-scope semantics rather than overloaded session `userId`
  - human `contact` subject should not become the implicit owner of personal/per-user credentials
Indexes:
  - existing tenant/project/visibility/createdBy indexes remain the basis for actor-scoped credential lookup
```

```text
Collection: facts (existing persistent memory store)
Current relevant fields:
  - tenantId
  - projectId
  - userId
  - scope
  - key / value / sourceSessionId
Planned contract changes:
  - project-scoped facts remain project-scoped
  - actor-owned memory must stay separate from canonical contact-backed human memory
  - migration should reduce reliance on overloaded `userId` ownership for human cross-session memory
Indexes:
  - existing tenant/project/user/scope indexes remain the basis for isolation while ownership semantics are clarified
```

```text
Collections: tenant_kms_configs, materialized_kms_configs, dek_registry (existing KMS/DEK substrate)
Current relevant fields:
  - tenantId
  - projectId
  - environment
  - resolvedProvider / keyId / failurePolicy
  - dekId / wrappedDek / status
Planned contract changes:
  - session-scope enforcement reuses this existing tenant+project+environment DEK hierarchy
  - project-scoped session artifacts should stop using tenant-wide DEK sentinels when this scope can already be derived safely
  - migration must classify which legacy session-adjacent ciphertext still sits under tenant-scoped compatibility paths
Indexes:
  - existing scope and `dekId` indexes remain the primary lookup path for rotation, decrypt, and migration reporting
```

```text
Table: platform_events and downstream reporting materializations (existing observability/reporting path)
Current relevant fields:
  - tenant_id
  - project_id
  - session_id
  - trace_id
  - agent_name
  - actor_type
Planned contract changes:
  - add or standardize queryable dimensions such as `scopeKind`, `subjectKind`, `actorKind`, `authType`, `source`, `compatibilityPathUsed`, and `migrationStatus`
  - human reporting must aggregate by canonical `contact` subject rather than legacy `customerId` / `anonymousId` heuristics
  - service-principal traffic must remain separable from human-session traffic, even when acting on behalf of a human subject
Indexes / partitions:
  - existing tenant/project/session/trace partitioning remains; new dimensions should be additive and reporting-friendly
```

```text
Table: audit_events and archive/export manifests (existing audit/compliance path)
Current relevant fields:
  - tenant_id
  - project_id
  - actor_id
  - actor_type
  - resource_type / resource_id
  - metadata
Planned contract changes:
  - preserve a privacy-safe canonical scope summary or derived dimensions that distinguish `subject` from `actor`
  - carry migration/compatibility status for operator summaries and exports
  - support anonymization rules that can target subject and actor semantics without leaking raw legacy identifiers
Indexes / partitions:
  - existing tenant/project partitioning remains; canonical scope dimensions should be additive for summary queries and export filters
```

### Key Relationships

- Runtime session state in Redis and MongoDB mirrors the same production scope contract and should no longer diverge on fallback behavior.
- Durable `sessions` rows remain the migration source of truth for project linkage, actor provenance, contact linkage, and current identity evidence hints.
- Message persistence, attachment access, and resume flows all depend on the session scope being trustworthy before deeper ALS-scoped operations run.
- Session-adjacent encryption should follow the same trust boundaries as session authz: project-scoped production payloads use project/environment DEKs, while tenant-wide contact identity remains tenant-scoped.
- Auth profiles should resolve against canonical actor/auth-scope semantics, while human `contact` subject identity remains a separate concern from credential ownership.
- Model resolution should continue consuming actor/project scope and versioned execution inputs without picking up human-subject cache dimensions unnecessarily.
- Persistent human memory should converge on canonical contact-backed context, while actor-owned/debug memory remains separately scoped and reviewable.
- Session views, admin summaries, trace exports, and downstream reporting/insights jobs should consume the same canonical scope summary so live and historical surfaces do not disagree about who a session was about.
- Retention, erasure, archive, and export flows should consume the same canonical scope summary and migration map as session ownership and session detail views.
- Agent-transfer and handoff stores should retain canonical human `contact` subjects even when provider-specific aliases or synthetic IDs are introduced downstream.

---

## 10. Key Implementation Files

### Runtime Scope Slices Landed In `apps/runtime`

| File                                                                  | Purpose                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session/execution-scope.ts`                | Canonical `ExecutionScope`, `SessionLocator`, and privileged-locator contracts used by converted paths. |
| `apps/runtime/src/services/session/execution-scope-factory.ts`        | Boundary scope validation, subject/actor/evidence construction, and required-contact gating.            |
| `apps/runtime/src/services/session/production-contact-scope.ts`       | Shared helper that preflights canonical contact-backed production scope for human session creation.     |
| `apps/runtime/src/services/identity/production-contact-resolution.ts` | Canonical contact resolution helper for guest, SDK, and voice identity inputs.                          |
| `apps/runtime/src/services/session-metadata.ts`                       | Shared request and post-merge `_metadata` validation and merge helpers.                                 |
| `apps/runtime/src/services/runtime-executor.ts`                       | Runtime persistence path, scoped registry/session operations, and follow-up metadata enforcement.       |
| `apps/runtime/src/routes/chat.ts`                                     | HTTP boundary enforcement for production scope, follow-up metadata, and scoped persistence.             |
| `apps/runtime/src/routes/livekit.ts`                                  | LiveKit token boundary that now validates canonical production scope before returning `200`.            |
| `apps/runtime/src/channels/session-resolver.ts`                       | Channel session creation/reuse and follow-up metadata validation on converted channel flows.            |
| `apps/runtime/src/websocket/twilio-media-handler.ts`                  | Voice bootstrap that now fails closed on invalid production scope instead of falling back to echo mode. |
| `apps/runtime/src/channels/pipeline/session-factory.ts`               | Shared runtime session creation path that accepts validated scope and locator inputs.                   |
| `apps/runtime/src/services/session/redis-session-store.ts`            | Hot-store lookup path hardened to fail closed when scoped reverse lookup is missing.                    |
| `apps/runtime/src/services/session/tiered-session-store.ts`           | Scoped cold-restore/version/delete/touch behavior for converted production session flows.               |
| `apps/runtime/src/services/session/session-state-repo.ts`             | Scoped cold-store repo methods that retain `projectId` when locator-based production access is used.    |
| `apps/runtime/src/services/execution/resumption-service.ts`           | Suspension/resumption path that now rebuilds a `SessionLocator` before rehydrating production sessions. |

### Domain / Core Logic

| File                                                                       | Purpose                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session/types.ts`                               | Current serializable session contract with optional tenant/project/user context.                                    |
| `apps/runtime/src/services/session/session-store.ts`                       | Current store interface that still exposes bare-`sessionId` CRUD and lifecycle operations.                          |
| `apps/runtime/src/services/session/session-service.ts`                     | Current orchestration layer for create/load/save/touch/delete over the store.                                       |
| `apps/runtime/src/services/session/redis-session-store.ts`                 | Hot-store implementation with reverse tenant lookup and current empty-tenant fallback behavior.                     |
| `apps/runtime/src/services/session/tiered-session-store.ts`                | Transparent hot-to-cold store wrapper that currently falls back through unscoped cold-store helpers.                |
| `apps/runtime/src/services/session/session-state-repo.ts`                  | Cold-store repository with both scoped public methods and unscoped internal helpers.                                |
| `apps/runtime/src/services/stores/mongo-conversation-store.ts`             | Durable session/message store that already uses ALS fail-closed patterns in some paths.                             |
| `apps/runtime/src/repos/session-repo.ts`                                   | Durable session helper repo, including current unscoped persistence-context lookup helpers.                         |
| `apps/runtime/src/services/identity/session-resolver.ts`                   | Resolution path that already thinks in tenant + channel + artifact terms.                                           |
| `packages/shared-auth/src/middleware/session-ownership.ts`                 | Shared ownership and session-list filter logic that still encodes legacy tiered identity semantics.                 |
| `packages/shared-encryption/src/index.ts`                                  | Shared DEK convenience wrappers whose tenant-default shortcuts currently diverge from project-scoped session needs. |
| `packages/shared-encryption/src/tenant-encryption-facade.ts`               | Canonical DEK envelope API keyed by `tenant + project + environment`.                                               |
| `packages/shared-encryption/src/encryption-manifest.ts`                    | ClickHouse and queue encryption manifest that determines which session-adjacent payloads are encrypted.             |
| `packages/database/src/kms/kms-resolver.ts`                                | Hot-path KMS configuration resolver for tenant/project/environment scope.                                           |
| `packages/database/src/kms/dek-manager.ts`                                 | DEK lifecycle manager that already uses project/environment scope and opaque `dekId` lookup.                        |
| `packages/database/src/models/tenant-kms-config.model.ts`                  | Source-of-truth KMS config with project/environment override support.                                               |
| `packages/database/src/models/materialized-kms-config.model.ts`            | Materialized per-scope KMS config used on the hot read path.                                                        |
| `packages/database/src/models/dek-registry.model.ts`                       | DEK registry keyed by tenant/project/environment with rotation status.                                              |
| `packages/database/src/models/session-state.model.ts`                      | Cold-store session payload model that already uses project-scoped DEK encryption.                                   |
| `packages/database/src/models/message.model.ts`                            | Message model that already uses project-scoped DEK encryption for content.                                          |
| `packages/database/src/models/contact.model.ts`                            | Tenant-wide contact registry whose encrypted identities and blind indexes must remain tenant-scoped.                |
| `packages/database/src/models/auth-profile.model.ts`                       | Auth-profile storage model that is already tenant/project/environment aware and should keep actor-owned semantics.  |
| `packages/database/src/models/fact.model.ts`                               | Persistent memory storage model whose current `userId` ownership semantics need clearer actor/contact separation.   |
| `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts` | Canonical human-subject resolution path that should anchor all human production sessions to `contactId`.            |
| `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`    | Existing promote/link flow that already separates identity proof strength from contact linkage.                     |
| `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`    | Contact deletion flow that already treats contact lifecycle as a compliance boundary.                               |
| `apps/runtime/src/services/auth-profile-resolver.ts`                       | Existing auth-profile lookup helper that should consume canonical actor/auth-scope inputs.                          |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`              | Tool-auth resolver whose current `userId` and auth-scope semantics should be fed from `ExecutionScope.actor`.       |
| `apps/runtime/src/services/auth-profile/auth-preflight.ts`                 | Preflight/consent evaluator that already distinguishes session/user/tenant auth and needs explicit actor semantics. |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`   | Middleware layer that propagates auth-profile context to tools and should stop depending on overloaded session IDs. |
| `apps/runtime/src/services/llm/model-resolution-versioning.ts`             | Canonical contract for actor-scoped full resolution vs settings-only reasoning resolution.                          |
| `apps/runtime/src/services/llm/model-resolution.ts`                        | Full model-resolution service that should keep using actor/project scope rather than human-subject scope.           |
| `apps/runtime/src/services/execution/memory-executor.ts`                   | Current REMEMBER/RECALL logic that still keys persistent memory on `userId`.                                        |
| `apps/runtime/src/services/execution/memory-integration.ts`                | Session-start memory/retrieval orchestration that will need explicit contact vs actor ownership semantics.          |
| `apps/runtime/src/services/execution/tool-memory-bridge.ts`                | Tool-facing memory API that currently exposes `session` / `user` / `project` semantics.                             |
| `apps/runtime/src/services/stores/mongodb-fact-store.ts`                   | Fact store enforcing `(tenantId, userId, projectId)` isolation, which becomes the migration boundary for memory.    |
| `apps/runtime/src/services/contact-context-service.ts`                     | Existing contact-backed cross-session context service that should become the canonical human-memory foundation.     |
| `apps/studio/src/services/retention/mongo-gdpr-store.ts`                   | Current GDPR subject-discovery path that still scans multiple legacy identity fields.                               |
| `apps/studio/src/services/retention/retention-service.ts`                  | Retention orchestration layer that will need canonical subject-aware erasure and archive semantics.                 |
| `packages/agent-transfer/src/session/types.ts`                             | Transfer-session model already keyed by contact and channel, making it a near-target contract.                      |
| `packages/agent-transfer/src/adapters/kore/index.ts`                       | Provider adapter that currently synthesizes provider-side user IDs from internal contact identity.                  |
| `apps/runtime/src/services/trace/emit-to-eventstore.ts`                    | Trace/reporting dual-write path that should emit canonical actor/subject-facing analytics dimensions.               |
| `apps/runtime/src/services/trace/clickhouse-session-trace-events.ts`       | Historical trace rehydration path that should preserve canonical scope metadata in replayed traces.                 |
| `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts`      | Current ClickHouse encryption wiring that still defaults to tenant-scoped wrappers for session-adjacent tables.     |
| `packages/database/src/clickhouse-encryption-interceptor.ts`               | Interceptor that can only scope encrypted rows as well as the caller-provided tenant/project inputs.                |
| `apps/runtime/src/services/kms/kms-audit-logger.ts`                        | KMS audit logger that already carries project/environment/dek metadata needed for rollout observability.            |
| `packages/eventstore/src/schema/platform-event.ts`                         | Core platform-event envelope that currently only carries actor-oriented identity fields.                            |
| `packages/eventstore/src/interfaces/event-gdpr.ts`                         | Event GDPR interface that currently anonymizes actor identity only.                                                 |
| `apps/runtime/src/services/stores/clickhouse-audit-store.ts`               | Audit query/store path that needs canonical subject-aware summaries and privacy-safe dimensions.                    |

### Routes / Handlers

| File                                                            | Purpose                                                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/channels/pipeline/session-factory.ts`         | Central production session bootstrap for multiple realtime channels.                                                  |
| `apps/runtime/src/services/session/session-bootstrap.ts`        | Shared deployment-aware session bootstrap path.                                                                       |
| `apps/runtime/src/routes/chat.ts`                               | HTTP chat/session creation path that eventually persists messages and metrics.                                        |
| `apps/runtime/src/websocket/handler.ts`                         | Internal WebSocket session create/resume path, including debug resume logic and message persistence calls.            |
| `apps/runtime/src/websocket/sdk-handler.ts`                     | SDK WebSocket bootstrap, persistence, and session resume path.                                                        |
| `apps/runtime/src/websocket/sdk-handler-contact-linking.ts`     | Current SDK helper that resolves `customerId` into `contactId` and should become part of the mandatory boundary path. |
| `apps/runtime/src/websocket/twilio-media-handler.ts`            | Voice session bootstrap path that currently overloads identity into `userId`.                                         |
| `apps/runtime/src/routes/admin-sessions.ts`                     | Admin session summaries/details that currently expose legacy identity fields and need canonical scope summaries.      |
| `apps/runtime/src/routes/platform-admin-traces.ts`              | Safe cross-tenant trace lookup surface that should gain canonical, privacy-preserving scope dimensions.               |
| `apps/runtime/src/routes/memory-api.ts`                         | Memory API surface whose ownership semantics should align with contact-backed human memory and actor-owned memory.    |
| `apps/runtime/src/routes/attachments.ts`                        | Route-local project/session attachment checks that illustrate the need for stronger reusable service boundaries.      |
| `apps/studio/src/app/api/runtime/sessions/route.ts`             | Studio proxy for project-scoped session lists that should pass through canonical scope summaries.                     |
| `apps/studio/src/app/api/runtime/sessions/[id]/route.ts`        | Studio proxy for session detail/delete that should remain project-scoped and identity-light.                          |
| `apps/studio/src/app/api/runtime/sessions/[id]/traces/route.ts` | Studio proxy for historical traces that should replay canonical scope metadata consistently.                          |
| `apps/studio/src/app/api/runtime/insights/route.ts`             | Studio proxy for project-scoped insights surfaces that inherit new identity/query dimensions.                         |
| `apps/studio/src/app/api/archives/sessions/route.ts`            | Studio-triggered archive surface that should align manifests and compliance summaries with canonical scope semantics. |
| `apps/studio/src/app/api/archives/traces/route.ts`              | Studio trace archive trigger that should reflect canonical scope/migration metadata.                                  |

### UI Components

| File                                                           | Purpose                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/session/SessionsListPage.tsx`      | Project-scoped session explorer that currently renders identity-light read models and should gain additive scope metadata. |
| `apps/studio/src/components/session/SessionDetailPage.tsx`     | Historical session detail page that should expose canonical scope summary and migration state alongside traces/metrics.    |
| `apps/studio/src/components/traces/TracesPage.tsx`             | Trace explorer that currently groups sessions by agent and should stay consistent with canonical trace/session semantics.  |
| `apps/studio/src/hooks/useSessionDetail.ts`                    | Session-detail hook that normalizes runtime responses and trace replay into Studio read models.                            |
| `apps/studio/src/components/chat/StudioChatPanel.tsx`          | Studio debug chat shell layered over the web SDK; needs explicit debug-only scope semantics.                               |
| `apps/studio/src/components/chat/SessionSidebar.tsx`           | Studio session sidebar that resumes, loads, deletes, and bulk-closes runtime sessions through proxies.                     |
| `apps/studio/src/components/operate/TransferSessionsPage.tsx`  | Studio transfer-monitoring page that already surfaces `contactId` and should keep provider aliases non-authoritative.      |
| `apps/studio/src/components/insights/CustomerInsightsPage.tsx` | Representative identity-sensitive insights UI that should stay project-scoped while gaining canonical dimensions.          |
| `apps/studio/src/hooks/useAtAGlance.ts`                        | Aggregate insights hook that should consume additive rollout dimensions without changing its project-scoped shape.         |
| `apps/studio/src/hooks/useInsightsDashboard.ts`                | Dashboard summary hook that should remain aggregate-oriented while aligning with canonical analytics dimensions.           |

### Jobs / Workers / Background Processes

| File                                                              | Purpose                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/message-persistence-queue.ts`          | Queue producer/worker contract that currently accepts partial scope and performs late repair.                             |
| `apps/runtime/src/services/kms/kms-audit-logger.ts`               | KMS audit writer that should become part of compatibility-path and re-encryption observability.                           |
| `apps/runtime/src/services/execution/auth-profile-fanout.ts`      | Branch/delegate auth propagation helper that should consume explicit actor/session-principal semantics.                   |
| `apps/runtime/src/services/execution/auth-profile-handoff.ts`     | Handoff auth propagation helper that already distinguishes session/user auth and should stop overloading `userId`.        |
| `apps/search-ai/src/workers/reconciliation-processor.ts`          | Example system-mode worker that currently encodes full-sweep behavior through optional tenant/index input.                |
| `apps/runtime/src/services/agent-transfer/event-queue-factory.ts` | Lower-priority global dead-letter storage example that should eventually align with explicit scope design.                |
| `apps/studio/src/services/retention/retention-service.ts`         | Scheduled retention/GDPR orchestration that must become canonical-subject aware during migration and enforcement rollout. |

### Tests

| File                                                                             | Type        | Coverage Focus                                                                                                           |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/session-scope-factory.test.ts`                       | unit        | Scope construction, contact-backed human subjects, and wrong-shape / wrong-kind regressions.                             |
| `apps/runtime/src/__tests__/channels/pipeline-session-factory.test.ts`           | integration | Shared runtime session-create contract and scope propagation across converted channel/session bootstraps.                |
| `apps/runtime/src/__tests__/channels/livekit-routes.test.ts`                     | integration | LiveKit token boundary fail-closed behavior before token issuance.                                                       |
| `apps/runtime/src/__tests__/channels/ws-twilio-handler.test.ts`                  | integration | Twilio fail-closed bootstrap behavior and canonical voice contact handling.                                              |
| `apps/runtime/src/__tests__/identity/production-contact-resolution.test.ts`      | unit        | Canonical contact resolution precedence, including `channelArtifact` over ephemeral session principals.                  |
| `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`                        | integration | HTTP chat bootstrap/follow-up scope validation and `413 PAYLOAD_TOO_LARGE` metadata enforcement.                         |
| `apps/runtime/src/__tests__/sessions/session-locator.test.ts`                    | integration | Locator-based load/version/delete/touch/cold-restore behavior on converted production seams.                             |
| `apps/runtime/src/__tests__/sessions/session-resolver-gaps.test.ts`              | integration | Channel resolver/session follow-up gaps, including metadata merge overflow failures.                                     |
| `apps/runtime/src/__tests__/routing/async-fanout-resumption.test.ts`             | integration | Suspension/resumption rehydrate path using scoped locators instead of bare `sessionId`.                                  |
| `apps/runtime/src/__tests__/execution/runtime-executor.test.ts`                  | unit        | Runtime follow-up metadata and scoped persistence error propagation.                                                     |
| `apps/runtime/src/__tests__/tiered-session-store.test.ts`                        | unit        | Current cold-restore behavior and current normalization of unscoped internal helpers.                                    |
| `apps/runtime/src/__tests__/message-persistence-queue-full.test.ts`              | unit        | Current queue contract, including missing-scope normalization in tests.                                                  |
| `apps/runtime/src/__tests__/sessions/session-rehydration.test.ts`                | integration | Existing session restore behavior that should gain scoped negative coverage.                                             |
| `apps/runtime/src/__tests__/sessions/session-security.test.ts`                   | integration | Session authorization and ownership regression surface.                                                                  |
| `apps/runtime/src/__tests__/mongo-conversation-store-isolation.test.ts`          | integration | Existing ALS-based isolation behavior that Phase 2 should preserve.                                                      |
| `packages/shared-auth/src/__tests__/session-ownership.test.ts`                   | unit        | Shared session ownership and session-list filter behavior that must move to canonical semantics.                         |
| `apps/runtime/src/__tests__/auth/auth-profile-propagation.test.ts`               | unit        | Auth propagation behavior that currently reuses `userId` for session principals and should move to explicit actor scope. |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-executor-integration.test.ts` | integration | Tool-auth resolution path that should stay actor-owned and not collapse into human-subject semantics.                    |
| `apps/runtime/src/__tests__/model-resolution-versioning.test.ts`                 | unit        | Existing contract test that protects actor-scoped full resolution and settings-only reasoning caches.                    |
| `apps/runtime/src/__tests__/memory-integration.test.ts`                          | integration | Existing memory behavior that should distinguish contact-backed human memory from actor-owned memory.                    |
| `apps/runtime/src/__tests__/mongodb-fact-store-scope.test.ts`                    | unit        | Fact-store isolation tests that will anchor the migration from overloaded `userId` ownership semantics.                  |
| `packages/database/src/__tests__/encryption-plugin-dek.test.ts`                  | unit        | Existing project-scoped DEK plugin coverage that should become the template for session payload encryption.              |
| `packages/database/src/__tests__/clickhouse-encryption-interceptor.test.ts`      | unit        | Existing ClickHouse encryption coverage that should gain project-scoped session-artifact assertions.                     |
| `packages/database/src/__tests__/kms-resolver.test.ts`                           | unit        | Existing tenant/project/environment KMS resolution coverage relevant to DEK scope alignment.                             |
| `packages/shared-encryption/src/__tests__/tenant-encryption-facade.test.ts`      | unit        | Existing DEK envelope behavior that should remain compatible while callers tighten scope.                                |
| `apps/runtime/src/__tests__/auth/kms-per-tenant-integration.test.ts`             | integration | Existing end-to-end KMS/DEK coverage that should expand to project-scoped runtime-session paths.                         |
| `apps/runtime/src/__tests__/auth/encryption-salt-lifecycle.test.ts`              | integration | Existing contact crypto-shredding behavior that should remain tenant-scoped by design.                                   |
| `packages/eventstore/src/__tests__/retention-gdpr.test.ts`                       | integration | Event GDPR anonymization behavior that currently only reasons about actor identity.                                      |
| `apps/studio/src/__tests__/retention-scheduler.test.ts`                          | integration | Studio retention/GDPR subject-discovery behavior that still scans legacy identity fields.                                |
| `apps/studio/src/__tests__/hooks/session-hooks.test.ts`                          | unit        | Studio session list/detail read-model expectations that should gain additive scope metadata.                             |
| `apps/studio/src/__tests__/agent-transfer-ui.test.ts`                            | component   | Studio transfer-monitoring UI expectations around contact identity and session state.                                    |
| `packages/agent-transfer/src/__tests__/unit/session-field-encryption.test.ts`    | unit        | Current transfer-session encryption behavior that should stop relying on tenant-scoped defaults for project sessions.    |

---

## 11. Configuration

### Environment Variables

| Variable                             | Default           | Description                                                                           |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------- |
| `SESSION_SCOPE_ENFORCEMENT_MODE`     | `audit` (planned) | Planned rollout mode for boundary validation: `audit`, `warn`, `enforce`.             |
| `SESSION_SCOPE_MIGRATION_BATCH_SIZE` | `500` (planned)   | Planned batch size for session/cold-store/message backfill and quarantine jobs.       |
| `SESSION_SCOPE_COMPAT_TTL_HOURS`     | `24` (planned)    | Planned compatibility-window TTL for legacy fallback metrics and migration reporting. |

### Runtime Configuration

- Production session builders must require `tenantId`, `projectId`, `sessionPrincipalId`, actor provenance, subject-of-record, identity evidence, `authType`, `source`, and `traceId`.
- Compatibility wrappers may remain temporarily, but they should be measurable and disabled per rollout mode.
- Project scope is mandatory for all production runtime sessions. Tenant-only runtime sessions move onto debug or system discriminants.
- `environment` should be resolved once at the runtime boundary and carried explicitly in production scope. Compatibility adapters may still translate no-env paths through documented fallback behavior, but the core runtime contract should not re-derive environment downstream.
- Project-scoped production session artifacts should resolve DEKs at `tenantId + projectId + environment` whenever the artifact itself is project-scoped. Tenant-wide sentinels such as `_tenant` or `_shared` remain allowed only for documented tenant-scoped artifacts like contacts, tenant-level configs, or explicit compatibility paths.
- Auth-profile resolution should accept canonical actor/auth-scope input rather than inferring credential ownership from overloaded runtime `userId`.
- Memory configuration should distinguish actor-owned persistent memory from canonical contact-backed human continuity, even when temporary compatibility shims remain.

### DSL / Agent IR / Schema

No user-facing DSL change is required in Phase 1 or Phase 2. The primary schema additions are internal runtime types.

```ts
type ExecutionScope = ProductionExecutionScope | DebugExecutionScope | SystemExecutionScope;

type SessionScope = Pick<
  ProductionExecutionScope,
  'kind' | 'tenantId' | 'projectId' | 'sessionId' | 'sessionPrincipalId' | 'actor' | 'subject'
>;

type SessionSubject =
  | { kind: 'contact'; contactId: string }
  | {
      kind: 'service_principal';
      principalType: 'workflow' | 'agent' | 'integration';
      principalId: string;
    };

type SessionActor =
  | { kind: 'contact'; contactId: string }
  | { kind: 'platform_user'; userId: string }
  | { kind: 'api_key'; keyId: string }
  | {
      kind: 'service_principal';
      principalType: 'workflow' | 'agent' | 'integration';
      principalId: string;
    };

type IdentityEvidence = {
  identityTier: 0 | 1 | 2;
  verificationMethod: VerificationMethod;
  verificationAttemptId?: string;
  verifiedAt?: string;
  policySource: 'runtime_default' | 'channel_policy' | 'project_policy' | 'tenant_policy';
  grantScope: 'session' | 'same_channel' | 'project_contact' | 'cross_channel' | 'service';
  artifacts: Array<{
    type: 'email' | 'phone' | 'external' | 'cookie' | 'caller_id' | 'device_id';
    valueHash: string;
  }>;
};

type ProductionExecutionScope = {
  kind: 'production';
  tenantId: string;
  projectId: string;
  sessionId: string;
  sessionPrincipalId: string;
  channelId?: string;
  traceId: string;
  authType: string;
  source: string;
  actor: SessionActor;
  subject: SessionSubject;
  identityEvidence: IdentityEvidence;
  callerContext?: unknown;
};

type DebugExecutionScope = {
  kind: 'debug';
  tenantId: string;
  projectId: string;
  sessionId: string;
  actor: Exclude<SessionActor, { kind: 'contact' }>;
  source: string;
  traceId: string;
  callerData?: unknown;
};

type SystemExecutionScope = {
  kind: 'system';
  tenantId: string;
  projectId?: string;
  sessionId: string;
  actor: Extract<SessionActor, { kind: 'service_principal' }>;
  source: string;
  traceId: string;
  operation: string;
};
```

For human production flows, `subject.kind = 'contact'` is mandatory before session creation completes. `sessionPrincipalId` is still mandatory before that resolution completes, because anonymous and pre-verification traffic needs a canonical provenance slot that is separate from human identity. Raw `customerId`, caller ID, cookies, or other external identifiers belong in `identityEvidence` and caller context, not in the authoritative subject contract.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Every production session must carry `projectId`, and project-scoped reads/writes must fail closed when `projectId` is missing or mismatched.                             |
| Tenant isolation  | Hot-store, cold-store, queue, and durable session/message operations must never widen missing tenant scope into `''` or unscoped lookups.                                |
| User isolation    | All human production sessions must anchor to `contactId`, while actor provenance remains explicit, so cross-user access stays rejectable at reusable service boundaries. |

### Security & Compliance

- Fail-closed boundary validation is the primary security improvement in this feature.
- Durable actor/subject/source/trace provenance improves auditability for regulated workloads.
- Migration must not silently widen access when classifying legacy sessions; unknown records should be quarantined or allowed to expire.
- Compatibility paths need observability so enforcement can be measured before it becomes mandatory.
- Project-scoped session data should not retain tenant-scoped DEK shortcuts indefinitely; otherwise blast-radius control and per-project key-rotation guarantees remain weaker than the access contract.
- KMS auditability matters for this rollout. Re-encryption, compatibility decrypts, and project-scoped session writes should be observable with project/environment/dek metadata where platform-managed crypto is involved.

### Performance & Scalability

- Phase 1 should add cheap boundary validation, not repeated deep-path lookups.
- Redis and Mongo round-trips should not increase materially on the hot path; the goal is safer addressing, not more fan-out.
- Migration jobs must batch work predictably and avoid unbounded scans in live request paths.

### Reliability & Failure Modes

- Missing scope must become an explicit, observable failure mode rather than an implicit empty-namespace write.
- Reverse-lookup expiry in Redis must fail closed and fall back only through scoped restore behavior.
- Compatibility rollout should support audit-only and warning modes before full enforcement.
- Red-first regression tests are required to reduce the risk of "fixing" only the happy path.
- Session-adjacent crypto should follow the same fail-closed rule. If project-scoped DEK inputs are unavailable for a project-scoped production artifact, the system should reject the write or enter an explicit compatibility path, not silently downgrade to tenant-wide defaults.

### Observability

- Emit structured logs for scope-construction failures, compatibility-wrapper use, migration classifications, quarantine counts, and queue drops.
- Add counters or dashboards for:
  - production session create failures due to missing scope
  - queue enqueue failures due to missing scope
  - legacy compatibility-path usage
  - migration success / quarantine / expiry counts
  - deprecated SDK `userContext.userId` identity usage
  - reporting rows missing canonical `subjectKind` / `actorKind` dimensions
  - human `contact` sessions vs `service_principal` sessions in reporting and insights pipelines
  - Studio proxy/detail responses missing canonical scope summary or migration state
  - retention/GDPR operations still falling back to legacy field-scan compatibility paths
  - project-scoped session artifacts still encrypted through tenant-scoped compatibility paths
  - KMS audit rows for session-adjacent writes or re-encryption missing `projectId`, `environment`, or `dekId`

### Data Lifecycle

- Legacy session and cold-store data must be classified and migrated before compatibility lanes are removed.
- Unclassifiable production records should not be rewritten into insecure defaults.
- Migration and quarantine records should have bounded retention so rollout artifacts do not become permanent operational debt.
- Archived exports, GDPR manifests, and Studio-driven compliance actions should record enough canonical scope metadata to remain interpretable after legacy fields are retired.
- Legacy project-scoped session ciphertext that was written through tenant-scoped DEK shortcuts may need re-encryption or explicit quarantine before the compatibility lane can be removed.

---

## 13. Delivery Plan / Work Breakdown

Use parent tasks with numbered subtasks so execution can be tracked clearly.

**Split criteria for HLD / execution planning**:

- If Phase 1 boundary enforcement (FR-1 to FR-12, FR-22 to FR-24) is blocked by cross-cutting read-model or compliance work, split FR-13 to FR-18 into a sibling sub-feature focused on operator/reporting/Studio surfaces.
- If crypto alignment or re-encryption planning materially delays scope-boundary rollout, split FR-19 to FR-21 into a sibling sub-feature focused on DEK alignment and encrypted-artifact migration.
- HLD may still describe these as one program, but implementation should split once cross-cutting or crypto work threatens timely delivery of the production P0 boundary fixes.

1. Establish the safety harness first.
   1.1 Add adversarial regression tests for reverse-lookup expiry, cross-tenant cold restore, missing queue scope, and incomplete debug resume before enforcement code is written.
   1.2 Add compatibility counters and structured warnings to current fallback paths so rollout impact is measurable.
   1.3 Inventory persisted session, cold-store, and message records that need migration or quarantine, and produce the migration volume estimate required for HLD sizing.
   1.4 Inventory shared-auth ownership filters, retention/GDPR jobs, event/audit surfaces, transfer adapters, and Studio read models that still encode legacy identity semantics.
   1.5 Inventory session-adjacent encrypted artifacts and classify which ones already use project-scoped DEKs versus tenant-scoped compatibility paths.
2. Enforce scope at production boundaries.
   2.1 Introduce typed `ExecutionScope`, `SessionScope`, `SessionActor`, `SessionSubject`, and `IdentityEvidence` contracts.
   2.2 Make HTTP and realtime session-create paths build validated production scope before calling shared runtime session bootstrap.
   2.3 Make queue enqueue APIs require full scope and audit envelope instead of optional tenant/project inputs.
   2.4 Enforce the product decision that every production session is project-scoped.
   2.5 Publish and apply client guidance that deprecates SDK `userContext.userId` as authoritative customer identity in favor of verified bootstrap and trusted identity evidence.
   2.6 Replace shared ownership/list-filter logic so session read, resume, and delete decisions use canonical subject/actor semantics rather than legacy customer/anonymous fallbacks.
   2.7 Publish a canonical encryption-scope matrix that distinguishes project-scoped session artifacts from tenant-scoped contact identity and other explicit exceptions.
3. Propagate validated scope through stores and deep layers.
   3.1 Refactor `SessionStore`, `SessionService`, Redis store, tiered store, and cold-store repo to use scoped locators instead of bare `sessionId`.
   3.2 Mirror validated scope into ALS for deep repository/service layers, while preserving explicit boundary ownership of the authoritative scope.
   3.3 Tighten reusable service boundaries that currently rely on route-local session/project checks.
   3.4 Update trace, admin-summary, and reporting emitters/readers so canonical actor/subject dimensions remain visible in live and historical surfaces without exposing raw legacy identity fields.
   3.5 Update retention/GDPR subject resolution, contact deletion cleanup, and archive/export compatibility paths to use canonical subject semantics plus migration-aware lookups.
   3.6 Update agent transfer and handoff adapters so canonical `contactId` remains authoritative and provider aliases stay transport-only.
   3.7 Update Studio proxies, read models, trace replay, transfer views, and debug surfaces so they surface additive canonical scope metadata without treating debug callerData as authoritative production identity.
   3.8 Align Redis hot-store, queue, agent-transfer, and ClickHouse/session-event encryption paths with project-scoped DEK usage for production session artifacts while preserving tenant-scoped contact crypto.
   3.9 Feed auth-profile resolution, preflight, and session-auth helpers from canonical actor/auth-scope semantics and define policy for service-principal credential usage.
   3.10 Preserve the current model-resolution contract while switching full resolution onto canonical actor scope and keeping reasoning-settings caches free of human-subject identity.
   3.11 Separate contact-backed human memory from actor-owned/debug memory and migrate persistent-memory ownership away from overloaded session `userId`.
4. Split debug and system contracts.
   4.1 Introduce discriminated debug and system scope variants separate from production scope.
   4.2 Update debug resume and system workers to stop relying on missing scope as control flow.
   4.3 Remove unscoped production-path helpers after compatibility usage drops to zero.
   4.4 Update event/audit schemas and anonymization utilities so canonical subject/actor semantics survive replay, summaries, and GDPR workflows.
5. Migrate legacy data and roll out enforcement.
   5.1 Backfill scope, canonical `contactId` subject data for human sessions, and actor/evidence metadata where they can be derived safely from durable session rows and caller context.
   5.2 Quarantine or age out records that cannot be classified safely.
   5.3 Use a bounded dead-letter or repair lane for pre-enforcement queue payloads only where needed, with explicit telemetry, retention limits, and retirement criteria.
   5.4 Roll rollout mode from `audit` to `warn` to `enforce` using observed compatibility and failure counters, and keep rollback to `warn` as a rehearsed operational path.
   5.5 Re-encrypt or retire legacy project-scoped session artifacts that still depend on tenant-scoped DEK compatibility paths.
6. Validate and close the feature.
   6.1 Turn all red adversarial tests green.
   6.2 Validate both forward rollout (`audit` -> `warn` -> `enforce`) and rollback (`enforce` -> `warn`) before production cutover.
   6.3 Run targeted runtime builds/tests, then repo-level `pnpm build` before broader test execution.
   6.4 Sync parent Memory & Sessions documentation and downstream design docs once implementation lands.

---

## 14. Success Metrics

| Metric                                                                       | Baseline                                           | Target                                               | How Measured                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Production session creates missing `projectId`                               | Allowed in several current contracts               | 0 after enforcement                                  | Boundary validation counters and logs            |
| Empty-tenant Redis session operations                                        | Possible through current fallback logic            | 0                                                    | Redis/compatibility metrics and regression tests |
| Queue messages dropped for missing scope in steady-state production traffic  | Non-zero risk due to optional enqueue contract     | 0 after caller migration                             | Queue failure counters after rollout             |
| Compatibility-path usage                                                     | Current production paths rely on fallback behavior | 0 before Phase 3 cleanup                             | Compatibility counters on wrappers/fallbacks     |
| Adversarial regression coverage                                              | Missing for several audit findings                 | 100% of listed Phase 0 scenarios                     | New unit/integration/e2e test matrix             |
| Legacy session migration classification                                      | Unknown                                            | >99% classified or intentionally expired/quarantined | Migration job reporting                          |
| Trace/reporting rows with canonical `subjectKind` and `actorKind` dimensions | Partial / legacy-field dependent                   | >99% after migration and compatibility rollout       | ClickHouse/admin/reporting validation            |
| Session ownership decisions resolved through canonical subject/actor logic   | Legacy-tier based today                            | >99% after compatibility rollout                     | Shared-auth/runtime authz metrics and tests      |
| Retention/GDPR operations using legacy field-scan compatibility path         | Likely common on historical data                   | Trend to 0 before compatibility removal              | Retention telemetry and audit logs               |
| Studio session/trace detail responses carrying canonical scope summary       | Not exposed today                                  | >99% after read-model rollout                        | Studio proxy/component validation                |
| Auth-profile resolutions using canonical actor/auth-scope semantics          | Partial / overloaded `userId` today                | >99% after compatibility rollout                     | Auth-profile preflight + runtime auth telemetry  |
| Model-resolution cache keys incorrectly including subject/contact dimensions | No known issue today                               | 0 regressions                                        | Contract tests + cache-key validation            |
| Human cross-session memory still relying on overloaded session `userId`      | Common in current runtime bootstrap                | Trend to 0 before compatibility removal              | Memory telemetry + fact-store migration reports  |
| Project-scoped session artifacts still using tenant-scoped DEK compatibility | Unknown                                            | 0 before compatibility removal                       | KMS audit + migration reporting                  |
| Session-adjacent KMS audit rows with project/environment/dek metadata        | Inconsistent today                                 | >99% for project-scoped encrypted session artifacts  | KMS audit log validation                         |

---

## 15. Open Questions

No HLD-blocking open questions remain in this sub-feature spec. Remaining implementation choices should be handled inside HLD/LLD within the constraints already decided here:

- privileged admin/observability reads use a separate explicit privileged locator contract
- GDPR/retention keeps a bounded legacy compatibility scan during migration
- Studio session detail is the operator-facing source of truth, backed by a dedicated diagnostics/read-model payload
- production scope carries `environment` explicitly from the runtime boundary
- service principals use shared/project-safe auth profiles by default
- legacy human `user` memory semantics retire through compatibility-read migration rather than long-lived dual-write

---

## 16. Gaps, Known Issues & Limitations

The production runtime core is no longer at the fully pre-implementation state captured in the original plan. Converted `apps/runtime` seams now enforce `ExecutionScope` / `SessionLocator`, LiveKit and Twilio fail closed at their converted boundaries, canonical contact resolution is active on landed human paths, resumed SDK/HTTP sessions now backfill canonical `contactId` into live and durable state, runtime fact stores re-key when canonical contact arrives, and follow-up `_metadata` overflows return `413` instead of being silently dropped. The table below tracks the remaining cross-package work and the compatibility debt that still exists after those runtime slices.

| ID      | Description                                                                                                                                                                                                                         | Severity | Status  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| GAP-001 | Compatibility APIs still expose bare-`sessionId` operations, but converted production create/load/resume paths now use `ExecutionScope` / `SessionLocator`; the remaining work is broader API cleanup.                              | Medium   | Partial |
| GAP-002 | Privileged and migration-oriented internal cold-store helpers still exist, but converted production restore/version/delete/touch paths now use scoped locators end to end.                                                          | Medium   | Partial |
| GAP-003 | `RedisSessionStore` no longer fails open on a missing reverse lookup for converted production access, but legacy unscoped compatibility methods still exist outside the hardened path.                                              | Medium   | Partial |
| GAP-004 | Scoped queue/persistence contracts are landed on converted runtime paths, but broader downstream/reporting/encryption cleanup is still needed before the compatibility story is complete.                                           | Medium   | Partial |
| GAP-005 | Debug and system flows still reuse production session primitives by omission; this split is intentionally deferred to Phase 3 after the production P0s are closed.                                                                  | Medium   | Planned |
| GAP-006 | Some reusable service boundaries still rely on route-local ownership checks rather than universally typed scope contracts.                                                                                                          | Medium   | Open    |
| GAP-007 | Converted SDK/HTTP resume paths now repair missing canonical `contactId` when contact resolution succeeds, but older production sessions still may require quarantine or expiry if they lack project scope or actor classification. | Medium   | Partial |
| GAP-008 | Session reporting, admin summaries, and trace materialization still rely on legacy identity fields or omit canonical actor/subject dimensions entirely.                                                                             | Medium   | Open    |
| GAP-009 | GDPR/retention subject discovery still scans legacy identifiers such as `customerId`, `anonymousId`, and `callerNumber` instead of canonical subject mappings.                                                                      | High     | Open    |
| GAP-010 | Shared session ownership and SDK session-list filters still encode `customerId` / `channelArtifact` / `anonymousId` priority logic.                                                                                                 | High     | Open    |
| GAP-011 | Agent-transfer adapters can synthesize provider-side user IDs from internal contact identity, which risks provider aliases looking canonical in downstream tooling.                                                                 | Medium   | Open    |
| GAP-012 | Event and audit schemas still primarily carry `actor_id` / `actor_type`, which is insufficient for subject-aware replay, export, and anonymization semantics.                                                                       | Medium   | Open    |
| GAP-013 | Studio session, trace, debug, retention, and transfer surfaces are mostly identity-light today and do not yet expose canonical scope or migration metadata.                                                                         | Medium   | Open    |
| GAP-014 | Several session-adjacent encrypted paths (Redis hot store, queue payloads, agent transfer, ClickHouse/session events) still use tenant-scoped DEK shortcuts despite project-scoped production session semantics.                    | High     | Open    |
| GAP-015 | The repository does not yet have an explicit encryption-scope matrix documenting which artifacts are intentionally tenant-scoped exceptions, which makes migration and review harder.                                               | Medium   | Open    |
| GAP-016 | Auth-profile and memory helpers still overload `userId` to mean platform user, session principal, service principal, or customer/contact surrogate depending on the path.                                                           | High     | Open    |
| GAP-017 | Model resolution already has the right contract, but not every caller is yet guaranteed to feed it canonical actor scope instead of optional session fields.                                                                        | Medium   | Open    |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                                           | Coverage Type    | Status     | Test File / Note                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Reverse-lookup expiry fails closed and does not read/write the empty-tenant namespace                                                              | integration      | COVERED    | `redis-session-store-lookup.test.ts`, `session-locator.test.ts`                                                                                  |
| 2   | Cross-tenant cold restore is rejected when hot-store tenant mapping is absent or mismatched                                                        | integration      | COVERED    | `tiered-session-store.test.ts`, `session-locator.test.ts`                                                                                        |
| 3   | Production HTTP session create rejects missing project-scoped `ExecutionScope`                                                                     | e2e              | PARTIAL    | `chat-routes.test.ts`, `livekit-routes.test.ts` are real integration guards; full black-box E2E still pending                                    |
| 4   | Guest human session bootstrap resolves to anonymous `contactId` before production session creation                                                 | e2e              | PARTIAL    | `session-scope-factory.test.ts`; full guest E2E still pending                                                                                    |
| 5   | Customer-known voice caller resolves or creates `contactId` before production persistence continues                                                | e2e              | PARTIAL    | `ws-twilio-handler.test.ts`, `livekit-routes.test.ts`; full voice harness E2E still pending                                                      |
| 6   | SDK/WebSocket session create and resume enforce project scope and canonical human-subject / actor semantics                                        | e2e              | PARTIAL    | `ws-sdk-handler.test.ts` covers resume identity/contact backfill and durable-row continuity; full `/ws/sdk` black-box E2E still pending          |
| 7   | Verification promotion strengthens identity evidence without changing the human subject model                                                      | e2e              | NOT TESTED | Planned against real verification flows                                                                                                          |
| 8   | Queue enqueue rejects missing tenant/project and preserves actor/subject/evidence provenance when valid                                            | integration      | COVERED    | `message-persistence-queue-full.test.ts`, `pipeline-session-factory.test.ts`                                                                     |
| 9   | Debug resume with incomplete scope does not accidentally bind or persist as production scope                                                       | integration      | PARTIAL    | Converted runtime locator/scope tests exist; dedicated debug-resume regression remains planned                                                   |
| 10  | Migration backfill classifies valid legacy sessions and quarantines unsafe rows without widening access                                            | integration      | NOT TESTED | Planned migration-job coverage                                                                                                                   |
| 11  | Reporting/admin trace surfaces preserve canonical human vs service-principal dimensions without raw legacy identity leakage                        | integration      | NOT TESTED | Planned in admin/reporting trace coverage                                                                                                        |
| 12  | Session ownership and session-list filters authorize via canonical subject/actor semantics rather than legacy identity tiers                       | integration      | NOT TESTED | Planned in shared-auth/runtime authz coverage                                                                                                    |
| 13  | Retention/GDPR flows resolve subjects through canonical mapping and compatibility telemetry without silently widening scope                        | integration      | NOT TESTED | Planned in Studio retention/eventstore tests                                                                                                     |
| 14  | Transfer and handoff flows preserve canonical contact subject while provider aliases remain transport metadata only                                | integration      | NOT TESTED | Planned in agent-transfer/runtime tests                                                                                                          |
| 15  | Audit/event/export surfaces preserve privacy-safe canonical scope summary through replay, anonymization, and archive views                         | integration      | NOT TESTED | Planned in eventstore/audit tests                                                                                                                |
| 16  | Studio session/traces/debug/transfer surfaces remain compatible and expose additive canonical scope metadata                                       | integration      | NOT TESTED | Planned in Studio proxy/hook/component tests                                                                                                     |
| 17  | Studio insights and aggregate dashboards consume canonical rollout dimensions without needing legacy identity heuristics                           | integration      | NOT TESTED | Planned in Studio insights proxy/hook tests                                                                                                      |
| 18  | Project-scoped production session artifacts encrypt with project/environment DEKs while tenant-scoped contact crypto remains an explicit exception | integration      | NOT TESTED | Planned in KMS/runtime/queue/transfer tests                                                                                                      |
| 19  | Legacy tenant-scoped session ciphertext is re-encrypted, quarantined, or explicitly compatibility-tracked with KMS audit metadata                  | integration      | NOT TESTED | Planned in migration/KMS audit coverage                                                                                                          |
| 20  | Auth-profile resolution and preflight use canonical actor/session-principal semantics rather than human `contact` subject or overloaded `userId`   | integration      | NOT TESTED | Planned in auth-profile runtime coverage                                                                                                         |
| 21  | Model resolution preserves actor-scoped full resolve and subject-agnostic reasoning-settings cache identity                                        | unit/integration | NOT TESTED | Planned in model-resolution contract tests                                                                                                       |
| 22  | Human cross-session memory resolves through canonical contact-backed context while actor/debug memory remains separately scoped                    | integration      | PARTIAL    | `runtime-session-identity.test.ts` and `runtime-executor.test.ts` now lock runtime re-keying; broader memory/contact integration remains planned |
| 23  | Debug/system discriminants cannot be coerced through production boundaries and instead fail with the documented wrong-scope-kind contract          | e2e              | NOT TESTED | Planned in runtime/Studio debug boundary tests                                                                                                   |
| 24  | Rollout can safely move from `enforce` back to `warn` without hidden state corruption, manual repair, or widened access                            | e2e/integration  | NOT TESTED | Planned in rollout-mode regression coverage                                                                                                      |

### Testing Notes

Some positive isolation behavior already exists, especially in ALS-backed durable-store paths and in the underlying KMS/DEK primitives, but the critical negative cases identified by the audit are not yet captured as first-class tests. This feature explicitly requires red-first regression coverage before rollout work begins, including tests that prove session authz scope and DEK scope do not drift apart during migration. The threat-model abuse paths called out earlier in the spec should all map to at least one adversarial automated test or explicit manual drill before HLD is considered complete.

> Full testing details: [../../testing/sub-features/session-scope-enforcement.md](../../testing/sub-features/session-scope-enforcement.md)

---

## 18. References

- Design docs: `docs/plans/2026-03-29-runtime-channel-contract-rollout.md`
- Related feature docs: [Memory & Sessions](../memory-sessions.md), [Omnichannel Session Continuity](../omnichannel-session-continuity.md), [SDK](../sdk.md), [Identity Verification](../identity-verification.md), [Session Timeout & Disposition Unification](session-timeout-disposition-unification.md)
- Reference files: `apps/runtime/src/services/session/types.ts`, `apps/runtime/src/services/session/session-store.ts`, `apps/runtime/src/services/session/session-service.ts`, `apps/runtime/src/services/session/redis-session-store.ts`, `apps/runtime/src/services/session/tiered-session-store.ts`, `apps/runtime/src/services/session/session-state-repo.ts`, `apps/runtime/src/services/message-persistence-queue.ts`, `apps/runtime/src/channels/pipeline/session-factory.ts`, `apps/runtime/src/channels/session-resolver.ts`, `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, `apps/runtime/src/websocket/twilio-media-handler.ts`, `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`, `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`, `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts`, `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`, `apps/runtime/src/services/auth-profile-resolver.ts`, `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`, `apps/runtime/src/services/auth-profile/auth-preflight.ts`, `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`, `apps/runtime/src/services/llm/model-resolution-versioning.ts`, `apps/runtime/src/services/llm/model-resolution.ts`, `apps/runtime/src/services/execution/memory-executor.ts`, `apps/runtime/src/services/execution/memory-integration.ts`, `apps/runtime/src/services/execution/tool-memory-bridge.ts`, `apps/runtime/src/services/contact-context-service.ts`, `apps/runtime/src/services/stores/mongodb-fact-store.ts`, `packages/shared-auth/src/middleware/session-ownership.ts`, `packages/shared-encryption/src/index.ts`, `packages/shared-encryption/src/tenant-encryption-facade.ts`, `packages/shared-encryption/src/encryption-manifest.ts`, `packages/database/src/kms/kms-resolver.ts`, `packages/database/src/kms/dek-manager.ts`, `packages/database/src/models/tenant-kms-config.model.ts`, `packages/database/src/models/materialized-kms-config.model.ts`, `packages/database/src/models/dek-registry.model.ts`, `packages/database/src/models/session-state.model.ts`, `packages/database/src/models/message.model.ts`, `packages/database/src/models/contact.model.ts`, `packages/database/src/models/auth-profile.model.ts`, `packages/database/src/models/fact.model.ts`, `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts`, `packages/database/src/clickhouse-encryption-interceptor.ts`, `apps/runtime/src/services/kms/kms-audit-logger.ts`, `apps/studio/src/services/retention/mongo-gdpr-store.ts`, `apps/studio/src/services/retention/retention-service.ts`, `packages/agent-transfer/src/session/types.ts`, `packages/agent-transfer/src/adapters/kore/index.ts`, `packages/agent-transfer/src/security/session-field-encryption.ts`, `packages/eventstore/src/schema/platform-event.ts`, `packages/eventstore/src/interfaces/event-gdpr.ts`, `apps/runtime/src/services/stores/clickhouse-audit-store.ts`, `apps/runtime/src/services/trace/emit-to-eventstore.ts`, `apps/runtime/src/services/trace/clickhouse-session-trace-events.ts`, `apps/runtime/src/routes/admin-sessions.ts`, `apps/runtime/src/routes/platform-admin-traces.ts`, `apps/runtime/src/routes/memory-api.ts`, `apps/studio/src/app/api/runtime/sessions/route.ts`, `apps/studio/src/app/api/runtime/sessions/[id]/route.ts`, `apps/studio/src/app/api/runtime/sessions/[id]/traces/route.ts`, `apps/studio/src/components/session/SessionsListPage.tsx`, `apps/studio/src/components/session/SessionDetailPage.tsx`, `apps/studio/src/components/chat/StudioChatPanel.tsx`
