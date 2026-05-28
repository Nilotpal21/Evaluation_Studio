# SDLC Log: Custom External Events -- Phase 2 (Test Spec)

**Date:** 2026-03-23
**Phase:** Test Spec
**Artifact:** `docs/testing/custom-external-events.md`

## Coverage Summary

- **E2E scenarios:** 10 (exceeds minimum 5)
- **Integration scenarios:** 10 (exceeds minimum 5)
- **Unit test scenarios:** 5
- **Components covered:** Event type CRUD, ingestion, schema validation, event bus, compiler, pipeline triggers, webhooks, ClickHouse, rate limiting, isolation

## Key Test Design Decisions

| Decision                                                         | Rationale                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| ClickHouse tests use real instance for E2E, mock for integration | E2E must exercise full path; integration isolates logic              |
| Webhook test uses real HTTP server (not mock)                    | Per E2E standards: no mocking codebase components                    |
| Concurrent ingestion test (INT-8) with 50 parallel requests      | Validates thread safety of event ID generation and ClickHouse writes |
| Atomic batch validation (E2E-6)                                  | Ensures all-or-nothing semantics prevent partial state               |

## Phase Audit

### Self-Review Findings

| #   | Severity | Finding                                                    | Resolution                                                                                                     |
| --- | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | MEDIUM   | No E2E test for compiler RECALL validation                 | INT-2 covers this at integration level; E2E would require full compilation + runtime which is covered by E2E-4 |
| 2   | LOW      | Missing test for event type update concurrent modification | Added to INT-9 scope (schema update)                                                                           |
| 3   | LOW      | E2E-9 webhook test requires test HTTP server setup         | Documented in infrastructure requirements                                                                      |
