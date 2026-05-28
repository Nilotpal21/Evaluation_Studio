# Test Spec Log: Arch Gate-Free Onboarding

**Feature**: Arch Conversational Flow — Gate-Free Onboarding
**Slug**: `arch-gate-free-build`
**Date**: 2026-04-10
**Ticket**: ABLP-162

## Oracle Decisions

All questions answered inline (agent API unavailable).

### Test Scope & Priorities

| #   | Question                             | Classification | Answer                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Highest risk FRs?                    | DECIDED        | FR-1 (GATE_PENDING removal), FR-4 (phase transitions), FR-14 (backward compat). These are the core state machine changes that affect every session.                                                                                                                                                         |
| Q2  | Known edge cases from production?    | ANSWERED       | 5 documented failure modes in BUILD (approvedAgents loop, GATE_PENDING races, buildSubPhase stuck, empty gate emissions, quality_floor blocking). Also: widget pending on refresh, topology gate after browser close.                                                                                       |
| Q3  | Current test coverage baseline?      | ANSWERED       | 37 test files in `packages/arch-ai/src/__tests__/`, 6 E2E files in `apps/studio/src/__tests__/e2e/arch-ai-*`. Existing: `session-state-machine.test.ts`, `phase-machine.test.ts`, `build-gate-queue.test.ts`, `build-exit-criteria-subphase.test.ts`, `resume-snapshot.test.ts`, `message-request.test.ts`. |
| Q4  | External dependencies needing mocks? | DECIDED        | Only the LLM provider (Vercel AI SDK / Anthropic). MongoMemoryServer for DB. No other external services in onboarding.                                                                                                                                                                                      |
| Q5  | Test environment setup?              | ANSWERED       | MongoMemoryServer + dynamic route module imports + dev-login auth tokens. Pattern established in `arch-ai-sessions.e2e.test.ts`.                                                                                                                                                                            |

### E2E Scenarios

| #   | Question                      | Classification | Answer                                                                                                                                                                          |
| --- | ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Critical user journeys?       | INFERRED       | Full onboarding (welcome→create), conversational topology modification, conversational agent modification, session resume mid-build, old GATE_PENDING session on load.          |
| Q7  | Auth/permission combinations? | DECIDED        | Tenant + user scoping only (onboarding is pre-project). Cross-tenant isolation is the key auth test. IN_PROJECT mode is out of scope but shared hook compat needs a smoke test. |
| Q8  | Cross-feature interactions?   | ANSWERED       | IN_PROJECT overlay shares `useArchChat` — gate removal must not break `proposal_response` handling.                                                                             |
| Q9  | Data seeding?                 | DECIDED        | MongoMemoryServer with dev-login. For backward compat: manually insert old `GATE_PENDING` sessions with `approvedAgents`/`buildSubPhase`.                                       |
| Q10 | Performance scenarios?        | DECIDED        | Token budget for 4-8 agent generation in one turn. Not a P0 for test spec — defer to load testing.                                                                              |

### Integration Boundaries

| #   | Question             | Classification | Answer                                                                                                                                                                                                  |
| --- | -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Service boundaries?  | ANSWERED       | Route handler → SessionService (MongoDB), Route handler → multi-turn executor (LLM), Route handler → compiler (compile_abl).                                                                            |
| Q12 | Event-driven flows?  | ANSWERED       | SSE events (file_changed, compile_result, activity, phase_transition, done). The SSE stream is the primary integration surface.                                                                         |
| Q13 | Isolation scenarios? | ANSWERED       | Cross-tenant: user A cannot see user B's session. Cross-user within tenant: same. All tested via session CRUD with different auth tokens.                                                               |
| Q14 | Race conditions?     | DECIDED        | Two-tab concurrent message sends while session is ACTIVE. The `ACTIVE` mutex should prevent corruption. Existing behavior, but worth a test now that GATE_PENDING is removed.                           |
| Q15 | Error/failure paths? | DECIDED        | LLM timeout during BUILD, partial generation (3/5 agents), compile error → auto-fix → re-compile, old client sending gate_response (schema rejection), stale GATE_PENDING session on every entry point. |
