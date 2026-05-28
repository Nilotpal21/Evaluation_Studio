# SDLC Log: Auth Profiles -- LLD (Phase 4)

**Date**: 2026-03-22
**Phase**: LLD
**Feature**: auth-profiles
**Author**: AI Agent (SDLC pipeline)

---

## Clarifying Questions & Decisions

### Implementation Strategy

1. **Q**: What's the preferred implementation order for gap closure?
   - **Classification**: DECIDED
   - **Answer**: Tests first (Phase 1-2), then E2E verification (Phase 3), then source file investigation (Phase 4), then documentation (Phase 5, already done). Rationale: tests provide immediate safety net; E2E verification confirms production readiness; source investigation is informational.

2. **Q**: Should missing source files be recreated?
   - **Classification**: DECIDED
   - **Answer**: Investigate first to determine if functionality exists elsewhere in the codebase. Files may have been consolidated, renamed, or deferred. Only recreate if a genuine gap in functionality is found.

3. **Q**: Should personal-visibility unique indexes be added?
   - **Classification**: AMBIGUOUS (escalated to user)
   - **Answer**: Left as open question. Adding them would prevent name collisions within a single owner's personal profiles, but current behavior works without them.

### Technical Details

4. **Q**: Which test framework patterns to follow?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: Vitest for all packages. Use `vi.mock()` for module-level mocks. Use `beforeEach`/`afterEach` for env var manipulation. Use `createAuthProfileFixture()` from test factory for profile fixtures.

5. **Q**: Are there performance-sensitive paths that need attention?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: Credential resolution is the most performance-sensitive path (called on every tool/model invocation). Cache hit rate is critical. No changes needed to the resolution path -- only adding tests.

---

## Phase Breakdown Summary

| Phase                               | Priority | Effort   | Exit Criteria                                                  |
| ----------------------------------- | -------- | -------- | -------------------------------------------------------------- |
| Phase 1: Critical test gaps         | HIGH     | ~2 days  | 32 new test cases passing (applyAuth 17, dualRead 6, redact 9) |
| Phase 2: Feature flag + addon tests | MEDIUM   | ~1 day   | Feature flag (5 cases), signing, webhook, proxy tests passing  |
| Phase 3: E2E verification           | HIGH     | ~1 day   | 3 existing E2E files run and pass                              |
| Phase 4: Missing file investigation | MEDIUM   | ~0.5 day | 7 files classified as relocated/deferred/removed               |
| Phase 5: Documentation              | LOW      | Done     | All docs consistent with codebase                              |

Total estimated effort: ~4.5 days

---

## Self-Audit Checklist

- [x] Phased implementation plan with clear exit criteria per phase
- [x] Exact file changes per phase (file path, what to add/modify)
- [x] Wiring checklist (21 connections verified)
- [x] Database migration plan (none needed, future index option documented)
- [x] Test implementation plan (7 new files, 3 E2E to verify)
- [x] Rollback strategy
- [x] Implementation order diagram
- [x] All claims grounded in code evidence from prior phases

---

# ABLP-913 LLD Run — 2026-05-08

**Ticket**: ABLP-913 — Auth Profile Design — Decisions & Behavior Spec
**Mode**: NEW LLD created at `docs/plans/2026-05-08-auth-profile-ablp913-impl-plan.md` (existing `docs/plans/auth-profiles.lld.md` for FR-1..FR-8 remains as historical baseline)

## Approach

Reused decisions D-1..D-16 from feature-spec product oracle run; no new oracle round. Fresh LLD captures phased plan with file-level changes, exit criteria, wiring checklist, and rollback.

## Final Outputs

- `docs/plans/2026-05-08-auth-profile-ablp913-impl-plan.md` — 664 lines, 5 phases (Schema → Services → Runtime → Studio API → Studio UI/E2E), 26 tasks, file-level change map (~40 new, ~25 modified), 24-item wiring checklist, complete acceptance criteria.

## Audit Outcomes

| Round | Reviewer                    | Verdict       | Findings                                                                               |
| ----- | --------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| 1     | lld-reviewer (architecture) | NEEDS_CHANGES | 5 CRITICAL (paths) + 5 HIGH + 6 MEDIUM                                                 |
| 2     | lld-reviewer (patterns)     | NEEDS_CHANGES | 3 HIGH (migration numbering, test paths, audit-event namespace) + 3 MEDIUM             |
| 3     | lld-reviewer (completeness) | NEEDS_CHANGES | 1 CRITICAL (publisher placement) + 2 HIGH (inline-host wiring, INT mapping) + 3 MEDIUM |
| 4     | phase-auditor (cross-phase) | APPROVED      | 2 HIGH + 3 MEDIUM (all addressed)                                                      |
| 5     | lld-reviewer (final sweep)  | APPROVED      | 3 LOW (cosmetic)                                                                       |

All CRITICAL and HIGH findings resolved before round 5. LLD is implementation-ready.

## Key Decisions Made During Audit

- Migration numbering: 20260508_019 + \_020 (continues global sequence after \_018)
- `force-invalidate-publisher.ts` lives in `packages/shared` (Studio cannot import `apps/runtime`)
- AuthTypeMetadata uses NEW `phaseTier` field (not overloading `category`)
- Audit-event naming namespace divergence documented in code (existing `AUTH_PROFILE_AUDIT_EVENTS` → audit_logs, new `AuthProfileAuditEventType` → auth_profile_audit_events)
- EndUserOAuthToken cascade-delete added to tenant/project/user erasure (GDPR gap discovered during ABLP-913 scoping)
- `cleanupInlineHostsForTool` wires into HTTP-tool DELETE handler (not auth-profile DELETE)
- OAuth callback path resolved: write happens in Studio route (`upsertOAuthGrant()`), not shared services

## Next Phase

`/implement` — execute the LLD phase-by-phase with pr-reviewer audits per phase. NO COMMITS — user reviews before commit.
