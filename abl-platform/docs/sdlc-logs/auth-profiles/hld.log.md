# SDLC Log: Auth Profiles -- HLD (Phase 3)

**Date**: 2026-03-22
**Phase**: HLD
**Feature**: auth-profiles
**Author**: AI Agent (SDLC pipeline)

---

## Clarifying Questions & Decisions

### Architecture & Data Flow

1. **Q**: What's the preferred architecture pattern?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: Shared package pattern. Core logic in `packages/shared/src/services/auth-profile/` (17 files). Consumed by Studio (Next.js routes), Runtime (internal services), and SearchAI (resolver). Not a separate microservice.

2. **Q**: How does data flow through the system?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: Two primary flows: (1) CRUD via Studio API routes -> AuthProfileService -> Mongoose model -> MongoDB; (2) Credential resolution via Runtime -> dualReadCredentials -> CredentialCache -> AuthProfile.findOne -> EncryptionService -> applyAuth.

3. **Q**: What's the expected scale?
   - **Classification**: INFERRED
   - **Answer**: Credential resolution happens on every tool/model/connector invocation during agent execution. Cache hit rate expected >90% with 5-min TTL. Rotation job processes batches of 100. Alert evaluator bounds at 10K entries.

### Integration & Dependencies

4. **Q**: Which services depend on auth profiles?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: 14+ consumer types identified via grep. Core dependencies: MongoDB (data store), Redis (locks, CC token cache), EncryptionService (secrets at rest).

5. **Q**: Are there breaking changes to existing APIs?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: No. Dual-read pattern is additive. Consumer entities add optional `authProfileId` field. Legacy credential paths remain functional.

### Risk & Migration

6. **Q**: What's the rollback strategy?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: Set `AUTH_PROFILE_ENABLED=false`. Dual-read falls back to legacy credential paths. No data migration needed for rollback.

7. **Q**: What are the highest-risk components?
   - **Classification**: INFERRED
   - **Answer**: (1) Token refresh with distributed locking (concurrent access, race conditions); (2) Key rotation with grace period (credential outage risk); (3) applyAuth dispatcher (17 auth types, each with different credential formats).

---

## Architectural Decisions

1. **Shared package, not microservice**: Auth profile logic is in `packages/shared/` consumed by multiple apps. This avoids network hops for credential resolution at execution time.

2. **Pod-local LRU + distributed locks**: Cache is pod-local (fast reads) with Redis locks for cross-pod coordination (safe writes). This balances performance with consistency.

3. **Feature flag as kill switch**: `AUTH_PROFILE_ENABLED` provides instant rollback without deployment. Strict equality check (`=== 'true'`) means disabled by default for safety.

4. **Dual-read with error propagation**: When auth profile is configured, errors propagate instead of falling back to legacy. This prevents masking credential issues in production.

---

## Self-Audit Checklist

- [x] System context diagram
- [x] Component architecture
- [x] Data flow diagrams (2: credential resolution + OAuth2)
- [x] All 12 architectural concerns addressed
- [x] Alternatives considered (3)
- [x] Data model design reference
- [x] API design reference
- [x] Risks and mitigations table
- [x] All claims grounded in code evidence

---

# ABLP-913 Update Run — 2026-05-08

**Ticket**: ABLP-913 — Auth Profile Design — Decisions & Behavior Spec
**Mode**: UPDATE existing 385-line HLD with new §9 "ABLP-913 Architecture Extensions"

## Approach

Rather than spawn a new product-oracle round, reused the 16 decisions logged in `feature-spec.log.md`. The HLD references each decision by its `D-N` ID for traceability.

## Final Outputs

- `docs/specs/auth-profiles.hld.md` — 745 lines (was 385). New §0 Overview/Goal, new §8 Implementation Trace pointer, new §9 ABLP-913 Architecture Extensions covering:
  - 9.1 New behaviors (7 coordinated)
  - 9.2 Component architecture (9 new components, ASCII diagram)
  - 9.3 Data flow sequences (session-init scan, two revoke actions, mid-session invalidation, scope detection)
  - 9.4 The 12 architectural concerns × ABLP-913
  - 9.5 Data model additions with partial-index strategy + deviation note for `EndUserOAuthToken` nullability
  - 9.6 5 new endpoints + 4 modified endpoints
  - 9.7 7 alternatives considered (A-G) with reject rationale
  - 9.8 8 risks + mitigations
  - 9.9 5 open questions deliberately punted to LLD
  - 9.10 FR-9..FR-31 → HLD section/component traceability table

## Audit Outcome

- design-lint.sh: PASS (95% completeness, 19/20 present, 1 warn)
- Round 1: NEEDS_REVISION (1 CRITICAL endpoint count, 2 HIGH oracle D-N references + profileId nullability, 2 MEDIUM)
- Round 1 fixes: endpoint count corrected; D-2/D-3/D-14/D-15/D-16 inline references added; profileId nullability deviation note + LLD action; FR-22 → OQ-8/FR-20 in risks; §8 placeholder for sequential numbering
- Round 2: APPROVED with 2 non-blocking MEDIUM (test spec INT count discrepancy, cascade-delete.ts mock-sync gotcha for LLD)
- Round 3: APPROVED — final cross-phase consistency confirmed; all 23 FRs and 16 oracle decisions traced

## LLD Action Items (carried forward)

1. `EndUserOAuthToken` Mongoose schema MUST use `{ required: false }` for `projectId` and `profileId`; the application layer enforces required-on-write for new rows.
2. `auth_profile_audit_events` model addition MUST update `cascade-delete.ts` mocks in three test files per `packages/database/agents.md`.
3. Wire `AUTH_PROFILE_SESSION_SCAN_ENABLED` env flag into phased rollout.
4. Reconcile test spec INT count ("15" stated vs 18-20 actual) in next test-spec touch.

## Next Phase

`/lld` — phased implementation plan in `docs/plans/<date>-auth-profile-ablp913.md` with exit criteria, wiring checklist, and 5-round lld-reviewer audit.
