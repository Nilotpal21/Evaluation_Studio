# SDLC Log: Workflow Versioning — HLD

**Phase**: HLD
**Date**: 2026-04-14
**Feature Slug**: workflow-versioning
**Artifact**: `docs/specs/workflow-versioning.hld.md`

---

## Oracle Decisions

All 15 clarifying questions answered. No AMBIGUOUS items required user escalation.

### Architecture & Data Flow

| #   | Question                             | Classification | Decision                                                                                      |
| --- | ------------------------------------ | -------------- | --------------------------------------------------------------------------------------------- |
| Q1  | Keep version lifecycle in same svc?  | ANSWERED       | Refactor WorkflowVersionService in-place, add activate/deactivate/getOrCreateDraft/resolve    |
| Q2  | Deployment-to-version flow location? | DECIDED        | Refactor createVersion() with `source` param (draft/workflow); deployment route calls service |
| Q3  | Canvas auto-save target change?      | ANSWERED       | Both layers: Phase 1 runtime handler redirects to draft; Phase 2 Studio API client switches   |
| Q4  | Version resolution caching?          | DECIDED        | Compound index sufficient for Phase 1; no cache needed at expected scale                      |
| Q5  | Centralize version resolution?       | ANSWERED       | Not needed — trigger-to-version is direct ID lookup; resolution only for Process API path     |

### Integration & Dependencies

| #   | Question                             | Classification | Decision                                                                          |
| --- | ------------------------------------ | -------------- | --------------------------------------------------------------------------------- |
| Q6  | New method or refactor createVersion | DECIDED        | Refactor with `source` param; avoids duplicating dedup/numbering logic            |
| Q7  | Name-based or ID-based manifest?     | DECIDED        | Keep name-based for consistency with agentVersionManifest                         |
| Q8  | Studio proxy for version endpoints?  | INFERRED       | Add new proxy routes under existing workflow sub-routes                           |
| Q9  | Multiple envs per version?           | ANSWERED       | Strictly one env per published version; multiple deploys create separate versions |
| Q10 | Connector trigger HLD depth?         | DECIDED        | Acknowledge and specify interface contract; defer detailed implementation to LLD  |

### Risk & Migration

| #   | Question                             | Classification | Decision                                                                                  |
| --- | ------------------------------------ | -------------- | ----------------------------------------------------------------------------------------- |
| Q11 | Biggest technical risk?              | DECIDED        | BullMQ state divergence (existing jobs lack workflowVersionId) > migration data integrity |
| Q12 | Migration script format?             | DECIDED        | Hybrid: one-time CLI batch + getOrCreateDraft() safety net                                |
| Q13 | Phase 1 rollback strategy?           | ANSWERED       | Stop dual-write; Workflow doc fields remain usable; additive fields ignored               |
| Q14 | Keep deployment fallback in Phase 1? | DECIDED        | Yes — primary (workflowVersionId), fallback (deployment resolution), final (working copy) |
| Q15 | Blast radius on resolution failure?  | DECIDED        | Skip execution with warning for cron; 500 for webhook callers; no BullMQ retry            |

---

## Audit Results

| Round | Result         | Findings                                                                                                                                                                                                 |
| ----- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | NEEDS_REVISION | 0 CRITICAL, 4 HIGH (sourceHash index label, per-trigger toggle endpoints missing, no Goal section, FR-20 UI architecture missing), 3 MEDIUM (OQ-4 promotion, rollback detail, open question count)       |
| 2     | NEEDS_REVISION | 0 CRITICAL, 3 HIGH (workflow deleted/deletedAt field labels, version prefix convention, PATCH request shape), 3 MEDIUM (D-1 in error table, trigger status exclusion note, TriggerRegistration enum gap) |
| 3     | APPROVED       | 0 CRITICAL, 0 HIGH, 3 MEDIUM (sourceHash index scoping, D-1 OQ attribution, FR-17 matching predicate), 1 LOW (OQ numbering divergence)                                                                   |

### Decisions Made During Audit

| #   | Decision                                          | Rationale                                                                    |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| D-1 | envVars frozen on published versions              | Nested under `definition`, affects behavior — use new deployment to change   |
| D-2 | Version names include `v` prefix (e.g., `v0.1.0`) | Consistency across HLD, feature spec, test spec                              |
| D-3 | TriggerRegistration status enum adds `"inactive"` | Distinguish version-level deactivation from user-initiated per-trigger pause |

---

## Files Created/Modified

- `docs/specs/workflow-versioning.hld.md` — full HLD (12 concerns, 3 alternatives, data model, API design, UI architecture)
- `docs/testing/sub-features/workflow-versioning.md` — updated HLD reference
- `docs/sdlc-logs/workflow-versioning/hld.log.md` — this log

## Next Phase

Run `/lld workflow-versioning` to generate the Low-Level Design + implementation plan.
