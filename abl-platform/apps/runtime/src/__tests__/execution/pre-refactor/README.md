# Pre-Refactor Parity Tests

Behavioral contract tests for RuntimeExecutor. These tests capture the CURRENT
behavior before consolidation begins. They serve as the safety net during the
strangler migration to ConstructExecutor sub-executors.

## Purpose

- Assert observable behavior: responses, state mutations, trace events
- Run before AND after each delegation phase
- Parity threshold: 99.5% match required before cutover

## Structure

- `helpers/` — Test factories and assertion utilities
- `fixtures/` — Reusable test data (DSL snippets, expected outputs)
- `session-lifecycle.test.ts` — Create, initialize, rehydrate, persist, end
- `gather-execution.test.ts` — Field collection, validation, entity extraction
- `constraint-evaluation.test.ts` — Guardrail evaluation, ON_FAIL branching
- `completion-detection.test.ts` — Completion conditions, session end
- `flow-execution.test.ts` — Step traversal, THEN/GOTO, loops
- `reasoning-execution.test.ts` — Tool-use loops, reasoning zones
- `handoff-delegate.test.ts` — Agent routing, handoffs, delegates
- `thread-model.test.ts` — Thread create, switch, return
- `trace-emission.test.ts` — TraceEvent shapes and ordering
- `error-handling.test.ts` — Tool/LLM failures, timeouts, recovery
