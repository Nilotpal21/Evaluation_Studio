# Session Compaction -- Feature Spec Log

**Phase**: 1 (Feature Spec)
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Scope & Problem

| Question                                                 | Classification | Answer                                                                                                                                                                    |
| -------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What specific problem does session compaction solve?     | ANSWERED       | Long conversations exceed LLM context window. Code evidence: `compaction-engine.ts` checks `currentTokens < threshold` before each LLM call.                              |
| What is the boundary -- what is explicitly out of scope? | ANSWERED       | Dedicated compaction model wiring (TODO at line 257), user-visible notifications, cross-session compaction. Inferred from existing code gaps and non-goals in prior spec. |
| Is this a new capability or enhancement?                 | ANSWERED       | Existing implementation. CompactionEngine and CompactionPolicy both exist and are wired into the reasoning executor.                                                      |
| What components exist?                                   | ANSWERED       | `compaction-engine.ts` (326 LOC), `compaction-policy.ts` (131 LOC), `tool-result-compressor.ts` (203 LOC), 4 test files.                                                  |

### Technical & Architecture

| Question                          | Classification | Answer                                                                                                                                        |
| --------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Which packages are affected?      | ANSWERED       | `apps/runtime` (engine, policy, compressor, types, config) and `packages/compiler` (IR schema types).                                         |
| How is compaction triggered?      | ANSWERED       | `autoCompact()` called in `reasoning-executor.ts` at line 575 before each LLM call.                                                           |
| How is policy resolved?           | ANSWERED       | 3-level merge in `compaction-policy.ts`: DEFAULT_COMPACTION_POLICY -> project config -> agent IR. Lazy cached on `session._compactionPolicy`. |
| What env vars control compaction? | ANSWERED       | `SESSION_COMPACTION_ENABLED`, `SESSION_AUTO_COMPACT_THRESHOLD`, `SESSION_COMPACTION_MODEL` mapped in `config/index.ts` lines 73-75, 287-289.  |

## Files Created

- `docs/features/session-compaction.md` -- Full 18-section feature spec
- `docs/sdlc-logs/session-compaction/feature-spec.log.md` -- This log

## Code Files Read

- `apps/runtime/src/services/session/compaction-engine.ts`
- `apps/runtime/src/services/session/types.ts`
- `apps/runtime/src/services/session/session-service.ts`
- `apps/runtime/src/services/session/session-store.ts`
- `apps/runtime/src/services/session/tiered-session-store.ts`
- `apps/runtime/src/services/session/session-operations.ts`
- `apps/runtime/src/services/session/session-bootstrap.ts`
- `apps/runtime/src/services/session/index.ts`
- `apps/runtime/src/services/execution/compaction-policy.ts`
- `apps/runtime/src/services/execution/tool-result-compressor.ts`
- `apps/runtime/src/services/execution/types.ts` (lines 200-270)
- `apps/runtime/src/config/index.ts` (compaction config lines)
- `packages/compiler/src/platform/ir/schema.ts` (CompactionPolicy types)
- `docs/plans/2026-03-09-compaction-strategies-design.md`
- `docs/plans/2026-03-09-compaction-strategies-plan.md`

## Review Findings

### Round 1 -- Completeness & Quality

- All 18 TEMPLATE.md sections addressed
- 5 user stories (exceeds minimum 3)
- 12 functional requirements with code references (exceeds minimum 4)
- Integration matrix references 6 related features
- Non-functional concerns address tenant/project/user isolation
- 5 open questions documented
- All claims grounded in code evidence with file paths and line numbers

### Round 2 -- Cross-Phase Consistency

- FR numbering consistent (FR-1 through FR-12)
- Scope boundaries match non-goals
- User stories align with functional requirements
- All implementation files verified to exist at stated paths
- Status changed from STABLE to ALPHA (no integration/E2E tests)
