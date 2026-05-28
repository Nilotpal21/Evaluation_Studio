# LLD Log: Arch Gate-Free Onboarding

**Feature**: Arch Conversational Flow — Gate-Free Onboarding
**Slug**: `arch-gate-free-build`
**Date**: 2026-04-10
**Ticket**: ABLP-162

## Oracle Decisions

### Implementation Strategy

| #   | Question              | Classification | Answer                                                                                                                                                                                                       |
| --- | --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Implementation order? | DECIDED        | Backend-first: types → state machine → phase transitions → route handler → session/resume → frontend. Data layer changes propagate upward.                                                                   |
| Q2  | Existing patterns?    | ANSWERED       | `continue`/`create` deterministic handlers (route.ts:3284-3455), atomic `$set` metadata writes with triple-filter, multi-turn executor (executor/multi-turn-executor.ts), ActivityEmitter for SSE narration. |
| Q3  | Feature flag?         | DECIDED        | No. Hard cutover per HLD AD-14. GATE_PENDING cleanup on load is the compat strategy.                                                                                                                         |
| Q4  | Phase 1 scope?        | DECIDED        | Backend types + state machine + phase machine (no route handler changes). Allows build verification before touching the 5000-line route.                                                                     |
| Q5  | Deadlines?            | DECIDED        | No hard deadline. Quality over speed — the gate bugs are P0 reliability issues worth fixing properly.                                                                                                        |

### Technical Details

| #   | Question                   | Classification | Answer                                                                                                                                                                                                          |
| --- | -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Files to modify vs create? | ANSWERED       | ~22 files modified, ~3 files created (BuildSummaryCard, proceed tool handler extract), ~3 files deleted (gate-manager.ts, ApprovalGate.tsx, build-gate-queue.ts).                                               |
| Q7  | Testing strategy?          | DECIDED        | Test-after per phase. Each phase has exit criteria with specific test commands. E2E tests are the final phase.                                                                                                  |
| Q8  | Type definitions first?    | ANSWERED       | Yes — `BuildProgress`, simplified `PendingInteraction`, `proceed_to_next_phase` tool definition. These cascade into all other changes.                                                                          |
| Q9  | Database migration?        | DECIDED        | None. Additive field (`buildProgress`). Old fields become dead data.                                                                                                                                            |
| Q10 | Performance paths?         | ANSWERED       | The BUILD auto-generation flow is the critical path. deterministic tool config generation (FR-5.5) must be fast (<3s). The route handler's buildProgress writes must not add perceptible latency (atomic $set). |

### Risk & Dependencies

| #   | Question                     | Classification | Answer                                                                                                                                                                                |
| --- | ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Conflicting changes?         | ANSWERED       | The `arch/knowledge` branch has recent commits. No other known branches touching gate code.                                                                                           |
| Q12 | Biggest implementation risk? | DECIDED        | Phase 3 (route handler rewrite) — 5000-line file, ~300 lines of gate handler code to remove, ~130 lines of BLUEPRINT→BUILD transition to refactor. Must not break IN_PROJECT mode.    |
| Q13 | Team dependencies?           | DECIDED        | Self-contained. No external team dependency. Codex review already done.                                                                                                               |
| Q14 | Monitoring?                  | DECIDED        | After deployment: monitor `arch_sessions` for any sessions stuck in unexpected states. Query: `db.arch_sessions.find({ state: 'GATE_PENDING' })` should return 0 after cleanup cycle. |
| Q15 | Definition of done?          | DECIDED        | All 7 E2E scenarios pass. All 10 integration scenarios pass. `pnpm build && pnpm test` clean. Zero `GATE_PENDING` sessions after one release cycle.                                   |
