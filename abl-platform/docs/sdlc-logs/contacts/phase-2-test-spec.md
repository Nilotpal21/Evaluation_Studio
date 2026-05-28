# Phase 2: Test Spec — Contacts Management

> **Date:** 2026-03-23
> **Feature:** #49 Contacts Management

## Summary

Generated test spec covering 8 E2E scenarios, 7 integration scenarios, and 3 unit scenario groups. Total of 18 distinct test scenarios with 80+ individual test cases planned.

## Key Metrics

- **E2E Scenarios:** 8 (exceeds minimum 5)
- **Integration Scenarios:** 7 (exceeds minimum 5)
- **Unit Scenarios:** 3 groups
- **Zero Mocks:** All E2E and integration tests use real infrastructure (MongoDB, Express server, EncryptionService)
- **No TODO stubs:** Every scenario has concrete steps and assertions

## Scenario Coverage

| Scenario                            | FR Coverage                | Priority |
| ----------------------------------- | -------------------------- | -------- |
| E2E-01: CRUD Lifecycle              | FR-01..07, FR-19           | P0       |
| E2E-02: Tenant Isolation            | NFR-01, FR-04              | P0       |
| E2E-03: Merge Workflow              | FR-11, FR-12, FR-14, FR-15 | P0       |
| E2E-04: Self-Merge                  | FR-12                      | P0       |
| E2E-05: GDPR Cascade Delete         | FR-13, NFR-05              | P0       |
| E2E-06: Input Validation            | FR-19, FR-01               | P1       |
| E2E-07: Contact History Pagination  | FR-18                      | P1       |
| E2E-08: Auth/Authz                  | NFR-01                     | P0       |
| INT-01: Resolve with Encryption     | FR-08..10, FR-20           | P0       |
| INT-02: Merge with Session Reassign | FR-11                      | P0       |
| INT-03: Cascade Delete              | FR-13, NFR-05              | P0       |
| INT-04: Contact Context Cache       | FR-16, NFR-03              | P1       |
| INT-05: Self-Merge Identity         | FR-12                      | P0       |
| INT-06: Repo Tenant Isolation       | NFR-01                     | P0       |
| INT-07: Merge Candidates            | FR-14                      | P1       |

## Audit Findings

| #   | Severity | Finding                                                                   | Resolution                     |
| --- | -------- | ------------------------------------------------------------------------- | ------------------------------ |
| 1   | INFO     | Existing encryption tests already cover UNIT-03 scenarios                 | Noted as pre-existing coverage |
| 2   | INFO     | Concurrent merge scenario identified as risk but not in current test plan | Logged as future enhancement   |

## Artifact

`docs/testing/contacts.md`
