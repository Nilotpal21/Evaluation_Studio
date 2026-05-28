# Test Spec Log: Attachment Settings UI

**Date**: 2026-03-22
**Phase**: TEST-SPEC
**Feature**: Studio Attachment Settings UI (sub-feature of Attachments)

---

## Oracle Decisions

15 questions asked across 3 categories (Test Scope, E2E Scenarios, Integration Boundaries). All answered.

| #   | Category    | Question Summary                 | Classification | Decision                                                                                                                 |
| --- | ----------- | -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Scope       | Highest risk FRs                 | INFERRED       | FR-5 (reset/null fallback) highest; FR-10 (permission gating) high; FR-8/FR-9 (MIME validation) medium-high              |
| Q2  | Scope       | Known edge cases                 | ANSWERED       | 6 documented: no configs, falsy-but-valid, empty array, GAP-002, missing tenantId, tenant has no `enabled` field         |
| Q3  | Scope       | Current test coverage baseline   | ANSWERED       | Resolver: 7 unit tests. Route handlers: 0 tests. Studio UI: 0 tests. ~35% resolver unit coverage only                    |
| Q4  | Scope       | External deps mock vs real       | INFERRED       | UI: mock apiFetch. Proxy: mock fetch. Runtime E2E: real MongoMemoryServer + RuntimeApiHarness. No combined E2E           |
| Q5  | Scope       | Studio test environment          | ANSWERED       | Vitest + happy-dom + RTL. setup.tsx mocks: next/navigation, next-intl (real translations), framer-motion, lucide         |
| Q6  | E2E         | Critical user journeys           | INFERRED       | 5 journeys: view defaults, override+persist, reset-to-default, config-affects-upload, permission-gating                  |
| Q7  | E2E         | Auth/permission combinations     | INFERRED       | 9 scenarios: happy read/write, read-only PUT, no perms, no auth, missing tenantId, cross-tenant, non-member, SDK         |
| Q8  | E2E         | Cross-feature interactions       | INFERRED       | Config→upload path (enable/disable, MIME, size). PII policy→preprocessor. No functional PII settings tab dependency      |
| Q9  | E2E         | Data seeding requirements        | INFERRED       | 6 seeds: clean slate, tenant-only, both configs, all-nulls project, multi-project, multi-tenant                          |
| Q10 | E2E         | Studio proxy vs runtime boundary | DECIDED        | Two separate test levels: proxy unit (mock fetch) + runtime E2E (real DB). Combined deferred as GAP-003                  |
| Q11 | Integration | Service boundaries               | INFERRED       | 4 boundaries: route→MongoDB, resolver→MongoDB, proxy→runtime, config→upload behavioral                                   |
| Q12 | Integration | Null field reset behavior        | ANSWERED       | PUT null → $set stores BSON null → resolver pick() falls through to tenant/platform. Integration gap: never DB-tested    |
| Q13 | Integration | Tenant/project isolation         | INFERRED       | 5 scenarios: cross-tenant 404, cross-project isolation, orphan config guard, resolver tenant isolation, proxy membership |
| Q14 | Integration | Race conditions                  | INFERRED       | Low risk: last-write-wins (atomic findOneAndUpdate), stale-read during write. Basic last-write-wins test sufficient      |
| Q15 | Integration | Zod validation edge cases        | ANSWERED       | 11 edge cases documented. Server does NOT enforce MIME regex or 50-cap — UI-only validation. Known gap documented        |

## Escalations

None — all questions resolved without user input.

## Key Findings

1. **Server-side validation gap**: Runtime Zod schema does NOT enforce MIME type regex (`^[a-z]+/([\w.+-]+|\*)$`) or 50-entry cap. These are UI-only validations (FR-8, FR-9).
2. **Zero route handler tests**: The GET/PUT handlers at `attachment-config.ts` have never been tested — only the resolver has unit tests.
3. **GAP-002 prerequisite**: `defaultProcessingMode` is not in `ResolvedAttachmentConfig` — UI tests for this field must account for the prerequisite Task 0.
4. **Established patterns**: Studio has mature test infrastructure (vitest, RTL, happy-dom, real i18n). Proxy tests use `vi.stubGlobal('fetch')` pattern. Runtime E2E uses `RuntimeApiHarness`.

## Files Created

- `docs/testing/sub-features/attachment-settings-ui.md` — Full test spec (replacing placeholder)
- `docs/sdlc-logs/attachment-settings-ui/test-spec.log.md` — This log
