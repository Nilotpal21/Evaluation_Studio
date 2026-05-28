# SDLC Log: Tool Invocations - LLD (Phase 4)

**Date**: 2026-03-22
**Phase**: LLD
**Skill**: `/lld`

## Clarifying Questions & Decisions

| #   | Question                                    | Classification | Answer / Rationale                                                                                              |
| --- | ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Preferred implementation order?             | DECIDED        | Gaps first (isolation E2E, validator), then resilience improvements, then new executor, then observability      |
| 2   | Existing codebase patterns to follow?       | ANSWERED       | Dispatcher+executor pattern, onion middleware, tenant isolation plugin. Source: tool-binding-executor.ts        |
| 3   | Should this be behind a feature flag?       | DECIDED        | No. All changes are additive and backward-compatible. No feature flags needed.                                  |
| 4   | Which files need modification vs creation?  | ANSWERED       | Primarily new test files. Existing executors/validators modified minimally. Source: codebase exploration        |
| 5   | Testing strategy: test-first or test-after? | DECIDED        | Test-first for isolation E2E (Phase 1). Test-with for new executor (Phase 3). Tests define exit criteria.       |
| 6   | Other ongoing changes that could conflict?  | INFERRED       | Auth profile system is stable. No known concurrent changes to tool execution code.                              |
| 7   | Biggest implementation risk?                | DECIDED        | Lambda executor (Phase 3) -- requires AWS SDK dependency and IAM auth. Mitigated by making it optional.         |
| 8   | Definition of done for the whole feature?   | DECIDED        | All GAPs either closed or documented with timeline. All existing 1,000+ tests still pass. E2E covers isolation. |

## Files Created / Modified

| File                                                  | Action  | Notes                       |
| ----------------------------------------------------- | ------- | --------------------------- |
| `docs/plans/2026-03-22-tool-invocations-impl-plan.md` | Created | 4 phases with exit criteria |
| `docs/sdlc-logs/tool-invocations/lld.log.md`          | Created | This file                   |

## Review Summary

### Round 1 - Architecture Compliance

- All phases use tenant-scoped patterns (isolation, auth, tracing)
- No stateful assumptions: Redis for cross-pod state, in-memory fallback
- Traceability preserved: reason codes added in Phase 4
- No new external dependencies except Phase 3 (AWS SDK, optional)

### Round 2 - Pattern Consistency

- New executors follow existing HttpToolExecutor/McpToolExecutor pattern
- Validation rules follow existing tool-schema-validator pattern
- E2E tests follow existing tool-invocations-api.e2e.test.ts pattern
- Middleware chain not modified: new concerns compose into existing chain

### Round 3 - Completeness

- Every FR from feature spec covered by at least one implementation phase
- File paths verified against codebase (existing files confirmed, new files in correct directories)
- Type signatures checked against actual source (ToolDefinition, ToolExecutor, ToolBindingExecutorConfig)
- All 10 GAPs from feature spec have a corresponding phase or documented status

### Round 4 - Cross-Phase Consistency

- LLD implements HLD architecture (dispatcher+executor pattern preserved)
- Test strategy aligns with test spec E2E and integration scenarios
- Phase ordering matches dependency chain (isolation first, then improvements, then new types)
- Wiring checklist covers all existing + planned integrations

### Round 5 - Final Sweep

- All tasks are independently completable in one session
- Each phase has measurable exit criteria (specific test counts, build commands)
- Wiring checklist has explicit items for each phase
- Rollback strategy documented for every phase
- No CRITICAL findings remaining

## Key Learnings

- The tool invocation system is architecturally complete for current tool types. The primary work is closing test gaps and adding partial executor implementations.
- The namespace-scoped executor pattern (creating per-tool executors for tools with `variable_namespace_ids`) adds memory overhead but is necessary for env var isolation. This pattern should be preserved in new executor types.
- Auth profile middleware operates at the middleware layer, not the executor layer. This is a deliberate architectural choice that keeps auth injection cross-cutting.
- The confirmation gate is implemented as a pre-dispatch check in `ToolBindingExecutor`, not as middleware. This is because confirmation requires synchronous user interaction that cannot be modeled as a transparent middleware pass-through.
