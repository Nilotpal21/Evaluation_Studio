# Phase 4: LLD — Contacts Management

> **Date:** 2026-03-23
> **Feature:** #49 Contacts Management

## Summary

Generated Low-Level Design and implementation plan with 5 phases, 20 tasks, and clear exit criteria per task. Covers security hardening, code quality, integration tests (7 scenarios), E2E tests (8 scenarios), and pagination/metrics polish.

## Key Metrics

- **Implementation Phases:** 5
- **Total Tasks:** 20
- **Security Fixes:** 3 (tenant isolation x2, RBAC x1)
- **Integration Test Files:** 7 (one per INT scenario)
- **E2E Test Files:** 8 (one per E2E scenario)
- **Estimated Total Effort:** 8 days
- **Wiring Checklist Items:** 13

## Phase Summary

| Phase | Name                | Tasks | Effort | Dependencies |
| ----- | ------------------- | ----- | ------ | ------------ |
| 1     | Security Hardening  | 3     | 1 day  | None         |
| 2     | Code Quality        | 2     | 1 day  | None         |
| 3     | Integration Tests   | 8     | 2 days | Phase 1      |
| 4     | E2E Tests           | 9     | 3 days | Phase 1      |
| 5     | Pagination & Polish | 2     | 1 day  | None         |

## Critical Path

Phase 1 (Security Hardening) must complete before Phases 3 and 4 because:

- INT-06 tests tenant isolation fixes from Task 1.1
- E2E-02 tests tenant isolation via HTTP API
- E2E-03/04 need RBAC from Task 1.2 to function correctly

Phases 2 and 5 are independent and can proceed in parallel with testing phases.

## Audit Findings

| #   | Severity | Finding                                                                    | Resolution                |
| --- | -------- | -------------------------------------------------------------------------- | ------------------------- |
| 1   | HIGH     | Tenant isolation in MongoContactStore is the #1 priority                   | Phase 1, Task 1.1         |
| 2   | HIGH     | RBAC missing on merge routes allows any authenticated user to merge/delete | Phase 1, Task 1.2         |
| 3   | MEDIUM   | console.error in routes breaks structured logging pipeline                 | Phase 2, Task 2.1         |
| 4   | INFO     | Dual store consolidation deferred to separate PR                           | Phase 2, Task 2.2 (DEFER) |
| 5   | INFO     | Prometheus metrics are optional/polish                                     | Phase 5, Task 5.2         |

## Artifact

`docs/plans/2026-03-23-contacts-impl-plan.md`
