# SDLC Log: memory-sessions / HLD (Phase 3)

**Date**: 2026-03-22
**Phase**: HLD (High-Level Design)
**Artifact**: `docs/specs/memory-sessions.hld.md`

---

## Clarifying Questions & Decisions

### Architecture & Data Flow

| #   | Question                                   | Classification | Answer                                                                                                                                                                                                                                 |
| --- | ------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What's the preferred architecture pattern? | ANSWERED       | Tiered store pattern: `TieredSessionStore` wraps a primary `SessionStore` (Redis or Memory) with MongoDB cold storage. Service layer (`SessionService`) orchestrates lifecycle. Code: `tiered-session-store.ts`, `session-service.ts`. |
| 2   | How does data flow?                        | ANSWERED       | Request path: Client -> Handler -> SessionResolver -> SessionService -> SessionStore -> Redis (hot) + MongoDB (cold). Event-driven: session lifecycle emits trace events via TraceStore.                                               |
| 3   | What's the deployment topology?            | ANSWERED       | Session management runs within the Runtime Express pod. Redis and MongoDB are external infrastructure. No separate deployment artifact. Code: `ensureSessionService()` factory in `session-service.ts`.                                |

### Integration & Dependencies

| #   | Question                                     | Classification | Answer                                                                                                                                                        |
| --- | -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Which existing services does this depend on? | ANSWERED       | Redis (ioredis), MongoDB (mongoose), EncryptionService (@agent-platform/shared/encryption), TenantConfigService, DeploymentResolver, TraceStore.              |
| 5   | Breaking changes to existing APIs?           | ANSWERED       | None. `SessionStore` interface is the stability contract; new stores must implement all methods. `saveAndReplaceConversation` is optional (`?` in interface). |

### Risk & Migration

| #   | Question                | Classification | Answer                                                                                                                                                             |
| --- | ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6   | Biggest technical risk? | DECIDED        | GAP-007 (messageType bypass) is highest immediate risk — allows potential unauthenticated session access. GAP-006 (cross-tenant E2E gap) is highest systemic risk. |
| 7   | Rollback strategy?      | INFERRED       | `MemorySessionStore` serves as zero-dependency fallback. Cold storage failures are non-blocking. The system degrades gracefully.                                   |

---

## Self-Audit Checklist

- [x] Problem statement refined from feature spec
- [x] 3 alternatives considered with pros/cons and rejection rationale
- [x] System context diagram showing component relationships
- [x] Component architecture with store hierarchy
- [x] Data flow diagrams for creation, load/execution, and memory flows
- [x] All 12 architectural concerns addressed (isolation, security, performance, reliability, observability, data lifecycle, deployment, migration, backwards compatibility, testing strategy, monitoring, error handling)
- [x] API design including resolution algorithm and Lua script protocols
- [x] Data model summary with indexes and TTLs
- [x] Security model with authentication matrix and encryption layers
- [x] Known limitations documented
- [x] All claims grounded in code evidence
