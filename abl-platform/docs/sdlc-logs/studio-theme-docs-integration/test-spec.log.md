# Test Spec Log: Studio Theme & Docs Integration

**Phase**: TEST-SPEC
**Date**: 2026-03-25
**Artifact**: `docs/testing/ancillary/studio-theme-docs-integration.md`
**Feature Spec**: `docs/features/ancillary/studio-theme-docs-integration.md`

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. No AMBIGUOUS items escalated to user.

### Test Scope & Priorities (5 questions)

| #   | Question                            | Classification | Answer Summary                                                   |
| --- | ----------------------------------- | -------------- | ---------------------------------------------------------------- |
| 1   | Highest-risk FRs                    | DECIDED        | FR-7/FR-8 (access control) and FR-4 (FOUC prevention)            |
| 2   | Known edge cases                    | INFERRED       | Email domain boundary (subdomain, case), localStorage corruption |
| 3   | Current test coverage               | ANSWERED       | theme-store has unit tests, gradient-tokens has E2E precedent    |
| 4   | External dependencies needing mocks | DECIDED        | None — all filesystem + client-side, no external services        |
| 5   | Test environment setup              | ANSWERED       | Playwright + Dev Login, Vitest for unit/integration              |

### E2E Scenarios (5 questions)

| #   | Question                     | Classification | Answer Summary                                                 |
| --- | ---------------------------- | -------------- | -------------------------------------------------------------- |
| 6   | Critical user journeys       | DECIDED        | Theme switch + docs access + domain gate                       |
| 7   | Auth/permission combinations | ANSWERED       | kore.ai (allowed), kore.com (allowed), gmail.com (non-allowed) |
| 8   | Cross-feature interactions   | INFERRED       | Theme store shared with existing gradient-tokens feature       |
| 9   | Data seeding                 | ANSWERED       | MDX fixtures, no DB seeding needed                             |
| 10  | Performance scenarios        | DECIDED        | Bundle isolation + mermaid lazy loading + LCP                  |

### Integration Boundaries (5 questions)

| #   | Question                 | Classification | Answer Summary                                                         |
| --- | ------------------------ | -------------- | ---------------------------------------------------------------------- |
| 11  | Service boundaries       | DECIDED        | Filesystem→content.ts, localStorage→theme-store, component→CSS classes |
| 12  | Event-driven flows       | ANSWERED       | None — no webhooks or events                                           |
| 13  | Tenant/project isolation | INFERRED       | Email-domain scoped, not tenant/project scoped                         |
| 14  | Race conditions          | DECIDED        | Theme rehydration timing (FOUC)                                        |
| 15  | Error/failure paths      | DECIDED        | Missing file, malformed frontmatter, mermaid render failure            |

---

## Audit Results

### Round 1: NEEDS_REVISION

**CRITICAL (2):**

- TS-3: Mermaid component hardcoded color (`bg-gray-100`) not tested → Added INT-9
- TS-4: INT-8 used Playwright but classified as integration → Rewritten as module-level test

**HIGH (4):**

- TS-6: E2E-2/E2E-3 auth contexts said "Any authenticated user" → Fixed to `developer@kore.ai`
- TS-7: No malformed frontmatter scenario → Added INT-10
- TS-7: No Mermaid render failure scenario → Added INT-11
- TS-10: E2E-3 missing THEME_INIT_SCRIPT system fallback path → Added steps 9-11

**MEDIUM (3):**

- TS-9: Fixture directory note → Added "(to be created during implementation)"
- TS-9: theme-store.test.ts misclassified → Changed to unit+integ
- TS-8: No Chromium CI note → Added browser engine requirement

### Round 2: APPROVED

**HIGH (1, deferred to HLD):**

- TS-7: Mermaid dynamic `import()` failure path not testable at integration level without mocking the import. Added HLD note to INT-11. Source `Mermaid.tsx` has no `.catch()` on the import promise.

**MEDIUM (1, deferred to post-impl-sync):**

- TS-3: FR-13 Unit column overcategorized → Fixed (removed REQ from Unit column)

---

## Final Counts

| Type                  | Count |
| --------------------- | ----- |
| E2E scenarios         | 8     |
| Integration scenarios | 11    |
| Unit test scenarios   | 8     |
| Security tests        | 10    |
| Performance tests     | 5     |

## Files Created/Modified

- Created: `docs/testing/ancillary/studio-theme-docs-integration.md`
- Modified: `docs/features/ancillary/studio-theme-docs-integration.md` (§10 Tests table, §17 cross-reference)
- Modified: `docs/testing/README.md` (entry added in prior commit)

## Next Phase

Run `/hld studio-theme-docs-integration`
