# SDLC Log: Template Store — Feature Spec

**Phase**: FEATURE-SPEC
**Date**: 2026-03-23
**Artifact**: `docs/features/template-store.md`

---

## Product Oracle Decisions

### Scope & Problem

| #   | Question                    | Classification | Summary                                                                                                                                      |
| --- | --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What problem does it solve? | ANSWERED       | Cold-start problem for new users; duplicate effort across enterprise teams. Target: <5min time-to-first-agent, 40%+ projects from templates. |
| Q2  | Phase 1 boundary?           | ANSWERED       | Browse & discover only. No install, no publish, no auth-required mutation endpoints. Public GET routes only.                                 |
| Q3  | New or enhancement?         | ANSWERED       | Entirely new capability. No existing template/starter concept in the platform.                                                               |
| Q4  | Priority/timeline driver?   | INFERRED       | Marketing website integration + competitive positioning. No explicit timeline dates.                                                         |
| Q5  | Competing approaches?       | ANSWERED       | Embedding in Studio was rejected. Separate service chosen for: marketing website, team ownership, enterprise growth.                         |

### User Stories & Requirements

| #   | Question                   | Classification | Summary                                                                                                                                                                      |
| --- | -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Primary personas?          | ANSWERED       | New User, Team Developer, Tenant Admin, Enterprise Architect, Marketing Website Visitor (anonymous).                                                                         |
| Q7  | Critical journeys?         | ANSWERED       | Browse landing → category drill-down → search/filter → detail viewing. Terminates without action in Phase 1.                                                                 |
| Q8  | Must-have vs nice-to-have? | INFERRED       | Must-have: browse API, landing page, detail page, search/filter, seed data, type badges, rate limiting. Screenshots/demo conversation are must-have per acceptance criteria. |
| Q9  | Performance requirements?  | INFERRED       | No explicit targets. Defaults: 100 req/60s rate limit, max 100 items/page, 300ms search debounce, <1000 templates scale target.                                              |
| Q10 | Feature interactions?      | ANSWERED       | Phase 1: Studio proxy, config constants, database models, Dockerfiles, i18n. Phase 3: project creation, agent cloning.                                                       |

### Technical & Architecture

| #   | Question               | Classification            | Summary                                                                                                                    |
| --- | ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Affected packages?     | ANSWERED                  | `apps/template-store/` (new), `packages/database/`, `apps/studio/`, `packages/config/`, `packages/i18n/`, all Dockerfiles. |
| Q12 | Model changes needed?  | ANSWERED                  | Current model already includes `typeMetadata`, `detailSections`, `sourceId`. Sufficient for Phase 1.                       |
| Q13 | Security implications? | INFERRED                  | No tenantIsolationPlugin (by design). PII concern: ipHash + userAgent in analytics. Public API rate-limited.               |
| Q14 | Deployment strategy?   | ANSWERED                  | Separate service, port 3115, shared MongoDB, same K8s namespace. Independent deploy cadence.                               |
| Q15 | Marketing website?     | AMBIGUOUS → USER-RESOLVED | Coming soon (separate repo). Future-proofing is valid. Separate service justified regardless.                              |

---

## User Decisions

| Question                        | User Answer                                                  | Date       |
| ------------------------------- | ------------------------------------------------------------ | ---------- |
| Q15: Marketing website timeline | Coming soon; yes future-proofing; separate service justified | 2026-03-23 |

---

## Files Created

| File                                                | Purpose                             |
| --------------------------------------------------- | ----------------------------------- |
| `docs/features/template-store.md`                   | Feature specification               |
| `docs/testing/template-store.md`                    | Testing guide placeholder (PLANNED) |
| `docs/sdlc-logs/template-store/feature-spec.log.md` | This log                            |

---

## Audit Rounds

| Round | Status         | Findings                            | Resolution                                                                                                                                                                                                               |
| ----- | -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | NEEDS_REVISION | 3 CRITICAL, 4 HIGH, 6 MEDIUM, 5 LOW | All CRITICAL/HIGH fixed: icon FolderKanban→FolderOpen, text index weights corrected, 404 format gap added, rate limiter/route wiring clarified, db.ts added to files, GAP-005 removed, metrics annotated with phase deps |
| 2     | APPROVED       | 0 CRITICAL, 0 HIGH, 4 MEDIUM, 5 LOW | M-1: i18n key count 104→74; M-2: 404 fix added to delivery plan; M-4: FR-4 E2E marked P in testing guide. M-3 already tracked as GAP-008.                                                                                |
