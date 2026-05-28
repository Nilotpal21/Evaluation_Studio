# SDLC Log: Workflow Versioning & Version-Aware Triggers — Feature Spec

**Phase**: FEATURE-SPEC
**Date**: 2026-04-14
**Feature Slug**: workflow-versioning
**Artifact**: `docs/features/sub-features/workflow-versioning.md`

---

## Oracle Decisions

All 15 clarifying questions were answered by the product oracle. No AMBIGUOUS items required user escalation.

### Scope & Problem

| #   | Question                                                 | Classification | Decision                                                             |
| --- | -------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| Q1  | Replace or fallback for fire-time deployment resolution? | DECIDED        | Completely replace; backfill existing triggers during migration      |
| Q2  | Remove 5-status lifecycle or keep for agents?            | DECIDED        | Remove for workflows only; agents retain their 5-status lifecycle    |
| Q3  | Update parent spec out-of-scope?                         | ANSWERED       | Yes — update workflows.md to reflect versioning is now in-scope      |
| Q4  | Breaking or gradual migration?                           | DECIDED        | Gradual with backward compatibility (2-phase: additive then cleanup) |
| Q5  | Refactor or replace WorkflowVersionService?              | DECIDED        | Refactor in-place — 80% reusable (dedup, numbering, diffing)         |

### User Stories & Requirements

| #   | Question                                      | Classification | Decision                                                  |
| --- | --------------------------------------------- | -------------- | --------------------------------------------------------- |
| Q6  | Who creates deployments?                      | ANSWERED       | ADMIN + OPERATOR roles via `deployment:create` permission |
| Q7  | Multiple active versions across environments? | ANSWERED       | Yes — one active deployment per (project, environment)    |
| Q8  | In-flight executions on deactivate?           | ANSWERED       | Run to completion — Restate captures definition at start  |
| Q9  | Add Versions tab to Studio?                   | DECIDED        | Yes — between Flow and Triggers tabs                      |
| Q10 | Default version with multiple environments?   | DECIDED        | Environment-specific; fallback to most recent then draft  |

### Technical & Architecture

| #   | Question                                 | Classification | Decision                                                            |
| --- | ---------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Q11 | Migrate existing triggers?               | DECIDED        | Backfill to draft version; no fallback path post-migration          |
| Q12 | CreateWorkflowModal changes?             | DECIDED        | Backend creates Workflow + draft WorkflowVersion atomically         |
| Q13 | Denormalized copy for backward compat?   | DECIDED        | Yes during transition; mark as deprecated, remove in phase 2        |
| Q14 | Environment context for internal events? | DECIDED        | Derived from originating deployment's environment                   |
| Q15 | Keep "auto" mode in deployments?         | DECIDED        | Yes — change source from Workflow document to draft WorkflowVersion |

---

## Audit Results

| Round | Result         | Findings                                                                                                                     |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1     | NEEDS_REVISION | 4 HIGH: tags field annotation, missing resolveDefault index, FR-17 env matching underspecified, FR-8 workflow-as-tool impact |
| 2     | APPROVED       | 1 MEDIUM (cosmetic OQ numbering collision — fixed pre-commit)                                                                |

## Files Created

- `docs/features/sub-features/workflow-versioning.md` — feature spec
- `docs/testing/sub-features/workflow-versioning.md` — testing guide placeholder
- `docs/sdlc-logs/workflow-versioning/feature-spec.log.md` — this log

## Commit

- **SHA**: `41669b91f0`
- **Message**: `[ABLP-2] docs(workflow-engine): add workflow versioning feature spec`
- **Date**: 2026-04-14

## Next Phase

Run `/test-spec workflow-versioning` to generate the full test specification.
