# SDLC Log: Template Store — HLD

**Phase**: HLD
**Date**: 2026-04-21
**Artifact**: `docs/specs/template-store.hld.md`

---

## Product Oracle Decisions

### Architecture & Data Flow

| #   | Question                     | Classification | Summary                                                                                                                                         |
| --- | ---------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Architecture pattern?        | ANSWERED       | Separate Express microservice (`apps/template-store/`, port 3115). Driven by marketing site integration, team ownership, enterprise trajectory. |
| Q2  | Data flow?                   | ANSWERED       | Studio proxies via `NextResponse.rewrite()` → template-store:3115. Marketing site calls directly. Both hit MongoDB.                             |
| Q3  | Expected scale?              | INFERRED       | Low-traffic read-heavy. <1,000 templates, 5,000 page views/month target, p95 <200ms. Single pod sufficient.                                     |
| Q4  | Existing patterns to follow? | ANSWERED       | Follows runtime/search-ai Express pattern: helmet→cors→compression→body-parse→requestId→observability→health→routes.                            |
| Q5  | Deployment topology?         | ANSWERED       | Single service, shared MongoDB (`abl_platform` DB), K8s-deployable. Rate limiter is in-memory (GAP-003).                                        |

### Integration & Dependencies

| #   | Question                      | Classification | Summary                                                                                                     |
| --- | ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| Q6  | Workspace dependencies?       | ANSWERED       | config, database, shared-auth, shared-kernel, shared-observability. All standard platform packages.         |
| Q7  | New external dependencies?    | ANSWERED       | None. Standard Express stack + mongoose + zod already in package.json.                                      |
| Q8  | API contract?                 | ANSWERED       | REST JSON. Error envelope: `{ success: false, error: { code, message } }`. 4 public GET endpoints + health. |
| Q9  | Breaking changes?             | ANSWERED       | None. Phase 1 is entirely additive — new service, new collections, new proxy rule, new sidebar entry.       |
| Q10 | Compiler/runtime integration? | ANSWERED       | Zero in Phase 1. Template store is independent from compile→deploy→execute lifecycle.                       |

### Risk & Migration

| #   | Question                 | Classification | Summary                                                                                                        |
| --- | ------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| Q11 | Biggest technical risk?  | DECIDED        | Seed template content quality (GAP-006). Infrastructure is scaffolded. Content gaps block value proposition.   |
| Q12 | Existing data migration? | ANSWERED       | Greenfield. Three new collections. No existing template data in the platform.                                  |
| Q13 | Rollback strategy?       | DECIDED        | Stop service, remove proxy rule, remove sidebar entry, drop 3 collections. Zero coupling to existing features. |
| Q14 | Feature flags?           | ANSWERED       | None. Binary rollout. All templates public, all users see same catalog.                                        |
| Q15 | Blast radius?            | ANSWERED       | Near-zero. Only marketplace pages in Studio affected. No other service depends on template store.              |

---

## Decisions Made

| #   | Decision                                               | Rationale                                                                   |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| D-1 | Biggest risk is content (GAP-006), not infrastructure  | Scaffold is complete and follows proven patterns. Empty catalog = no value. |
| D-2 | Rollback: stop service + remove proxy + remove sidebar | Phase 1 is fully additive with zero coupling.                               |

## Escalations

None. All 15 questions resolved from existing documentation and code.

---

## Audit Rounds

| Round | Verdict        | Findings                            | Resolution                                                                                                      |
| ----- | -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1     | NEEDS_REVISION | 0 CRITICAL, 4 HIGH, 4 MEDIUM, 2 LOW | All HIGHs fixed: missing data model fields, featured response shape, docker-compose scope, trust proxy security |
| 2     | NEEDS_REVISION | 0 CRITICAL, 2 HIGH, 3 MEDIUM        | All HIGHs fixed: template_versions missing fields, marketplace_view reclassified as server-side                 |
| 3     | APPROVED       | 0 CRITICAL, 0 HIGH, 2 MEDIUM        | MEDIUMs carried forward to LLD: trust proxy code gap, missing agents.md for template-store                      |

## LLD Handoff Items

1. Barrel export — add Template/TemplateVersion/TemplateAnalyticsEvent to `packages/database/src/models/index.ts`
2. GAP-007 — fix 404 handler to standard error format
3. Trust proxy — add `app.set('trust proxy', 1)`, simplify rate-limit.ts
4. Dockerfile sync — add `COPY apps/template-store/package.json` to all app Dockerfiles
5. Docker-compose — add template-store service entry
6. Seed content — GAP-006 needs product team input
