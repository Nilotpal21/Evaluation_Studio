# LLD Audit Log: Project RBAC Management Layer

**Date**: 2026-04-09
**Artifact**: `docs/plans/2026-04-09-project-rbac-management-impl-plan.md`

---

## Oracle Decisions

Questions answered autonomously by product oracle (no user escalation needed):

- Implementation order: data layer → API → UI → E2E (standard layering)
- Project members sourced from tenant member list only (user-specified constraint)
- Breaking changes are fine — forward-looking only (user confirmation)
- Workspace creation/switching out of scope (D-7)

---

## Round 1: Architecture Compliance (lld-reviewer)

**Verdict**: CRITICAL findings

| Severity | Finding                                                                                                                   | Resolution                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| CRITICAL | `findProjects()` OR mapper silently drops `_id.$in` conditions — membership-filtered listing query would fail             | Added D-8: direct `Project.find()` via new `findUserAccessibleProjects` function |
| CRITICAL | No backfill for existing projects — listing filter would hide all owned projects                                          | Added D-9: Phase 0 backfill script                                               |
| CRITICAL | `requireProjectAccess` only checks tenant membership, not project admin role — privilege escalation for member management | Added D-10: explicit `assertCallerCanManageMembers` helper                       |
| HIGH     | `project-repo.ts` incorrectly listed as modified for ProjectMember functions                                              | Moved to new `project-member-repo.ts`                                            |
| HIGH     | `MEMBER_ADDED` audit action doesn't exist                                                                                 | Added project-namespaced `PROJECT_MEMBER_ADDED/REMOVED/ROLE_CHANGED`             |

## Round 2: Pattern Consistency (lld-reviewer)

**Verdict**: HIGH findings (CRITICAL from R1 verified as fixed)

| Severity | Finding                                                                         | Resolution                                                                               |
| -------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| HIGH     | `findUserAccessibleProjects` pseudocode used `findProjects()` — contradicts D-8 | Updated to direct `Project.find()` with explicit `$or`                                   |
| MED      | Missing `createLogger` specification for new modules                            | Added `createLogger('project-member-repo')` and `createLogger('project-member-service')` |

## Round 3: Completeness (lld-reviewer)

**Verdict**: HIGH findings (prior fixes verified)

| Severity | Finding                                                                 | Resolution                                    |
| -------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| HIGH     | Missing `countProjectAdmins` function in repo for sole-admin protection | Added to repo function list                   |
| MED      | Phase 0 lacks idempotency guarantee                                     | Added `$setOnInsert` + `upsert: true` pattern |

## Round 4: Cross-Phase Consistency (phase-auditor)

**Verdict**: CRITICAL + HIGH findings

| Severity | Finding                                                                                                                                                           | Resolution                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| CRITICAL | `hasPermission` import path `@agent-platform/shared-auth/rbac` is wrong — Studio uses `@/lib/permission-resolver` (re-exports from `@agent-platform/shared/rbac`) | Fixed both wiring checklist items + Phase 1 pseudocode to use `@/lib/permission-resolver` |
| HIGH     | `findUserAccessibleProjects` returns bare projects without `_count.agents` — route handler at `projects/route.ts:96` maps `p._count.agents` and would crash       | Added explicit `ProjectAgent.countDocuments` enrichment pseudocode in task 1.2            |
| HIGH     | Phase 0 rollback `deleteMany({ role: 'admin' })` would destroy ALL admin records                                                                                  | Fixed to log created IDs and delete only those                                            |
| HIGH     | LLD says "non-members get 404" but `requireProjectAccess` grants access to ALL same-tenant users                                                                  | Rewrote Phase 2 auth model documentation to accurately describe two-layer model           |

## Round 5: Final Sweep (lld-reviewer)

**Verdict**: HIGH findings

| Severity | Finding                                                                                        | Resolution                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| HIGH     | `requireProjectAccess` behavior mismatch still present in auth model description               | Fixed in same pass as R4 — rewrote auth model section                                      |
| HIGH     | `_count.agents` enrichment still missing explicit pseudocode                                   | Fixed in same pass as R4 — added code block                                                |
| MED      | Scenario 7 sole-admin test doesn't isolate the protection (Alice is both owner and sole admin) | Expanded scenario to test both owner-removal protection AND separate sole-admin protection |

---

## Remaining MEDIUM Items (logged, not blocking)

1. Pagination for project members list — deferred to Open Questions
2. Notifications on member add/remove — deferred
3. Bulk add members — deferred

## Final Status

All CRITICAL findings resolved. All HIGH findings resolved. MEDIUM items logged. LLD marked as REVIEWED.
