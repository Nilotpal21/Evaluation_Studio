# SDLC Log: OAuth Tooling -- Phase 3 (HLD)

**Date:** 2026-03-23
**Phase:** High-Level Design
**Artifact:** `docs/specs/oauth-tooling.hld.md`

## Architectural Concerns Addressed

| #   | Concern                | Addressed | Notes                                                          |
| --- | ---------------------- | --------- | -------------------------------------------------------------- |
| 1   | Tenant Isolation       | Yes       | All queries include tenantId; cross-tenant returns 404         |
| 2   | Project Isolation      | Yes       | Tool-to-Auth-Profile links validated at project level          |
| 3   | User Isolation         | Yes       | per_user tokens use visibility: personal + createdBy filter    |
| 4   | Authentication         | Yes       | authMiddleware for API routes; unifiedAuth for callback        |
| 5   | Encryption at Rest     | Yes       | encryptionPlugin (AES-256-GCM) for all tokens                  |
| 6   | Encryption in Transit  | Yes       | HTTPS for IdP communication; TLS for Redis                     |
| 7   | Traceability           | Yes       | TraceEvents via auth-profile/trace-events.ts                   |
| 8   | Performance            | Yes       | Redis caching for CC tokens; in-memory cache for auth profiles |
| 9   | Compliance             | Yes       | TTLs, revocation cascade, right to erasure                     |
| 10  | Stateless Distributed  | Yes       | Redis for all shared state; distributed locks                  |
| 11  | Error Handling         | Yes       | Structured error codes; timeout handling                       |
| 12  | Backward Compatibility | Yes       | Feature flag; legacy fallback chain                            |

## Key Design Decisions

- No new MongoDB collections -- all data stored in existing `auth_profiles` collection
- Reuse `RedisOAuthStateStore` pattern from runtime for multi-pod safety
- Token exchange uses `httpsPost` helper (not `fetch`) to avoid dual-stack issues
- Token health computed from DB fields (no external calls to IdPs)

## Alternatives Rejected

| Alternative                          | Reason                                                 |
| ------------------------------------ | ------------------------------------------------------ |
| Store tokens in ProjectTool document | Duplicates encryption/rotation already in Auth Profile |
| Use `simple-oauth2` library          | Unnecessary dependency; native fetch works             |
| WebSocket OAuth for runtime consent  | Too complex; HTTP redirect is standard                 |
| Separate OAuth token collection      | Auth Profile already handles this                      |

## Audit Round 1 (Self-Review)

| #   | Finding                                                            | Severity | Status   |
| --- | ------------------------------------------------------------------ | -------- | -------- |
| 1   | All 12 architectural concerns documented with specific mitigations | --       | Complete |
| 2   | API contracts specified for all new endpoints                      | --       | Complete |
| 3   | Data model changes are additive (no breaking schema changes)       | --       | Verified |
| 4   | Migration strategy is phased (4 phases) with clear boundaries      | --       | Complete |
| 5   | Component diagram shows all integration points                     | --       | Complete |
