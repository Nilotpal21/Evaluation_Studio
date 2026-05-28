# HLD Log: Arch Gate-Free Onboarding

**Feature**: Arch Conversational Flow — Gate-Free Onboarding
**Slug**: `arch-gate-free-build`
**Date**: 2026-04-10
**Ticket**: ABLP-162

## Oracle Decisions

### Architecture & Data Flow

| #   | Question                     | Classification | Answer                                                                                                                                                                                                                                                                       |
| --- | ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Architecture pattern?        | ANSWERED       | Refactor within existing route handler (`POST /api/arch-ai/message`). No service extraction. Same request→SSE→client pattern. Gate logic is removed, `proceed_to_next_phase` tool added, `buildProgress` persisted via atomic `$set` on existing `arch_sessions` collection. |
| Q2  | Data flow?                   | ANSWERED       | Request path: `POST /message` → session load → phase machine → specialist executor → multi-turn LLM loop → SSE events → `done`. No event-driven flows. All synchronous within a single SSE stream per request.                                                               |
| Q3  | Expected scale?              | INFERRED       | Low volume: onboarding is single-user, single-session. ~1 concurrent BUILD per user. No horizontal scale concerns for this feature specifically.                                                                                                                             |
| Q4  | Existing patterns to follow? | ANSWERED       | The `continue` and `create` deterministic message types are the pattern for button-driven transitions (route.ts:3284-3455). The `ask_user` widget contract is the pattern for LLM-paused tool calls (specialist-executor.ts:133-148). Follow both.                           |
| Q5  | Deployment topology?         | ANSWERED       | Single Studio Next.js service. No workers, no queues. All processing in the route handler.                                                                                                                                                                                   |

### Integration & Dependencies

| #   | Question                          | Classification | Answer                                                                                                                                                                                                            |
| --- | --------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Existing dependencies?            | ANSWERED       | `packages/arch-ai` (types, coordinator, executor, prompts, session, streaming), Vercel AI SDK (LLM), MongoDB (sessions, journals), `@abl/compiler` (compile_abl tool).                                            |
| Q7  | New external dependencies?        | DECIDED        | None. `proceed_to_next_phase` is an internal tool. Deterministic tool config generation (FR-5.5) uses existing `extractAllTools` from `mock-server/tool-extractor.ts`.                                            |
| Q8  | API contract changes?             | ANSWERED       | `gate_response` removed from `MessageRequestSchema`. No new endpoints. `buildProgress` added to session metadata (read via `GET /sessions/current`). `proceed_to_next_phase` is an LLM tool, not an API endpoint. |
| Q9  | Breaking changes?                 | DECIDED        | `gate_response` removal is a breaking change for old clients. Mitigated: old clients get HTTP 400 at schema validation. Old GATE_PENDING sessions cleaned up on load.                                             |
| Q10 | Compile→deploy→execute lifecycle? | ANSWERED       | No impact. This feature is pre-project (onboarding). The compile→deploy lifecycle starts after `create_project`.                                                                                                  |

### Risk & Migration

| #   | Question                | Classification | Answer                                                                                                                                                                                                                                                    |
| --- | ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Biggest technical risk? | DECIDED        | The BLUEPRINT→BUILD transition refactor. Moving topology diff/preserve logic from the gate handler into a shared function is the highest-risk code change — it's ~130 lines of atomic MongoDB operations that must preserve tenant scoping.               |
| Q12 | Data migration?         | DECIDED        | No migration needed. Old fields (`buildSubPhase`, `approvedAgents`, `selectedTools`) become dead data. New field (`buildProgress`) is added additively. Old `GATE_PENDING` sessions are cleaned up on load.                                               |
| Q13 | Rollback strategy?      | DECIDED        | Revert the commit. Re-add `GATE_PENDING` to state machine. Re-add `gate_response` to schema. Old sessions still have gate-era fields in metadata. The only irreversible action is `GATE_PENDING` session archival — but those sessions were stuck anyway. |
| Q14 | Feature flags?          | DECIDED        | No feature flag. Hard cutover. The gate system is the source of P0 bugs — maintaining two code paths is worse than a clean cut.                                                                                                                           |
| Q15 | Blast radius?           | DECIDED        | Onboarding flow only. IN_PROJECT mode is unaffected (uses `proposal_response`). The shared `useArchChat` hook has gate branches that are removed, but IN_PROJECT only uses the widget and proposal branches.                                              |
