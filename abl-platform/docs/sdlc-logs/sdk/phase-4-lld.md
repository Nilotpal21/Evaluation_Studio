# SDK LLD — SDLC Phase 4 Log

**Feature**: Web SDK (`packages/web-sdk`)
**Phase**: 4 — Low-Level Design (Implementation Plan)
**Date**: 2026-03-22
**Status**: COMPLETE

## Inputs Read

- `docs/features/sdk.md` — Feature spec (18 FRs, 8 NFRs)
- `docs/testing/sdk.md` — Test spec (10 E2E, 12 integration)
- `docs/specs/sdk.hld.md` — HLD (12 concerns, 3 alternatives, security model)
- `packages/web-sdk/src/` — All source files
- `apps/runtime/src/websocket/sdk-handler.ts` — Server handler (200+ lines read)

## Decisions

| ID  | Decision                                        | Classification | Rationale                                                         |
| --- | ----------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| D1  | 5 phases (not 3 or 7)                           | DECIDED        | Balances granularity with practical execution                     |
| D2  | Phase 1 focuses on integration tests before E2E | DECIDED        | Integration tests are faster to write and provide faster feedback |
| D3  | Security hardening in dedicated Phase 3         | DECIDED        | Critical gaps from HLD need focused attention                     |
| D4  | CDN distribution deferred to Phase 5            | DECIDED        | Not blocking BETA; tests and security are higher priority         |
| D5  | Mock SessionManager as test helper, NOT vi.mock | DECIDED        | Per CLAUDE.md: E2E tests must NOT mock codebase components        |

## Audit Round 1 — LLD Review

| Finding | Severity | Description                                            | Resolution                        |
| ------- | -------- | ------------------------------------------------------ | --------------------------------- |
| A1-1    | HIGH     | Phase 1 missing barge-in integration test (IT-6)       | Added task 1.9                    |
| A1-2    | HIGH     | Phase 3 missing E2E verification for security controls | Added tasks 3.6, 3.7              |
| A1-3    | MEDIUM   | No wiring checklist                                    | Added wiring checklist section    |
| A1-4    | MEDIUM   | Timeline does not account for parallel execution       | Added parallel note for Phase 2+3 |

## Audit Round 2 — Coverage Verification

| Finding | Severity | Description                                         | Resolution                |
| ------- | -------- | --------------------------------------------------- | ------------------------- |
| A2-1    | HIGH     | FR-18 (deployment-aware resolution) had no E2E test | Added as E2E-8 in Phase 5 |
| A2-2    | MEDIUM   | Risk register missing voice provider dependency     | Added to risk register    |
| A2-3    | LOW      | Phase 5 missing doc sync task (/post-impl-sync)     | Added task 5.10           |

## Counts

- Total phases: 5
- Total tasks: 47
- FRs covered: 18/18
- NFRs covered: 6/8 (NFR-7 Shadow DOM and NFR-8 browser support already satisfied)
- Security gaps addressed: 3 (origin validation, message size limits, catch handling)
- Estimated effort: ~10 working days

## Output

- `docs/plans/2026-03-22-sdk-impl-plan.md` — 5-phase implementation plan with exit criteria
