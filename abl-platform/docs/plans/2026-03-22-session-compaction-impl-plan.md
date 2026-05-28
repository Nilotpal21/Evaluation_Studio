# Session Compaction -- Low-Level Design + Implementation Plan

**Feature**: Session Compaction
**Feature Spec**: `docs/features/session-compaction.md`
**HLD**: `docs/specs/session-compaction.hld.md`
**Test Spec**: `docs/testing/session-compaction.md`
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| Decision                                            | Rationale                                                                      | Alternatives Rejected                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Character-based token estimation (4 chars/token)    | O(n) string length, no dependency, sufficient accuracy for threshold decisions | Real tokenizer (tiktoken) -- adds dependency, per-model loading, marginal accuracy gain |
| Split at max(MIN_ACTIVE_WINDOW, floor(length/2))    | Preserves at least half the recent context while guaranteeing minimum window   | Fixed split point (always keep N) -- less adaptive to conversation length               |
| LLM summarization with extractive fallback          | Best quality when LLM available; graceful degradation without                  | LLM-only (no fallback) -- fragile when LLM unavailable                                  |
| 3-level policy merge (platform -> project -> agent) | Matches existing pattern (guardrail policy, model resolution chain)            | Single-level config -- insufficient granularity for multi-tenant platform               |
| Lazy policy caching on `session._compactionPolicy`  | Avoid re-computing per LLM call; session-scoped lifetime is appropriate        | Global cache -- cross-session pollution risk; per-call -- unnecessary overhead          |
| Compaction disabled by default                      | Conservative rollout; prevents unexpected LLM calls on existing deployments    | Enabled by default -- risk of unexpected LLM costs and behavior change                  |

### Key Interfaces & Types

Already defined in codebase:

```typescript
// packages/compiler/src/platform/ir/schema.ts (lines 344-432)
export interface CompactionPolicy {
  model?: string;
  tool_results: ToolResultCompactionConfig;
  prior_turns: PriorTurnCompactionConfig;
}

export interface ToolResultCompactionConfig {
  strategy: 'none' | 'truncate' | 'structured' | 'summarize';
  max_chars: number;
  structured_threshold: number;
  keep_recent: number;
  essential_fields?: Record<string, string[]>;
  max_description_length?: number;
  summarize_prompt?: string;
}

export interface PriorTurnCompactionConfig {
  strategy: 'none' | 'placeholder' | 'compact' | 'summarize';
  assistant_preview_chars: number;
}

// apps/runtime/src/services/session/compaction-engine.ts (lines 34-41)
export interface CompactionResult {
  compacted: boolean;
  threadIndex: number;
  messagesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
}

// apps/runtime/src/services/session/types.ts (lines 162-196)
export interface SessionConfig {
  compactionEnabled: boolean;
  autoCompactThreshold: number;
  compactionModel: string;
  // ... other fields
}
```

### Module Boundaries

| Module                      | Responsibility                                                                                             | Dependencies                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `compaction-engine.ts`      | Token estimation, auto-compact trigger, history split, summary generation (LLM + extractive), trace events | RuntimeSession, SessionConfig, model registry, LLM client |
| `compaction-policy.ts`      | 3-level policy merge, tool essential_fields collection, lazy caching                                       | CompactionPolicy types from IR schema, RuntimeSession     |
| `tool-result-compressor.ts` | Per-result compression: none/truncate/structured/summarize strategies                                      | CompactionPolicy                                          |
| `reasoning-executor.ts`     | Orchestration: calls autoCompact() before LLM, applies cross-turn truncation                               | CompactionEngine, CompactionPolicy                        |
| `config/index.ts`           | Env var mappings for SESSION*COMPACTION*\* variables                                                       | Zod validation                                            |

---

## 2. File-Level Change Map

### Existing Files (Already Implemented)

