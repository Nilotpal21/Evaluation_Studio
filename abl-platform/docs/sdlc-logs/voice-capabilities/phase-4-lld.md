# Phase 4: LLD — voice-capabilities

**Phase:** Low-Level Design & Implementation Plan
**Date:** 2026-03-22
**Status:** COMPLETE

## Inputs

- Feature spec: `docs/features/voice-capabilities.md`
- Test spec: `docs/testing/voice-capabilities.md`
- HLD: `docs/specs/voice-capabilities.hld.md`
- Codebase: Full voice subsystem analysis (23 source files, 8 existing test files)

## Key Decisions

| ID  | Decision                                                                                | Classification |
| --- | --------------------------------------------------------------------------------------- | -------------- |
| D1  | 5-phase implementation plan (Foundation -> Integration -> E2E -> Realtime -> Hardening) | DECIDED        |
| D2  | External services (Deepgram, ElevenLabs, OpenAI) stubbed via DI, never vi.mock          | DECIDED        |
| D3  | LiveKit E2E deferred to separate infra test suite                                       | DECIDED        |
| D4  | Provider health checks added in Phase 5 (hardening)                                     | DECIDED        |
| D5  | Focus on test coverage since code already exists                                        | DECIDED        |

## Phase Summary

| Phase | Focus                          | Duration | Key Deliverables                                                        |
| ----- | ------------------------------ | -------- | ----------------------------------------------------------------------- |
| 1     | Foundation Tests & VerbBuilder | 1 week   | 5 new unit test files, VerbBuilder edge cases                           |
| 2     | Integration Tests              | 1 week   | 4 integration test files (pipeline, protocol, verbs, realtime executor) |
| 3     | E2E Tests — Core Paths         | 1 week   | 4 E2E test files (pipeline, KoreVG, isolation, barge-in)                |
| 4     | Realtime & Provider Hardening  | 1 week   | 4 test files (realtime E2E, mode resolution, credentials, reconnection) |
| 5     | Production Hardening           | 1 week   | Provider health checks, error recovery, SDK tests, coverage report      |

## LLD Review Round 1 Findings

| #   | Severity | Finding                                                    | Resolution                                       |
| --- | -------- | ---------------------------------------------------------- | ------------------------------------------------ |
| 1   | HIGH     | Missing wiring checklist for integration verification      | Added wiring checklist section                   |
| 2   | HIGH     | E2E tests should specify how external services are handled | Added explicit DI stub approach to each E2E task |
| 3   | MEDIUM   | No risk mitigation for flaky WebSocket tests               | Added risk mitigation table with timing approach |
| 4   | MEDIUM   | Phase 1 should include VoiceSessionResolver tests          | Added task 1.3 for VoiceSessionResolver          |

## LLD Review Round 2 Findings

| #   | Severity | Finding                                                                        | Resolution                                        |
| --- | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| 1   | MEDIUM   | Success metrics should compare current vs target                               | Added success metrics table                       |
| 2   | MEDIUM   | DeepgramService and ElevenLabsService tests need mock WebSocket/fetch approach | Added implementation details to tasks 1.4 and 1.5 |
| 3   | LOW      | Phase 5 should update package agents.md files                                  | Added task 5.5                                    |
| 4   | LOW      | Current state assessment table should show test status more precisely          | Refined status column in assessment table         |

## Artifacts Produced

- `docs/plans/2026-03-22-voice-capabilities-impl-plan.md` — 5-phase implementation plan
- `docs/sdlc-logs/voice-capabilities/phase-4-lld.md` — This log

## Metrics

- Implementation Phases: 5
- Total Tasks: ~25
- New Test Files Planned: ~17
- Exit Criteria Defined: 5 (one per phase)
- Wiring Checklist Items: 8
- Risks Identified: 5
