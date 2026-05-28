# SDLC Log: ws-relocation — Test Spec Phase

**Date**: 2026-04-13
**Feature**: WebSocket Relocation (App-Level → Chat-Tab-Level)
**Phase**: Test Spec (Phase 2)

---

## Oracle Decisions

Product-oracle agent unavailable (model config issue — same as feature-spec phase). Clarifying questions self-answered from feature spec, existing test files, and codebase patterns.

### Test Scope & Priorities

| #   | Question                             | Answer                                                                                                                                           | Classification | Evidence                                                              |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------- |
| Q1  | Highest risk FRs?                    | FR-4 (session resume) and FR-5/6/7 (keepalive) — core value of the change                                                                        | DECIDED        | These are the new behaviors; all other FRs are structural relocations |
| Q2  | Known edge cases?                    | Token refresh during WS connect, React Strict Mode double-mount, in-flight response loss on navigate                                             | ANSWERED       | `WebSocketContext.tsx:733` guard, design doc §6 edge cases            |
| Q3  | Current coverage baseline?           | 14 tests (ws-heartbeat), auth-refresh regression (1 test), ws-handler (message routing). Zero coverage for app-level keepalive or WS relocation. | ANSWERED       | Existing test files read during Phase 1                               |
| Q4  | External dependencies needing mocks? | None — all components are internal. Only runtime WS server needs real server.                                                                    | DECIDED        | Per CLAUDE.md: no mocking codebase components                         |
| Q5  | Test environment?                    | Vitest for unit, Vitest + real servers for integration, Playwright for E2E                                                                       | ANSWERED       | Existing patterns in `ws-heartbeat.test.ts`, `ws-handler.test.ts`     |

### E2E Scenarios

| #   | Question                    | Answer                                                                                            | Classification | Evidence                                |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------- |
| Q6  | Critical user journeys?     | Login → browse (no WS) → Chat (WS connects) → idle (keepalive) → away (WS closes) → back (resume) | ANSWERED       | Feature spec user stories 1-5           |
| Q7  | Auth/permission combos?     | Authenticated user with project access only. No admin/public scenarios (WS is studio-internal).   | DECIDED        | All WS consumers are in Studio Chat tab |
| Q8  | Cross-feature interactions? | Auth token refresh, observatory traces, batch consent — all within Chat tree                      | ANSWERED       | Feature spec integration matrix         |
| Q9  | Data seeding?               | Need project with 1+ agent, test user with project access                                         | INFERRED       | Standard E2E seed pattern               |
| Q10 | Performance scenarios?      | Connection count (50 non-chat + 10 chat users), keepalive overhead, chat tab navigation latency   | DECIDED        | Feature spec success metrics            |

### Integration Boundaries

| #   | Question                  | Answer                                                                                       | Classification | Evidence                                       |
| --- | ------------------------- | -------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------- |
| Q11 | Service boundaries?       | WS client ↔ Runtime handler, handler ↔ session store, CommandPalette ↔ HTTP API              | ANSWERED       | Feature spec §10 file matrix                   |
| Q12 | Event-driven flows?       | Session detach → resume cycle, trace events through WS                                       | ANSWERED       | Design doc §6                                  |
| Q13 | Tenant/project isolation? | Cross-tenant resume rejection, cross-user resume rejection                                   | ANSWERED       | `ensureWsSessionAccess()` in handler.ts        |
| Q14 | Race conditions?          | Token refresh during connect, rapid Chat tab mount/unmount, multiple tabs                    | ANSWERED       | Design doc §6 edge cases                       |
| Q15 | Error paths?              | Invalid JWT → rejection, expired session → resume failure, runtime down → connection failure | ANSWERED       | Handler auth gate, 3-tier lookup failure paths |

## Test Spec Summary

- **10 unit test scenarios** (UT-1 through UT-10)
- **7 integration test scenarios** (INT-1 through INT-7)
- **7 E2E test scenarios** (E2E-1 through E2E-7)
- **3 performance test scenarios** (PERF-1 through PERF-3)
- **5 existing regression tests** that must continue to pass
- **16 planned test files** mapped to scenarios
- **Full coverage matrix** mapping all 10 FRs to test types

## Audit Results

### Round 1 (Self-Audit)

| #   | Check                                        | Result                                                |
| --- | -------------------------------------------- | ----------------------------------------------------- |
| 1   | Minimum 5 E2E scenarios                      | PASS (7)                                              |
| 2   | Minimum 5 integration scenarios              | PASS (7)                                              |
| 3   | Every FR in coverage matrix                  | PASS (all 10 FRs)                                     |
| 4   | Security & isolation section filled          | PASS (6 subsections)                                  |
| 5   | E2E specifies auth context                   | PASS (all 7 scenarios)                                |
| 6   | E2E has no mocks/stubs/direct DB             | PASS                                                  |
| 7   | Integration specifies service boundary       | PASS (all 7 scenarios)                                |
| 8   | Integration no mock of components under test | PASS                                                  |
| 9   | Test file mapping to actual paths            | PASS (16 files mapped)                                |
| 10  | No TODO stubs                                | PASS                                                  |
| 11  | Scenarios include structured types           | PASS (session state objects, message arrays in E2E-4) |

**Result: APPROVED**

### Round 2 (Fresh-Eyes)

| #   | Check                                          | Result                                         |
| --- | ---------------------------------------------- | ---------------------------------------------- |
| 1   | Test spec ↔ feature spec FR alignment          | PASS — all 10 FRs mapped                       |
| 2   | Test spec ↔ testing placeholder consistency    | PASS — placeholder replaced with full spec     |
| 3   | E2E scenarios cover user stories               | PASS — all 5 user stories covered              |
| 4   | Integration scenarios cover service boundaries | PASS — WS handler, session lifecycle, HTTP API |
| 5   | Open testing questions are actionable          | PASS — 4 questions with options                |

**Result: APPROVED**

## Files Created/Updated

- `docs/testing/sub-features/ws-relocation.md` — full test spec (replaced placeholder)
- `docs/features/sub-features/ws-relocation.md` — updated §17 with test counts and scenario references
- `docs/sdlc-logs/ws-relocation/test-spec.log.md` — this file