| File                                                            | Purpose                                   | Status              |
| --------------------------------------------------------------- | ----------------------------------------- | ------------------- |
| `apps/runtime/src/services/session/compaction-engine.ts`        | CompactionEngine class (326 LOC)          | Implemented, tested |
| `apps/runtime/src/services/execution/compaction-policy.ts`      | Policy resolution (131 LOC)               | Implemented, tested |
| `apps/runtime/src/services/execution/tool-result-compressor.ts` | Tool result compression (203 LOC)         | Implemented, tested |
| `apps/runtime/src/services/session/types.ts`                    | SessionConfig with compaction fields      | Implemented         |
| `apps/runtime/src/config/index.ts`                              | Env var mappings (lines 73-75, 287-289)   | Implemented         |
| `packages/compiler/src/platform/ir/schema.ts`                   | CompactionPolicy types (lines 344-432)    | Implemented         |
| `apps/runtime/src/services/execution/types.ts`                  | \_compactionPolicy cache field (line 225) | Implemented         |
| `apps/runtime/src/services/execution/reasoning-executor.ts`     | autoCompact() integration (line 575)      | Implemented         |

### Existing Test Files (Already Implemented)

| File                                                            | Status         |
| --------------------------------------------------------------- | -------------- |
| `apps/runtime/src/__tests__/compaction-engine.test.ts`          | ~8 tests, PASS |
| `apps/runtime/src/__tests__/compaction-policy.test.ts`          | ~4 tests, PASS |
| `apps/runtime/src/__tests__/tool-result-compressor.test.ts`     | ~6 tests, PASS |
| `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts` | ~4 tests, PASS |

### New Files (Planned)

| File                                                                       | Purpose                                                     | LOC Estimate |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------ |
| `apps/runtime/src/__tests__/integration/compaction-reasoning-loop.test.ts` | Integration test: compaction within reasoning executor flow | ~200         |
| `apps/runtime/src/__tests__/e2e/compaction-e2e.test.ts`                    | E2E test: long conversation auto-compaction via WebSocket   | ~300         |

### Modified Files (Planned Enhancements)

| File                                                     | Change Description                                                     | Risk   |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| `apps/runtime/src/services/session/compaction-engine.ts` | Wire dedicated compaction model (GAP-001); add ContentBlock[] counting | Medium |
| `apps/runtime/src/__tests__/compaction-engine.test.ts`   | Add LLM abstractive summary test, ContentBlock[] test                  | Low    |

---

## 3. Implementation Phases

### Phase 1: Hardening -- LLM Summary Path & ContentBlock Support

**Goal**: Close the unit test gaps for the LLM abstractive summary path and ContentBlock[] message handling.

**Tasks**:
1.1. Add unit test for LLM abstractive summary path: inject a mock `llmClient` on the thread that returns a fixed summary string. Verify `generateSummary()` uses it and produces the correct `CompactionResult`.
1.2. Add unit test for ContentBlock[] message token estimation: create messages with `[{ type: 'text', text: '...' }]` content and verify `estimateTokens()` counts text block content correctly.
1.3. Add unit test for mixed content (some string, some ContentBlock[]): verify consistent token estimation.
1.4. Add unit test for messages with non-text ContentBlock types (image blocks): verify they contribute 0 tokens.

**Files Touched**:

- `apps/runtime/src/__tests__/compaction-engine.test.ts` -- add 4 new test cases

**Exit Criteria**:

- [ ] `pnpm test --filter=runtime -- compaction-engine` passes with 12+ tests (8 existing + 4 new)
- [ ] LLM abstractive summary path exercised with mock llmClient
- [ ] ContentBlock[] token estimation verified for text, mixed, and non-text blocks

**Test Strategy**:

- Unit: Mock `llmClient` via DI (set on thread/session object), not `vi.mock()`
- No integration or E2E tests in this phase

**Rollback**: Remove new test cases. No production code changes.

---

### Phase 2: Dedicated Compaction Model Wiring (GAP-001)

**Goal**: Wire the `compactionModel` field to create a separate LLM client for summarization instead of reusing the session's primary LLM.

