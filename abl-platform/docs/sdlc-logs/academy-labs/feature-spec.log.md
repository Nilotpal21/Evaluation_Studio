# SDLC Log: Academy Labs — Feature Spec Phase

**Feature**: Academy Hands-On Labs
**Phase**: Feature Spec (Phase 1 of 6)
**Date**: 2026-04-16
**Ticket**: ABLP-2 (Learning Academy)

---

## Oracle Decisions

15 clarifying questions asked, answered by product-oracle agent.

| #   | Question                         | Classification       | Decision                                                                                                      |
| --- | -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Q1  | What problem does Labs solve?    | ANSWERED             | Knowledge-doing gap: users pass quizzes but can't build agents. 70% of learning is hands-on (70-20-10 model). |
| Q2  | What's out of scope for Phase 1? | ANSWERED             | Sandbox provisioning, challenge mode, capstones, AI hints, time limits, dual-axis ranking.                    |
| Q3  | New capability or enhancement?   | DECIDED → OVERRIDDEN | Oracle said sub-feature; plan specifies major feature doc. Going with major feature.                          |
| Q4  | Prior attempts?                  | ANSWERED             | None. Two exploration docs provide design direction.                                                          |
| Q5  | Timeline driver?                 | AMBIGUOUS → RESOLVED | No explicit deadline. User chose full SDLC pipeline = quality over speed.                                     |
| Q6  | Which personas get labs?         | INFERRED             | All three. Agent Builder (primary), Agent Architect (primary), Business Analyst (secondary).                  |
| Q7  | Critical user journeys?          | INFERRED             | See spec for 3 journeys: complete lab, resume lab, lab contributes to course completion.                      |
| Q8  | Must-have vs nice-to-have?       | DECIDED              | Phase 1: content model, verifier, API, UI, 5 pilot labs, badges, completion logic change.                     |
| Q9  | Performance requirements?        | DECIDED              | 3s p50, 5s p95 for full verification. Parallelize objective checks.                                           |
| Q10 | Feature interactions?            | ANSWERED             | Agent Development, Tool Invocations, Multi-Agent Orchestration, Deployments (all read-only).                  |
| Q11 | Packages affected?               | ANSWERED             | packages/academy (major), apps/academy (major), apps/studio (major), apps/runtime (none).                     |
| Q12 | Data model changes?              | ANSWERED             | ModuleProgress +4 fields, new LabFile/LabObjective/LabCheck types, AcademySettings extension.                 |
| Q13 | Security implications?           | ANSWERED             | JWT forwarding to Runtime. Runtime enforces tenant/project isolation. Read-only = low risk.                   |
| Q14 | Cross-service communication?     | DECIDED              | Academy forwards user JWT to Runtime API. No service-to-service credentials needed.                           |
| Q15 | isCourseCompleted() impact?      | ANSWERED             | Must check labPassed for modules with labs. Cascades to path/multi-path/all-courses badges.                   |

## User Decisions (Pre-Confirmed)

1. Manual project ID input (not dropdown)
2. No quiz gating for lab access
3. Labs required for module/course completion (for modules that have labs)
4. Full SDLC pipeline (feature-spec → test-spec → HLD → LLD → implement)

## Audit Results

### Round 1: NEEDS_REVISION (2 CRITICAL, 4 HIGH, 4 MEDIUM)

| ID   | Severity | Finding                                                          | Resolution                                                                    |
| ---- | -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| F-1  | CRITICAL | Spec listed fictional Runtime endpoints `/topology` and `/tools` | Rewrote Section 8 — adapter uses existing endpoints + `@abl/core` DSL parsing |
| F-2  | CRITICAL | Agent list endpoint doesn't return `dslContent`                  | Documented N+1 per-agent detail calls with parallelization                    |
| F-3  | HIGH     | Doc Type MAJOR FEATURE contradicts "Parent Feature: N/A"         | Changed to "Parent Feature: Learning Academy (L01)"                           |
| F-5  | HIGH     | `AcademySettings` extension missing from delivery plan           | Added task 1.6                                                                |
| F-6  | HIGH     | FR-4 not precisely testable                                      | Rewrote with exact endpoint, JWT forwarding, 404 mapping                      |
| F-10 | MEDIUM   | `custom-check` security concern (GAP-003) unmitigated            | Deferred to Phase 2, reduced to 6 check types                                 |

### Round 2: APPROVED (0 CRITICAL, 0 HIGH, 2 MEDIUM)

| ID  | Severity | Finding                                               | Resolution                          |
| --- | -------- | ----------------------------------------------------- | ----------------------------------- |
| M-1 | MEDIUM   | Testing guide FR-6 says "7 check types" vs spec's "6" | Fixed — updated testing guide       |
| M-2 | MEDIUM   | Dead reference link to `.claude/plans/` in Section 18 | Fixed — replaced with SDLC log link |

## Files Created

- `docs/features/academy-labs.md` — Feature spec
- `docs/testing/academy-labs.md` — Testing guide placeholder
- `docs/sdlc-logs/academy-labs/feature-spec.log.md` — This file
