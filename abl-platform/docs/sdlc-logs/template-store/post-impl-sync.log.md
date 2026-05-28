# SDLC Log: Template Store — Post-Implementation Sync

**Feature**: template-store
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-22

---

## Documents Updated

| Document      | File                                                | Changes                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature Spec  | `docs/features/template-store.md`                   | Status PLANNED→ALPHA, Last Updated→2026-04-22, removed all TODO markers from §10, fixed page paths (no `(app)` group), added MarketplaceLayout.tsx + category index page, updated delivery plan with commit hashes, mitigated GAP-001/007/008, added GAP-009/010, updated §17 testing matrix |
| Test Spec     | `docs/testing/template-store.md`                    | Status PLANNED→PARTIAL, feature status PLANNED→ALPHA, coverage matrix updated (10 ✅, 5 WRITTEN), security tests 4/5 passing, current state updated                                                                                                                                          |
| Testing Index | `docs/testing/README.md`                            | Added template-store row #53b in P2 section                                                                                                                                                                                                                                                  |
| HLD           | `docs/specs/template-store.hld.md`                  | Status APPROVED→DONE, cleaned stale TODO/EXISTS/NEEDS markers from project structure, fixed GAP-007 note, fixed page path                                                                                                                                                                    |
| LLD           | `docs/plans/2026-04-21-template-store-impl-plan.md` | Status IN PROGRESS→DONE                                                                                                                                                                                                                                                                      |

## Coverage Delta

| Type              | Before | After                                                            |
| ----------------- | ------ | ---------------------------------------------------------------- |
| Unit tests        | 0      | 42 (7 Studio component test files + marketplace-store)           |
| Integration tests | 0      | 45 (routes, template-repo, analytics-repo via MongoMemoryServer) |
| E2E tests         | 0      | 5 specs / 23 test cases (written, require running services)      |

## Deviations from Plan

- Navigation uses UserMenu dropdown (Academy pattern) instead of sidebar entry (FR-12) — documented in LLD D-4
- Pages at `apps/studio/src/app/marketplace/` (no `(app)` route group) — matches Academy precedent
- `MarketplaceLayout.tsx` added as shared layout component (not in original spec)
- Category index page added at `apps/studio/src/app/marketplace/category/page.tsx`

## Remaining Gaps

| ID      | Description                                                  | Severity |
| ------- | ------------------------------------------------------------ | -------- |
| GAP-002 | No Cache-Control headers on browse responses                 | Low      |
| GAP-003 | In-memory rate limiter not shared across replicas            | Medium   |
| GAP-004 | userAgent GDPR concern in analytics events                   | Medium   |
| GAP-006 | Seed template content (DSL, screenshots, demos) not authored | High     |
| GAP-009 | hashIp lacks salt for stronger privacy                       | Low      |
| GAP-010 | Text search index weights untuned                            | Low      |
| SEC-4   | CORS headers integration test not yet implemented            | Low      |

## Audit

| Round | Verdict  | Critical | High | Medium | Low |
| ----- | -------- | -------- | ---- | ------ | --- |
| 1     | APPROVED | 0        | 2    | 2      | 0   |

HIGH findings (resolved before commit):

- HLD project structure had stale [TODO]/[EXISTS]/[NEEDS] markers → cleaned
- HLD GAP-007 note was stale → updated to reflect fix

MEDIUM findings (resolved):

- CORS test noted as PLANNED with rationale
- Feature spec task 4.4 wording fixed