**Tasks**:
2.1. In `compaction-engine.ts`, add a `compactionLLMClient` field to the `CompactionEngine` class constructor. If `SessionConfig.compactionModel` is set and differs from the session's model, create a lightweight LLM client for summarization.
2.2. Modify `generateSummary()` to prefer `this.compactionLLMClient` over `thread.llmClient || session.llmClient` when available.
2.3. Add config resolution: `CompactionPolicy.model` (from agent IR) -> `SessionConfig.compactionModel` (from env var) -> fallback to session's primary LLM.
2.4. Add unit test verifying the compaction LLM client is used when configured.
2.5. Add unit test verifying fallback to session LLM when compaction model is not available.

**Files Touched**:

- `apps/runtime/src/services/session/compaction-engine.ts` -- add `compactionLLMClient` field, modify `generateSummary()`
- `apps/runtime/src/__tests__/compaction-engine.test.ts` -- add 2 new test cases

**Exit Criteria**:

- [ ] `pnpm build --filter=runtime` succeeds with 0 type errors
- [ ] `pnpm test --filter=runtime -- compaction-engine` passes with 14+ tests
- [ ] Dedicated compaction model used when configured; session LLM fallback when not
- [ ] TODO at line 257 of compaction-engine.ts is resolved

**Test Strategy**:

- Unit: Verify LLM client selection logic with different configurations

**Rollback**: Revert compaction-engine.ts changes. Feature flag via `compactionModel` config -- if not set, behavior unchanged.

---

### Phase 3: Integration Tests

**Goal**: Verify compaction works correctly within the reasoning executor flow and with the session persistence layer.

**Tasks**:
3.1. Create `apps/runtime/src/__tests__/integration/compaction-reasoning-loop.test.ts`:

- Test CompactionEngine triggered by reasoning executor with a mock LLM client
- Verify conversation history is compacted after the reasoning loop
- Verify `[Conversation Summary]` system message is present
- Verify `auto_compact` trace event is emitted
  3.2. Test CompactionPolicy resolution with a fully populated RuntimeSession:
- Set `_projectRuntimeConfig.compaction` with partial overrides
- Set `agentIR.execution.compaction` with agent-level overrides
- Verify 3-level merge produces correct result
  3.3. Test tool-result compressor integration with CompactionPolicy:
- Create policy with tool-specific essential_fields
- Compress a large tool result
- Verify only essential fields are preserved
  3.4. Test session persistence round-trip:
- Compact a session's conversation history
- Save via SessionService (MemorySessionStore)
- Load and verify compacted history is intact
  3.5. Test compaction failure handling:
- Mock `autoCompact()` to throw an error
- Verify reasoning executor catches the error and continues

**Files Touched**:

- NEW: `apps/runtime/src/__tests__/integration/compaction-reasoning-loop.test.ts` (~200 LOC)

**Exit Criteria**:

- [ ] Integration test file runs with `pnpm test --filter=runtime -- compaction-reasoning-loop`
- [ ] All 5 integration test scenarios pass
- [ ] No `vi.mock()` of codebase components -- only mock LLM client via DI
- [ ] Session persistence round-trip verified

**Test Strategy**:

- Integration: Real CompactionEngine, real CompactionPolicy, real SessionService with MemorySessionStore
- Mock only: LLM client (external dependency, injected via DI on session/thread object)

**Rollback**: Delete test file. No production code changes.

---

### Phase 4: E2E Tests

**Goal**: Verify end-to-end compaction behavior through the real runtime server HTTP/WebSocket API.

**Tasks**:
4.1. Create `apps/runtime/src/__tests__/e2e/compaction-e2e.test.ts`:

- Start runtime Express server on random port with compaction enabled
- Compile an agent DSL with known model
- Open WebSocket connection with auth context
- Send enough messages to trigger compaction
- Verify conversation continues after compaction
- Verify history is compacted (shorter than total messages sent)
  4.2. Test compaction disabled by default:
- Start server WITHOUT `SESSION_COMPACTION_ENABLED`
- Send many messages
- Verify no compaction occurs
  4.3. Test cross-tenant isolation:
- Open two WebSocket connections with different tenantIds
- Verify sessions are independent
  4.4. Test per-agent threshold override:
- Create agent with `compaction_threshold: 0.5`
- Verify compaction triggers at lower threshold

