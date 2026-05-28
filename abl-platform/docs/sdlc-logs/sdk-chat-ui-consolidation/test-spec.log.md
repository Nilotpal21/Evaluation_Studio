# SDLC Log: SDK Chat UI Consolidation — Test Spec Phase

**Feature**: sdk-chat-ui-consolidation
**Phase**: TEST-SPEC
**Date**: 2026-03-25

---

## Oracle Decisions

All 15 questions answered autonomously. No AMBIGUOUS items escalated.

### Test Scope & Priorities (Q1-Q5)

| #   | Question           | Classification | Key Decision                                                                                                         |
| --- | ------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Q1  | Highest risk FRs?  | INFERRED       | FR-4 (ChatClient refactor), FR-2 (DefaultTransport), FR-11 (StudioTransport), FR-15 (hooks unchanged), FR-5 (type)   |
| Q2  | Known edge cases?  | INFERRED       | Session start race, auth token expiry on reconnect, streaming orphan, backfill dedup, thought absence, dual delivery |
| Q3  | Coverage baseline? | ANSWERED       | 23 existing test files; 0 transport/component tests; React layer has only agent-provider-config.test.ts              |
| Q4  | Mock vs real?      | INFERRED       | Mock WebSocket/fetch; real ChatClient, React components, EventEmitter; no real services for unit/integration         |
| Q5  | Test environment?  | ANSWERED       | Vitest + happy-dom (unit/int), Playwright (E2E), PM2 services for E2E, `pnpm build` before test                      |

### E2E Scenarios (Q6-Q10)

| #   | Question                | Classification | Key Decision                                                                                      |
| --- | ----------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| Q6  | Critical user journeys? | ANSWERED       | Studio chat+debug, SDK embed, backwards compat, custom transport, rich content, error surfacing   |
| Q7  | Auth combinations?      | INFERRED       | DefaultTransport (API key pk\_\*), StudioTransport (JWT), invalid/expired key, JIT auth challenge |
| Q8  | Cross-feature E2E?      | ANSWERED       | Rich Content Templates, Tracing/Observatory, Omnichannel, Auth Session Unification                |
| Q9  | Data seeding?           | DECIDED        | PM2 services + existing test project with tool-enabled agent for thought events                   |
| Q10 | Performance scenarios?  | DECIDED        | Bundle size <40KB, large message list (200+), rapid streaming (100 chunks), theme switching cost  |

### Integration Boundaries (Q11-Q15)

| #   | Question             | Classification | Key Decision                                                                                          |
| --- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| Q11 | Service boundaries?  | ANSWERED       | 6 boundaries: Transport↔ChatClient, Default↔Session, Studio↔WSContext, Provider↔Transport, etc.       |
| Q12 | Event-driven flows?  | ANSWERED       | Streaming protocol, thought pipeline, status lifecycle, auth challenge, reconnection, live transcript |
| Q13 | Isolation scenarios? | INFERRED       | Project scoping via transport, scope cleared on disconnect, no cross-project leakage                  |
| Q14 | Race conditions?     | INFERRED       | Connect/disconnect cycling, message during reconnect, chunk interleaving, session switch mid-stream   |
| Q15 | Error/failure paths? | INFERRED       | Connection failure, send while disconnected, upload failure, missing provider, invalid role fallback  |

## Audit Log

### Round 1 — NEEDS_REVISION

| ID    | Severity | Finding                                      | Resolution                                                        |
| ----- | -------- | -------------------------------------------- | ----------------------------------------------------------------- |
| TS-4  | CRITICAL | E2E-6 used echo transport (client-side mock) | Replaced with real-system theme/strings E2E, echo moved to INT-11 |
| TS-3  | CRITICAL | FR-14 missing E2E coverage in matrix         | Added "P" in E2E column                                           |
| TS-5  | HIGH     | No isolation E2E tests                       | Added E2E-9 (cross-project rejection, missing auth)               |
| TS-6  | HIGH     | E2E-7/E2E-8 vague auth context               | Pinned to "API key, SDK embed test page"                          |
| TS-7  | HIGH     | No disconnect/reconnect E2E                  | Added E2E-10 (network disruption during streaming)                |
| TS-9  | HIGH     | SDK E2E path wrong (`packages/web-sdk/e2e/`) | Fixed to `apps/studio/e2e/sdk-chat-consolidation.spec.ts`         |
| TS-10 | HIGH     | FR-9/FR-10 no E2E coverage                   | Added "P" in E2E column, covered by E2E-6                         |
| TS-8  | MEDIUM   | Data seeding + CI config imprecise           | Added concrete seeding guidance, referenced Playwright config     |
| TS-2  | MEDIUM   | INT mocking not justified                    | Added note about network boundary mocking in section header       |

### Round 2 — APPROVED

| ID   | Severity | Finding                            | Status              |
| ---- | -------- | ---------------------------------- | ------------------- |
| TS-8 | MEDIUM   | Playwright config path specificity | Noted, non-blocking |
| TS-8 | MEDIUM   | Helper import paths not documented | Noted, non-blocking |

## Test Spec Summary

| Category    | Count |
| ----------- | ----- |
| E2E         | 10    |
| Integration | 11    |
| Unit        | 12    |
| Security    | 5     |
| Performance | 4     |
| Total       | 42    |

## Files Created / Updated

- `docs/testing/sub-features/sdk-chat-ui-consolidation.md` — full test spec (42 scenarios)
- Updated `docs/testing/README.md` — row 79 updated to 8 E2E, 10 integration, DONE
