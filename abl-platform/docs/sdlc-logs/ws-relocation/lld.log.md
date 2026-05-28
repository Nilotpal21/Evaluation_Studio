# SDLC Log: ws-relocation — LLD Phase

**Date**: 2026-04-13
**Feature**: WebSocket Relocation (App-Level → Chat-Tab-Level)
**Phase**: LLD (Phase 4)

---

## Oracle Decisions

Product-oracle agent unavailable (model config issue — same as prior phases). Clarifying questions self-answered from feature spec, HLD, test spec, and codebase evidence.

### Implementation Strategy

| #   | Question              | Answer                                                                                                      | Classification | Evidence                       |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------ |
| Q1  | Implementation order? | Types → handler → client keepalive → decouple → relocate. Bottom-up.                                        | DECIDED        | HLD §4.10 two-phase deployment |
| Q2  | Existing patterns?    | SDK handler `case 'ping'` at `sdk-handler.ts:2337`. `fetchApps` already HTTP at `WebSocketContext.tsx:903`. | ANSWERED       | Codebase grep                  |
| Q3  | Feature flags?        | Not needed. Structural isolation sufficient.                                                                | DECIDED        | HLD §4.10                      |

### Technical Details

| #   | Question                   | Answer                                                                                                                          | Classification | Evidence                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------- |
| Q4  | Files to modify vs create? | 8 modified, 1 new (`useAvailableApps.ts`).                                                                                      | ANSWERED       | Feature spec §10, codebase |
| Q5  | Testing strategy?          | Test-after per phase. Real WS servers for integration.                                                                          | DECIDED        | Test spec, CLAUDE.md       |
| Q6  | Type changes?              | `ClientMessage` (runtime + studio) + ping, `ServerMessage` (studio) + pong. Runtime ServerMessage already has pong at line 400. | ANSWERED       | Runtime types grep         |

### Risk & Dependencies

| #   | Question                | Answer                                                                       | Classification | Evidence                       |
| --- | ----------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------------------ |
| Q7  | Biggest risk?           | Context tree change. All 7 consumers verified inside Chat tree.              | DECIDED        | Consumer audit                 |
| Q8  | `fetchApps` dependency? | Already HTTP — zero WS dependency. `authHeaders` from `lib/api-client`.      | ANSWERED       | `WebSocketContext.tsx:903-906` |
| Q9  | Phase ordering?         | Phase 5 (relocate) depends on Phase 3+4 (decouple App.tsx + CommandPalette). | DECIDED        | Component tree analysis        |

## Audit Results

### Round 1 (Architecture Compliance)

All checks passed. Tenant isolation, centralized auth, stateless, traceability — all preserved. Ping/pong is auth-gated, stateless, carries no PII.

**Result: APPROVED**

### Round 2 (Pattern Consistency)

| #   | Severity | Finding                                                                                             | Resolution                                                    |
| --- | -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | HIGH     | `useAvailableApps.ts` imported `authHeaders` from wrong path (`../api/auth` vs `../lib/api-client`) | Fixed — correct import path                                   |
| 2   | HIGH     | `AppInfo` type missing `entryAgent: string` and `agentCount: number` fields                         | Fixed — full type from WebSocketContext.tsx:31-37             |
| 3   | HIGH     | `fetchApps` response check missing `data.success` guard                                             | Fixed — `data.success && data.apps` matches existing pattern  |
| 4   | MED      | Missing dev-mode error logging in hook catch block                                                  | Fixed — added `console.error` guard matching existing pattern |

**Result: APPROVED (after fixes)**

### Round 3 (Completeness)

All 10 FRs mapped to implementation phases. All file paths verified. All function signatures checked.

| #   | Severity | Finding                                      | Resolution                                   |
| --- | -------- | -------------------------------------------- | -------------------------------------------- |
| 1   | HIGH     | Phase 5 dependency on Phase 3+4 not explicit | Fixed — added "Dependencies" note to Phase 5 |

**Result: APPROVED (after fix)**

### Round 4 (Cross-Phase Consistency)

All 9 cross-phase checks passed. LLD aligns with feature spec (10 FRs, delivery plan), test spec (scenario references, test file mapping), and HLD (architecture decisions, rollback strategy).

**Result: APPROVED**

### Round 5 (Final Sweep)

All 12 checks passed. Task independence verified. Wiring checklist complete (13 items). Domain rules followed. Exit criteria measurable.

**Result: APPROVED**

## Files Created/Updated

- `docs/plans/2026-04-13-ws-relocation-impl-plan.md` — LLD + implementation plan (5 phases)
- `docs/sdlc-logs/ws-relocation/lld.log.md` — this file