**Files Touched**:

- NEW: `apps/runtime/src/__tests__/e2e/compaction-e2e.test.ts` (~300 LOC)

**Exit Criteria**:

- [ ] E2E test file runs with `pnpm test --filter=runtime -- compaction-e2e`
- [ ] Real Express server started on random port
- [ ] WebSocket connection established with auth headers
- [ ] Compaction verified via session state inspection (not direct DB access)
- [ ] Full middleware chain executed (auth, rate limiting, tenant isolation)

**Test Strategy**:

- E2E: Real runtime server, real session store (Memory), real compaction engine
- Mock only: LLM endpoint (HTTP mock server returning fixed responses) -- acceptable as external third-party service
- No `vi.mock()`, no direct DB access, no Mongoose model imports

**Rollback**: Delete test file. No production code changes.

---

## 4. Wiring Checklist

- [x] CompactionEngine instantiated in reasoning executor (`reasoning-executor.ts` line 294)
- [x] `autoCompact()` called before LLM call (`reasoning-executor.ts` line 575)
- [x] CompactionPolicy types exported from `@abl/compiler/platform/ir/schema.js`
- [x] `resolveCompactionPolicy()` exported from `compaction-policy.ts`
- [x] `DEFAULT_COMPACTION_POLICY` exported and used by `tool-result-compressor.ts`
- [x] Session config env vars mapped in `config/index.ts` (lines 73-75, 287-289)
- [x] `_compactionPolicy` cache field on `RuntimeSession` type (`types.ts` line 225)
- [x] `resolvedCompactionThreshold` set by `llm-wiring.ts` (line 1015-1016)
- [x] `compactThread()` modifies `thread.conversationHistory` in place
- [x] Compacted history saved via `SessionService.saveSession()` (normal save path)
- [ ] **PLANNED**: Integration test file wired to vitest config
- [ ] **PLANNED**: E2E test file wired to vitest config

---

## 5. Cross-Phase Concerns

### Configuration Changes

| Phase   | Config Change                        | Notes                                               |
| ------- | ------------------------------------ | --------------------------------------------------- |
| All     | `SESSION_COMPACTION_ENABLED` env var | Already implemented; controls master toggle         |
| Phase 2 | `SESSION_COMPACTION_MODEL` env var   | Already mapped but not wired to separate LLM client |

### Feature Flags

Compaction is controlled by `compactionEnabled` in `SessionConfig`. No additional feature flags needed. The feature is opt-in via environment variable.

### Database Migrations

None. No schema changes to MongoDB collections. CompactionPolicy types are defined in the IR schema (compile-time, no persistence migration).

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All existing unit tests pass: `pnpm test --filter=runtime -- compaction` (4 test files, ~22+ tests)
- [ ] Phase 1 unit tests pass: LLM abstractive path and ContentBlock[] handling (4 new tests)
- [ ] Phase 2 unit tests pass: Dedicated compaction model wiring (2 new tests)
- [ ] Phase 3 integration tests pass: 5 scenarios testing compaction within reasoning flow
- [ ] Phase 4 E2E tests pass: 4 scenarios testing real WebSocket compaction
- [ ] `pnpm build --filter=runtime` succeeds with 0 type errors after all phases
- [ ] No regressions in existing runtime tests: `pnpm test --filter=runtime` passes
- [ ] Feature spec updated with implementation details (GAP-001 resolved)
- [ ] Testing matrix updated with actual coverage (integration + E2E rows filled)

---

## 7. Open Questions

1. **E2E LLM mock strategy**: Should E2E tests use a real LLM endpoint or a deterministic HTTP mock server? The mock server approach is more reliable for CI but doesn't test actual summarization quality.
2. **Compaction model client lifecycle**: When wiring the dedicated compaction LLM client (Phase 2), should it be created per-session or shared across sessions? Per-session is simpler but may be wasteful if the compaction model is the same across sessions.
3. **Integration test scope**: Should integration tests test the full reasoning loop (which requires significant session setup) or isolate the CompactionEngine + ReasoningExecutor boundary?
