# SDK Test Spec — SDLC Phase 2 Log

**Feature**: Web SDK (`packages/web-sdk`)
**Phase**: 2 — Test Spec
**Date**: 2026-03-22
**Status**: COMPLETE

## Inputs Read

- `docs/features/sdk.md` — Phase 1 feature spec (18 FRs, 8 NFRs)
- `packages/web-sdk/src/__tests__/rich-content-sdk.test.ts` — existing unit tests
- `apps/runtime/src/__tests__/ws-sdk-handler.test.ts` — existing server-side tests
- `docs/testing/README.md` — testing README for feature index

## Decisions

| ID  | Decision                                     | Classification | Rationale                                                |
| --- | -------------------------------------------- | -------------- | -------------------------------------------------------- |
| D1  | 10 E2E scenarios (exceeds 5 minimum)         | DECIDED        | SDK has many integration surfaces requiring E2E coverage |
| D2  | 12 integration scenarios (exceeds 5 minimum) | DECIDED        | ChatClient, VoiceClient, SessionManager each need tests  |
| D3  | No mocking codebase components in E2E        | DECIDED        | Per CLAUDE.md E2E test standards                         |
| D4  | Server-side handler tests flagged as gap     | DECIDED        | Existing tests are fully mocked — need real integration  |

## Audit Round 1 — Self-Review

| Finding | Severity | Description                                      | Resolution                      |
| ------- | -------- | ------------------------------------------------ | ------------------------------- |
| A1-1    | HIGH     | E2E-5 (voice) missing auth context specification | Added auth context to all E2E   |
| A1-2    | HIGH     | IT-5 (VoiceClient) did not test error state      | State machine covers error path |
| A1-3    | MEDIUM   | Missing test infrastructure requirements section | Added setup instructions        |

## Audit Round 2 — Completeness

| Finding | Severity | Description                                              | Resolution         |
| ------- | -------- | -------------------------------------------------------- | ------------------ |
| A2-1    | HIGH     | No test for concurrent WebSocket connections             | Added E2E-10       |
| A2-2    | MEDIUM   | Integration tests did not cover ManualVADAdapter         | Added IT-12        |
| A2-3    | LOW      | Health dashboard missing deployment-aware resolution row | Added to dashboard |

## Counts

- E2E scenarios: 10 (7 detailed, 3 brief)
- Integration scenarios: 12
- Unit test cases needed: 7 additional
- Existing tests: 14 unit + ~30 server-side (mocked)

## Output

- `docs/testing/sdk.md` — test spec with coverage map, E2E/integration scenarios
