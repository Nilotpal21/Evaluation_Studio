# SDLC Log: Auth Profiles -- Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec
**Feature**: auth-profiles
**Author**: AI Agent (SDLC pipeline)

---

## Clarifying Questions & Decisions

### Test Scope Questions

1. **Q**: Which functional requirements are highest risk?
   - **Classification**: INFERRED
   - **Answer**: FR-4 (OAuth2 lifecycle) and FR-3 (scope resolution) are highest risk due to distributed state and multi-level cascade logic. FR-5 (redaction) and FR-6 (dual-read) are high risk because failures cause security leaks or wrong credential source.

2. **Q**: What is the current test coverage baseline?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: 24 verified test files. Strong unit coverage for model, schema, service, cache, rotation, health, alerting, and propagation. Gaps in apply-auth dispatch, dual-read, redaction, and addon mechanisms. 13 test files from prior docs are missing.

3. **Q**: What external dependencies need mocking vs real integration?
   - **Classification**: DECIDED
   - **Answer**: Mock only external OAuth providers (token endpoints), external HTTP services (for tool auth). Use real MongoDB (via MongoMemoryServer for integration tests), real Redis (via redis-mock or test Redis for lock/cache tests), real EncryptionService for integration tests.

### E2E Questions

4. **Q**: What infrastructure is needed for E2E tests?
   - **Classification**: DECIDED
   - **Answer**: Real Express servers on random ports, real MongoDB, real Redis. OAuth provider endpoints can be mock HTTP servers. No mocking of codebase components. Full middleware chain (auth, rate limiting, tenant isolation, validation).

5. **Q**: How many E2E scenarios are needed?
   - **Classification**: DECIDED
   - **Answer**: 7 E2E scenarios covering CRUD lifecycle, OAuth2 flow, dual-read migration, token refresh with locking, personal profile isolation, key rotation/grace period, and scope-aware resolution precedence.

### Integration Questions

6. **Q**: What service boundaries should integration tests cover?
   - **Classification**: INFERRED
   - **Answer**: 7 integration scenarios covering encryption plugin round-trip, tenant isolation plugin, AuthProfileService resolve cascade, token refresh with Redis lock, import/export resolution, consumer discovery/delete guard, and client credentials caching.

---

## Key Findings

1. **13 missing test files**: The prior test spec claimed these files existed and passed, but they are not in the codebase. This is the biggest gap to resolve.
2. **3 E2E files exist but unverified**: The E2E tests for connector setup, OAuth flow, and token refresh have never been confirmed to run successfully.
3. **No dedicated tests for critical paths**: `applyAuth()` (17 auth types), `dualReadCredentials()` (migration path), `redactAuthProfile()` (security), and addon mechanisms have no dedicated test files.
4. **Strong model/schema/service coverage**: The core data layer and business logic have solid unit test coverage.

---

## Coverage Summary

- **Verified test files**: 24
- **Missing test files from prior docs**: 13
- **E2E test files**: 3 (exist, unverified)
- **E2E scenarios defined**: 7
- **Integration scenarios defined**: 7
- **Missing test coverage areas**: 11 (4 high, 4 medium, 3 low priority)

---

# ABLP-913 Update Run — 2026-05-08

**Ticket**: ABLP-913 — Auth Profile Design — Decisions & Behavior Spec
**Mode**: UPDATE existing docs/testing/auth-profiles.md to fill the FR-9..FR-31 coverage matrix
**Source**: docs/features/auth-profiles.md (1015 lines, 31 FRs)

## Product Oracle Decisions

20 questions classified. **Zero AMBIGUOUS** — no human escalation needed.

| ID   | Decision                                                                                                                                           | Rationale                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D-1  | P0: 1 E2E + 1 INT each; P1: 1 INT each + E2E for runtime-visible FRs; P2: 1 INT each + E2E for FR-26                                               | Matches SDLC pipeline minimum (≥5 E2E + ≥5 INT) while focusing on highest-risk FRs |
| D-2  | MongoDB real (MongoMemoryServer); Redis via ioredis-mock; OAuth providers DI-stubbed                                                               | CLAUDE.md: no mocking platform components; only external third-party via DI        |
| D-3  | Add 5th critical journey: session-init scan (FR-12)                                                                                                | FR-12 is P0 and a new runtime bootstrap path                                       |
| D-4  | E2E: HTTP tool + integration node; INT: MCP + A2A                                                                                                  | Assignment logic identical across surfaces; A2A gated on model                     |
| D-5  | Defer perf test to load-test phase                                                                                                                 | Functional correctness first; latency belongs in k6/capacity-planner               |
| D-6  | Test only Redis pub/sub (chosen primary)                                                                                                           | Feature spec OQ-5 chose pub/sub                                                    |
| D-7  | Revoke-wins race: MANDATORY; concurrent session-init: STRETCH                                                                                      | Data integrity vs cosmetic impact                                                  |
| D-8  | Insufficient_scope + refresh-500: MANDATORY; force-invalidate partial: STRETCH                                                                     | MUST-level FRs vs P2 unbuilt transport                                             |
| D-9  | Migration tests as standalone scripts under `packages/database/src/migrations/scripts/`                                                            | Repo has formal migration framework with registry/runner/lock pattern              |
| D-10 | Activity tab pagination: 50/page default, 100 max, cursor-based                                                                                    | Matches existing auth-profiles list endpoint                                       |
| D-11 | Sensitive-field-change advisory triggered by 5 fields only (clientId, clientSecret, scopes, tokenUrl, refreshUrl); test asserts non-trigger fields | Per FR-25                                                                          |
| D-12 | New `auth_profile_audit_events` is canonical; `auditTrailPlugin` continues for generic CRUD; no dual-write                                         | Per FR-30 + feature-spec D-11                                                      |
| D-13 | Cross-project token reuse blocked: dedicated INT test required                                                                                     | Core isolation invariant                                                           |
| D-14 | Inline-Add cascade-delete: tested; orphan cleanup not needed (profile only created on submit)                                                      | Per OQ-8 + Data Lifecycle                                                          |
| D-15 | Permission for Authorize CTA: test both `auth_profile:write` and `auth_profile:read`; document as Open Question                                    | OQ-9 not yet resolved                                                              |

## Status

- [x] Read feature spec, existing test spec, CLAUDE.md test standards
- [x] Spawn product-oracle for clarifying questions
- [x] Log decisions
- [x] Generate updated test spec (ABLP-913 E2E + INT + migration sections)
- [x] Audit loop round 1 — NEEDS_REVISION (2 CRITICAL, 3 HIGH, 3 MEDIUM)
- [x] Round-1 fixes: E2E-9/10 DB-access removed (HTTP-only); revoke-preview endpoint added to feature spec; INT-24 added; E2E-11 auth context split; numbering note added
- [x] Audit loop round 2 — APPROVED with 2 non-blocking MEDIUM
- [x] Round-2 fixes: E2E-11 force-delete uses DELETE (not POST); FR-15 matrix shows INT-18 cross-ref

## Final Outputs

- `docs/testing/auth-profiles.md` — ~1015 lines; 23 FR rows in ABLP-913 matrix; 8 E2E scenarios + 15 integration scenarios + 2 migration tests
- `docs/features/auth-profiles.md` — added GET `/:profileId/revoke-preview` endpoint (FR-24)
- `docs/sdlc-logs/auth-profiles/test-spec.log.md` — this log

## Next Phase

`/hld` — extend `docs/specs/auth-profiles.hld.md` to address the 12 architectural concerns for ABLP-913.
