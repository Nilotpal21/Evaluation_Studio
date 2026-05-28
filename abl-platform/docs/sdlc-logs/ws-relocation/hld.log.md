# SDLC Log: ws-relocation — HLD Phase

**Date**: 2026-04-13
**Feature**: WebSocket Relocation (App-Level → Chat-Tab-Level)
**Phase**: HLD (Phase 3)

---

## Oracle Decisions

Product-oracle agent unavailable (model config issue). Clarifying questions self-answered.

### Architecture & Data Flow

| #   | Question              | Answer                                                                                                                 | Classification | Evidence                                               |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------ |
| Q1  | Architecture pattern? | React provider relocation + additive server handler case. No new services/workers.                                     | ANSWERED       | Feature spec §6, design doc §4                         |
| Q2  | Data flow?            | Client WS connect on mount → bidirectional messages → WS close on unmount → session detach. Keepalive: ping every 25s. | ANSWERED       | `WebSocketContext.tsx:728-803`, `handler.ts:1140-1328` |
| Q3  | Scale?                | 10K max connections per pod. After relocation: only Chat tab users connect.                                            | ANSWERED       | `WebSocketConnectionManager` max, feature spec §12     |
| Q4  | Existing patterns?    | SDK handler already has `case 'ping'` at `sdk-handler.ts:2337`.                                                        | ANSWERED       | Codebase grep                                          |
| Q5  | Deployment topology?  | Single runtime Express service. Studio Next.js SSR. No change.                                                         | ANSWERED       | Architecture                                           |

### Integration & Dependencies

| #   | Question                    | Answer                                                                                    | Classification | Evidence                           |
| --- | --------------------------- | ----------------------------------------------------------------------------------------- | -------------- | ---------------------------------- |
| Q6  | Dependencies?               | Auth store, session store, runtime WS handler, tenant resolution.                         | ANSWERED       | Feature spec §5 integration matrix |
| Q7  | New external deps?          | None.                                                                                     | DECIDED        | All internal changes               |
| Q8  | API contract?               | Additive: handler accepts `{type:'ping'}`, responds `{type:'pong'}`. Backward compatible. | ANSWERED       | Design doc §4.5                    |
| Q9  | Breaking changes?           | None.                                                                                     | DECIDED        | Consumer audit confirmed           |
| Q10 | Compile → deploy → execute? | No impact. No DSL/IR/compiler changes.                                                    | ANSWERED       | Feature spec §11                   |

### Risk & Migration

| #   | Question        | Answer                                                                                                         | Classification | Evidence                      |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------- |
| Q11 | Biggest risk?   | Component tree change breaking context access. Mitigated by consumer audit — all 7 consumers inside Chat tree. | DECIDED        | Design doc §3.2 consumer tree |
| Q12 | Data migration? | None. TypeScript union type additions only.                                                                    | ANSWERED       | Feature spec §9               |
| Q13 | Rollback?       | Revert 3 files. Keepalive changes independently beneficial.                                                    | DECIDED        | Design doc §10.3              |
| Q14 | Feature flags?  | Not needed. 2-phase deployment (keepalive first, relocation second).                                           | DECIDED        | Design doc §12                |
| Q15 | Blast radius?   | Low. Only Chat tab affected. 30+ pages unchanged. SDK/voice/A2A unchanged.                                     | ANSWERED       | Consumer audit                |

## Audit Results

### Round 1 (Full Audit — 12 concerns, alternatives, cross-phase)

All 10 checks passed. No CRITICAL or HIGH findings. 1 MEDIUM (design-lint.sh not referenced — acceptable for self-audit).

**Result: APPROVED**

### Round 2 (Data model / API deep dive)

All 5 checks passed. Type union changes verified backward compatible. `ServerMessages.pong()` factory confirmed exists.

**Result: APPROVED**

### Round 3 (Cross-phase consistency)

All 6 checks passed. HLD aligns with feature spec (problem statement, delivery plan, test totals) and test spec (scenario coverage, no-mock strategy, isolation tests).

**Result: APPROVED**

## Files Created/Updated

- `docs/specs/ws-relocation.hld.md` — HLD document
- `docs/sdlc-logs/ws-relocation/hld.log.md` — this file
