# SDLC Log: Workflow Versioning — LLD

**Phase**: LLD
**Date**: 2026-04-14
**Feature Slug**: workflow-versioning
**Artifact**: `docs/plans/2026-04-14-workflow-versioning-impl-plan.md`

---

## Oracle Decisions

All 15 clarifying questions answered. No AMBIGUOUS items required user escalation.

### Implementation Strategy

| #   | Question                                   | Classification | Decision                                                                                   |
| --- | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------ |
| Q1  | Implementation order?                      | ANSWERED       | Bottom-up: data layer → service → routes → UI (per feature spec Section 13)                |
| Q2  | Phase 1 + Phase 2 same LLD?                | DECIDED        | Phase 2 deferred to separate future LLD; 2+ week stability required first                  |
| Q3  | Runtime feature checks for migration phase | DECIDED        | No conditional code paths; Phase 1 behaviors unconditional; env var for documentation only |
| Q4  | Keep promoteVersion() as deprecated?       | DECIDED        | Remove entirely; replace with activate()/deactivate() per FR-6                             |
| Q5  | Studio UI same LLD or separate?            | DECIDED        | Same LLD, later internal phase (Phase 4 of 5); backend-first                               |

### Technical Details

| #   | Question                               | Classification | Decision                                                                                      |
| --- | -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Q6  | createVersion() source param?          | ANSWERED       | Always source from draft; getOrCreateDraft() is safety net; no source param needed            |
| Q7  | Keep fire-time deployment resolution?  | ANSWERED       | Yes as fallback during Phase 1; new version binding tried first; old block removed in Phase 2 |
| Q8  | Studio proxy routes for versions?      | ANSWERED       | Yes; add Next.js route files under versions/ directory; per feature spec Section 8            |
| Q9  | validate-workflow-tool-binding update? | ANSWERED       | Dual check: active version exists OR legacy status === 'active'; per INT-11 backward compat   |
| Q10 | Migration script format?               | DECIDED        | Standalone CLI at apps/runtime/src/scripts/; matches existing pattern; supports --dry-run     |

### Risk & Dependencies

| #   | Question                                | Classification | Decision                                                                                         |
| --- | --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| Q11 | BullMQ state divergence strategy?       | ANSWERED       | Both: migration backfills TriggerRegistration + processJob() fallback for old jobs; per HLD OQ-3 |
| Q12 | Conflicting changes on branch?          | ANSWERED       | Yes, recent model changes exist; read current state fresh before implementing                    |
| Q13 | Test rewrites — same phase or deferred? | DECIDED        | Same phase as code changes; separate test() commits; broken tests block CI                       |
| Q14 | Monitoring before rollout?              | INFERRED       | version.resolution.miss metric, trigger fire version metadata logging, cron skip warnings        |
| Q15 | GAP scope — which gaps in this LLD?     | DECIDED        | GAP-008 (workflow-as-tool) in scope; GAP-001 (connectors) and GAP-005 (import/export) deferred   |

---

## Audit Results

| Round | Auditor       | Result         | Findings                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | lld-reviewer  | NEEDS_CHANGES  | 2 CRITICAL (structured errors missing, audit/TraceStore task missing), 5 HIGH (getVersion projectId optional, listVersions deleted filter, TriggerJobData interface, i18n missing, SWR cache/loading states), 4 MEDIUM (withTransaction, v prefix parse, E2E paths, LQ-4), 2 LOW (LQ-1, LQ-4 resolved)                                                       |
| 2     | lld-reviewer  | NEEDS_CHANGES  | 3 HIGH (audit in service not route layer, AuditEventType gaps, process-api DI approach), 4 MEDIUM (auto-save file ref wrong, strategy/triggerType discrepancy, i18n locale file missing from files touched, barrel export missing), 1 LOW (err:any type narrowing)                                                                                           |
| 3     | lld-reviewer  | NEEDS_CHANGES  | 2 CRITICAL (FR-17 environment routing missing, INT-5 unmapped), 4 HIGH (INT-12 unmapped, INT-10 no integration test, AuditLog resourceType dual union, createVersion state gap), 4 MEDIUM (Studio proxy routes missing PATCH/GET/diff, strategy/triggerType unresolved, barrel export rename, INT-1 unmapped), 2 LOW (exit criteria counts, LQ-2 unresolved) |
| 4     | phase-auditor | NEEDS_REVISION | 1 CRITICAL (environmentsMatch case 4 contradicts FR-17/HLD/test-spec), 3 HIGH (test file mapping diverges, UI E2E Playwright missing, sourceHash index stale in feature spec), 2 MEDIUM (delivery plan 3.4 scope mismatch, INT-6 envVars TBD)                                                                                                                |
| 5     | lld-reviewer  | NEEDS_CHANGES  | 1 CRITICAL (environmentsMatch case 4 — same as R4), 2 HIGH (Phase 5 task 5.3 file overlap, createVersion inactive not in decision log), 4 MEDIUM (mutability matrix too restrictive, deleted filter on process-api, trigger registration field mapping, strategy/triggerType approach), 3 LOW (wiring checklist wording, LQ-2 blocking, LQ-3 answered)       |

### Decisions Made During Audit

| #     | Decision                                                       | Rationale                                                                                   | Round |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----- |
| LD-10 | Post-save sync hook as explicit code in PATCH handler          | Mongoose middleware implicit and harder to test                                             | 1     |
| LD-11 | Migration always ensures draft exists                          | getOrCreateDraft() single source of truth                                                   | 1     |
| LD-12 | Structured error responses with error codes                    | HLD mandates `{ success, error: { code, message } }`                                        | 1     |
| LD-13 | createVersion() sets initial state "inactive" (HLD divergence) | Centralizes trigger registration in activate() — one place for TriggerRegistration creation | 3/5   |
| LD-14 | Generic JSON diff for version comparison (Phase 1)             | Unblocks implementation; structural diff deferred                                           | 5     |

### Key Fixes Across Rounds

- R1: Added structured errors (LD-12), audit events, TriggerJobData, i18n, SWR cache, loading states, E2E file path alignment
- R2: Moved audit to route layer, added AuditEventType/resourceType extensions, fixed auto-save file reference, added i18n locale file
- R3: Added FR-17 environment routing (environmentsMatch), createVersion→inactive + explicit activate (LD-13), INT-12/INT-10/INT-1 test coverage, missing Studio proxy routes
- R4: Fixed environmentsMatch strict equality, added test file consolidation mapping, UI E2E deferral note, post-impl-sync notes
- R5: Fixed environmentsMatch (shared with R4), moved post-save sync to Phase 3, added LD-13/LD-14, fixed mutability matrix per FR-7, added deleted filter to process-api, specified trigger registration field mapping

---

## Files Created/Modified

- `docs/plans/2026-04-14-workflow-versioning-impl-plan.md` — full LLD (14 decisions, 5 phases, file-level change map, wiring checklist, acceptance criteria)
- `docs/sdlc-logs/workflow-versioning/lld.log.md` — this log

## Next Phase

Run `/implement workflow-versioning` to begin phased implementation.
