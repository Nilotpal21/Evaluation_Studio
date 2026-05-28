# SDLC Log: Template Store — LLD

**Phase**: LLD
**Date**: 2026-04-21
**Artifact**: `docs/plans/2026-04-21-template-store-impl-plan.md`

---

## Product Oracle Decisions

### Implementation Strategy

| #   | Question                               | Classification | Summary                                                                                                             |
| --- | -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Q1  | Preferred implementation order?        | ANSWERED       | Data layer first → API → UI → tests. Feature spec delivery plan separates testing as final phase.                   |
| Q2  | Existing patterns to follow?           | ANSWERED       | Runtime pattern for repos (standalone functions, dynamic imports). Academy pattern for Zustand store with apiFetch. |
| Q3  | Feature flag for phased rollout?       | ANSWERED       | No. Binary rollout per HLD decision. All templates public.                                                          |
| Q4  | Acceptable scope for phase 1 vs later? | ANSWERED       | Phase 1: browse-only catalog (15 FRs). No install, no publish, no auth-required mutations.                          |
| Q5  | Hard deadlines driving phasing?        | INFERRED       | No explicit deadlines. Marketing site integration drives urgency but no hard date.                                  |

### Technical Details

| #   | Question                       | Classification | Summary                                                                                                                |
| --- | ------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Q6  | Which files need modification? | ANSWERED       | 9 modified files (index.ts, server.ts, proxy.ts, AppShell.tsx, 4 Dockerfiles, docker-compose). 15 new files.           |
| Q7  | Testing strategy?              | ANSWERED       | Test-after per CLAUDE.md commit discipline. Separate Phase 3 for all test types.                                       |
| Q8  | Type definitions to change?    | ANSWERED       | No changes. Template/TemplateVersion/TemplateAnalyticsEvent models exist. New Zod schemas for query validation.        |
| Q9  | Database migration strategy?   | ANSWERED       | Greenfield. MongoDB auto-creates collections. Indexes via Mongoose schemas.                                            |
| Q10 | Performance-sensitive paths?   | ANSWERED       | Browse endpoint with text search (requires text index). Category aggregation pipeline. All read-only, cacheable later. |

### Risk & Dependencies

| #   | Question                             | Classification | Summary                                                                                                      |
| --- | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------ |
| Q11 | Other ongoing changes that conflict? | INFERRED       | None. Template store is greenfield with zero coupling to existing features.                                  |
| Q12 | Biggest implementation risk?         | DECIDED        | Content quality (GAP-006). Infrastructure is scaffolded. Seed content defines perceived value.               |
| Q13 | Team dependencies?                   | INFERRED       | None for Phase 1. Product team input needed for seed content refinement (post-implementation).               |
| Q14 | Monitoring/alerting before rollout?  | ANSWERED       | Standard Express observability via shared-observability. Health/ready probes. No custom alerting in Phase 1. |
| Q15 | Definition of done?                  | ANSWERED       | All 15 FRs functional, 7 integration + 5 E2E tests passing, no regressions, seed data present.               |

---

## Decisions Made

| #   | Decision                                                          | Rationale                                                                                     |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D-1 | Repos as standalone functions at `apps/template-store/src/repos/` | Matches runtime pattern. Only one consumer. Cross-tenant means TenantScopedRepository N/A.    |
| D-2 | Tests in separate Phase 3                                         | Feature spec delivery plan separates testing. Commit discipline favors separate test commits. |
| D-3 | HLD handoff items as Phase 0 prerequisite                         | Barrel export blocks repos. Dockerfile sync blocks builds. Docker-compose blocks local dev.   |
| D-4 | Marketplace as global Next.js App Router pages                    | Cross-tenant/project. Matches `/academy` pattern. Feature spec: "below Projects" in sidebar.  |
| D-5 | Seed script as standalone `pnpm tsx` script                       | Template store is separate service. Seed data is service-specific.                            |
| D-6 | Analytics events as server-side effects of GET endpoints          | No POST tracking needed in Phase 1. Browse handler classifies by query params.                |
| D-7 | `optionalAuth` on marketplace routes for analytics enrichment     | Populates userId/tenantId when authenticated but doesn't block unauthenticated access.        |

## Escalations

None. All 15 questions resolved from existing documentation and code.

---

## Audit Rounds

| Round | Verdict        | Findings                            | Resolution                                                                                                                                                                                       |
| ----- | -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | NEEDS_REVISION | 0 CRITICAL, 4 HIGH, 6 MEDIUM        | All HIGHs fixed: GAP-003 documented, docker-compose condition format, extractClientIp clarified, HTTP-only assertions. Slug validation, requestId, version upsert added                          |
| 2     | NEEDS_REVISION | 0 CRITICAL, 2 HIGH, 4 MEDIUM        | All HIGHs fixed: removed (app) route group, nav moved to UserMenu. Fixed useTranslations, added selectors, layout.tsx, apiFetch path                                                             |
| 3     | NEEDS_REVISION | 0 CRITICAL, 0 HIGH, 3 MEDIUM        | All MEDIUMs fixed: i18n key path corrected to studio.json, requestId stored in metadata, security tests aligned with test spec section                                                           |
| 4     | NEEDS_REVISION | 1 CRITICAL, 3 HIGH, 3 MEDIUM        | CRITICAL fixed: INT count reverted to 7 (security tests referenced by section). HIGHs fixed: D-4 deviation documented, requestId removed from interface, agents.md task added, 7 component tests |
| 5     | APPROVED       | 0 CRITICAL, 0 HIGH, 1 MEDIUM, 2 LOW | MEDIUM (isProtectedPage exclusion) non-blocking for Phase 1. LOWs: feature spec/HLD path inconsistencies documented for post-impl-sync                                                           |

## LLD Handoff Items (from HLD)

1. ✅ Barrel export — Phase 0, task 0.1
2. ✅ GAP-007 404 handler — Phase 1, task 1.4
3. ✅ Trust proxy — Phase 1, task 1.4
4. ✅ Dockerfile sync — Phase 0, task 0.2
5. ✅ Docker-compose — Phase 0, task 0.3
6. ⚠️ Seed content (GAP-006) — Phase 1, task 1.5 (engineering creates representative content, product refines)
