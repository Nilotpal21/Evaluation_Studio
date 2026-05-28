# SDLC Log: memory-sessions / Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec
**Artifact**: `docs/features/memory-sessions.md`

---

## Clarifying Questions & Decisions

### Scope & Problem

| #   | Question                                 | Classification | Answer                                                                                                                                                                                                                                      |
| --- | ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What specific problem does this solve?   | ANSWERED       | Code evidence: `session-service.ts` orchestrates lifecycle; `tiered-session-store.ts` provides durability; `session-resolver.ts` handles reconnects. Without this, agents lose context on pod restarts, Redis evictions, or WS disconnects. |
| 2   | What is explicitly out of scope?         | DECIDED        | Cross-tenant shared state, RAG/vector memory, trace pipeline (which is a separate feature). Rationale: these are separate features in the platform.                                                                                         |
| 3   | Is this a new capability or enhancement? | ANSWERED       | Existing STABLE feature. Code exists across 50+ implementation files and 57+ test files totaling ~1,198 tests.                                                                                                                              |

### User Stories & Requirements

| #   | Question                                   | Classification | Answer                                                                                                                                                                                                |
| --- | ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Who are the primary personas?              | INFERRED       | Runtime operator, Studio user, platform engineer, agent developer, platform admin. Based on route handlers (sessions.ts, admin-sessions.ts), DSL constructs (REMEMBER/RECALL), and Studio components. |
| 5   | What are the critical user journeys?       | ANSWERED       | Session creation via `SessionBootstrap`, resolution via `SessionResolver`, persistence via `TieredSessionStore`, inspection via Studio `SessionDetailPage`.                                           |
| 6   | What performance/scale requirements exist? | ANSWERED       | MemorySessionStore: 10K max sessions. Redis: Lua atomic saves, pipeline batching. Cleanup: 500 per batch. L1 cache: 50 IR entries.                                                                    |

### Technical & Architecture

| #   | Question                                   | Classification | Answer                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Which packages are affected?               | ANSWERED       | `apps/runtime` (session services, routes, execution), `apps/studio` (components, hooks, store), `packages/database` (models), `packages/shared-auth` (ownership middleware), `packages/compiler` (memory validation).                                               |
| 8   | What data models are involved?             | ANSWERED       | `sessions` collection (session.model.ts), `session_states` collection (session-state.model.ts), Redis key layout (redis-session-store.ts header comment).                                                                                                           |
| 9   | Are there security/isolation implications? | ANSWERED       | Extensive: tenant isolation via Redis key prefix + MongoDB tenantIsolationPlugin; project scoping via `requireProjectScope`; user ownership via tiered identity matching middleware; encryption at rest; PII vault. Audit findings GAP-007 and GAP-008 remain open. |
| 10  | What external dependencies exist?          | ANSWERED       | Redis (ioredis), MongoDB (mongoose), EncryptionService, TenantConfigService. All are internal platform services.                                                                                                                                                    |
| 11  | What is the current test coverage?         | ANSWERED       | 57 test files, ~1,198 tests. See test file inventory in existing test spec.                                                                                                                                                                                         |
| 12  | What gaps exist?                           | ANSWERED       | 8 documented gaps (GAP-001 through GAP-008) from existing spec and 2026-03-20 audit. Two HIGH severity (GAP-006 cross-tenant E2E, GAP-007 messageType bypass).                                                                                                      |

---

## Self-Audit Checklist

- [x] All 18 TEMPLATE.md sections present
- [x] All file paths verified via Glob/Bash
- [x] All claims grounded in code evidence
- [x] Feature status correctly set to STABLE
- [x] Integration matrix includes 6 related features
- [x] Functional requirements are numbered and testable (FR-1 through FR-9)
- [x] Data model includes field types, indexes, and plugins
- [x] Non-functional concerns cover all 6 subsections
- [x] Gaps table includes severity and status
- [x] Success metrics include baseline, target, and measurement method
- [x] Testing section cross-references test spec

---

## Files Read

- `apps/runtime/src/services/session/types.ts` — Core types
- `apps/runtime/src/services/session/session-store.ts` — Store interface
- `apps/runtime/src/services/session/session-service.ts` — Orchestration layer
- `apps/runtime/src/services/session/tiered-session-store.ts` — Cold storage tiering
- `apps/runtime/src/services/session/redis-session-store.ts` — Redis backend
- `apps/runtime/src/services/session/session-operations.ts` — Fork operations
- `apps/runtime/src/services/session/session-bootstrap.ts` — Session creation
- `apps/runtime/src/services/session/session-factory.ts` — Transport-agnostic factory
- `apps/runtime/src/services/session/compaction-engine.ts` — Context compaction
- `apps/runtime/src/services/identity/session-resolver.ts` — Resolution logic
- `apps/runtime/src/services/execution/memory-executor.ts` — REMEMBER/RECALL
- `apps/runtime/src/services/execution/memory-integration.ts` — Memory facade
- `apps/runtime/src/services/execution/memory-bridge-registry.ts` — Bridge registry
- `apps/runtime/src/services/session-cleanup-job.ts` — Cleanup job
- `apps/runtime/src/routes/sessions.ts` — Session routes
- `apps/runtime/src/routes/admin-sessions.ts` — Admin routes
- `apps/runtime/src/routes/memory-api.ts` — Memory API
- `packages/database/src/models/session.model.ts` — Session schema
- `packages/database/src/models/session-state.model.ts` — Cold storage schema
- `packages/shared-auth/src/middleware/session-ownership.ts` — Ownership middleware
- Studio: 20+ component/hook/store files discovered via Glob
- Test files: 57 test files discovered via find
